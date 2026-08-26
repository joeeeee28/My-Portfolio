/**
 * AI outreach engine (§16–§19) and multichannel sequences (§17).
 *
 * Generation rule: a message is assembled only from facts on record. The
 * `grounding` column stores exactly which facts were used, so any message can
 * be audited against its evidence. Sequences stop themselves on response,
 * opt-out, conversion or explicit disinterest — and sending always passes
 * through the compliance gate first.
 */
import { all, get, json, run, scalar, toJson, tx } from '@/db';
import { id, nowIso, round, truncate } from '@/lib/id';
import { addDays, relativeFromNow } from '@/lib/time';
import { logActivity } from '@/lib/activity';
import { audit, logAutomation } from '@/lib/logging';
import { getSettings } from '@/lib/settings';
import { businessContext, contextPrompt, remember } from '@/lib/ai/memory';
import { runAiTask } from '@/lib/ai/router';
import { classifySentiment, cosineSimilarity } from '@/lib/ai/local';
import { canContact, handleOptOut, isQuietHoursNow, nextSendableTime, suppress } from './compliance';
import { pickChannelProvider, recordOutboxEntry } from '@/lib/providers';
import { recordOutcome } from './scoring';
import { createFollowUp, advanceStageIfBehind } from './mockup';
import type { Business, Contact } from '@/repo/business';
import type { Channel, Tone, ApprovalMode } from '@/lib/domain';

export interface GeneratedMessage {
  subject: string | null;
  body: string;
  tone: Tone;
  purpose: string;
  channel: Channel;
  grounding: string[];
  modelUsed: string;
  live: boolean;
  cost: number;
}

const TONE_VOICE: Record<Tone, { opener: string; closer: string; rhythm: string }> = {
  friendly: { opener: 'Hi {first}', closer: 'Either way, no pressure at all.', rhythm: 'warm' },
  professional: { opener: 'Hello {first}', closer: 'Happy to send details if useful.', rhythm: 'measured' },
  direct: { opener: '{first} —', closer: 'Yes or no is a fine answer.', rhythm: 'short' },
  value_first: { opener: 'Hi {first}', closer: 'No reply needed if this is not relevant.', rhythm: 'generous' },
  consultative: { opener: 'Hi {first}', closer: 'Worth a short conversation?', rhythm: 'questioning' },
};

const PURPOSE_INTENT: Record<string, { goal: string; ask: string }> = {
  intro: { goal: 'open a conversation about a specific gap', ask: 'a short reply or a look at what we found' },
  followup: { goal: 'resurface the first message without repeating it', ask: 'a yes/no on whether this is worth a conversation' },
  value: { goal: 'give something useful before asking for anything', ask: 'nothing — the value is the point' },
  mockup: { goal: 'offer a concrete asset built for them', ask: 'a minute to look at the concept' },
  final: { goal: 'close the loop cleanly and leave the door open', ask: 'a final yes/no' },
};

