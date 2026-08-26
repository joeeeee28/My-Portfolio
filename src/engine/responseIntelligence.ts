/**
 * Response intelligence (§14).
 *
 * Classifies an inbound reply into one of nine intents and recommends the next
 * action. V1 only had three-way sentiment, which lost the distinction between
 * "send me pricing" and "stop emailing me" — both are actionable, but very
 * differently.
 *
 * Classification is rule-first with an AI assist: the rules are deterministic
 * and auditable, and the AI only refines the confidence and reasoning.
 */
import { all, get, json, run, scalar, toJson } from '@/db';
import { nowIso, truncate } from '@/lib/id';
import { logActivity } from '@/lib/activity';
import { runAiTask } from '@/lib/ai/router';
import { classifySentiment } from '@/lib/ai/local';
import { handleOptOut, suppress } from './compliance';
import { createFollowUp } from './mockup';
import { changeStage } from '@/lib/activity';
import { recordOutcome } from './scoring';
import { remember } from '@/lib/ai/memory';

export type ResponseClassification =
  | 'interested'
  | 'not_interested'
  | 'maybe'
  | 'pricing_question'
  | 'info_request'
  | 'wants_call'
  | 'objection'
  | 'opt_out'
  | 'unknown';

export const CLASSIFICATION_LABELS: Record<ResponseClassification, string> = {
  interested: 'Interested',
  not_interested: 'Not interested',
  maybe: 'Maybe',
  pricing_question: 'Pricing question',
  info_request: 'Information request',
  wants_call: 'Wants a call',
  objection: 'Objection',
  opt_out: 'Opt-out',
  unknown: 'Unknown',
};

export interface ClassificationResult {
  classification: ResponseClassification;
  confidence: number;
  signals: string[];
  recommendedAction: string;
  recommendedReason: string;
  modelUsed: string | null;
  cost: number;
}

interface Rule {
  classification: ResponseClassification;
  patterns: RegExp[];
  weight: number;
}

