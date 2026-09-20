/**
 * CRM delivery layer: calls (§28, §29), proposals (§30, §31), client
 * conversion (§32), projects (§33), deployment (§34) and recurring revenue (§35).
 *
 * Conversion rule (§32): winning a deal converts the *existing* business row
 * into a client. `clients.business_id` is UNIQUE, so a duplicate client is
 * structurally impossible.
 */
import { all, get, json, run, scalar, toJson, tx } from '@/db';
import { id, nowIso, round, slugify, stableHash } from '@/lib/id';
import { addDays } from '@/lib/time';
import { logActivity } from '@/lib/activity';
import { audit, logAutomation } from '@/lib/logging';
import { getSettings } from '@/lib/settings';
import { runAiTask } from '@/lib/ai/router';
import { businessContext, contextPrompt, remember } from '@/lib/ai/memory';
import { bulletize } from '@/lib/ai/local';
import { getBusiness, updateBusiness, type Business } from '@/repo/business';
import { getHostingProvider, getPaymentProvider } from '@/lib/providers/registry';
import { advanceStageIfBehind } from './mockup';
import { recordOutcome } from './scoring';
import { computeSalesIntelligence } from './nba';
import {
  PROJECT_STAGE_LABELS,
  PROJECT_STAGE_PROGRESS,
  STAGE_LABELS,
  type ProjectStage,
  type PipelineStage,
} from '@/lib/domain';

// ═════════════════════════════════════════════════════════════
// CALLS (§28)
// ═════════════════════════════════════════════════════════════
export interface CallRow {
  id: string;
  org_id: string;
  business_id: string;
  contact_id: string | null;
  title: string;
  scheduled_at: string | null;
  duration_min: number;
  meeting_link: string | null;
  status: string;
  agenda: string;
  raw_notes: string | null;
  ai_summary: string | null;
  requirements: string;
  scope: string;
  budget: string | null;
  decision_maker: string | null;
  objections: string;
  next_steps: string;
  outcome: string | null;
  completed_at: string | null;
  created_at: string;
}

export function scheduleCall(
  orgId: string,
  businessId: string,
  data: {
    title?: string;
    scheduledAt: string;
    durationMin?: number;
    contactId?: string;
    attendees?: string[];
    agenda?: string[];
    meetingLink?: string;
    actor?: string;
  }
): CallRow {
  const business = getBusiness(orgId, businessId);
  if (!business) throw new Error('business_not_found');
  const callId = id('cal');
  const now = nowIso();
  run(
    `INSERT INTO calls (id, org_id, business_id, contact_id, title, scheduled_at, duration_min, meeting_link,
        location, status, attendees, agenda, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,NULL,'scheduled',?,?,?,?)`,
    [
      callId, orgId, businessId, data.contactId ?? null,
      data.title ?? `Discovery call — ${business.name}`,
      data.scheduledAt, data.durationMin ?? 30, data.meetingLink ?? null,
      toJson(data.attendees ?? []), toJson(data.agenda ?? defaultAgenda()), now, now,
    ]
  );
  logActivity(orgId, 'call', `Call scheduled with ${business.name}`, {
    businessId,
    actor: data.actor ?? 'user',
    detail: new Date(data.scheduledAt).toUTCString(),
    entityType: 'call',
    entityId: callId,
    importance: 'high',
  });
  advanceStageIfBehind(orgId, businessId, 'call_scheduled');
  return get<CallRow>('SELECT * FROM calls WHERE id = ?', [callId]) as CallRow;
}

function defaultAgenda(): string[] {
  return [
    'What they need and why now',
    'Current website and social performance',
    'Budget range and decision process',
    'Timeline and who signs off',
    'Next step and who owns it',
  ];
}

export function addCallNote(orgId: string, callId: string, body: string, kind = 'note', author = 'user'): void {
  run('INSERT INTO call_notes (id, call_id, author, body, kind, created_at) VALUES (?,?,?,?,?,?)', [
    id('cno'),
    callId,
    author,
    body,
    kind,
    nowIso(),
  ]);
  const call = get<{ business_id: string; raw_notes: string | null }>('SELECT business_id, raw_notes FROM calls WHERE id = ?', [callId]);
  if (call) {
    run('UPDATE calls SET raw_notes = ?, updated_at = ? WHERE id = ?', [
      [call.raw_notes, body].filter(Boolean).join('\n\n'),
      nowIso(),
      callId,
    ]);
  }
  void orgId;
}

export interface CallSummary {
  summary: string;
  requirements: string[];
  scope: string[];
  objections: string[];
  nextSteps: string[];
  budget: string | null;
  decisionMaker: string | null;
  outcome: 'positive' | 'neutral' | 'negative' | 'no_show';
}

/**
 * Summarises call notes and derives requirements → scope (§28). The AI layer
 * extracts; it does not invent commitments that are not in the notes.
 */
export async function summarizeCall(orgId: string, callId: string, opts: { outcome?: CallSummary['outcome'] } = {}): Promise<CallSummary> {
  const call = get<CallRow & { business_id: string }>('SELECT * FROM calls WHERE id = ? AND org_id = ?', [callId, orgId]);
  if (!call) throw new Error('call_not_found');
  const business = getBusiness(orgId, call.business_id);
  const notes = all<{ body: string; kind: string; author: string }>('SELECT * FROM call_notes WHERE call_id = ? ORDER BY created_at', [callId]);
  const rawNotes = notes.map((n) => `[${n.kind}] ${n.body}`).join('\n') || call.raw_notes || '';

  if (!rawNotes.trim()) {
    return {
      summary: 'No notes were recorded for this call.',
      requirements: [],
      scope: [],
      objections: [],
      nextSteps: [],
      budget: null,
      decisionMaker: null,
      outcome: opts.outcome ?? 'neutral',
    };
  }

  const ctx = businessContext(orgId, call.business_id);
  const res = await runAiTask(
    orgId,
    'call_summary',
    {
      task: 'call_summary',
      system: [
        'You summarise sales call notes into a structured record.',
        'Only report what the notes actually say. If something was not discussed, leave it empty.',
        'Return JSON: {"summary":string,"requirements":string[],"scope":string[],"objections":string[],"nextSteps":string[],"budget":string|null,"decisionMaker":string|null,"outcome":"positive|neutral|negative"}',
      ].join('\n'),
      prompt: `${ctx ? contextPrompt(ctx) : ''}\n\n## Business\n${business?.name ?? ''} — ${business?.category ?? ''}\n\n## Raw notes\n${rawNotes}`,
      json: true,
      maxTokens: 800,
    },
    { entityType: 'call', entityId: callId }
  );

  const parsed = (res.json ?? {}) as Partial<CallSummary>;
  const summary: CallSummary = {
    summary: parsed.summary?.trim() || bulletize(rawNotes, 4).join(' '),
    requirements: parsed.requirements?.length ? parsed.requirements : notes.filter((n) => n.kind === 'requirement').map((n) => n.body),
    scope: parsed.scope?.length ? parsed.scope : [],
    objections: parsed.objections?.length ? parsed.objections : notes.filter((n) => n.kind === 'objection').map((n) => n.body),
    nextSteps: parsed.nextSteps?.length ? parsed.nextSteps : notes.filter((n) => n.kind === 'next_step').map((n) => n.body),
    budget: parsed.budget ?? null,
    decisionMaker: parsed.decisionMaker ?? null,
    outcome: opts.outcome ?? parsed.outcome ?? 'neutral',
  };

  const now = nowIso();
  run(
    `UPDATE calls SET ai_summary = ?, requirements = ?, scope = ?, objections = ?, next_steps = ?, budget = ?,
            decision_maker = ?, outcome = ?, status = 'completed', completed_at = ?, cost = ?, updated_at = ?
      WHERE id = ?`,
    [
      summary.summary, toJson(summary.requirements), toJson(summary.scope), toJson(summary.objections),
      toJson(summary.nextSteps), summary.budget, summary.decisionMaker, summary.outcome, now, res.cost, now, callId,
    ]
  );

  logActivity(orgId, 'call', `Call completed with ${business?.name ?? 'prospect'} — ${summary.outcome}`, {
    businessId: call.business_id,
    actor: 'ai',
    detail: summary.summary.slice(0, 160),
    entityType: 'call',
    entityId: callId,
    importance: summary.outcome === 'positive' ? 'high' : 'normal',
  });

  // Persist durable facts into memory (§44).
  for (const o of summary.objections) remember(orgId, call.business_id, 'objection', `call:${now}`, o, { source: 'call' });
  if (summary.budget) remember(orgId, call.business_id, 'fact', 'budget', summary.budget, { source: 'call' });
  if (summary.decisionMaker) remember(orgId, call.business_id, 'fact', 'decision_maker', summary.decisionMaker, { source: 'call' });
  for (const r of summary.requirements) remember(orgId, call.business_id, 'commitment', `requirement:${stableHash(r)}`, r, { source: 'call' });

  advanceStageIfBehind(orgId, call.business_id, 'call_completed');
  if (summary.outcome === 'positive') recordOutcome(orgId, 'call', call.business_id);

  return summary;
}