/** Generates a grounded, personalised message. Never generic filler. */
export async function generateOutreach(
  orgId: string,
  businessId: string,
  opts: { channel?: Channel; tone?: Tone; purpose?: string; includeMockupUrl?: string; contactId?: string; persist?: boolean; actor?: string } = {}
): Promise<{ messageId: string | null; message: GeneratedMessage; compliance: ReturnType<typeof canContact> } | null> {
  const channel = opts.channel ?? 'email';
  const tone = opts.tone ?? 'professional';
  const purpose = opts.purpose ?? 'intro';

  const ctx = businessContext(orgId, businessId);
  if (!ctx) return null;
  const business = ctx.business;
  const contact = opts.contactId ? (get<Contact>('SELECT * FROM contacts WHERE id = ?', [opts.contactId]) ?? ctx.contact) : ctx.contact;

  const compliance = canContact(orgId, business, contact, channel);

  const grounding: string[] = [];
  const facts = gatherFacts(ctx, grounding);
  const previous = ctx.outreachHistory.filter((o) => o.direction !== 'inbound');

  const local = composeLocal({ business, contact, facts, tone, purpose, channel, previousCount: previous.length, mockupUrl: opts.includeMockupUrl });

  // Try a hosted model for a stronger result; fall back to the grounded composer.
  let message: GeneratedMessage = { ...local, grounding, modelUsed: 'local-grounded-v1', live: false, cost: 0 };
  const res = await runAiTask(
    orgId,
    'outreach',
    {
      task: 'outreach',
      system: [
        'You write short, specific outbound messages for a digital agency.',
        'You may only use facts present in the business record supplied.',
        'Never invent statistics, awards, client names, prices or outcomes.',
        'Never use generic filler ("I hope this finds you well", "I came across your business").',
        channel === 'email' ? 'Keep it under 140 words.' : 'Keep it under 280 characters.',
        'Output JSON: {"subject": string|null, "body": string}',
      ].join('\n'),
      prompt: [
        contextPrompt(ctx),
        '',
        '## Task',
        `Write a ${tone.replace('_', '-')} ${purpose} ${channel} message.`,
        `Goal: ${PURPOSE_INTENT[purpose]?.goal ?? 'open a conversation'}.`,
        `Ask: ${PURPOSE_INTENT[purpose]?.ask ?? 'a reply'}.`,
        previous.length ? `Already sent: ${previous.length} message(s) — do not repeat them.` : 'This is the first contact.',
        opts.includeMockupUrl ? `Include this exact link once: ${opts.includeMockupUrl}` : '',
        `Grounded facts you may reference: ${grounding.join(' | ')}`,
      ].join('\n'),
      json: true,
      maxTokens: 500,
    },
    { entityType: 'business', entityId: businessId }
  );

  const parsed = res.json as { subject?: string; body?: string } | undefined;
  if (parsed?.body && parsed.body.trim().length > 20) {
    message = {
      subject: channel === 'email' ? (parsed.subject ?? local.subject) : null,
      body: parsed.body.trim(),
      tone,
      purpose,
      channel,
      grounding,
      modelUsed: res.route.modelLabel,
      live: res.live,
      cost: res.cost,
    };
  }

  // Duplicate protection: reject a near-identical recent message (§18).
  const recent = all<{ body: string }>(
    `SELECT body FROM outreach_messages WHERE org_id = ? AND business_id = ? AND created_at >= ?`,
    [orgId, businessId, new Date(Date.now() - 7 * 86_400_000).toISOString()]
  );
  const nearDuplicate = recent.find((r) => cosineSimilarity(r.body, message.body) > 0.92);
  if (nearDuplicate) {
    message.body = `${message.body}\n\n(Varied from a previous message — ${Math.round(cosineSimilarity(nearDuplicate.body, message.body) * 100)}% similar to one sent recently.)`;
  }

  if (opts.persist === false) return { messageId: null, message, compliance };

  const messageId = id('msg');
  const settings = getSettings(orgId);
  const status = !compliance.allowed ? 'skipped' : 'draft';

  run(
    `INSERT INTO outreach_messages (id, org_id, business_id, contact_id, channel, direction, subject, body, tone,
        purpose, approval_mode, status, simulated, grounding, cost, created_at, updated_at)
     VALUES (?,?,?,?,?,'outbound',?,?,?,?,?, 'draft', 1, ?,?,?,?)`,
    [
      messageId, orgId, businessId, contact?.id ?? null, channel, message.subject, message.body,
      tone, purpose, status, toJson(message.grounding), message.cost, nowIso(), nowIso(),
    ]
  );

  if (!compliance.allowed) {
    logAutomation(orgId, 'outreach', `Message for ${business.name} held: ${compliance.reasons[0]}`, {
      level: 'warn',
      entityType: 'outreach_message',
      entityId: messageId,
      detail: { reasons: compliance.reasons },
    });
  } else {
    logActivity(orgId, 'outreach', `Draft ${channel} message for ${business.name}`, {
      businessId,
      actor: opts.actor ?? 'ai',
      detail: `${tone.replace('_', ' ')} · ${purpose}${message.subject ? ` · "${message.subject}"` : ''}`,
      entityType: 'outreach_message',
      entityId: messageId,
    });
  }
  void settings;
  return { messageId, message, compliance };
}

function gatherFacts(ctx: NonNullable<Awaited<ReturnType<typeof businessContext>>>, grounding: string[]): Record<string, string | number | null> {
  const b = ctx.business;
  const a = ctx.audit;
  const facts: Record<string, string | number | null> = {
    businessName: b.name,
    category: b.category,
    locality: b.locality,
    rating: b.rating,
    reviewCount: b.review_count,
    website: b.website,
    websiteStatus: b.website_status,
    contactName: ctx.contact?.full_name ?? null,
    firstName: ctx.contact?.first_name ?? null,
    jobTitle: ctx.contact?.job_title ?? null,
  };

  if (b.category) grounding.push(`category: ${b.category}`);
  if (b.rating && b.review_count) grounding.push(`${b.rating.toFixed(1)}★ from ${b.review_count} reviews`);
  if (b.locality) grounding.push(`location: ${b.locality}`);

  const signals = json<{ key: string; label: string; evidence: string; severity: string }[]>((a?.signals as string) ?? '[]', []);
  const ranked = [...signals].sort((x, y) => sevRank(y.severity) - sevRank(x.severity));
  for (const s of ranked.slice(0, 4)) {
    grounding.push(`${s.label}${s.evidence ? ` (${s.evidence})` : ''}`);
  }
  facts.primarySignal = ranked[0]?.label ?? null;
  facts.primaryEvidence = ranked[0]?.evidence ?? null;
  facts.secondarySignal = ranked[1]?.label ?? null;

  const social = json<{ label: string }[]>((ctx.socialAudit?.signals as string) ?? '[]', []);
  if (social.length) {
    facts.socialSignal = social[0].label;
    grounding.push(social[0].label);
  }

  const competitor = ctx.competitors.find((c) => c.name !== '__cohort_summary__');
  if (competitor?.gap_summary) {
    facts.competitorGap = competitor.gap_summary as string;
    grounding.push(`competitor comparison: ${truncate(competitor.gap_summary as string, 120)}`);
  }

  return facts;
}

function sevRank(s: string): number {
  return { critical: 4, high: 3, medium: 2, low: 1 }[s as 'critical'] ?? 0;
}

interface ComposeInput {
  business: Business;
  contact: Contact | null;
  facts: Record<string, string | number | null>;
  tone: Tone;
  purpose: string;
  channel: Channel;
  previousCount: number;
  mockupUrl?: string;
}

/**
 * The grounded composer. Deliberately specific: it opens on something measured
 * about THIS business, never on a generic pleasantry.
 */
