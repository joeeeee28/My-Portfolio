/**
 * Forge AI — the global assistant (§45).
 *
 * Forge AI understands the whole lifecycle. Read-only questions are answered
 * immediately. Anything with an external consequence (sending, deploying,
 * publishing, bulk generating) is returned as a *proposed action* that the user
 * must authorise — Forge AI never takes an outside action on its own.
 */
import { all, get, json, run, scalar, toJson } from '@/db';
import { id, nowIso, round, truncate } from '@/lib/id';
import { relativeFromNow } from '@/lib/time';
import { BRAND, serviceLabel } from '@/lib/brand';
import { listBusinesses, type BusinessFilters } from '@/repo/business';
import { buildActionQueue, smartQueues } from './queues';
import { acquisitionFunnel, automationHealth, efficiencyAnalytics, revenueAnalytics } from './analytics';
import { buildDailyBriefing, topPriority } from './briefing';
import { computeSalesIntelligence, computeNba } from './nba';
import { outreachStats } from './outreach';
import { latestScore } from './scoring';
import { listUpsells } from './crm';
import { runAiTask } from '@/lib/ai/router';

export type Intent =
  | 'best_opportunities'
  | 'no_website_high_reviews'
  | 'mockup_viewed_no_reply'
  | 'generate_mockups_above'
  | 'follow_up_today'
  | 'likely_to_close'
  | 'competitor_gap'
  | 'upsell'
  | 'weekly_performance'
  | 'what_today'
  | 'why_high_opportunity'
  | 'create_outreach'
  | 'generate_concept'
  | 'prepare_calls'
  | 'generate_proposal'
  | 'pipeline_status'
  | 'automation_status'
  | 'cost_status'
  | 'unknown';

export interface ProposedAction {
  label: string;
  kind: string;
  payload: Record<string, unknown>;
  external: boolean;
  confirmation: string;
}

export interface CommandResult {
  runId: string;
  intent: Intent;
  answer: string;
  resultKind: 'list' | 'summary' | 'action_plan' | 'chart' | 'table';
  rows: Record<string, unknown>[];
  metrics: Record<string, string | number>[];
  proposedActions: ProposedAction[];
  aiNote: string | null;
}