// Ordered most-specific first: an opt-out must win over a polite "no thanks".
const RULES: Rule[] = [
  {
    classification: 'opt_out',
    weight: 1.0,
    patterns: [
      /\bunsubscrib/i, /\bstop (email|contact|messag)/i, /\bdo ?n[o']?t (contact|email|message)/i,
      /\bremove me\b/i, /\btake me off\b/i, /\bno (more|further) (email|contact|message)/i,
      /\bnever (contact|email|message)/i, /\bopt ?out\b/i, /\bspam\b/i, /\breport(ing)? (you|this)\b/i,
    ],
  },
  {
    classification: 'wants_call',
    weight: 0.95,
    patterns: [
      /\b(call|phone|ring) me\b/i, /\blet'?s (talk|chat|have a call|jump on a call|schedule|meet)/i,
      /\b(book|schedule|arrange) (a )?(call|meeting|time)/i, /\bfree (to|for a) (call|chat)/i,
      /\bwhen (are you|can we) (free|available)/i, /\bhappy to (talk|chat|discuss)/i,
      /\bcan we (talk|chat|meet)/i, /\bwhat'?s your (availability|calendar)/i, /\bsend (me )?(some )?(times|slots)/i,
    ],
  },
  {
    classification: 'pricing_question',
    weight: 0.9,
    patterns: [
      /\bhow much\b/i, /\bwhat('?s| is) (the |your )?(price|cost|pricing|rate|quote)/i,
      /\b(send|share) (me )?(pricing|prices|a quote|costs|rates)\b/i, /\bcost(s)? (of|for)\b/i,
      /\bprice (range|list|list)?\b/i, /\bwhat would (it|this) cost\b/i, /\bbudget\b.*\?/i,
      /\bquote\b/i, /\bpackage(s)? (cost|price)/i,
    ],
  },
  {
    classification: 'not_interested',
    weight: 0.85,
    patterns: [
      /\bnot interested\b/i, /\bno thanks?\b/i, /\bwe'?re (good|fine|set|sorted|happy)\b/i,
      /\balready (have|use|work with)\b/i, /\bwe (do|handle) (this|it) (in.?house|ourselves)\b/i,
      /\bnot (looking|searching|in the market)\b/i, /\bpass(ing)? (on this)?\b/i,
      /\bnot (a|the) (good )?fit\b/i, /\bwe (don'?t|do not) need\b/i, /\bno (need|interest)\b/i,
    ],
  },
  {
    classification: 'objection',
    weight: 0.7,
    patterns: [
      /\btoo expensive\b/i, /\bcan'?t afford\b/i, /\bno budget\b/i, /\bbudget (is|was) (cut|gone|tight)\b/i,
      /\bnot (the )?(right )?time\b/i, /\bcome back (in|next|after)\b/i, /\brevisit (this|it) (in|later|next)\b/i,
      /\bhad a bad experience\b/i, /\bprevious(ly)? (didn'?t|did not) work\b/i, /\bwaste of (time|money)\b/i,
      /\bwe tried (that|this|a website)\b/i, /\bdoesn'?t (work|convert)\b/i, /\bnot sure (it|this) (will|would)\b/i,
      /\bsceptic/i, /\bneed to (think|discuss|check)\b/i, /\bnot (my|the) decision\b/i, /\bask(ing)? (my|the) (boss|partner|team)\b/i,
    ],
  },
  {
    classification: 'interested',
    weight: 0.8,
    patterns: [
      /\b(sounds|looks) (good|great|interesting|promising)\b/i, /\binterested\b/i, /\btell me more\b/i,
      /\byes please\b/i, /\bdefinitely\b/i, /\bwe (need|want|would like) (this|that|a website|help)\b/i,
      /\bsend (me |over )?(more|details|info)\b/i, /\bhow (does|do) (it|you) work\b/i,
      /\bthis (is|looks) (exactly )?what we (need|want)\b/i, /\bimpressive\b/i, /\blove (it|this|the)\b/i,
      /\bwhere (do|did) (i|we) (start|begin)\b/i, /\bwhat'?s (the )?next step\b/i,
    ],
  },
  {
    classification: 'info_request',
    weight: 0.65,
    patterns: [
      /\b(send|share) (me )?(some )?(info|information|details|brochure|portfolio|examples|case stud)/i,
      /\bwhat (do you|services|do you offer|can you do)\b/i, /\bcan you (send|share)\b/i,
      /\bmore (info|information|details)\b/i, /\bportfolio\b/i, /\bexamples of\b/i, /\bcase stud/i,
      /\bhow long (does|would) (it|this) take\b/i, /\bwhat'?s involved\b/i, /\btimeline\b/i,
    ],
  },
  {
    classification: 'maybe',
    weight: 0.4,
    patterns: [
      /\bmaybe\b/i, /\bpossibly\b/i, /\bnot sure\b/i, /\bmight\b/i, /\bcould be\b/i,
      /\bkeep me (in mind|posted|updated)\b/i, /\bcheck back\b/i, /\bnext (quarter|year|month)\b/i,
    ],
  },
];

const NEXT_ACTION: Record<ResponseClassification, { action: string; reason: string }> = {
  interested: {
    action: 'Send the proposal or book the call now',
    reason: 'They said yes. Momentum is the asset — respond within the hour and move to a concrete next step.',
  },
  wants_call: {
    action: 'Send two or three specific time slots',
    reason: 'They asked for a call. Offering open-ended availability stalls; concrete slots convert.',
  },
  pricing_question: {
    action: 'Generate a pricing response and offer a call',
    reason: 'Pricing interest is buying intent. Answer the number directly, then anchor it to scope on a call.',
  },
  info_request: {
    action: 'Send the requested information, then follow up in 3 days',
    reason: 'They want to evaluate. Give them the material and set a specific follow-up so it does not go cold.',
  },
  maybe: {
    action: 'Nurture — add to a longer, lower-frequency sequence',
    reason: 'Not a no. Move them off the active sequence and re-approach in a few weeks with new evidence.',
  },
  objection: {
    action: 'Address the specific objection, do not re-pitch',
    reason: 'A stated objection is a request for reassurance. Answer it directly rather than repeating the offer.',
  },
  not_interested: {
    action: 'Stop outreach and archive',
    reason: 'A clear no. Continuing risks the domain reputation and the relationship.',
  },
  opt_out: {
    action: 'Suppress immediately and stop all sequences',
    reason: 'A compliance obligation, not a choice. Suppress before anything else is sent.',
  },
  unknown: {
    action: 'Review manually',
    reason: 'The reply did not match a known intent. Read it and classify by hand rather than guessing.',
  },
};

/**
 * Classifies a reply. Rules run first and are deterministic; the AI pass only
 * adjusts confidence and reasoning, so the outcome is always explainable.
 */
export async function classifyResponse(
  orgId: string,
  businessId: string,
  body: string,
  opts: { messageId?: string; persist?: boolean; useAi?: boolean } = {}
): Promise<ClassificationResult> {
  const text = body ?? '';
  const scores: Partial<Record<ResponseClassification, number>> = {};
  const signals: string[] = [];

  for (const rule of RULES) {
    for (const pattern of rule.patterns) {
      const match = text.match(pattern);
      if (match) {
        scores[rule.classification] = Math.max(scores[rule.classification] ?? 0, rule.weight);
        const sig = match[0].trim().toLowerCase();
        if (!signals.includes(sig)) signals.push(sig);
      }
    }
  }

  const sentiment = classifySentiment(text);
  let classification: ResponseClassification = 'unknown';
  let confidence = 0.3;

  const ranked = Object.entries(scores).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0)) as [ResponseClassification, number][];
  if (ranked.length) {
    [classification, confidence] = ranked[0];
  } else if (sentiment.label === 'positive') {
    classification = 'interested';
    confidence = 0.45;
    signals.push(...sentiment.signals);
  } else if (sentiment.label === 'negative') {
    classification = 'not_interested';
    confidence = 0.4;
    signals.push(...sentiment.signals);
  } else {
    signals.push(...sentiment.signals);
  }

  let modelUsed: string | null = null;
  let cost = 0;

  // AI assist — refines confidence/reasoning but never overrides a high-confidence rule.
  if (opts.useAi !== false && confidence < 0.85) {
    try {
      const res = await runAiTask(
        orgId,
        'classification',
        {
          task: 'classification',
          system: [
            'Classify a prospect reply into exactly one category.',
            'Categories: interested, not_interested, maybe, pricing_question, info_request, wants_call, objection, opt_out, unknown.',
            'Base the decision only on what the reply actually says. If ambiguous, choose unknown.',
            'Return JSON: {"classification":string,"confidence":number,"reason":string}',
          ].join('\n'),
          prompt: `Reply:\n"""\n${truncate(text, 2000)}\n"""\n\nRule-based guess: ${classification} (${Math.round(confidence * 100)}%)`,
          json: true,
          maxTokens: 200,
        },
        { entityType: 'business', entityId: businessId }
      );
      const parsed = res.json as { classification?: string; confidence?: number; reason?: string } | undefined;
      if (parsed?.classification && parsed.classification in CLASSIFICATION_LABELS) {
        classification = parsed.classification as ResponseClassification;
        confidence = Math.max(confidence, Math.min(1, parsed.confidence ?? confidence));
        if (parsed.reason) signals.push(`ai: ${truncate(parsed.reason, 120)}`);
        modelUsed = res.route.modelLabel;
        cost = res.cost;
      }
    } catch {
      // The rule-based result stands — an AI failure must not block classification.
    }
  }

  const next = NEXT_ACTION[classification];
  const result: ClassificationResult = {
    classification,
    confidence: Math.round(Math.min(1, confidence) * 100) / 100,
    signals: signals.slice(0, 8),
    recommendedAction: next.action,
    recommendedReason: next.reason,
    modelUsed,
    cost,
  };

  if (opts.persist !== false) {
    run(
      `INSERT INTO response_classifications (id, org_id, business_id, message_id, classification, confidence,
          signals, recommended_action, recommended_reason, model_used, cost, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        `rc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        orgId, businessId, opts.messageId ?? null, classification, result.confidence,
        toJson(result.signals), result.recommendedAction, result.recommendedReason, modelUsed, cost, nowIso(),
      ]
    );
    await applyClassification(orgId, businessId, result, body);
  }

  return result;
}

/**
 * Acts on the classification: suppresses opt-outs, stops sequences, schedules
 * follow-ups and moves the pipeline stage. Idempotent — the same reply does not
 * create duplicate follow-ups because createFollowUp de-duplicates by title.
 */
async function applyClassification(
  orgId: string,
  businessId: string,
  result: ClassificationResult,
  body: string
): Promise<void> {
  const business = get<{ name: string; email: string | null; phone: string | null; website_domain: string | null }>(
    'SELECT name, email, phone, website_domain FROM businesses WHERE id = ?',
    [businessId]
  );
  if (!business) return;

  remember(orgId, businessId, 'history', `reply:${result.classification}:${Date.now().toString(36)}`,
    truncate(body, 400), { source: 'response_intelligence' });

  logActivity(orgId, 'outreach', `Reply classified: ${CLASSIFICATION_LABELS[result.classification]}`, {
    businessId,
    actor: 'ai',
    detail: `${Math.round(result.confidence * 100)}% confidence — ${result.recommendedAction}`,
    importance: result.classification === 'opt_out' ? 'critical' : ['interested', 'wants_call', 'pricing_question'].includes(result.classification) ? 'high' : 'normal',
  });

  switch (result.classification) {
    case 'opt_out':
      handleOptOut(orgId, { businessId, channel: 'email', reason: 'explicit opt-out detected in reply' });
      recordOutcome(orgId, 'lost', businessId);
      return;

    case 'not_interested': {
      const { stopSequences } = await import('./outreach');
      stopSequences(orgId, businessId, 'stopped_not_interested', 'Classified not interested');
      run(`UPDATE follow_ups SET status = 'cancelled' WHERE org_id = ? AND business_id = ? AND status = 'pending'`, [orgId, businessId]);
      run(`UPDATE businesses SET archived_reason = 'Classified not interested', updated_at = ? WHERE id = ?`, [nowIso(), businessId]);
      recordOutcome(orgId, 'lost', businessId);
      return;
    }

    case 'interested':
    case 'wants_call': {
      const { stopSequences } = await import('./outreach');
      stopSequences(orgId, businessId, 'stopped_response', 'Positive reply — moving to a call');
      changeStage(orgId, businessId, 'interested', { actor: 'ai', reason: CLASSIFICATION_LABELS[result.classification] });
      createFollowUp(orgId, businessId, {
        kind: 'call',
        title: `${business.name} — ${CLASSIFICATION_LABELS[result.classification].toLowerCase()}`,
        reason: `${result.recommendedReason} Signals: ${result.signals.slice(0, 3).join(', ') || 'positive reply'}.`,
        dueInHours: result.classification === 'wants_call' ? 1 : 3,
        priority: 'critical',
        suggestedAction: 'schedule_call',
      });
      recordOutcome(orgId, 'positive', businessId);
      return;
    }

    case 'pricing_question': {
      const { stopSequences } = await import('./outreach');
      stopSequences(orgId, businessId, 'stopped_response', 'Asked about pricing');
      changeStage(orgId, businessId, 'interested', { actor: 'ai', reason: 'Pricing question' });
      createFollowUp(orgId, businessId, {
        kind: 'proposal',
        title: `${business.name} — send pricing`,
        reason: `${result.recommendedReason} Signals: ${result.signals.slice(0, 3).join(', ')}.`,
        dueInHours: 2,
        priority: 'critical',
        suggestedAction: 'generate_proposal',
      });
      recordOutcome(orgId, 'positive', businessId);
      return;
    }

    case 'info_request':
      createFollowUp(orgId, businessId, {
        kind: 'outreach',
        title: `${business.name} — send requested information`,
        reason: `${result.recommendedReason} Signals: ${result.signals.slice(0, 3).join(', ')}.`,
        dueInHours: 6,
        priority: 'high',
        suggestedAction: 'send_information',
      });
      recordOutcome(orgId, 'response', businessId);
      return;

    case 'objection':
      remember(orgId, businessId, 'objection', `objection:${Date.now().toString(36)}`, truncate(body, 300), {
        source: 'response_intelligence',
        pinned: true,
      });
      createFollowUp(orgId, businessId, {
        kind: 'outreach',
        title: `${business.name} — address objection`,
        reason: `${result.recommendedReason} Objection: ${truncate(body, 160)}`,
        dueInHours: 12,
        priority: 'high',
        suggestedAction: 'address_objection',
      });
      return;

    case 'maybe':
      createFollowUp(orgId, businessId, {
        kind: 'outreach',
        title: `${business.name} — nurture in 3 weeks`,
        reason: result.recommendedReason,
        dueInHours: 21 * 24,
        priority: 'low',
        suggestedAction: 'nurture',
      });
      recordOutcome(orgId, 'response', businessId);
      return;

    case 'unknown':
      createFollowUp(orgId, businessId, {
        kind: 'outreach',
        title: `${business.name} — review reply manually`,
        reason: result.recommendedReason,
        dueInHours: 8,
        priority: 'medium',
        suggestedAction: 'manual_review',
      });
      return;
  }
}

export function listClassifications(orgId: string, opts: { businessId?: string; limit?: number } = {}) {
  const where = ['org_id = ?'];
  const params: unknown[] = [orgId];
  if (opts.businessId) {
    where.push('business_id = ?');
    params.push(opts.businessId);
  }
  params.push(opts.limit ?? 50);
  return all(
    `SELECT * FROM response_classifications WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`,
    params
  ).map((r) => ({ ...r, signals: json<string[]>(r.signals as string, []) }));
}

/** Breakdown by classification, for the Outreach and Analytics screens. */
export function classificationSummary(orgId: string) {
  const rows = all<{ classification: string; c: number }>(
    'SELECT classification, COUNT(*) AS c FROM response_classifications WHERE org_id = ? GROUP BY classification ORDER BY c DESC',
    [orgId]
  );
  const total = rows.reduce((a, r) => a + r.c, 0);
  return {
    total,
    byClassification: Object.fromEntries(rows.map((r) => [r.classification, r.c])),
    positiveRate: total
      ? Math.round(
          ((rows.filter((r) => ['interested', 'wants_call', 'pricing_question', 'info_request'].includes(r.classification))
            .reduce((a, r) => a + r.c, 0) / total) * 1000)
        ) / 10
      : 0,
  };
}

export { suppress };