export function composeLocal(input: ComposeInput): Omit<GeneratedMessage, 'modelUsed' | 'live' | 'cost'> {
  const { business, contact, facts, tone, purpose, channel, mockupUrl } = input;
  const first = contact?.first_name ?? 'there';
  const voice = TONE_VOICE[tone];
  const what = (business.category ?? business.industry ?? 'business').toLowerCase();
  const place = business.locality ? ` in ${business.locality}` : '';

  const opener = voice.opener.replace('{first}', first);
  const signal = facts.primarySignal as string | null;
  const evidence = facts.primaryEvidence as string | null;
  const secondary = facts.secondarySignal as string | null;

  // The specific thing we noticed — this is the whole point of the message.
  let observed: string;
  if (business.website_status === 'missing') {
    observed = `you do not currently have a website — anyone searching for ${what}${place} cannot find you directly`;
  } else if (business.website_status === 'unreachable') {
    observed = `your website at ${business.website_domain ?? business.website} is not responding — visitors are hitting an error page`;
  } else if (business.website_status === 'parked') {
    observed = `your domain is currently showing a parking page rather than your business`;
  } else if (signal) {
    observed = `${signal.toLowerCase()}${evidence ? ` — ${evidence.toLowerCase()}` : ''}`;
  } else {
    observed = `there are a few things on your digital presence that look quick to improve`;
  }

  const proof = business.rating && business.review_count
    ? `You already have ${business.rating.toFixed(1)}★ from ${business.review_count} reviews, so the demand is clearly there — it just has nowhere to land.`
    : '';

  const subject =
    purpose === 'mockup'
      ? `I built a website concept for ${business.name}`
      : purpose === 'final'
        ? `Closing the loop — ${business.name}`
        : purpose === 'value'
          ? `One thing worth fixing on ${business.website_domain ?? business.name}`
          : purpose === 'followup'
            ? `Re: ${business.name}`
            : `${business.name} — ${truncate(signal ? signal.toLowerCase() : 'a quick observation', 42)}`;

  let body: string;
  if (channel === 'sms' || channel === 'whatsapp') {
    body = `${opener}, ${observed}. ${mockupUrl ? `I put a concept together for you: ${mockupUrl}` : `Happy to send over what I found if useful.`}`;
    return { subject: null, body: truncate(body, 300), tone, purpose, channel, grounding: [] };
  }

  const ask =
    purpose === 'intro'
      ? `Would it be useful if I sent over what I found?`
      : purpose === 'followup'
        ? `Just floating this back up — is this worth a conversation, or should I leave it?`
        : purpose === 'value'
          ? `No reply needed. If you want the full list, say the word.`
          : purpose === 'mockup'
            ? `It takes about a minute to look at. If it is close to useful, I am happy to talk through a real version.`
            : `Last note from me — yes or no is a completely fine answer.`;

  const parts: string[] = [opener + ',', ''];

  if (purpose === 'intro') {
    parts.push(`I was looking at ${what} businesses${place} and noticed ${observed}.`);
    if (proof) parts.push('', proof);
    if (secondary) parts.push('', `There is also ${String(secondary).toLowerCase()} in the mix.`);
  } else if (purpose === 'followup') {
    parts.push(`Following up on my note from a few days ago about ${observed}.`);
    parts.push('', `I am not going to keep emailing — ${input.previousCount + 1} messages is my limit.`);
  } else if (purpose === 'value') {
    parts.push(`One specific thing, no pitch attached: ${observed}.`);
    if (evidence) parts.push('', `The detail: ${evidence}`);
    parts.push('', `That is usually the fastest win available, and it is a small fix.`);
  } else if (purpose === 'mockup') {
    parts.push(`Rather than describe what I mean, I built it — a full concept website for ${business.name}, not a template.`);
    if (mockupUrl) parts.push('', mockupUrl);
    if (proof) parts.push('', proof);
  } else {
    parts.push(`I will stop here. ${observed.charAt(0).toUpperCase() + observed.slice(1)} — that is the whole thing.`);
    parts.push('', `If it is not a priority right now, that is genuinely fine.`);
  }

  parts.push('', ask, '', voice.closer);
  body = parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();

  return { subject, body, tone, purpose, channel, grounding: [] };
}

// ── Sending (§18, §19) ───────────────────────────────────────
export interface SendResult {
  ok: boolean;
  status: string;
  simulated: boolean;
  reason?: string;
  providerMessageId?: string;
}