export function completeCall(orgId: string, callId: string, outcome: CallSummary['outcome']): void {
  run("UPDATE calls SET status = ?, outcome = ?, completed_at = ?, updated_at = ? WHERE id = ?", [
    outcome === 'no_show' ? 'no_show' : 'completed',
    outcome,
    nowIso(),
    nowIso(),
    callId,
  ]);
  const call = get<{ business_id: string }>('SELECT business_id FROM calls WHERE id = ?', [callId]);
  if (call) advanceStageIfBehind(orgId, call.business_id, 'call_completed');
  void orgId;
}

export function cancelCall(orgId: string, callId: string): void {
  run("UPDATE calls SET status = 'cancelled', updated_at = ? WHERE id = ?", [nowIso(), callId]);
  void orgId;
}

export function listCalls(orgId: string, opts: { businessId?: string; status?: string; upcoming?: boolean; limit?: number } = {}) {
  const where = ['c.org_id = ?'];
  const params: unknown[] = [orgId];
  if (opts.businessId) {
    where.push('c.business_id = ?');
    params.push(opts.businessId);
  }
  if (opts.status) {
    where.push('c.status = ?');
    params.push(opts.status);
  }
  if (opts.upcoming) {
    where.push("c.status = 'scheduled' AND c.scheduled_at >= ?");
    params.push(nowIso());
  }
  params.push(opts.limit ?? 100);
  return all<CallRow & { business_name: string; priority: string; opportunity_score: number | null }>(
    `SELECT c.*, b.name business_name, b.priority, b.opportunity_score FROM calls c
       JOIN businesses b ON b.id = c.business_id
      WHERE ${where.join(' AND ')}
      ORDER BY (c.scheduled_at IS NULL), c.scheduled_at ${opts.upcoming ? 'ASC' : 'DESC'} LIMIT ?`,
    params
  );
}

// ── Call briefing (§29) ──────────────────────────────────────
export interface CallBriefing {
  businessOverview: string;
  digitalProblems: string[];
  opportunity: string;
  likelyNeeds: string[];
  opening: string;
  questions: string[];
  objections: string[];
  recommendedPackage: string | null;
  priceRange: string;
  callGoal: string;
}