const INTENT_PATTERNS: { intent: Intent; patterns: RegExp[] }[] = [
  { intent: 'best_opportunities', patterns: [/best opportunit/i, /top opportunit/i, /highest opportunit/i, /best prospects/i, /top prospects/i] },
  { intent: 'no_website_high_reviews', patterns: [/no website.*review/i, /review.*no website/i, /no site.*review/i] },
  { intent: 'mockup_viewed_no_reply', patterns: [/viewed.*(mockup|concept).*not respond/i, /concept.*viewed.*no reply/i, /mockup.*viewed.*didn/i, /who viewed/i] },
  { intent: 'generate_mockups_above', patterns: [/(generate|create|build).*(mockup|concept).*above/i, /(mockup|concept)s? for all/i] },
  { intent: 'follow_up_today', patterns: [/follow.?up/i, /who should i (contact|follow)/i] },
  { intent: 'likely_to_close', patterns: [/likely to close/i, /most likely.*deal/i, /close probability/i, /deals.*close/i] },
  { intent: 'competitor_gap', patterns: [/competitor/i] },
  { intent: 'upsell', patterns: [/upsell/i, /growth opportunit/i, /additional service/i, /sell.*existing client/i] },
  { intent: 'weekly_performance', patterns: [/week.*performance/i, /performance.*week/i, /summar.*(week|sales|performance)/i, /how (am|are) (i|we) doing/i] },
  { intent: 'what_today', patterns: [/what should i (work on|do) today/i, /today/i, /where (do i|should i) start/i] },
  { intent: 'why_high_opportunity', patterns: [/why.*(high|score|opportunit)/i, /explain.*score/i] },
  { intent: 'create_outreach', patterns: [/(create|write|draft|generate).*outreach/i, /(create|write|draft).*email/i, /message for/i] },
  { intent: 'generate_concept', patterns: [/(generate|create|build).*(website|concept|mockup)/i] },
  { intent: 'prepare_calls', patterns: [/(prepare|brief).*(call|meeting)/i, /calls today/i, /today'?s calls/i] },
  { intent: 'generate_proposal', patterns: [/(generate|create|draft|prepare).*proposal/i] },
  { intent: 'pipeline_status', patterns: [/pipeline/i, /funnel/i, /conversion rate/i] },
  { intent: 'automation_status', patterns: [/automation/i, /discovery (run|job|status)/i, /forge automation/i] },
  { intent: 'cost_status', patterns: [/cost/i, /spend/i, /budget/i] },
];

export function detectIntent(input: string): Intent {
  for (const { intent, patterns } of INTENT_PATTERNS) {
    if (patterns.some((p) => p.test(input))) return intent;
  }
  return 'unknown';
}

export async function runCommand(orgId: string, input: string, opts: { userId?: string; targetBusinessId?: string } = {}): Promise<CommandResult> {
  const intent = detectIntent(input);
  const parsed = parseParameters(input);
  const runId = id('cmd');
  const now = nowIso();

  let answer = '';
  let resultKind: CommandResult['resultKind'] = 'summary';
  let rows: Record<string, unknown>[] = [];
  let metrics: { label: string; value: string | number }[] = [];
  let proposedActions: ProposedAction[] = [];
  let aiNote: string | null = null;

  const row = (raw: unknown) => {
    const b = raw as Record<string, unknown>;
    return {
    id: b.id,
    name: b.name,
    category: b.category,
    locality: b.locality,
    score: b.opportunity_score,
    priority: b.priority,
    stage: b.stage,
    websiteStatus: b.website_status,
    rating: b.rating,
    reviewCount: b.review_count,
    service: serviceLabel(b.recommended_service as string | null),
    nextAction: b.next_best_action_reason,
    href: `/prospects/${b.id}`,
    isDemo: b.is_demo === 1,
  };
  };

  switch (intent) {
    case 'best_opportunities': {
      const limit = parsed.limit ?? 20;
      const { rows: found } = listBusinesses(orgId, {
        stages: ['discovered', 'qualified', 'outreach_ready', 'outreach_sent', 'engaged', 'interested', 'mockup_generated', 'mockup_shared', 'mockup_viewed', 'call_scheduled', 'call_completed', 'proposal_sent', 'negotiation'],
        sortBy: 'score',
        limit,
      });
      rows = found.map(row);
      resultKind = 'list';
      answer = found.length
        ? `Here are the ${found.length} highest-scoring opportunities. ${found[0].name} leads at ${found[0].opportunity_score ?? 0}/100 — ${truncate(String(found[0].next_best_action_reason ?? 'review the audit'), 120)}.`
        : 'No prospects in the hub yet. Run discovery to populate it.';
      break;
    }

    case 'no_website_high_reviews': {
      const minRating = parsed.rating ?? 4.3;
      const found = all<Record<string, unknown>>(
        `SELECT * FROM businesses WHERE org_id = ? AND website_status = 'missing' AND rating >= ? AND merged_into IS NULL AND is_archived = 0
          ORDER BY opportunity_score DESC LIMIT ?`,
        [orgId, minRating, parsed.limit ?? 25]
      );
      rows = found.map(row);
      resultKind = 'list';
      answer = found.length
        ? `${found.length} business(es) have no website and a rating of ${minRating}★ or better. These are the cleanest pitches available — the demand is proven and there is nothing to defend.`
        : `Nothing matches "no website + rating ≥ ${minRating}". Try lowering the rating threshold.`;
      break;
    }

    case 'mockup_viewed_no_reply': {
      const found = all<Record<string, unknown>>(
        `SELECT b.*, m.view_count, m.last_viewed_at FROM businesses b JOIN mockups m ON m.business_id = b.id
          WHERE b.org_id = ? AND m.view_count > 0 AND b.merged_into IS NULL
            AND NOT EXISTS (SELECT 1 FROM outreach_messages o WHERE o.business_id = b.id AND o.direction = 'inbound')
          ORDER BY m.view_count DESC, m.last_viewed_at DESC LIMIT ?`,
        [orgId, parsed.limit ?? 20]
      );
      rows = found.map((b) => ({ ...row(b), viewCount: b.view_count, lastViewedAt: b.last_viewed_at }));
      resultKind = 'list';
      answer = found.length
        ? `${found.length} prospect(s) opened their concept without replying. ${rows[0].name as string} has viewed it ${found[0].view_count} time(s) — that is the warmest signal in the pipeline.`
        : 'No concept views without a reply. Either nothing has been viewed, or everyone who viewed has responded.';
      proposedActions = found.slice(0, 10).map((b) => ({
        label: `Follow up with ${b.name}`,
        kind: 'follow_up',
        payload: { businessId: b.id },
        external: false,
        confirmation: `Create a follow-up task for ${b.name}?`,
      }));
      break;
    }

    case 'generate_mockups_above': {
      const threshold = parsed.score ?? 90;
      const found = all<{ id: string; name: string }>(
        `SELECT id, name FROM businesses WHERE org_id = ? AND opportunity_score >= ? AND merged_into IS NULL AND is_archived = 0
           AND NOT EXISTS (SELECT 1 FROM mockups m WHERE m.business_id = businesses.id)
         ORDER BY opportunity_score DESC LIMIT 25`,
        [orgId, threshold]
      );
      rows = found.map((f) => ({ id: f.id, name: f.name }));
      resultKind = 'action_plan';
      answer = found.length
        ? `${found.length} prospect(s) score ${threshold}+ and have no concept yet. Generating concepts is internal work — no external contact — but it does take time, so confirm first.`
        : `No prospects score ${threshold}+ without a concept already.`;
      if (found.length) {
        proposedActions = [
          {
            label: `Generate ${found.length} website concept${found.length === 1 ? '' : 's'}`,
            kind: 'bulk_generate_mockups',
            payload: { businessIds: found.map((f) => f.id) },
            external: false,
            confirmation: `Generate ${found.length} website concepts? This is internal work and sends nothing.`,
          },
        ];
      }
      break;
    }

    case 'follow_up_today': {
      const queue = buildActionQueue(orgId, { limit: 40 }).filter((q) => q.kind === 'Follow up' || q.kind === 'Follow Up' || q.action === 'follow_up');
      rows = queue.map((q) => ({ id: q.businessId, name: q.businessName, reason: q.reason, tone: q.tone, href: q.actionHref, score: q.score }));
      resultKind = 'list';
      answer = queue.length
        ? `${queue.length} follow-up${queue.length === 1 ? '' : 's'} need attention. Start with ${queue[0].businessName}: ${queue[0].reason}`
        : 'Nothing due for follow-up. The Action Queue is clear.';
      break;
    }

    case 'likely_to_close': {
      const found = all<Record<string, unknown>>(
        `SELECT * FROM businesses WHERE org_id = ? AND close_probability >= 0.3 AND merged_into IS NULL
           AND stage NOT IN ('lost','won','active_client') ORDER BY close_probability DESC LIMIT ?`,
        [orgId, parsed.limit ?? 15]
      );
      rows = found.map((b) => {
        const si = computeSalesIntelligence(orgId, b.id as string);
        return { ...row(b), closeProbability: b.close_probability, dealHealth: si?.dealHealth.label, risk: si?.salesRisk, revenuePotential: si?.revenuePotential };
      });
      resultKind = 'list';
      answer = found.length
        ? `${found.length} deal(s) have a close probability of 30% or more. ${found[0].name} is highest at ${round((found[0].close_probability as number) * 100, 0)}%.`
        : 'No deals currently above a 30% close probability.';
      break;
    }

    case 'competitor_gap': {
      const found = all<Record<string, unknown>>(
        `SELECT b.id, b.name, b.category, b.locality, b.opportunity_score, b.priority, b.website_status, b.rating, b.review_count,
                b.stage, b.recommended_service, b.next_best_action_reason, b.is_demo,
                c.name competitor, c.gap_score, c.gap_summary
           FROM businesses b JOIN competitors c ON c.business_id = b.id
          WHERE b.org_id = ? AND c.name <> '__cohort_summary__' AND c.gap_score > 0 AND b.merged_into IS NULL
          ORDER BY c.gap_score DESC LIMIT ?`,
        [orgId, parsed.limit ?? 20]
      );
      rows = found.map((f) => ({ ...row(f), competitor: f.competitor, gapScore: f.gap_score, gapSummary: f.gap_summary }));
      resultKind = 'list';
      answer = found.length
        ? `${found.length} prospect(s) are measurably behind an audited peer. This is the strongest evidence-led angle available because both sides were measured by us.`
        : 'No measured competitor gaps yet. Competitor analysis runs for prospects scoring 50+, using other audited businesses in the same category.';
      break;
    }

    case 'upsell': {
      const upsells = listUpsells(orgId, { status: 'identified', limit: 25 });
      rows = upsells.map((u) => ({ id: u.business_id, name: u.business_name, service: u.service, score: u.score, rationale: u.rationale, estMrr: u.estMrr, href: `/clients` }));
      resultKind = 'list';
      const totalMrr = upsells.reduce((a, u) => a + u.estMrr, 0);
      answer = upsells.length
        ? `${upsells.length} growth opportunit${upsells.length === 1 ? 'y' : 'ies'} across your clients, worth roughly $${round(totalMrr, 0)}/mo in additional recurring revenue if all converted. This is the cheapest revenue you have — no discovery, no cold outreach.`
        : 'No growth opportunities identified yet. They appear once you have active clients with delivered work.';
      break;
    }

    case 'weekly_performance': {
      const funnel = acquisitionFunnel(orgId);
      const revenue = revenueAnalytics(orgId);
      const outreach = outreachStats(orgId, new Date(Date.now() - 7 * 86_400_000).toISOString());
      const eff = efficiencyAnalytics(orgId);
      metrics = [
        { label: 'Prospects discovered', value: funnel.discovered },
        { label: 'Qualified', value: funnel.qualified },
        { label: 'Contacted', value: funnel.contacted },
        { label: 'Replies', value: funnel.responded },
        { label: 'Concepts generated', value: funnel.mockups },
        { label: 'Calls', value: funnel.calls },
        { label: 'Proposals', value: funnel.proposals },
        { label: 'Won', value: funnel.won },
        { label: 'MRR', value: `$${round(revenue.mrr, 0)}` },
        { label: 'Pipeline value', value: `$${round(revenue.pipelineValue, 0)}` },
        { label: 'Cost per prospect', value: eff.costPerProspect !== null ? `$${eff.costPerProspect}` : 'n/a' },
      ];
      resultKind = 'summary';
      const worst = [...funnel.funnel].filter((s, i) => i > 0 && s.conversionFromPrev !== null && funnel.funnel[i - 1].count >= 3).sort((a, b) => (a.conversionFromPrev ?? 0) - (b.conversionFromPrev ?? 0))[0];
      answer = [
        `${funnel.discovered} prospects discovered, ${funnel.qualified} qualified, ${funnel.contacted} contacted, ${funnel.responded} replied, ${funnel.won} won.`,
        outreach.sent ? `Outreach: ${outreach.sent} sent, ${outreach.replyRate}% reply rate, ${outreach.openRate}% open rate.` : 'No outreach sent this week.',
        revenue.mrr ? `Recurring revenue is $${round(revenue.mrr, 0)}/mo across ${revenue.activeClients} active client(s).` : 'No recurring revenue yet.',
        worst && (worst.conversionFromPrev ?? 0) < 30
          ? `The weakest step is ${funnel.funnel[funnel.funnel.indexOf(worst) - 1].label} → ${worst.label} at ${worst.conversionFromPrev}%. That is where effort moves the most revenue.`
          : 'Conversion is even across the funnel — no single obvious leak.',
      ].join(' ');
      break;
    }

    case 'what_today': {
      const briefing = buildDailyBriefing(orgId);
      const queue = buildActionQueue(orgId, { limit: 8 });
      rows = queue.map((q) => ({ id: q.businessId, name: q.businessName, kind: q.kind, reason: q.reason, tone: q.tone, href: q.actionHref, action: q.actionLabel }));
      metrics = briefing.sections.map((s) => ({ label: s.label, value: s.value }));
      resultKind = 'action_plan';
      answer = `${briefing.headline} ${briefing.subheadline}${briefing.topAction ? ` Your highest-priority action: ${briefing.topAction.title} — ${briefing.topAction.detail}` : ''}`;
      break;
    }

    case 'why_high_opportunity': {
      const businessId = opts.targetBusinessId ?? (parsed.businessName ? findBusinessByName(orgId, parsed.businessName) : null);
      if (!businessId) {
        answer = 'Which business? Name it and Forge AI will walk through the score.';
        break;
      }
      const score = latestScore(orgId, businessId);
      const business = get<Record<string, unknown>>('SELECT * FROM businesses WHERE id = ?', [businessId]);
      if (!score || !business) {
        answer = 'No score on record for that business yet. Run discovery or score it manually.';
        break;
      }
      rows = (score.breakdown as { label: string; score: number; weight: number; contribution: number; evidence: string[] }[]).map((b) => ({
        factor: b.label,
        score: b.score,
        weight: `${round(b.weight * 100, 0)}%`,
        contribution: b.contribution,
        evidence: b.evidence.join(' · '),
      }));
      resultKind = 'table';
      metrics = [
        { label: 'Opportunity Score', value: score.total },
        { label: 'Priority', value: score.priority },
        { label: 'Recommended service', value: serviceLabel(business.recommended_service as string | null) },
      ];
      answer = `${business.name} scores ${score.total}/100 (${score.priority}). The strongest factors: ${(score.breakdown as { label: string; contribution: number }[]).sort((a, b) => b.contribution - a.contribution).slice(0, 3).map((b) => `${b.label} (+${b.contribution})`).join(', ')}. ${(score.reasons as string[]).slice(0, 3).join(' ')}`;
      break;
    }

    case 'create_outreach': {
      const businessId = opts.targetBusinessId ?? (parsed.businessName ? findBusinessByName(orgId, parsed.businessName) : null);
      if (!businessId) {
        answer = 'Which prospect should I draft outreach for?';
        break;
      }
      const business = get<Record<string, unknown>>('SELECT * FROM businesses WHERE id = ?', [businessId]);
      resultKind = 'action_plan';
      answer = `I can draft a grounded ${parsed.tone ?? 'professional'} message for ${business?.name ?? 'that prospect'} using their audit findings. Nothing is sent until you approve it.`;
      proposedActions = [
        {
          label: `Draft outreach for ${business?.name ?? 'prospect'}`,
          kind: 'generate_outreach',
          payload: { businessId, tone: parsed.tone ?? 'professional' },
          external: false,
          confirmation: `Draft an outreach message for ${business?.name}? Drafting sends nothing.`,
        },
      ];
      break;
    }

    case 'generate_concept': {
      const businessId = opts.targetBusinessId ?? (parsed.businessName ? findBusinessByName(orgId, parsed.businessName) : null);
      if (!businessId) {
        answer = 'Which prospect should I build a concept for?';
        break;
      }
      const business = get<Record<string, unknown>>('SELECT * FROM businesses WHERE id = ?', [businessId]);
      resultKind = 'action_plan';
      answer = `I can build a ${BRAND.conceptLabel} for ${business?.name ?? 'that prospect'} from their real record — services, reviews and contact details. Anything missing is flagged for you rather than invented.`;
      proposedActions = [
        {
          label: `Generate concept for ${business?.name ?? 'prospect'}`,
          kind: 'generate_mockup',
          payload: { businessId },
          external: false,
          confirmation: `Generate a website concept for ${business?.name}?`,
        },
      ];
      break;
    }

    case 'prepare_calls': {
      const calls = all<Record<string, unknown>>(
        `SELECT c.*, b.name business_name, b.opportunity_score FROM calls c JOIN businesses b ON b.id = c.business_id
          WHERE c.org_id = ? AND c.status = 'scheduled' AND c.scheduled_at BETWEEN ? AND ? ORDER BY c.scheduled_at ASC`,
        [orgId, nowIso(), new Date(Date.now() + 86_400_000).toISOString()]
      );
      rows = calls.map((c) => ({
        id: c.business_id,
        name: c.business_name,
        title: c.title,
        scheduledAt: c.scheduled_at,
        when: relativeFromNow(c.scheduled_at as string),
        score: c.opportunity_score,
        href: `/prospects/${c.business_id}?tab=calls`,
      }));
      resultKind = 'list';
      answer = calls.length
        ? `${calls.length} call(s) in the next 24 hours. First is ${calls[0].business_name} ${relativeFromNow(calls[0].scheduled_at as string)}.`
        : 'No calls in the next 24 hours.';
      proposedActions = calls.slice(0, 5).map((c) => ({
        label: `Prepare briefing — ${c.business_name}`,
        kind: 'generate_briefing',
        payload: { businessId: c.business_id, callId: c.id },
        external: false,
        confirmation: `Generate the call briefing for ${c.business_name}?`,
      }));
      break;
    }

    case 'generate_proposal': {
      const businessId = opts.targetBusinessId ?? (parsed.businessName ? findBusinessByName(orgId, parsed.businessName) : null);
      if (!businessId) {
        answer = 'Which prospect is the proposal for?';
        break;
      }
      const business = get<Record<string, unknown>>('SELECT * FROM businesses WHERE id = ?', [businessId]);
      const call = get<{ id: string; requirements: string }>("SELECT id, requirements FROM calls WHERE business_id = ? AND status = 'completed' ORDER BY completed_at DESC LIMIT 1", [businessId]);
      resultKind = 'action_plan';
      answer = call
        ? `I can draft a proposal for ${business?.name} from the completed call — ${json<string[]>(call.requirements, []).length} requirement(s) recorded. It stays in draft until you send it.`
        : `No completed call on record for ${business?.name}. A proposal can still be drafted from the audit, but it will be less specific.`;
      proposedActions = [
        {
          label: `Draft proposal for ${business?.name ?? 'prospect'}`,
          kind: 'generate_proposal',
          payload: { businessId, callId: call?.id },
          external: false,
          confirmation: `Draft a proposal for ${business?.name}? Nothing is sent until you send it.`,
        },
      ];
      break;
    }

    case 'pipeline_status': {
      const funnel = acquisitionFunnel(orgId);
      rows = funnel.funnel.map((s) => ({ step: s.label, count: s.count, fromPrevious: s.conversionFromPrev !== null ? `${s.conversionFromPrev}%` : '—', fromTop: `${s.conversionFromTop}%` }));
      metrics = [{ label: 'End-to-end conversion', value: `${funnel.funnel[funnel.funnel.length - 1].conversionFromTop}%` }];
      resultKind = 'table';
      answer = `${funnel.discovered} prospects in, ${funnel.won} won — ${funnel.funnel[funnel.funnel.length - 1].conversionFromTop}% end to end.`;
      break;
    }

    case 'automation_status': {
      const health = automationHealth(orgId);
      metrics = [
        { label: 'Status', value: health.enabled ? 'Active' : 'Paused' },
        { label: 'Last run', value: health.lastRunAt ? relativeFromNow(health.lastRunAt) : 'never' },
        { label: 'Next run', value: health.nextRunAt ? relativeFromNow(health.nextRunAt) : 'not scheduled' },
        { label: 'Success rate', value: `${health.successRate}%` },
        { label: 'Avg runtime', value: `${round(health.avgRuntimeMs / 1000, 1)}s` },
        { label: 'Unresolved errors', value: health.errors.reduce((a, e) => a + e.unresolved, 0) },
      ];
      resultKind = 'summary';
      answer = `${BRAND.automation} is ${health.enabled ? 'active' : 'paused'}. ${health.runs} run(s) recorded, ${health.successRate}% successful. ${health.errors.filter((e) => e.unresolved > 0).length ? `${health.errors.filter((e) => e.unresolved > 0).length} error categor${health.errors.filter((e) => e.unresolved > 0).length === 1 ? 'y' : 'ies'} need attention.` : 'No unresolved errors.'}`;
      break;
    }

    case 'cost_status': {
      const eff = efficiencyAnalytics(orgId);
      metrics = [
        { label: 'Total cost', value: `$${eff.totalCost}` },
        { label: 'Cost per prospect', value: eff.costPerProspect !== null ? `$${eff.costPerProspect}` : 'n/a' },
        { label: 'Cost per qualified prospect', value: eff.costPerQualifiedProspect !== null ? `$${eff.costPerQualifiedProspect}` : 'n/a' },
        { label: 'Cost per customer', value: eff.costPerCustomer !== null ? `$${eff.costPerCustomer}` : 'n/a' },
        { label: 'Cost per concept', value: eff.costPerMockup !== null ? `$${eff.costPerMockup}` : 'n/a' },
      ];
      resultKind = 'summary';
      answer = `Total spend is $${eff.totalCost}. ${eff.costPerQualifiedProspect !== null ? `Each qualified prospect costs $${eff.costPerQualifiedProspect}.` : 'Not enough data for unit economics yet.'}`;
      break;
    }

    default: {
      // Unknown intent — fall back to the AI layer for a grounded answer.
      const top = topPriority(orgId);
      const queueCount = buildActionQueue(orgId, { limit: 100 }).length;
      const res = await runAiTask(
        orgId,
        'command',
        {
          task: 'command',
          system: 'You are Forge AI, the assistant inside ClientForge AI. Answer briefly using only the supplied state. If you cannot answer, say what you would need.',
          prompt: `User asked: "${input}"\n\nCurrent state:\n- ${queueCount} items in the Action Queue\n- Top prospect: ${top ? `${top.name} (${top.opportunity_score}/100) — ${top.reason ?? ''}` : 'none'}\n- ${JSON.stringify(smartQueues(orgId).map((q) => ({ [q.key]: q.count })))}`,
          maxTokens: 300,
        },
        { entityType: 'command' }
      );
      aiNote = res.text || null;
      answer = res.text || 'I did not recognise that. Try: "find my best opportunities", "who should I follow up with today", "what should I work on today", or "why is <business> a high opportunity".';
      resultKind = 'summary';
    }
  }

  run(
    `INSERT INTO command_runs (id, org_id, user_id, input, intent, parsed, result_kind, result, proposed_actions, authorized, executed, cost, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,0,0,0,?)`,
    [runId, orgId, opts.userId ?? null, input, intent, toJson(parsed), resultKind, toJson({ answer, rows: rows.slice(0, 50), metrics }), toJson(proposedActions), now]
  );

  return { runId, intent, answer, resultKind, rows, metrics, proposedActions, aiNote };
}

function parseParameters(input: string): { limit?: number; score?: number; rating?: number; businessName?: string; tone?: string } {
  const out: { limit?: number; score?: number; rating?: number; businessName?: string; tone?: string } = {};
  const limit = input.match(/\b(\d{1,3})\s+(best|top|highest|opportunit|prospect)/i) ?? input.match(/\btop\s+(\d{1,3})\b/i);
  if (limit) out.limit = Number(limit[1]);
  const above = input.match(/above\s+(\d{1,3})/i) ?? input.match(/(\d{1,3})\s*\+/);
  if (above) out.score = Number(above[1]);
  const rating = input.match(/(\d(?:\.\d)?)\s*(?:★|star)/i);
  if (rating) out.rating = Number(rating[1]);
  const tone = input.match(/\b(friendly|professional|direct|value[- ]first|consultative)\b/i);
  if (tone) out.tone = tone[1].toLowerCase().replace(/[- ]/, '_');
  const quoted = input.match(/["“]([^"”]+)["”]/);
  if (quoted) out.businessName = quoted[1];
  else {
    const forMatch = input.match(/\bfor\s+([A-Z][\w&'.-]+(?:\s+[A-Z][\w&'.-]+){0,3})/);
    if (forMatch) out.businessName = forMatch[1];
  }
  return out;
}

function findBusinessByName(orgId: string, name: string): string | null {
  const exact = get<{ id: string }>('SELECT id FROM businesses WHERE org_id = ? AND LOWER(name) = LOWER(?)', [orgId, name]);
  if (exact) return exact.id;
  const partial = get<{ id: string }>('SELECT id FROM businesses WHERE org_id = ? AND name LIKE ? ORDER BY opportunity_score DESC LIMIT 1', [orgId, `%${name}%`]);
  return partial?.id ?? null;
}

/** Executes an authorised proposed action. Only called after explicit user consent. */
export async function executeProposedAction(
  orgId: string,
  runId: string,
  action: ProposedAction,
  opts: { actor?: string } = {}
): Promise<{ ok: boolean; message: string }> {
  const now = nowIso();
  try {
    switch (action.kind) {
      case 'generate_mockup': {
        const { generateMockup } = await import('./mockup');
        await generateMockup(orgId, String(action.payload.businessId), { actor: opts.actor ?? 'forge-ai' });
        return { ok: true, message: 'Website concept generated.' };
      }
      case 'bulk_generate_mockups': {
        const ids = (action.payload.businessIds as string[]) ?? [];
        const { generateMockup } = await import('./mockup');
        let ok = 0;
        for (const bid of ids) {
          try {
            await generateMockup(orgId, bid, { actor: opts.actor ?? 'forge-ai' });
            ok++;
          } catch {
            /* recorded by generateMockup's own logging */
          }
        }
        return { ok: true, message: `${ok} of ${ids.length} concepts generated.` };
      }
      case 'generate_outreach': {
        const { generateOutreach } = await import('./outreach');
        const res = await generateOutreach(orgId, String(action.payload.businessId), {
          tone: (action.payload.tone as never) ?? 'professional',
          actor: 'forge-ai',
        });
        return {
          ok: !!res?.messageId,
          message: res?.compliance.allowed
            ? 'Draft created. Approve it in Outreach to send.'
            : `Draft held: ${res?.compliance.reasons[0] ?? 'blocked by compliance'}`,
        };
      }
      case 'generate_briefing': {
        const { generateCallBriefing } = await import('./crm');
        await generateCallBriefing(orgId, String(action.payload.businessId), action.payload.callId as string | undefined);
        return { ok: true, message: 'Call briefing generated.' };
      }
      case 'generate_proposal': {
        const { generateProposal } = await import('./crm');
        await generateProposal(orgId, String(action.payload.businessId), {
          callId: action.payload.callId as string | undefined,
          actor: opts.actor ?? 'forge-ai',
        });
        return { ok: true, message: 'Proposal drafted. It stays in draft until you send it.' };
      }
      case 'follow_up': {
        const { createFollowUp } = await import('./mockup');
        createFollowUp(orgId, String(action.payload.businessId), {
          kind: 'outreach',
          title: 'Follow up',
          reason: 'Requested from Forge AI.',
          dueInHours: 4,
          priority: 'high',
        });
        return { ok: true, message: 'Follow-up created.' };
      }
      default:
        return { ok: false, message: `Unknown action kind: ${action.kind}` };
    }
  } finally {
    run('UPDATE command_runs SET authorized = 1, executed = 1, execution_result = ? WHERE id = ?', [
      toJson({ kind: action.kind, at: now, actor: opts.actor ?? 'user' }),
      runId,
    ]);
  }
}

export interface CommandRunRow {
  id: string;
  org_id: string;
  user_id: string | null;
  input: string;
  intent: string;
  result_kind: string;
  authorized: number;
  executed: number;
  cost: number;
  created_at: string;
  result: Record<string, unknown>;
  proposed_actions: ProposedAction[];
}

export function listCommandRuns(orgId: string, limit = 50): CommandRunRow[] {
  return all<Omit<CommandRunRow, 'result' | 'proposed_actions'> & { result: string; proposed_actions: string }>(
    'SELECT * FROM command_runs WHERE org_id = ? ORDER BY created_at DESC LIMIT ?',
    [orgId, limit]
  ).map((r) => ({
    ...r,
    result: json<Record<string, unknown>>(r.result, {}),
    proposed_actions: json<ProposedAction[]>(r.proposed_actions, []),
  }));
}

/** Suggested prompts for the Forge AI surface. */
export const SUGGESTED_COMMANDS = [
  'Find my best opportunities.',
  'What should I work on today?',
  'Which businesses have no website and high reviews?',
  'Show prospects who viewed their concept but did not respond.',
  'Who should I follow up with today?',
  'What deals are most likely to close?',
  'Show businesses where competitors have much better websites.',
  'Which clients have growth opportunities?',
  'Summarise this week’s sales performance.',
  'Prepare me for today’s calls.',
  'What is Forge Automation doing?',
  'What does acquisition cost per prospect?',
];