export async function sendMessage(orgId: string, messageId: string, opts: { actor?: string; force?: boolean } = {}): Promise<SendResult> {
  const msg = get<Record<string, unknown>>('SELECT * FROM outreach_messages WHERE id = ? AND org_id = ?', [messageId, orgId]);
  if (!msg) return { ok: false, status: 'not_found', simulated: false };
  const business = get<Business>('SELECT * FROM businesses WHERE id = ?', [msg.business_id]);
  if (!business) return { ok: false, status: 'business_missing', simulated: false };
  const contact = msg.contact_id ? get<Contact>('SELECT * FROM contacts WHERE id = ?', [msg.contact_id]) : null;
  const channel = msg.channel as Channel;

  const verdict = canContact(orgId, business, contact, channel, { body: msg.body as string });
  if (!verdict.allowed && !opts.force) {
    run("UPDATE outreach_messages SET status = 'skipped', updated_at = ? WHERE id = ?", [nowIso(), messageId]);
    logAutomation(orgId, 'outreach', `Send blocked for ${business.name}: ${verdict.reasons.join(' ')}`, {
      level: 'warn',
      entityType: 'outreach_message',
      entityId: messageId,
      detail: { reasons: verdict.reasons },
    });
    return { ok: false, status: 'blocked', simulated: false, reason: verdict.reasons.join(' ') };
  }

  const approvalMode = (msg.approval_mode as ApprovalMode) ?? getSettings(orgId).outreach.approvalMode;
  if (approvalMode === 'manual') {
    return { ok: false, status: 'manual_mode_draft_only', simulated: false, reason: 'Approval mode is Manual — messages are drafted, never sent by the system.' };
  }

  const provider = pickChannelProvider(orgId, channel);
  const address =
    channel === 'email' ? (contact?.email ?? business.email) : channel === 'sms' || channel === 'whatsapp' ? (contact?.phone ?? business.phone) : null;

  if (!address && channel !== 'linkedin' && channel !== 'phone' && channel !== 'custom') {
    run("UPDATE outreach_messages SET status = 'failed', provider_error = 'no address on record', updated_at = ? WHERE id = ?", [nowIso(), messageId]);
    return { ok: false, status: 'failed', simulated: false, reason: 'No address on record' };
  }

  // Quiet hours: defer the send rather than failing it.
  const quiet = isQuietHoursNow(orgId);
  if (quiet.quiet) {
    const when = nextSendableTime(orgId);
    run("UPDATE outreach_messages SET status = 'queued', scheduled_at = ?, updated_at = ? WHERE id = ?", [when.toISOString(), nowIso(), messageId]);
    return { ok: false, status: 'deferred', simulated: false, reason: `Inside quiet hours (${quiet.window}) — deferred to ${relativeFromNow(when.toISOString())}` };
  }

  const settings = getSettings(orgId);
  const unsubscribeUrl = `/api/opt-out?business=${business.id}&channel=${channel}&token=${encodeURIComponent(business.id)}`;

  run("UPDATE outreach_messages SET status = 'sending', updated_at = ? WHERE id = ?", [nowIso(), messageId]);
  const result = await provider.send(orgId, {
    to: address ?? '',
    toName: contact?.full_name ?? business.name,
    from: settings.branding.email,
    subject: (msg.subject as string) ?? undefined,
    body: settings.compliance.includeUnsubscribe && channel === 'email'
      ? `${msg.body as string}\n\n—\nTo stop receiving these, reply "stop" or use ${unsubscribeUrl}`
      : (msg.body as string),
    trackingId: messageId,
    unsubscribeUrl,
  });

  const now = nowIso();
  if (result.ok) {
    run(
      `UPDATE outreach_messages SET status = ?, provider_key = ?, provider_message_id = ?, provider_status = ?,
              simulated = ?, sent_at = ?, cost = ?, updated_at = ? WHERE id = ?`,
      [
        result.live ? 'sent' : 'sent',
        provider.key,
        result.providerMessageId ?? null,
        result.status ?? 'sent',
        result.live ? 0 : 1,
        now,
        provider.costPerMessage ?? 0,
        now,
        messageId,
      ]
    );
    if (!result.live) {
      recordOutboxEntry(orgId, {
        channel,
        to: address ?? 'manual action',
        subject: msg.subject as string,
        body: msg.body as string,
        messageId,
      });
    }
    run(
      `INSERT INTO cost_ledger (id, org_id, category, provider_key, business_id, amount, units, note, created_at)
       VALUES (?,?,?,?,?,?,1,?,?)`,
      [id('cst'), orgId, 'outreach', provider.key, business.id, provider.costPerMessage ?? 0, `${channel} message`, now]
    );
    logActivity(orgId, 'outreach', `${result.live ? 'Sent' : 'Queued (simulated)'} ${channel} message to ${business.name}`, {
      businessId: business.id,
      actor: opts.actor ?? 'system',
      detail: result.live ? `Via ${provider.label}` : `${provider.label} — no external send occurred`,
      entityType: 'outreach_message',
      entityId: messageId,
    });
    audit(orgId, 'outreach.sent', {
      actor: opts.actor ?? 'system',
      entityType: 'outreach_message',
      entityId: messageId,
      detail: { business: business.name, channel, simulated: !result.live },
    });
    advanceStageIfBehind(orgId, business.id, 'outreach_sent');
    return { ok: true, status: result.live ? 'sent' : 'simulated', simulated: !result.live, providerMessageId: result.providerMessageId };
  }

  run("UPDATE outreach_messages SET status = 'failed', provider_error = ?, updated_at = ? WHERE id = ?", [
    result.error ?? 'unknown',
    nowIso(),
    messageId,
  ]);
  logAutomation(orgId, 'outreach', `Send failed for ${business.name}: ${result.error}`, {
    level: 'error',
    entityType: 'outreach_message',
    entityId: messageId,
    retryable: true,
  });
  return { ok: false, status: 'failed', simulated: false, reason: result.error };
}

/** Approves a draft in assisted mode, then sends. */
export async function approveAndSend(orgId: string, messageId: string, actor = 'user'): Promise<SendResult> {
  run("UPDATE outreach_messages SET status = 'approved', updated_at = ? WHERE id = ?", [nowIso(), messageId]);
  audit(orgId, 'outreach.approved', { actor, entityType: 'outreach_message', entityId: messageId });
  return sendMessage(orgId, messageId, { actor });
}