export async function generateCallBriefing(orgId: string, businessId: string, callId?: string): Promise<CallBriefing & { id: string }> {
  const ctx = businessContext(orgId, businessId);
  if (!ctx) throw new Error('business_not_found');
  const b = ctx.business;
  const si = computeSalesIntelligence(orgId, businessId);
  const pkg = b.recommended_package_id
    ? get<{ name: string; one_time_price: number; monthly_price: number }>('SELECT name, one_time_price, monthly_price FROM service_packages WHERE id = ?', [b.recommended_package_id])
    : get<{ name: string; one_time_price: number; monthly_price: number }>(
        "SELECT name, one_time_price, monthly_price FROM service_packages WHERE org_id = ? AND is_active = 1 ORDER BY one_time_price ASC LIMIT 1",
        [orgId]
      );

  const priceRange = pkg
    ? `$${round(pkg.one_time_price * 0.85, 0)}–$${round(pkg.one_time_price * 1.25, 0)} upfront${pkg.monthly_price ? `, $${round(pkg.monthly_price * 0.85, 0)}–$${round(pkg.monthly_price * 1.2, 0)}/month` : ''}`
    : 'Not yet determined — establish budget on the call.';

  const digitalProblems = ctx.signals.slice(0, 6);
  const likelyNeeds = deriveLikelyNeeds(ctx);
  const knownObjections = ctx.objections.slice(0, 4);

  const res = await runAiTask(
    orgId,
    'call_summary',
    {
      task: 'call_summary',
      system: [
        'You prepare a sales call briefing.',
        'Use only the supplied business record. Do not invent facts about the business.',
        'Return JSON with keys: businessOverview, opportunity, opening, questions (array of 5), objections (array of 3).',
      ].join('\n'),
      prompt: `${contextPrompt(ctx)}\n\n## Context\nClose probability ${si?.closeProbability ?? 0}%, engagement ${si?.engagementScore ?? 0}/100. Recommended package: ${pkg?.name ?? 'none'}. Price range: ${priceRange}.`,
      json: true,
      maxTokens: 900,
    },
    { entityType: 'business', entityId: businessId }
  );
  const parsed = (res.json ?? {}) as Partial<CallBriefing>;

  const briefing: CallBriefing = {
    businessOverview:
      parsed.businessOverview?.trim() ||
      `${b.name}${b.category ? ` is a ${b.category.toLowerCase()}` : ''}${b.locality ? ` in ${b.locality}` : ''}.` +
        (b.rating && b.review_count ? ` They hold ${b.rating.toFixed(1)}★ from ${b.review_count} reviews.` : '') +
        (b.website ? ` Website status: ${b.website_status}.` : ' No website on record.'),
    digitalProblems,
    opportunity:
      parsed.opportunity?.trim() ||
      (digitalProblems.length
        ? `The measurable gaps are ${digitalProblems.slice(0, 3).map((d) => d.toLowerCase()).join(', ')}. Closing these is the opportunity.`
        : 'No measured gaps on record — establish current performance on the call.'),
    likelyNeeds,
    opening:
      parsed.opening?.trim() ||
      `Thanks for making time. Before we talk about us — I looked at ${b.name} properly before this call, and there are a couple of specific things I noticed. Can I walk you through what I found?`,
    questions:
      parsed.questions?.length === 5
        ? parsed.questions
        : [
            'How are customers finding you at the moment?',
            'What happens between someone finding you and actually booking or buying?',
            'Who else is involved in a decision like this?',
            'What would need to be true for this to be worth doing this quarter?',
            'If we could fix one thing first, which would matter most to you?',
          ],
    objections: [
      ...knownObjections,
      ...(parsed.objections ?? []),
      ...[
        'We already have someone who handles this.',
        'It is not in the budget right now.',
        'We tried a website before and it did not do anything.',
      ],
    ].slice(0, 5),
    recommendedPackage: pkg?.name ?? null,
    priceRange,
    callGoal:
      b.stage === 'proposal_sent' || b.stage === 'negotiation'
        ? 'Agree the scope and get a signature date.'
        : 'Leave with a specific problem they agree is worth fixing, and a time to present the proposal.',
  };

  const briefingId = id('brf');
  run(
    `INSERT INTO call_briefings (id, org_id, call_id, business_id, business_overview, digital_problems, opportunity,
        likely_needs, opening, questions, objections, recommended_package, price_range, call_goal, cost, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      briefingId, orgId, callId ?? null, businessId, briefing.businessOverview, toJson(briefing.digitalProblems),
      briefing.opportunity, toJson(briefing.likelyNeeds), briefing.opening, toJson(briefing.questions),
      toJson(briefing.objections), briefing.recommendedPackage, briefing.priceRange, briefing.callGoal,
      res.cost, nowIso(),
    ]
  );
  if (callId) run('UPDATE calls SET briefing_id = ?, updated_at = ? WHERE id = ?', [briefingId, nowIso(), callId]);

  logActivity(orgId, 'call', `Call briefing generated for ${b.name}`, { businessId, actor: 'ai', entityType: 'call_briefing', entityId: briefingId });
  return { ...briefing, id: briefingId };
}

function deriveLikelyNeeds(ctx: NonNullable<Awaited<ReturnType<typeof businessContext>>>): string[] {
  const needs: string[] = [];
  const b = ctx.business;
  if (b.website_status === 'missing' || b.website_status === 'unreachable' || b.website_status === 'parked') needs.push('A working website with a clear enquiry route');
  if (ctx.signals.some((s) => s.toLowerCase().includes('mobile'))) needs.push('A site that works properly on phones');
  if (ctx.signals.some((s) => s.toLowerCase().includes('booking'))) needs.push('Online booking or quote requests');
  if (ctx.signals.some((s) => s.toLowerCase().includes('seo') || s.toLowerCase().includes('metadata'))) needs.push('To be findable in local search');
  if (ctx.signals.some((s) => s.toLowerCase().includes('social'))) needs.push('A consistent social presence');
  if (ctx.signals.some((s) => s.toLowerCase().includes('testimonial') || s.toLowerCase().includes('proof'))) needs.push('Reviews surfaced where prospects actually see them');
  if (!needs.length) needs.push('Establish current performance before scoping anything');
  return needs.slice(0, 6);
}

export function listBriefings(orgId: string, businessId?: string) {
  return businessId
    ? all('SELECT * FROM call_briefings WHERE org_id = ? AND business_id = ? ORDER BY created_at DESC', [orgId, businessId])
    : all('SELECT * FROM call_briefings WHERE org_id = ? ORDER BY created_at DESC LIMIT 100', [orgId]);
}

// ═════════════════════════════════════════════════════════════
// PROPOSALS (§30, §31)
// ═════════════════════════════════════════════════════════════
export interface ProposalRow {
  id: string;
  org_id: string;
  business_id: string;
  call_id: string | null;
  number: string;
  title: string;
  status: string;
  slug: string;
  problem: string | null;
  solution: string | null;
  scope: string;
  deliverables: string;
  timeline: string | null;
  timeline_weeks: number | null;
  subtotal: number;
  discount_pct: number;
  tax_pct: number;
  total: number;
  currency: string;
  optional_services: string;
  recurring_total: number;
  terms: string;
  next_steps: string;
  validity_days: number;
  view_count: number;
  first_viewed_at: string | null;
  last_viewed_at: string | null;
  sent_at: string | null;
  responded_at: string | null;
  response_note: string | null;
  signature_provider: string | null;
  signature_status: string;
  signature_payload: string | null;
  payment_provider: string | null;
  payment_status: string;
  deposit_amount: number | null;
  deposit_status: string;
  created_at: string;
  updated_at: string;
}

export async function generateProposal(
  orgId: string,
  businessId: string,
  opts: { callId?: string; packageIds?: string[]; discountPct?: number; actor?: string } = {}
): Promise<ProposalRow> {
  const ctx = businessContext(orgId, businessId);
  if (!ctx) throw new Error('business_not_found');
  const b = ctx.business;
  const settings = getSettings(orgId);

  const call = opts.callId
    ? get<CallRow>('SELECT * FROM calls WHERE id = ?', [opts.callId])
    : get<CallRow>("SELECT * FROM calls WHERE business_id = ? AND status = 'completed' ORDER BY completed_at DESC LIMIT 1", [businessId]);

  const packages = (opts.packageIds?.length
    ? all<Record<string, unknown>>(
        `SELECT * FROM service_packages WHERE org_id = ? AND id IN (${opts.packageIds.map(() => '?').join(',')})`,
        [orgId, ...opts.packageIds]
      )
    : b.recommended_package_id
      ? all<Record<string, unknown>>('SELECT * FROM service_packages WHERE id = ?', [b.recommended_package_id])
      : all<Record<string, unknown>>("SELECT * FROM service_packages WHERE org_id = ? AND is_active = 1 ORDER BY one_time_price DESC LIMIT 1", [orgId]));

  const requirements = call ? json<string[]>(call.requirements, []) : [];
  const signals = ctx.signals.slice(0, 6);

  const res = await runAiTask(
    orgId,
    'proposal',
    {
      task: 'proposal',
      system: [
        'You write the narrative sections of a proposal.',
        'Base the problem statement only on measured findings and stated requirements supplied to you.',
        'Do not promise specific traffic, ranking or revenue outcomes.',
        'Return JSON: {"problem":string,"solution":string,"timeline":string,"nextSteps":string[]}',
      ].join('\n'),
      prompt: [
        contextPrompt(ctx),
        '',
        '## Requirements from the call',
        requirements.length ? requirements.map((r) => `- ${r}`).join('\n') : '(none recorded)',
        '',
        '## Proposed packages',
        packages.map((p) => `- ${p.name}: ${p.summary ?? ''} ($${p.one_time_price} + $${p.monthly_price}/mo, ${p.timeline_weeks} weeks)`).join('\n'),
        '',
        '## Measured findings',
        signals.map((s) => `- ${s}`).join('\n') || '(none)',
      ].join('\n'),
      json: true,
      maxTokens: 900,
    },
    { entityType: 'business', entityId: businessId }
  );
  const parsed = (res.json ?? {}) as Partial<{ problem: string; solution: string; timeline: string; nextSteps: string[] }>;

  const problem =
    parsed.problem?.trim() ||
    (signals.length
      ? `${b.name} currently has ${signals.slice(0, 3).map((s) => s.toLowerCase()).join(', ')}. ${
          b.rating && b.review_count
            ? `With ${b.rating.toFixed(1)}★ from ${b.review_count} reviews the demand clearly exists — the gap is in how that demand is captured online.`
            : 'This limits how many of the customers already looking for this service can find and contact them.'
        }`
      : `We did not measure specific gaps for ${b.name}. This proposal is scoped from the requirements discussed rather than from an audit.`);

  const solution =
    parsed.solution?.trim() ||
    `We rebuild the digital route from discovery to enquiry: ${packages.map((p) => p.name).join(', ')}. Everything is measured against the findings above, and progress is reported monthly.`;

  const timelineWeeks = packages.reduce((a, p) => Math.max(a, (p.timeline_weeks as number) ?? 4), 4);
  const timeline = parsed.timeline?.trim() || `${timelineWeeks} weeks from kickoff to launch, then ongoing monthly.`;

  const subtotal = packages.reduce((a, p) => a + ((p.one_time_price as number) ?? 0), 0);
  const recurring = packages.reduce((a, p) => a + ((p.monthly_price as number) ?? 0), 0);
  const discountPct = opts.discountPct ?? 0;
  const taxPct = 0;
  const total = round(subtotal * (1 - discountPct / 100) * (1 + taxPct / 100), 2);

  const proposalId = id('prp');
  const number = `PROP-${new Date().getFullYear()}-${String((scalar<number>('SELECT COUNT(*) FROM proposals WHERE org_id = ?', [orgId]) ?? 0) + 1).padStart(4, '0')}`;
  const slug = `proposal-${slugify(b.name)}-${stableHash(proposalId).slice(0, 6)}`;
  const now = nowIso();

  tx(() => {
    run(
      `INSERT INTO proposals (id, org_id, business_id, call_id, number, title, status, slug, problem, solution, scope,
          deliverables, timeline, timeline_weeks, subtotal, discount_pct, tax_pct, total, currency, optional_services,
          recurring_total, terms, next_steps, validity_days, view_count, signature_status, payment_status, cost, created_at, updated_at)
       VALUES (?,?,?,?,?,?,'draft',?,?,?,?,?,?,?,?,?,?,?,?,'[]',?,?,?,14,0,'not_configured','not_configured',?,?,?)`,
      [
        proposalId, orgId, businessId, call?.id ?? null, number,
        `Proposal for ${b.name}`, slug, problem, solution,
        toJson(packages.flatMap((p) => json<string[]>(p.includes as string, []))),
        toJson(packages.flatMap((p) => json<string[]>(p.deliverables as string, []))),
        timeline, timelineWeeks, subtotal, discountPct, taxPct, total, settings.branding.currency,
        recurring, toJson(defaultTerms()), toJson(parsed.nextSteps ?? defaultNextSteps()), res.cost, now, now,
      ]
    );
    let position = 0;
    for (const p of packages) {
      run(
        `INSERT INTO proposal_items (id, proposal_id, package_id, name, description, kind, qty, unit_price, interval, total, optional, position)
         VALUES (?,?,?,?,?,'one_time',1,?,NULL,?,0,?)`,
        [id('pri'), proposalId, p.id, p.name, p.summary ?? null, p.one_time_price ?? 0, p.one_time_price ?? 0, position]
      );
      if ((p.monthly_price as number) > 0) {
        run(
          `INSERT INTO proposal_items (id, proposal_id, package_id, name, description, kind, qty, unit_price, interval, total, optional, position)
           VALUES (?,?,?,?,?,'recurring',1,?,'month',?,0,?)`,
          [id('pri'), proposalId, p.id, `${p.name} — ongoing`, 'Hosting, maintenance and support', p.monthly_price ?? 0, p.monthly_price ?? 0, position + 1]
        );
      }
      position += 2;
    }
  });

  logActivity(orgId, 'proposal', `Proposal ${number} drafted for ${b.name} — $${round(total, 0)}`, {
    businessId,
    actor: opts.actor ?? 'ai',
    detail: `${packages.length} package(s) · ${timelineWeeks} weeks · $${round(recurring, 0)}/mo recurring`,
    entityType: 'proposal',
    entityId: proposalId,
  });
  return get<ProposalRow>('SELECT * FROM proposals WHERE id = ?', [proposalId]) as ProposalRow;
}

function defaultTerms(): string[] {
  return [
    '50% deposit to schedule work; balance on launch.',
    'Two rounds of revisions included per phase.',
    'Monthly fees billed in advance, cancel with 30 days notice.',
    'Content and imagery provided by the client unless otherwise scoped.',
    'This proposal is valid for 14 days from the date sent.',
  ];
}

function defaultNextSteps(): string[] {
  return ['Approve this proposal', 'Pay the deposit to lock in a start date', 'Kickoff call within 5 working days'];
}

export function sendProposal(orgId: string, proposalId: string, actor = 'user'): ProposalRow {
  const proposal = get<ProposalRow>('SELECT * FROM proposals WHERE id = ? AND org_id = ?', [proposalId, orgId]);
  if (!proposal) throw new Error('proposal_not_found');
  const now = nowIso();
  run("UPDATE proposals SET status = 'sent', sent_at = ?, updated_at = ? WHERE id = ?", [now, now, proposalId]);
  logActivity(orgId, 'proposal', `Proposal ${proposal.number} sent`, {
    businessId: proposal.business_id,
    actor,
    detail: `$${round(proposal.total, 0)} · valid ${proposal.validity_days} days`,
    entityType: 'proposal',
    entityId: proposalId,
    importance: 'high',
  });
  advanceStageIfBehind(orgId, proposal.business_id, 'proposal_sent');
  return get<ProposalRow>('SELECT * FROM proposals WHERE id = ?', [proposalId]) as ProposalRow;
}

export function viewProposal(orgId: string, proposalId: string): void {
  const p = get<ProposalRow>('SELECT * FROM proposals WHERE id = ? AND org_id = ?', [proposalId, orgId]);
  if (!p) return;
  const now = nowIso();
  run(
    `UPDATE proposals SET view_count = view_count + 1, first_viewed_at = COALESCE(first_viewed_at, ?),
            last_viewed_at = ?, status = CASE WHEN status = 'sent' THEN 'viewed' ELSE status END, updated_at = ?
      WHERE id = ?`,
    [now, now, now, proposalId]
  );
  if (p.view_count === 0) {
    logActivity(orgId, 'proposal', `Proposal ${p.number} opened`, { businessId: p.business_id, actor: 'client', entityType: 'proposal', entityId: proposalId, importance: 'high' });
    advanceStageIfBehind(orgId, p.business_id, 'negotiation');
  }
}

export function respondToProposal(
  orgId: string,
  proposalId: string,
  decision: 'accepted' | 'rejected',
  opts: { note?: string; actor?: string } = {}
): ProposalRow {
  const proposal = get<ProposalRow>('SELECT * FROM proposals WHERE id = ? AND org_id = ?', [proposalId, orgId]);
  if (!proposal) throw new Error('proposal_not_found');
  const now = nowIso();
  run("UPDATE proposals SET status = ?, responded_at = ?, response_note = ?, updated_at = ? WHERE id = ?", [
    decision,
    now,
    opts.note ?? null,
    now,
    proposalId,
  ]);
  logActivity(orgId, 'proposal', `Proposal ${proposal.number} ${decision}`, {
    businessId: proposal.business_id,
    actor: opts.actor ?? 'client',
    detail: opts.note,
    entityType: 'proposal',
    entityId: proposalId,
    importance: 'high',
  });
  if (decision === 'rejected') {
    advanceStageIfBehind(orgId, proposal.business_id, 'lost');
    recordOutcome(orgId, 'lost', proposal.business_id);
  }
  return get<ProposalRow>('SELECT * FROM proposals WHERE id = ?', [proposalId]) as ProposalRow;
}

/**
 * E-signature / payment readiness (§31).
 * These never fabricate completion: without a configured provider the status
 * stays `not_configured`, and a created Stripe PaymentIntent is `pending`
 * until the customer actually completes it.
 */
export function requestSignature(orgId: string, proposalId: string): { status: string; live: boolean; message: string } {
  const proposal = get<ProposalRow>('SELECT * FROM proposals WHERE id = ? AND org_id = ?', [proposalId, orgId]);
  if (!proposal) throw new Error('proposal_not_found');
  const providerKey = process.env.ESIGN_PROVIDER ?? null;
  if (!providerKey) {
    run("UPDATE proposals SET signature_status = 'not_configured', signature_provider = NULL, updated_at = ? WHERE id = ?", [nowIso(), proposalId]);
    return {
      status: 'not_configured',
      live: false,
      message: 'No e-signature provider is configured. Add one in Settings → Integrations; the proposal schema is already signature-ready.',
    };
  }
  return { status: 'pending', live: false, message: `Provider "${providerKey}" is registered but the signing flow is not implemented in this build.` };
}

export async function requestDeposit(orgId: string, proposalId: string): Promise<{ status: string; live: boolean; message: string; providerPaymentId?: string }> {
  const proposal = get<ProposalRow>('SELECT * FROM proposals WHERE id = ? AND org_id = ?', [proposalId, orgId]);
  if (!proposal) throw new Error('proposal_not_found');
  const provider = getPaymentProvider();
  if (!provider) return { status: 'not_configured', live: false, message: 'No payment provider registered.' };

  const deposit = round(proposal.total * 0.5, 2);
  const result = await provider.createCharge(orgId, {
    amount: deposit,
    currency: proposal.currency,
    description: `Deposit — ${proposal.number}`,
    metadata: { proposalId },
  });

  const now = nowIso();
  run("UPDATE proposals SET payment_provider = ?, payment_status = ?, deposit_amount = ?, deposit_status = ?, updated_at = ? WHERE id = ?", [
    provider.key,
    result.status,
    deposit,
    result.status,
    now,
    proposalId,
  ]);
  run(
    `INSERT INTO payments (id, org_id, client_id, proposal_id, kind, amount, currency, status, provider,
        provider_payment_id, simulated, invoice_number, due_at, created_at)
     VALUES (?,?,?,?, 'deposit', ?,?,?,?, ?,?,?,?,?)`,
    [
      id('pay'), orgId, null, proposalId, deposit, proposal.currency, result.status, provider.key,
      result.providerPaymentId ?? null, result.live ? 0 : 1, proposal.number,
      new Date(Date.now() + 7 * 86_400_000).toISOString(), now,
    ]
  );

  return {
    status: result.status,
    live: result.live,
    message: result.live
      ? result.status === 'pending'
        ? `Deposit of $${deposit} created as a pending payment. It is not paid until the customer completes it.`
        : `Deposit of $${deposit} recorded.`
      : `No payment provider configured — a $${deposit} deposit was recorded as pending. Nothing was charged.`,
    providerPaymentId: result.providerPaymentId,
  };
}

export function listProposals(orgId: string, opts: { businessId?: string; status?: string; limit?: number } = {}) {
  const where = ['p.org_id = ?'];
  const params: unknown[] = [orgId];
  if (opts.businessId) {
    where.push('p.business_id = ?');
    params.push(opts.businessId);
  }
  if (opts.status) {
    where.push('p.status = ?');
    params.push(opts.status);
  }
  params.push(opts.limit ?? 100);
  return all<ProposalRow & { business_name: string }>(
    `SELECT p.*, b.name business_name FROM proposals p JOIN businesses b ON b.id = p.business_id
      WHERE ${where.join(' AND ')} ORDER BY p.created_at DESC LIMIT ?`,
    params
  ).map((p) => ({
    ...p,
    items: all('SELECT * FROM proposal_items WHERE proposal_id = ? ORDER BY position', [p.id]),
  }));
}

// ═════════════════════════════════════════════════════════════
// CLIENT CONVERSION (§32)
// ═════════════════════════════════════════════════════════════
export interface ClientRow {
  id: string;
  org_id: string;
  business_id: string;
  portal_token: string;
  status: string;
  kickoff_at: string | null;
  won_at: string | null;
  lifetime_value: number;
  mrr: number;
  arr: number;
  health: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Converts the existing business record into a client + project. Idempotent:
 * re-winning a business updates the existing client rather than creating a
 * second one, because `clients.business_id` is UNIQUE.
 */
export async function convertToClient(
  orgId: string,
  businessId: string,
  opts: { proposalId?: string; actor?: string; startProject?: boolean } = {}
): Promise<{ client: ClientRow; project: { id: string; name: string; stage: string } | null; created: boolean }> {
  const business = getBusiness(orgId, businessId);
  if (!business) throw new Error('business_not_found');

  const existing = get<ClientRow>('SELECT * FROM clients WHERE business_id = ?', [businessId]);
  const now = nowIso();

  let client: ClientRow;
  let created = false;

  if (existing) {
    run("UPDATE clients SET status = 'onboarding', updated_at = ? WHERE id = ?", [now, existing.id]);
    client = get<ClientRow>('SELECT * FROM clients WHERE id = ?', [existing.id]) as ClientRow;
  } else {
    const clientId = id('cli');
    const portalToken = stableHash(`${clientId}:${now}`, 'portal');
    run(
      `INSERT INTO clients (id, org_id, business_id, portal_token, status, kickoff_at, won_at, lifetime_value, mrr, arr, health, created_at, updated_at)
       VALUES (?,?,?,?, 'onboarding', ?, ?, 0, 0, 0, 'good', ?, ?)`,
      [clientId, orgId, businessId, portalToken, now, now, now, now]
    );
    client = get<ClientRow>('SELECT * FROM clients WHERE id = ?', [clientId]) as ClientRow;
    created = true;
  }

  // Mark the business as won — this is the same row, not a copy.
  run("UPDATE businesses SET stage = 'won', updated_at = ? WHERE id = ?", [now, businessId]);
  logActivity(orgId, 'client', `${business.name} converted to client`, {
    businessId,
    clientId: client.id,
    actor: opts.actor ?? 'user',
    detail: created ? 'Client workspace created from the existing business record — no duplicate.' : 'Existing client record reused.',
    entityType: 'client',
    entityId: client.id,
    importance: 'high',
  });
  recordOutcome(orgId, 'won', businessId, { value: 1 });

  // Revenue from the accepted proposal (§35).
  const proposal = opts.proposalId
    ? get<ProposalRow>('SELECT * FROM proposals WHERE id = ?', [opts.proposalId])
    : get<ProposalRow>("SELECT * FROM proposals WHERE business_id = ? ORDER BY created_at DESC LIMIT 1", [businessId]);
  if (proposal) {
    run('UPDATE clients SET lifetime_value = lifetime_value + ?, updated_at = ? WHERE id = ?', [proposal.total, now, client.id]);
    const recurring = proposal.recurring_total ?? 0;
    if (recurring > 0) {
      run('UPDATE clients SET mrr = ?, arr = ?, updated_at = ? WHERE id = ?', [recurring, round(recurring * 12, 2), now, client.id]);
      const existingSub = get<{ id: string }>('SELECT id FROM subscriptions WHERE client_id = ? AND status = ?', [client.id, 'active']);
      if (!existingSub) {
        run(
          `INSERT INTO subscriptions (id, org_id, client_id, package_id, name, amount, interval, currency, status, started_at, current_period_end, created_at)
           VALUES (?,?,?,?,?,?, 'month', ?, 'active', ?, ?, ?)`,
          [
            id('sub'), orgId, client.id, null, `Recurring — ${proposal.title}`, recurring, proposal.currency, now,
            addDays(new Date(), 30).toISOString(), now,
          ]
        );
      }
    }
  }

  let project: { id: string; name: string; stage: string } | null = null;
  if (opts.startProject !== false) {
    project = createProject(orgId, client.id, businessId, {
      proposalId: proposal?.id,
      kind: business.recommended_service === 'social' ? 'social' : 'website',
      name: `${business.name} — ${business.recommended_service === 'social' ? 'Social management' : 'Website build'}`,
      actor: opts.actor,
    });
  }

  advanceStageIfBehind(orgId, businessId, 'onboarding');
  return { client, project, created };
}

// ═════════════════════════════════════════════════════════════
// PROJECTS (§33)
// ═════════════════════════════════════════════════════════════
export interface ProjectRow {
  id: string;
  org_id: string;
  client_id: string;
  business_id: string;
  proposal_id: string | null;
  name: string;
  kind: string;
  stage: ProjectStage;
  status: string;
  progress: number;
  starts_at: string | null;
  due_at: string | null;
  health: string;
  health_reason: string | null;
  requirements: string;
  deliverables: string;
}

export function createProject(
  orgId: string,
  clientId: string,
  businessId: string,
  opts: { proposalId?: string; kind?: string; name?: string; actor?: string } = {}
): { id: string; name: string; stage: string } {
  const business = getBusiness(orgId, businessId);
  const call = get<CallRow>("SELECT * FROM calls WHERE business_id = ? AND status = 'completed' ORDER BY completed_at DESC LIMIT 1", [businessId]);
  const requirements = call ? json<string[]>(call.requirements, []) : [];
  const proposal = opts.proposalId ? get<ProposalRow>('SELECT * FROM proposals WHERE id = ?', [opts.proposalId]) : null;
  const deliverables = proposal ? json<string[]>(proposal.deliverables, []) : defaultDeliverables(opts.kind ?? 'website');
  const weeks = proposal?.timeline_weeks ?? 5;
  const now = nowIso();
  const projectId = id('prj');

  run(
    `INSERT INTO projects (id, org_id, client_id, business_id, proposal_id, name, kind, stage, status, progress,
        owner_id, starts_at, due_at, budget, health, requirements, deliverables, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?, 'onboarding', 'active', 0, NULL, ?, ?, ?, 'on_track', ?,?,?,?)`,
    [
      projectId, orgId, clientId, businessId, opts.proposalId ?? null,
      opts.name ?? `${business?.name ?? 'Client'} project`,
      opts.kind ?? 'website', now, addDays(new Date(), weeks * 7).toISOString(),
      proposal?.total ?? null, toJson(requirements), toJson(deliverables), now, now,
    ]
  );

  const tasks = buildProjectTasks(opts.kind ?? 'website', business?.name ?? 'Client');
  let offset = 0;
  const taskIds: string[] = [];
  for (const t of tasks) {
    const taskId = id('tsk');
    const dependsOn = t.dependsOnIndex !== undefined ? [taskIds[t.dependsOnIndex]] : [];
    run(
      `INSERT INTO tasks (id, org_id, project_id, business_id, title, description, stage, owner_id, assignee_role,
          due_at, priority, status, depends_on, estimate_hours, progress, needs_client_input, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?)`,
      [
        taskId, orgId, projectId, businessId, t.title, t.description ?? null, t.stage, null, t.role ?? null,
        addDays(new Date(), offset).toISOString(), t.priority ?? 'medium', 'todo', toJson(dependsOn),
        t.estimate ?? null, t.needsClientInput ? 1 : 0, now, now,
      ]
    );
    taskIds.push(taskId);
    offset += t.gap ?? 2;
  }

  logActivity(orgId, 'project', `Project created — ${opts.name ?? business?.name ?? 'Client'}`, {
    businessId,
    clientId,
    projectId,
    actor: opts.actor ?? 'system',
    detail: `${tasks.length} tasks · ${weeks} week timeline · ${deliverables.length} deliverable(s)`,
    entityType: 'project',
    entityId: projectId,
  });

  return { id: projectId, name: opts.name ?? `${business?.name ?? 'Client'} project`, stage: 'onboarding' };
}

function defaultDeliverables(kind: string): string[] {
  if (kind === 'social') {
    return ['Profile optimisation', 'Content calendar', '12 posts per month', 'Monthly performance report'];
  }
  return ['Homepage', 'About page', 'Service pages', 'Contact page with enquiry form', 'Mobile optimisation', 'Analytics setup', 'Handover documentation'];
}

interface TaskSeed {
  title: string;
  description?: string;
  stage: ProjectStage;
  role?: string;
  gap?: number;
  estimate?: number;
  priority?: string;
  needsClientInput?: boolean;
  dependsOnIndex?: number;
}

function buildProjectTasks(kind: string, clientName: string): TaskSeed[] {
  if (kind === 'social') {
    return [
      { title: `Audit ${clientName} social profiles`, stage: 'onboarding', role: 'social_manager', estimate: 2, gap: 2 },
      { title: 'Collect brand assets and messaging', stage: 'requirements', role: 'social_manager', estimate: 2, gap: 3, needsClientInput: true, dependsOnIndex: 0 },
      { title: 'Build 90-day content calendar', stage: 'design', role: 'social_manager', estimate: 6, gap: 5, dependsOnIndex: 1 },
      { title: 'Client approval of calendar', stage: 'client_review', role: 'social_manager', estimate: 1, gap: 3, needsClientInput: true, dependsOnIndex: 2 },
      { title: 'Produce first month of content', stage: 'content', role: 'social_manager', estimate: 8, gap: 7, dependsOnIndex: 3 },
      { title: 'Publish and monitor', stage: 'deployment', role: 'social_manager', estimate: 2, gap: 5, dependsOnIndex: 4 },
    ];
  }
  return [
    { title: `Kickoff call with ${clientName}`, description: 'Confirm scope, stakeholders and timeline.', stage: 'onboarding', role: 'sales', estimate: 1, gap: 2, priority: 'high' },
    { title: 'Collect content, logo and brand assets', stage: 'requirements', role: 'designer', estimate: 2, gap: 4, needsClientInput: true, dependsOnIndex: 0 },
    { title: 'Confirm sitemap and page structure', stage: 'requirements', role: 'designer', estimate: 2, gap: 2, needsClientInput: true, dependsOnIndex: 1 },
    { title: 'Design direction and homepage mockup', stage: 'design', role: 'designer', estimate: 8, gap: 4, priority: 'high', dependsOnIndex: 2 },
    { title: 'Client review of design', stage: 'client_review', role: 'designer', estimate: 1, gap: 3, needsClientInput: true, dependsOnIndex: 3 },
    { title: 'Build remaining pages', stage: 'development', role: 'developer', estimate: 12, gap: 6, dependsOnIndex: 4 },
    { title: 'Write and place final copy', stage: 'content', role: 'designer', estimate: 6, gap: 3, needsClientInput: true, dependsOnIndex: 5 },
    { title: 'Cross-device and accessibility testing', stage: 'testing', role: 'developer', estimate: 4, gap: 2, dependsOnIndex: 6 },
    { title: 'Client review of staging site', stage: 'client_review', role: 'developer', estimate: 1, gap: 4, needsClientInput: true, dependsOnIndex: 7 },
    { title: 'Apply revisions', stage: 'revisions', role: 'developer', estimate: 4, gap: 3, dependsOnIndex: 8 },
    { title: 'Final approval and sign-off', stage: 'approval', role: 'sales', estimate: 1, gap: 2, needsClientInput: true, priority: 'high', dependsOnIndex: 9 },
    { title: 'Deploy to production', stage: 'deployment', role: 'developer', estimate: 2, gap: 1, priority: 'high', dependsOnIndex: 10 },
    { title: 'Handover, training and documentation', stage: 'handover', role: 'developer', estimate: 2, gap: 2, dependsOnIndex: 11 },
  ];
}

export function advanceProject(orgId: string, projectId: string, stage: ProjectStage, actor = 'user'): ProjectRow {
  const now = nowIso();
  run('UPDATE projects SET stage = ?, progress = ?, updated_at = ? WHERE id = ?', [
    stage,
    PROJECT_STAGE_PROGRESS[stage] ?? 0,
    now,
    projectId,
  ]);
  if (stage === 'complete') run("UPDATE projects SET status = 'complete', updated_at = ? WHERE id = ?", [now, projectId]);
  const project = get<ProjectRow>('SELECT * FROM projects WHERE id = ?', [projectId]) as ProjectRow;
  logActivity(orgId, 'project', `${project.name} → ${PROJECT_STAGE_LABELS[stage]}`, {
    projectId,
    clientId: project.client_id,
    businessId: project.business_id,
    actor,
    entityType: 'project',
    entityId: projectId,
  });
  if (stage === 'deployment') updateBusiness(orgId, project.business_id, { stage: 'delivery' as PipelineStage });
  if (stage === 'complete') {
    updateBusiness(orgId, project.business_id, { stage: 'active_client' as PipelineStage });
    run("UPDATE clients SET status = 'active', updated_at = ? WHERE id = ?", [now, project.client_id]);
  }
  return get<ProjectRow>('SELECT * FROM projects WHERE id = ?', [projectId]) as ProjectRow;
}

export function updateTask(orgId: string, taskId: string, patch: { status?: string; progress?: number; ownerId?: string | null; dueAt?: string | null; priority?: string }): void {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.status !== undefined) {
    sets.push('status = ?');
    params.push(patch.status);
    if (patch.status === 'done') {
      sets.push('completed_at = ?', 'progress = 100');
      params.push(nowIso());
    }
  }
  if (patch.progress !== undefined) {
    sets.push('progress = ?');
    params.push(patch.progress);
  }
  if (patch.ownerId !== undefined) {
    sets.push('owner_id = ?');
    params.push(patch.ownerId);
  }
  if (patch.dueAt !== undefined) {
    sets.push('due_at = ?');
    params.push(patch.dueAt);
  }
  if (patch.priority !== undefined) {
    sets.push('priority = ?');
    params.push(patch.priority);
  }
  if (!sets.length) return;
  params.push(nowIso(), taskId, orgId);
  run(`UPDATE tasks SET ${sets.join(', ')}, updated_at = ? WHERE id = ? AND org_id = ?`, params);
  refreshProjectProgress(orgId, taskId);
}

export function refreshProjectProgress(orgId: string, taskId: string): void {
  const task = get<{ project_id: string }>('SELECT project_id FROM tasks WHERE id = ?', [taskId]);
  if (!task?.project_id) return;
  const stats = get<{ avg: number; done: number; total: number }>(
    `SELECT AVG(progress) avg, SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) done, COUNT(*) total
       FROM tasks WHERE project_id = ? AND status <> 'cancelled'`,
    [task.project_id]
  );
  if (!stats) return;
  const stageProgress = scalar<number>('SELECT 1') ? 0 : 0;
  const taskProgress = Math.round(stats.avg ?? 0);
  const stage = scalar<ProjectStage>('SELECT stage FROM projects WHERE id = ?', [task.project_id]);
  const blended = Math.max(taskProgress, Math.min(100, PROJECT_STAGE_PROGRESS[stage ?? 'onboarding'] + stageProgress));
  run('UPDATE projects SET progress = ?, updated_at = ? WHERE id = ?', [blended, nowIso(), task.project_id]);
}

/** Delivery health (§59 delivery risks, §63 delivery risks queue). */
export function assessDeliveryHealth(orgId: string): void {
  const projects = all<ProjectRow>("SELECT * FROM projects WHERE org_id = ? AND status = 'active'", [orgId]);
  for (const p of projects) {
    const overdue = scalar<number>(
      "SELECT COUNT(*) FROM tasks WHERE project_id = ? AND status <> 'done' AND due_at < ?",
      [p.id, nowIso()]
    ) ?? 0;
    const blocked = scalar<number>("SELECT COUNT(*) FROM tasks WHERE project_id = ? AND status = 'blocked'", [p.id]) ?? 0;
    const waitingClient = scalar<number>(
      "SELECT COUNT(*) FROM tasks WHERE project_id = ? AND needs_client_input = 1 AND status <> 'done'",
      [p.id]
    ) ?? 0;
    const pastDue = p.due_at ? new Date(p.due_at).getTime() < Date.now() : false;

    let health = 'on_track';
    let reason = '';
    if (overdue >= 3 || blocked >= 2 || pastDue) {
      health = 'delayed';
      reason = [overdue ? `${overdue} overdue task(s)` : '', blocked ? `${blocked} blocked` : '', pastDue ? 'past due date' : '']
        .filter(Boolean)
        .join(', ');
    } else if (overdue > 0 || blocked > 0 || waitingClient > 0) {
      health = 'at_risk';
      reason = [overdue ? `${overdue} overdue` : '', blocked ? `${blocked} blocked` : '', waitingClient ? `waiting on client for ${waitingClient} item(s)` : '']
        .filter(Boolean)
        .join(', ');
    }
    if (health !== p.health) {
      run('UPDATE projects SET health = ?, health_reason = ?, updated_at = ? WHERE id = ?', [health, reason || null, nowIso(), p.id]);
      if (health === 'delayed') {
        logActivity(orgId, 'project', `${p.name} is delayed`, {
          projectId: p.id,
          clientId: p.client_id,
          businessId: p.business_id,
          detail: reason,
          importance: 'critical',
        });
      }
    }
  }
}

export function listProjects(orgId: string, opts: { clientId?: string; status?: string; limit?: number } = {}) {
  const where = ['p.org_id = ?'];
  const params: unknown[] = [orgId];
  if (opts.clientId) {
    where.push('p.client_id = ?');
    params.push(opts.clientId);
  }
  if (opts.status) {
    where.push('p.status = ?');
    params.push(opts.status);
  }
  params.push(opts.limit ?? 100);
  return all<ProjectRow & { business_name: string; client_status: string; open_tasks: number; overdue_tasks: number }>(
    `SELECT p.*, b.name business_name, c.status client_status,
            (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status <> 'done') open_tasks,
            (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status <> 'done' AND t.due_at < ?) overdue_tasks
       FROM projects p JOIN businesses b ON b.id = p.business_id JOIN clients c ON c.id = p.client_id
      WHERE ${where.join(' AND ')} ORDER BY p.status = 'active' DESC, p.due_at ASC LIMIT ?`,
    [nowIso(), ...params]
  );
}

export interface TaskRow {
  id: string;
  org_id: string;
  project_id: string | null;
  business_id: string | null;
  title: string;
  description: string | null;
  stage: string | null;
  owner_id: string | null;
  due_at: string | null;
  priority: string;
  status: string;
  progress: number;
  needs_client_input: number;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  project_name: string | null;
  business_name: string | null;
}

export function listTasks(orgId: string, opts: { projectId?: string; status?: string; needsClientInput?: boolean; limit?: number } = {}): TaskRow[] {
  const where = ['t.org_id = ?'];
  const params: unknown[] = [orgId];
  if (opts.projectId) {
    where.push('t.project_id = ?');
    params.push(opts.projectId);
  }
  if (opts.status) {
    where.push('t.status = ?');
    params.push(opts.status);
  }
  if (opts.needsClientInput) where.push('t.needs_client_input = 1');
  params.push(opts.limit ?? 200);
  return all<TaskRow>(
    `SELECT t.*, p.name project_name, b.name business_name FROM tasks t
       LEFT JOIN projects p ON p.id = t.project_id LEFT JOIN businesses b ON b.id = t.business_id
      WHERE ${where.join(' AND ')} ORDER BY t.status = 'done', t.due_at ASC LIMIT ?`,
    params
  );
}

// ═════════════════════════════════════════════════════════════
// WEBSITES & DEPLOYMENT (§34)
// ═════════════════════════════════════════════════════════════
export interface WebsiteRow {
  id: string;
  org_id: string;
  client_id: string | null;
  business_id: string;
  mockup_id: string | null;
  name: string;
  status: string;
  html: string | null;
  current_version: number;
  preview_url: string | null;
  live_url: string | null;
  hosting_provider: string | null;
}

export function publishWebsiteFromMockup(orgId: string, mockupId: string, opts: { clientId?: string; actor?: string } = {}): WebsiteRow {
  const mockup = get<{ id: string; business_id: string; title: string; current_version: number; slug: string; theme: string }>(
    'SELECT * FROM mockups WHERE id = ? AND org_id = ?',
    [mockupId, orgId]
  );
  if (!mockup) throw new Error('mockup_not_found');
  const html = scalar<string>('SELECT html FROM mockup_versions WHERE mockup_id = ? AND version = ?', [mockupId, mockup.current_version]);
  if (!html) throw new Error('version_not_found');

  const now = nowIso();
  let website = get<WebsiteRow>('SELECT * FROM websites WHERE mockup_id = ? AND org_id = ?', [mockupId, orgId]);
  if (!website) {
    const websiteId = id('web');
    run(
      `INSERT INTO websites (id, org_id, client_id, business_id, mockup_id, name, status, html, theme,
          current_version, preview_url, live_url, hosting_provider, created_at, updated_at)
       VALUES (?,?,?,?,?,?,'preview',?,?,1,?,NULL,NULL,?,?)`,
      [websiteId, orgId, opts.clientId ?? null, mockup.business_id, mockupId, mockup.title, html, mockup.theme, `/site/${mockup.slug}`, now, now]
    );
    website = get<WebsiteRow>('SELECT * FROM websites WHERE id = ?', [websiteId]) as WebsiteRow;
  } else {
    run('UPDATE websites SET html = ?, current_version = current_version + 1, updated_at = ? WHERE id = ?', [html, now, website.id]);
    run('INSERT INTO website_versions (id, website_id, version, html, theme, note, created_at) VALUES (?,?,?,?,?,?,?)', [
      id('wev'),
      website.id,
      website.current_version + 1,
      html,
      mockup.theme,
      'Published from mockup',
      now,
    ]);
    website = get<WebsiteRow>('SELECT * FROM websites WHERE id = ?', [website.id]) as WebsiteRow;
  }

  logActivity(orgId, 'deployment', `Website record created for ${mockup.title.replace(' — concept', '')}`, {
    businessId: mockup.business_id,
    clientId: opts.clientId ?? null,
    actor: opts.actor ?? 'user',
    detail: 'Served in-app at /site/. Configure a hosting provider for a production URL.',
    entityType: 'website',
    entityId: website.id,
  });
  return website;
}

export async function deployWebsite(orgId: string, websiteId: string, opts: { providerKey?: string; domain?: string; actor?: string } = {}): Promise<{
  ok: boolean;
  status: string;
  url: string | null;
  simulated: boolean;
  message: string;
}> {
  const website = get<WebsiteRow>('SELECT * FROM websites WHERE id = ? AND org_id = ?', [websiteId, orgId]);
  if (!website) throw new Error('website_not_found');
  const html = website.html ?? '';
  const provider = getHostingProvider(opts.providerKey);
  if (!provider) throw new Error('no_hosting_provider');

  const deploymentId = id('dpl');
  const started = Date.now();
  run(
    `INSERT INTO deployments (id, org_id, website_id, website_version, provider_key, target, status, simulated, started_at, created_at)
     VALUES (?,?,?,?,?,?, 'building', 1, ?, ?)`,
    [deploymentId, orgId, websiteId, website.current_version, provider.key, opts.domain ?? null, nowIso(), nowIso()]
  );

  const result = await provider.deploy(orgId, {
    siteName: slugify(website.name),
    html,
    domain: opts.domain ?? null,
    version: website.current_version,
  });
  const now = nowIso();

  run(
    `UPDATE deployments SET status = ?, simulated = ?, url = ?, logs = ?, error = ?, finished_at = ?, duration_ms = ?
      WHERE id = ?`,
    [result.status, result.live ? 0 : 1, result.url ?? null, result.logs ?? null, result.error ?? null, now, Date.now() - started, deploymentId]
  );

  if (result.ok) {
    run('UPDATE websites SET status = ?, live_url = ?, hosting_provider = ?, deployment_id = ?, updated_at = ? WHERE id = ?', [
      result.live ? 'live' : 'preview',
      result.url ?? null,
      provider.key,
      deploymentId,
      now,
      websiteId,
    ]);
  }

  const message = result.live
    ? `Deployed via ${provider.label}${result.url ? ` → ${result.url}` : ''}.`
    : `No external host contacted. ${provider.label} served it in-app${result.url ? ` at ${result.url}` : ''}. Configure Vercel, Netlify or GitHub Pages in Settings → Integrations for a public URL.`;

  logActivity(orgId, 'deployment', `${result.ok ? 'Deployment' : 'Deployment failed'} — ${website.name}`, {
    businessId: website.business_id,
    clientId: website.client_id,
    actor: opts.actor ?? 'user',
    detail: message,
    entityType: 'deployment',
    entityId: deploymentId,
    importance: result.ok ? 'normal' : 'critical',
  });
  if (!result.ok) {
    logAutomation(orgId, 'deployment', `Deployment failed for ${website.name}: ${result.error}`, {
      level: 'error',
      entityType: 'website',
      entityId: websiteId,
      retryable: true,
    });
  }

  return { ok: result.ok, status: result.status, url: result.url ?? null, simulated: !result.live, message };
}

export async function rollbackDeployment(orgId: string, websiteId: string, toVersion: number, actor = 'user'): Promise<{ ok: boolean; message: string }> {
  const version = get<{ html: string; theme: string }>('SELECT html, theme FROM website_versions WHERE website_id = ? AND version = ?', [websiteId, toVersion]);
  if (!version) return { ok: false, message: 'Version not found' };
  const now = nowIso();
  const website = get<WebsiteRow>('SELECT * FROM websites WHERE id = ?', [websiteId]) as WebsiteRow;
  const newVersion = website.current_version + 1;
  run('INSERT INTO website_versions (id, website_id, version, html, theme, note, created_at) VALUES (?,?,?,?,?,?,?)', [
    id('wev'), websiteId, newVersion, version.html, version.theme, `Rolled back to v${toVersion}`, now,
  ]);
  run('UPDATE websites SET html = ?, current_version = ?, updated_at = ? WHERE id = ?', [version.html, newVersion, now, websiteId]);
  await deployWebsite(orgId, websiteId, { actor });
  logActivity(orgId, 'deployment', `Rolled back to v${toVersion}`, { businessId: website.business_id, actor, entityType: 'website', entityId: websiteId });
  return { ok: true, message: `Rolled back to v${toVersion} and redeployed as v${newVersion}.` };
}

export async function attachDomain(orgId: string, websiteId: string, hostname: string, kind: 'subdomain' | 'custom' = 'custom'): Promise<{ ok: boolean; message: string; dns?: { type: string; name: string; value: string }[] }> {
  const website = get<WebsiteRow>('SELECT * FROM websites WHERE id = ? AND org_id = ?', [websiteId, orgId]);
  if (!website) throw new Error('website_not_found');
  const provider = getHostingProvider(website.hosting_provider ?? undefined);
  const supportsDomains = provider?.supportsCustomDomains ?? false;
  const now = nowIso();
  const domainId = id('dom');

  const dns = [
    { type: 'A', name: '@', value: '76.76.21.21' },
    { type: 'CNAME', name: 'www', value: 'cname.vercel-dns.com' },
  ];

  run(
    `INSERT INTO domains (id, org_id, website_id, hostname, kind, status, provider, ssl_status, dns_records, created_at)
     VALUES (?,?,?,?,?,?,?, 'pending', ?, ?)`,
    [domainId, orgId, websiteId, hostname, kind, supportsDomains ? 'pending' : 'failed', provider?.key ?? null, toJson(dns), now]
  );

  const message = supportsDomains
    ? `Domain ${hostname} added. Point these records at the host to verify — SSL is issued automatically once DNS resolves.`
    : `No hosting provider with custom-domain support is configured. ${hostname} is recorded but cannot be verified yet.`;

  logActivity(orgId, 'deployment', `Domain ${hostname} attached`, { businessId: website.business_id, detail: message, entityType: 'domain', entityId: domainId });
  return { ok: supportsDomains, message, dns };
}

export function listWebsites(orgId: string, opts: { clientId?: string; status?: string } = {}) {
  const where = ['w.org_id = ?'];
  const params: unknown[] = [orgId];
  if (opts.clientId) {
    where.push('w.client_id = ?');
    params.push(opts.clientId);
  }
  if (opts.status) {
    where.push('w.status = ?');
    params.push(opts.status);
  }
  return all<WebsiteRow & { business_name: string; domains: unknown[]; latest_deployment: unknown }>(
    `SELECT w.*, b.name business_name,
            (SELECT json_group_array(json_object('hostname', hostname, 'status', status, 'ssl', ssl_status)) FROM domains d WHERE d.website_id = w.id) domains
       FROM websites w JOIN businesses b ON b.id = w.business_id
      WHERE ${where.join(' AND ')} ORDER BY w.updated_at DESC`,
    params
  ).map((w) => ({
    ...w,
    domains: json<unknown[]>(w.domains as unknown as string, []),
    latest_deployment: get('SELECT * FROM deployments WHERE website_id = ? ORDER BY created_at DESC LIMIT 1', [w.id]),
  }));
}

// ═════════════════════════════════════════════════════════════
// RECURRING REVENUE (§35)
// ═════════════════════════════════════════════════════════════
export function revenueSummary(orgId: string) {
  const mrr = scalar<number>("SELECT COALESCE(SUM(amount),0) FROM subscriptions WHERE org_id = ? AND status = 'active' AND interval = 'month'", [orgId]) ?? 0;
  const yearly = scalar<number>("SELECT COALESCE(SUM(amount),0) FROM subscriptions WHERE org_id = ? AND status = 'active' AND interval = 'year'", [orgId]) ?? 0;
  const wonRevenue = scalar<number>("SELECT COALESCE(SUM(total),0) FROM proposals WHERE org_id = ? AND status = 'accepted'", [orgId]) ?? 0;
  const paidRevenue = scalar<number>("SELECT COALESCE(SUM(amount),0) FROM payments WHERE org_id = ? AND status = 'paid'", [orgId]) ?? 0;
  const pipelineValue = scalar<number>(
    `SELECT COALESCE(SUM(b.revenue_potential),0) FROM businesses b WHERE b.org_id = ? AND b.stage NOT IN ('lost','won','active_client')`,
    [orgId]
  ) ?? 0;
  const clients = scalar<number>("SELECT COUNT(*) FROM clients WHERE org_id = ? AND status = 'active'", [orgId]) ?? 0;
  const totalLtv = scalar<number>('SELECT COALESCE(SUM(lifetime_value),0) FROM clients WHERE org_id = ?', [orgId]) ?? 0;

  const monthlyMrr = mrr + yearly / 12;
  return {
    mrr: round(monthlyMrr, 2),
    arr: round(monthlyMrr * 12, 2),
    wonRevenue: round(wonRevenue, 2),
    paidRevenue: round(paidRevenue, 2),
    pipelineValue: round(pipelineValue, 2),
    activeClients: clients,
    totalLifetimeValue: round(totalLtv, 2),
    averageDealValue: clients ? round(totalLtv / clients, 2) : 0,
    recurringByService: all<{ name: string; amount: number }>(
      "SELECT name, SUM(amount) amount FROM subscriptions WHERE org_id = ? AND status = 'active' GROUP BY name ORDER BY amount DESC",
      [orgId]
    ),
  };
}

export function refreshClientMetrics(orgId: string): void {
  const clients = all<ClientRow>('SELECT * FROM clients WHERE org_id = ?', [orgId]);
  for (const c of clients) {
    const mrr = scalar<number>("SELECT COALESCE(SUM(amount),0) FROM subscriptions WHERE client_id = ? AND status = 'active' AND interval = 'month'", [c.id]) ?? 0;
    const won = scalar<number>("SELECT COALESCE(SUM(total),0) FROM proposals WHERE business_id = ? AND status = 'accepted'", [c.business_id]) ?? 0;
    const openTasks = scalar<number>('SELECT COUNT(*) FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.client_id = ? AND t.status <> ?', [c.id, 'done']) ?? 0;
    const overdue = scalar<number>("SELECT COUNT(*) FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.client_id = ? AND t.status <> 'done' AND t.due_at < ?", [c.id, nowIso()]) ?? 0;
    const health = overdue >= 3 ? 'critical' : overdue > 0 ? 'at_risk' : 'good';
    run('UPDATE clients SET mrr = ?, arr = ?, lifetime_value = MAX(lifetime_value, ?), health = ?, updated_at = ? WHERE id = ?', [
      mrr,
      round(mrr * 12, 2),
      won,
      health,
      nowIso(),
      c.id,
    ]);
    void openTasks;
  }
}

// ═════════════════════════════════════════════════════════════
// UPSELL (§50)
// ═════════════════════════════════════════════════════════════
export interface UpsellOpportunity {
  id: string;
  org_id: string;
  client_id: string;
  business_id: string;
  service: string;
  package_id: string | null;
  score: number;
  rationale: string;
  evidence: string;
  estMrr: number;
  estOneTime: number;
  status: string;
  created_at: string;
}

const UPSELL_MAP: Record<string, { service: string; why: string; evidence: (b: Business, ctx: unknown) => string[] }[]> = {
  website: [
    { service: 'SEO', why: 'A new site with no search strategy will not rank on its own. SEO is the natural second purchase.', evidence: (b) => [`Website delivered for ${b.name}`] },
    { service: 'Maintenance', why: 'Every site needs updates, backups and monitoring. This is the cheapest recurring add-on.', evidence: (b) => [`Website delivered for ${b.name}`] },
    { service: 'Social management', why: 'The site now gives social traffic somewhere to land — pairing them compounds.', evidence: (b) => [`Website delivered for ${b.name}`] },
    { service: 'Content', why: 'Ongoing content is what keeps the site ranking after launch.', evidence: (b) => [`Website delivered for ${b.name}`] },
    { service: 'Analytics', why: 'They can now measure — most clients want that turned into a monthly report.', evidence: (b) => [`Website delivered for ${b.name}`] },
  ],
  social: [
    { service: 'Website', why: 'Social interest has nowhere substantial to land. A site captures it.', evidence: (b) => [`Social management active for ${b.name}`] },
    { service: 'Landing page', why: 'A single campaign page converts social traffic far better than a profile link.', evidence: (b) => [`Social management active for ${b.name}`] },
    { service: 'SEO', why: 'Once they have a site, search becomes the next durable channel.', evidence: (b) => [`Social management active for ${b.name}`] },
  ],
  seo: [
    { service: 'Content', why: 'Rankings decay without fresh content. This is the retention play.', evidence: (b) => [`SEO active for ${b.name}`] },
    { service: 'Conversion', why: 'Traffic without a converting page is wasted spend.', evidence: (b) => [`SEO active for ${b.name}`] },
  ],
};

export function scanUpsells(orgId: string): UpsellOpportunity[] {
  const clients = all<ClientRow & { name: string; stage: string; category: string | null; recommended_service: string | null }>(
    `SELECT c.*, b.name, b.stage, b.category, b.recommended_service FROM clients c JOIN businesses b ON b.id = c.business_id
      WHERE c.org_id = ? AND c.status IN ('active','onboarding')`,
    [orgId]
  );
  const packages = all<Record<string, unknown>>('SELECT * FROM service_packages WHERE org_id = ? AND is_active = 1', [orgId]);
  const created: UpsellOpportunity[] = [];
  const now = nowIso();

  for (const c of clients) {
    // subscriptions has no `kind` column — the package name carries the service.
    const purchased = all<{ name: string }>(
      "SELECT name FROM subscriptions WHERE client_id = ? AND status = 'active'",
      [c.id]
    ).map((s) => s.name.toLowerCase());
    const baseKind = c.recommended_service ?? 'website';
    const options = UPSELL_MAP[baseKind] ?? UPSELL_MAP.website;

    for (const opt of options) {
      const already = purchased.some((p) => p.includes(opt.service.toLowerCase()));
      if (already) continue;
      const existing = get<{ id: string }>(
        'SELECT id FROM upsell_opportunities WHERE client_id = ? AND service = ? AND status IN (?,?)',
        [c.id, opt.service, 'identified', 'pitched']
      );
      if (existing) continue;

      const pkg = packages.find((p) => (p.name as string).toLowerCase().includes(opt.service.toLowerCase().split(' ')[0]));
      const estMrr = (pkg?.monthly_price as number) ?? 149;
      const estOneTime = (pkg?.one_time_price as number) ?? 0;
      const score = round(Math.min(95, 55 + ((c.mrr ?? 0) > 0 ? 15 : 0) + (c.health === 'good' ? 15 : 0) + Math.min(10, (c.lifetime_value ?? 0) / 500)));

      const oppId = id('ups');
      run(
        `INSERT INTO upsell_opportunities (id, org_id, client_id, business_id, service, package_id, score, rationale,
            evidence, est_mrr, est_one_time, status, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?, 'identified', ?)`,
        [
          oppId, orgId, c.id, c.business_id, opt.service, pkg?.id ?? null, score, opt.why,
          toJson(opt.evidence(c as unknown as Business, null)), estMrr, estOneTime, now,
        ]
      );
      created.push({
        id: oppId,
        org_id: orgId,
        client_id: c.id,
        business_id: c.business_id,
        service: opt.service,
        package_id: (pkg?.id as string) ?? null,
        score,
        rationale: opt.why,
        evidence: JSON.stringify(opt.evidence(c as unknown as Business, null)),
        estMrr,
        estOneTime,
        status: 'identified',
        created_at: now,
      });
    }
  }
  if (created.length) {
    logActivity(orgId, 'client', `Upsell scan found ${created.length} new opportunit${created.length === 1 ? 'y' : 'ies'}`, {
      actor: 'ai',
      detail: created.slice(0, 5).map((u) => `${u.service} ($${u.estMrr}/mo)`).join(' · '),
    });
  }
  return created;
}

export function listUpsells(orgId: string, opts: { clientId?: string; status?: string; limit?: number } = {}) {
  const where = ['u.org_id = ?'];
  const params: unknown[] = [orgId];
  if (opts.clientId) {
    where.push('u.client_id = ?');
    params.push(opts.clientId);
  }
  if (opts.status) {
    where.push('u.status = ?');
    params.push(opts.status);
  }
  params.push(opts.limit ?? 100);
  return all<(UpsellOpportunity & { business_name: string; client_status: string; estMrr: number; estOneTime: number })>(
    `SELECT u.*, b.name business_name, c.status client_status FROM upsell_opportunities u
       JOIN businesses b ON b.id = u.business_id JOIN clients c ON c.id = u.client_id
      WHERE ${where.join(' AND ')} ORDER BY u.score DESC LIMIT ?`,
    params
  ).map((u) => ({
    ...u,
    estMrr: (u as unknown as { est_mrr: number }).est_mrr ?? 0,
    estOneTime: (u as unknown as { est_one_time: number }).est_one_time ?? 0,
  }));
}

// ── Clients listing ──────────────────────────────────────────
export function listClients(orgId: string, opts: { status?: string; limit?: number } = {}) {
  const where = ['c.org_id = ?'];
  const params: unknown[] = [orgId];
  if (opts.status) {
    where.push('c.status = ?');
    params.push(opts.status);
  }
  params.push(opts.limit ?? 100);
  return all<ClientRow & {
    business_name: string;
    category: string | null;
    stage: string;
    projects: number;
    open_tasks: number;
    subscriptions: number;
  }>(
    `SELECT c.*, b.name business_name, b.category, b.stage,
            (SELECT COUNT(*) FROM projects p WHERE p.client_id = c.id) projects,
            (SELECT COUNT(*) FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.client_id = c.id AND t.status <> 'done') open_tasks,
            (SELECT COUNT(*) FROM subscriptions s WHERE s.client_id = c.id AND s.status = 'active') subscriptions
       FROM clients c JOIN businesses b ON b.id = c.business_id
      WHERE ${where.join(' AND ')} ORDER BY c.status = 'active' DESC, c.created_at DESC LIMIT ?`,
    params
  );
}

export function getClientByToken(orgId: string, token: string): ClientRow | null {
  return get<ClientRow>('SELECT * FROM clients WHERE org_id = ? AND portal_token = ?', [orgId, token]);
}

export { STAGE_LABELS, audit };