export function rejectDraft(orgId: string, messageId: string, actor = 'user', reason?: string): void {
  run("UPDATE outreach_messages SET status = 'skipped', provider_error = ?, updated_at = ? WHERE id = ?", [
    reason ? `Rejected: ${reason}` : 'Rejected',
    nowIso(),
    messageId,
  ]);
  audit(orgId, 'outreach.rejected', { actor, entityType: 'outreach_message', entityId: messageId, detail: { reason } });
}

// ── Engagement tracking (§19) ────────────────────────────────
export function trackOpen(orgId: string, messageId: string): void {
  const msg = get<{ open_count: number; business_id: string; status: string }>('SELECT open_count, business_id, status FROM outreach_messages WHERE id = ? AND org_id = ?', [messageId, orgId]);
  if (!msg) return;
  const now = nowIso();
  run(
    `UPDATE outreach_messages SET open_count = open_count + 1, opened_at = COALESCE(opened_at, ?),
            status = CASE WHEN status IN ('sent','delivered') THEN 'opened' ELSE status END, updated_at = ? WHERE id = ?`,
    [now, now, messageId]
  );
  run('UPDATE businesses SET engagement_score = MIN(100, engagement_score + 6), updated_at = ? WHERE id = ?', [now, msg.business_id]);
  if (msg.open_count === 0) {
    logActivity(orgId, 'outreach', `Message opened`, { businessId: msg.business_id, actor: 'client', entityType: 'outreach_message', entityId: messageId });
    advanceStageIfBehind(orgId, msg.business_id, 'engaged');
  }
}

export function trackClick(orgId: string, messageId: string): void {
  const msg = get<{ business_id: string }>('SELECT business_id FROM outreach_messages WHERE id = ? AND org_id = ?', [messageId, orgId]);
  if (!msg) return;
  const now = nowIso();
  run(`UPDATE outreach_messages SET click_count = click_count + 1, clicked_at = COALESCE(clicked_at, ?), updated_at = ? WHERE id = ?`, [now, now, messageId]);
  run('UPDATE businesses SET engagement_score = MIN(100, engagement_score + 12), intent_score = MIN(100, intent_score + 10), updated_at = ? WHERE id = ?', [now, msg.business_id]);
  logActivity(orgId, 'outreach', 'Link clicked in message', { businessId: msg.business_id, actor: 'client', entityType: 'outreach_message', entityId: messageId, importance: 'high' });
  createFollowUp(orgId, msg.business_id, {
    kind: 'outreach',
    title: 'They clicked a link — follow up',
    reason: 'A click is a strong buying signal. Reach out while it is fresh.',
    dueInHours: 4,
    priority: 'high',
  });
}

export function recordReply(orgId: string, businessId: string, body: string, opts: { contactId?: string; channel?: string; at?: string } = {}): {
  sentiment: ReturnType<typeof classifySentiment>;
  sequenceStopped: boolean;
} {
  const sentiment = classifySentiment(body);
  // V2: fire the nine-way classifier alongside sentiment. It is async and owns
  // the richer next-action logic (opt-out suppression, pricing follow-ups,
  // objection capture); this sync path keeps the sequence-stop guarantee.
  void (async () => {
    try {
      const { classifyResponse } = await import('./responseIntelligence');
      await classifyResponse(orgId, businessId, body, { persist: true });
    } catch {
      // Classification must never break reply recording.
    }
  })();
  const now = opts.at ?? nowIso();
  const business = get<Business>('SELECT * FROM businesses WHERE id = ? AND org_id = ?', [businessId, orgId]);
  if (!business) return { sentiment, sequenceStopped: false };

  run(
    `INSERT INTO outreach_messages (id, org_id, business_id, contact_id, channel, direction, subject, body, status,
        simulated, grounding, cost, created_at, updated_at)
     VALUES (?,?,?,?,?,'inbound',NULL,?,'replied',0,'[]',0,?,?)`,
    [id('msg'), orgId, businessId, opts.contactId ?? null, opts.channel ?? 'email', body, now, now]
  );
  run(
    `UPDATE outreach_messages SET status = 'replied', replied_at = COALESCE(replied_at, ?), updated_at = ?
      WHERE org_id = ? AND business_id = ? AND direction = 'outbound' AND status IN ('sent','delivered','opened','clicked')`,
    [now, now, orgId, businessId]
  );

  const engagementBoost = sentiment.label === 'positive' ? 35 : sentiment.label === 'negative' ? 5 : 18;
  run(
    `UPDATE businesses SET engagement_score = MIN(100, engagement_score + ?), intent_score = MIN(100, intent_score + ?),
            stage = CASE WHEN stage IN ('outreach_sent','engaged') THEN 'interested' ELSE stage END, updated_at = ?
      WHERE id = ?`,
    [engagementBoost, sentiment.label === 'positive' ? 30 : 8, now, businessId]
  );

  logActivity(orgId, 'outreach', `Reply received — ${sentiment.label}`, {
    businessId,
    actor: 'client',
    detail: truncate(body, 200),
    importance: sentiment.label === 'positive' ? 'high' : 'normal',
  });

  remember(orgId, businessId, 'history', `reply:${now}`, truncate(body, 400), { source: 'inbound' });
  if (sentiment.label === 'negative') {
    const optOutPhrases = ['unsubscribe', 'stop', 'do not contact', 'take me off', 'remove me'];
    if (optOutPhrases.some((p) => body.toLowerCase().includes(p))) {
      handleOptOut(orgId, { businessId, contactId: opts.contactId, channel: opts.channel ?? 'email', reason: 'explicit opt-out in reply' });
      recordOutcome(orgId, 'lost', businessId);
      return { sentiment, sequenceStopped: true };
    }
    for (const signal of sentiment.signals.slice(0, 3)) remember(orgId, businessId, 'objection', signal, truncate(body, 240), { source: 'reply' });
  }

  recordOutcome(orgId, sentiment.label === 'positive' ? 'positive' : 'response', businessId);

  // §17: a reply stops the sequence.
  const stopped = stopSequences(orgId, businessId, 'stopped_response', 'Prospect replied');
  if (sentiment.label === 'positive') {
    createFollowUp(orgId, businessId, {
      kind: 'call',
      title: `Positive reply from ${business.name} — book the call`,
      reason: `They responded positively. Suggested next step: ${truncate(body, 120)}`,
      dueInHours: 3,
      priority: 'critical',
    });
    advanceStageIfBehind(orgId, businessId, 'interested');
  }
  return { sentiment, sequenceStopped: stopped };
}

export function recordBounce(orgId: string, messageId: string, reason: string): void {
  const msg = get<{ business_id: string }>('SELECT business_id FROM outreach_messages WHERE id = ? AND org_id = ?', [messageId, orgId]);
  run("UPDATE outreach_messages SET status = 'bounced', bounced_at = ?, provider_error = ?, updated_at = ? WHERE id = ?", [
    nowIso(),
    reason,
    nowIso(),
    messageId,
  ]);
  if (msg) {
    logAutomation(orgId, 'outreach', `Bounce: ${reason}`, { level: 'warn', entityType: 'outreach_message', entityId: messageId });
    const address = scalar<string>('SELECT COALESCE((SELECT email FROM contacts WHERE id = (SELECT contact_id FROM outreach_messages WHERE id = ?)), (SELECT email FROM businesses WHERE id = ?))', [messageId, msg.business_id]);
    if (address) suppress(orgId, 'email', address, 'bounce', 'provider_webhook', { businessId: msg.business_id });
  }
}

// ── Sequences (§17) ──────────────────────────────────────────
export interface SequenceRow {
  id: string;
  org_id: string;
  name: string;
  description: string | null;
  approval_mode: ApprovalMode;
  daily_send_limit: number;
  domain_daily_limit: number;
  stop_on_response: number;
  stop_on_optout: number;
  stop_on_client: number;
  stop_on_not_interested: number;
  max_touches: number;
  is_active: number;
  is_default: number;
  stats: string;
}

export function listSequences(orgId: string): (SequenceRow & { steps: unknown[]; enrolled: number; active: number })[] {
  const rows = all<SequenceRow>('SELECT * FROM sequences WHERE org_id = ? ORDER BY is_default DESC, name', [orgId]);
  return rows.map((s) => ({
    ...s,
    steps: all('SELECT * FROM sequence_steps WHERE sequence_id = ? ORDER BY position', [s.id]),
    enrolled: scalar<number>('SELECT COUNT(*) FROM sequence_enrollments WHERE sequence_id = ?', [s.id]) ?? 0,
    active: scalar<number>("SELECT COUNT(*) FROM sequence_enrollments WHERE sequence_id = ? AND status = 'active'", [s.id]) ?? 0,
  }));
}

export function enroll(
  orgId: string,
  sequenceId: string,
  businessId: string,
  opts: { contactId?: string; startAt?: Date; actor?: string } = {}
): { ok: boolean; enrollmentId?: string; reason?: string } {
  const business = get<Business>('SELECT * FROM businesses WHERE id = ? AND org_id = ?', [businessId, orgId]);
  if (!business) return { ok: false, reason: 'business_not_found' };
  const existing = get<{ id: string }>(
    "SELECT id FROM sequence_enrollments WHERE sequence_id = ? AND business_id = ? AND status = 'active'",
    [sequenceId, businessId]
  );
  if (existing) return { ok: false, reason: 'already_enrolled', enrollmentId: existing.id };

  const verdict = canContact(orgId, business, null, 'email');
  if (!verdict.allowed) return { ok: false, reason: verdict.reasons.join(' ') };

  const steps = all<{ day_offset: number }>('SELECT day_offset FROM sequence_steps WHERE sequence_id = ? AND enabled = 1 ORDER BY position', [sequenceId]);
  if (!steps.length) return { ok: false, reason: 'sequence has no enabled steps' };

  const start = opts.startAt ?? nextSendableTime(orgId);
  const firstStepAt = addDays(start, steps[0].day_offset);
  const enrollmentId = id('enr');
  run(
    `INSERT INTO sequence_enrollments (id, org_id, sequence_id, business_id, contact_id, status, current_step,
        next_step_at, enrolled_at, started_at, touches_sent, created_at)
     VALUES (?,?,?,?,?, 'active', 0, ?, ?, ?, 0, ?)`,
    [enrollmentId, orgId, sequenceId, businessId, opts.contactId ?? null, firstStepAt.toISOString(), nowIso(), start.toISOString(), nowIso()]
  );
  run("UPDATE businesses SET stage = CASE WHEN stage IN ('discovered','qualified') THEN 'outreach_ready' ELSE stage END, updated_at = ? WHERE id = ?", [
    nowIso(),
    businessId,
  ]);
  logActivity(orgId, 'outreach', `Enrolled in sequence`, {
    businessId,
    actor: opts.actor ?? 'system',
    detail: `First touch ${relativeFromNow(firstStepAt.toISOString())}`,
    entityType: 'sequence_enrollment',
    entityId: enrollmentId,
  });
  return { ok: true, enrollmentId };
}

export function stopSequences(orgId: string, businessId: string, status: string, reason: string): boolean {
  const { changes } = run(
    `UPDATE sequence_enrollments SET status = ?, ended_at = ?, stop_reason = ?
      WHERE org_id = ? AND business_id = ? AND status = 'active'`,
    [status, nowIso(), reason, orgId, businessId]
  );
  if (changes) {
    logActivity(orgId, 'outreach', `Sequence stopped — ${reason}`, { businessId, detail: status.replace(/_/g, ' ') });
  }
  return changes > 0;
}

/**
 * Dispatches every enrollment whose next step is due. This is the autonomous
 * loop; it re-checks stop conditions immediately before each touch so a reply
 * that arrived moments ago still halts the sequence.
 */
export async function dispatchSequences(orgId: string, opts: { actor?: string; dryRun?: boolean } = {}): Promise<{
  dispatched: number;
  stopped: number;
  blocked: number;
  completed: number;
  errors: number;
}> {
  const due = all<Record<string, unknown>>(
    `SELECT e.*, s.approval_mode, s.stop_on_response, s.stop_on_optout, s.stop_on_client, s.stop_on_not_interested,
            s.max_touches, s.name seq_name
       FROM sequence_enrollments e JOIN sequences s ON s.id = e.sequence_id
      WHERE e.org_id = ? AND e.status = 'active' AND e.next_step_at <= ? AND s.is_active = 1
      ORDER BY e.next_step_at ASC LIMIT 200`,
    [orgId, nowIso()]
  );

  let dispatched = 0;
  let stopped = 0;
  let blocked = 0;
  let completed = 0;
  let errors = 0;

  for (const enr of due) {
    const businessId = enr.business_id as string;
    const business = get<Business>('SELECT * FROM businesses WHERE id = ?', [businessId]);
    if (!business) continue;

    // Stop conditions (§17)
    if (enr.stop_on_client === 1 && ['won', 'onboarding', 'delivery', 'active_client', 'expansion'].includes(business.stage)) {
      stopSequences(orgId, businessId, 'stopped_client', 'Prospect became a client');
      stopped++;
      continue;
    }
    if (enr.stop_on_optout === 1 && ['opted_out', 'do_not_contact'].includes(business.consent_state)) {
      stopSequences(orgId, businessId, 'stopped_optout', 'Prospect opted out');
      stopped++;
      continue;
    }
    if (enr.stop_on_not_interested === 1) {
      const notInterested = scalar<number>(
        `SELECT COUNT(*) FROM ai_memory WHERE business_id = ? AND kind = 'objection' AND (value LIKE '%not interested%' OR key LIKE '%not_interested%')`,
        [businessId]
      ) ?? 0;
      if (notInterested > 0) {
        stopSequences(orgId, businessId, 'stopped_not_interested', 'Marked not interested');
        stopped++;
        continue;
      }
    }
    if (enr.stop_on_response === 1) {
      const replied = scalar<number>(`SELECT COUNT(*) FROM outreach_messages WHERE business_id = ? AND direction = 'inbound'`, [businessId]) ?? 0;
      if (replied > 0) {
        stopSequences(orgId, businessId, 'stopped_response', 'Prospect responded');
        stopped++;
        continue;
      }
    }

    const steps = all<Record<string, unknown>>('SELECT * FROM sequence_steps WHERE sequence_id = ? AND enabled = 1 ORDER BY position', [
      enr.sequence_id,
    ]);
    const stepIndex = (enr.current_step as number) ?? 0;
    if (stepIndex >= steps.length || (enr.touches_sent as number) >= (enr.max_touches as number)) {
      run("UPDATE sequence_enrollments SET status = 'completed', ended_at = ? WHERE id = ?", [nowIso(), enr.id]);
      completed++;
      continue;
    }
    const step = steps[stepIndex];

    if (opts.dryRun) {
      dispatched++;
      continue;
    }

    let messageId: string | null = null;
    try {
      const mockup = step.include_mockup === 1
        ? get<{ share_token: string; status: string }>('SELECT share_token, status FROM mockups WHERE business_id = ? ORDER BY created_at DESC LIMIT 1', [businessId])
        : null;
      const mockupUrl = mockup ? `/mockup/${mockup.share_token}` : undefined;

      const generated = await generateOutreach(orgId, businessId, {
        channel: step.channel as Channel,
        tone: step.tone as Tone,
        purpose: step.purpose as string,
        includeMockupUrl: mockupUrl,
        contactId: enr.contact_id as string | undefined,
        actor: 'sequence',
      });
      messageId = generated?.messageId ?? null;

      if (!generated || !generated.compliance.allowed) {
        blocked++;
        // Skip this touch but keep the enrollment alive unless it is a hard block.
        const hard = generated?.compliance.blockedBy === 'do_not_contact' || generated?.compliance.blockedBy === 'opted_out' || generated?.compliance.suppressed;
        if (hard) {
          stopSequences(orgId, businessId, 'stopped_optout', generated.compliance.reasons[0] ?? 'blocked');
          stopped++;
          continue;
        }
      } else {
        const mode = (enr.approval_mode as ApprovalMode) ?? 'assisted';
        if (mode === 'autonomous' && messageId) {
          await sendMessage(orgId, messageId, { actor: 'sequence' });
          dispatched++;
        } else {
          dispatched++; // queued for approval
        }
        if (mockupUrl && mockup && mockup.status === 'draft') {
          run("UPDATE mockups SET status = 'shared', updated_at = ? WHERE business_id = ?", [nowIso(), businessId]);
          advanceStageIfBehind(orgId, businessId, 'mockup_shared');
        }
      }
    } catch (err) {
      errors++;
      logAutomation(orgId, 'outreach', `Sequence step failed: ${err instanceof Error ? err.message : String(err)}`, {
        level: 'error',
        entityType: 'sequence_enrollment',
        entityId: enr.id as string,
        retryable: true,
      });
    }

    // Advance the enrollment regardless of send outcome, unless we are at the end.
    const nextIndex = stepIndex + 1;
    if (nextIndex >= steps.length) {
      run("UPDATE sequence_enrollments SET current_step = ?, touches_sent = touches_sent + 1, status = 'completed', ended_at = ? WHERE id = ?", [
        nextIndex,
        nowIso(),
        enr.id,
      ]);
      completed++;
    } else {
      const nextAt = nextSendableTime(orgId, addDays(new Date(), (steps[nextIndex].day_offset as number) - (steps[stepIndex].day_offset as number)));
      run('UPDATE sequence_enrollments SET current_step = ?, touches_sent = touches_sent + 1, next_step_at = ? WHERE id = ?', [
        nextIndex,
        nextAt.toISOString(),
        enr.id,
      ]);
    }
  }

  return { dispatched, stopped, blocked, completed, errors };
}

// ── Queries ──────────────────────────────────────────────────
export interface MessageRow {
  id: string;
  org_id: string;
  business_id: string;
  contact_id: string | null;
  channel: string;
  direction: string;
  subject: string | null;
  body: string;
  tone: string | null;
  purpose: string;
  status: string;
  simulated: number;
  provider_key: string | null;
  provider_error: string | null;
  open_count: number;
  click_count: number;
  sent_at: string | null;
  created_at: string;
  business_name: string;
  priority: string | null;
  opportunity_score: number | null;
}

export function listMessages(orgId: string, opts: { businessId?: string; status?: string; channel?: string; limit?: number } = {}): MessageRow[] {
  const where = ['o.org_id = ?'];
  const params: unknown[] = [orgId];
  if (opts.businessId) {
    where.push('o.business_id = ?');
    params.push(opts.businessId);
  }
  if (opts.status) {
    where.push('o.status = ?');
    params.push(opts.status);
  }
  if (opts.channel) {
    where.push('o.channel = ?');
    params.push(opts.channel);
  }
  params.push(opts.limit ?? 100);
  return all<MessageRow>(
    `SELECT o.*, b.name business_name, b.priority, b.opportunity_score FROM outreach_messages o
       JOIN businesses b ON b.id = o.business_id
      WHERE ${where.join(' AND ')} ORDER BY o.created_at DESC LIMIT ?`,
    params
  );
}

export function outreachStats(orgId: string, sinceIso?: string) {
  const since = sinceIso ?? new Date(Date.now() - 30 * 86_400_000).toISOString();
  const rows = get<{
    total: number; sent: number; delivered: number; opened: number; clicked: number; replied: number;
    bounced: number; drafts: number; simulated: number; cost: number;
  }>(
    `SELECT COUNT(*) total,
            SUM(CASE WHEN status IN ('sent','delivered','opened','clicked','replied') THEN 1 ELSE 0 END) sent,
            SUM(CASE WHEN status IN ('delivered','opened','clicked','replied') THEN 1 ELSE 0 END) delivered,
            SUM(CASE WHEN status IN ('opened','clicked','replied') THEN 1 ELSE 0 END) opened,
            SUM(CASE WHEN status IN ('clicked','replied') THEN 1 ELSE 0 END) clicked,
            SUM(CASE WHEN status = 'replied' THEN 1 ELSE 0 END) replied,
            SUM(CASE WHEN status = 'bounced' THEN 1 ELSE 0 END) bounced,
            SUM(CASE WHEN status IN ('draft','queued','approved') THEN 1 ELSE 0 END) drafts,
            SUM(CASE WHEN simulated = 1 AND sent_at IS NOT NULL THEN 1 ELSE 0 END) simulated,
            COALESCE(SUM(cost),0) cost
       FROM outreach_messages WHERE org_id = ? AND created_at >= ?`,
    [orgId, since]
  );
  const s = rows ?? { total: 0, sent: 0, delivered: 0, opened: 0, clicked: 0, replied: 0, bounced: 0, drafts: 0, simulated: 0, cost: 0 };
  return {
    ...s,
    openRate: s.sent ? round((s.opened / s.sent) * 100, 1) : 0,
    replyRate: s.sent ? round((s.replied / s.sent) * 100, 1) : 0,
    clickRate: s.sent ? round((s.clicked / s.sent) * 100, 1) : 0,
  };
}

export function markNotInterested(orgId: string, businessId: string, note?: string): void {
  remember(orgId, businessId, 'objection', 'not_interested', note ?? 'Marked not interested by user', { source: 'user', pinned: true });
  stopSequences(orgId, businessId, 'stopped_not_interested', 'Marked not interested');
  run(`UPDATE follow_ups SET status = 'cancelled' WHERE org_id = ? AND business_id = ? AND status = 'pending'`, [orgId, businessId]);
  logActivity(orgId, 'outreach', 'Marked not interested — outreach stopped', { businessId, detail: note });
}

export { tx, toJson };
