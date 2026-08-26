/**
 * Daily briefing (§46) and the dashboard Action Center (§59).
 *
 * Written in ClientForge voice: what was found, what needs a decision, and the
 * single highest-priority action to take first.
 */
import { all, get, run, scalar, toJson } from '@/db';
import { id, nowIso, round, truncate } from '@/lib/id';
import { todayKey } from '@/lib/time';
import { BRAND } from '@/lib/brand';
import { buildActionQueue, actionQueueCounts, newOpportunities, smartQueues } from './queues';
import { acquisitionFunnel, automationHealth, revenueAnalytics } from './analytics';
import { outreachStats } from './outreach';
import { computeSalesIntelligence } from './nba';
import { serviceLabel } from '@/lib/brand';

export interface BriefingSection {
  label: string;
  value: number | string;
  detail: string;
  href: string;
  tone?: 'critical' | 'high' | 'medium' | 'good' | 'neutral';
}

export interface DailyBriefing {
  forDate: string;
  greeting: string;
  headline: string;
  subheadline: string;
  sections: BriefingSection[];
  topAction: { title: string; detail: string; href: string } | null;
  priorityList: { rank: number; label: string; detail: string; href: string }[];
  aiInsights: string[];
  generatedAt: string;
}

export function buildDailyBriefing(orgId: string, opts: { regenerate?: boolean } = {}): DailyBriefing {
  const forDate = todayKey();
  if (!opts.regenerate) {
    const cached = get<{ payload: string }>('SELECT payload FROM briefings WHERE org_id = ? AND for_date = ?', [orgId, forDate]);
    if (cached) {
      try {
        return JSON.parse(cached.payload) as DailyBriefing;
      } catch {
        /* fall through and rebuild */
      }
    }
  }

  const overnightSince = new Date(Date.now() - 18 * 3_600_000).toISOString();
  const queue = buildActionQueue(orgId, { limit: 60 });
  const counts = actionQueueCounts(orgId);
  const queues = smartQueues(orgId);
  const automation = automationHealth(orgId);
  const outreach = outreachStats(orgId, overnightSince);
  const revenue = revenueAnalytics(orgId);

  const newOpportunityCount =
    scalar<number>(
      `SELECT COUNT(*) FROM businesses WHERE org_id = ? AND first_discovered_at >= ? AND merged_into IS NULL`,
      [orgId, overnightSince]
    ) ?? 0;
  const highWebsite =
    scalar<number>(
      `SELECT COUNT(*) FROM businesses WHERE org_id = ? AND first_discovered_at >= ? AND website_status IN ('missing','unreachable','parked')
         AND opportunity_score >= 60`,
      [orgId, overnightSince]
    ) ?? 0;
  const strongSocial =
    scalar<number>(
      `SELECT COUNT(*) FROM businesses b WHERE b.org_id = ? AND b.first_discovered_at >= ?
         AND EXISTS (SELECT 1 FROM social_audits s WHERE s.business_id = b.id AND s.social_score < 45) AND b.opportunity_score >= 60`,
      [orgId, overnightSince]
    ) ?? 0;
  const readyForOutreach = queues.find((q) => q.key === 'ready_for_outreach')?.count ?? 0;
  const conceptsViewed =
    scalar<number>(
      `SELECT COUNT(DISTINCT m.business_id) FROM mockups m JOIN mockup_views v ON v.mockup_id = m.id
        WHERE m.org_id = ? AND v.viewed_at >= ?`,
      [orgId, overnightSince]
    ) ?? 0;
  const callsToday =
    scalar<number>(
      `SELECT COUNT(*) FROM calls WHERE org_id = ? AND status = 'scheduled' AND substr(scheduled_at,1,10) = ?`,
      [orgId, forDate]
    ) ?? 0;
  const proposalsAwaiting =
    scalar<number>(`SELECT COUNT(*) FROM proposals WHERE org_id = ? AND status IN ('sent','viewed')`, [orgId]) ?? 0;
  const deliveryRisks = queues.find((q) => q.key === 'delivery_risks')?.count ?? 0;
  const followUpsDue = queues.find((q) => q.key === 'follow_up_today')?.count ?? 0;
  const activeProjects = scalar<number>(`SELECT COUNT(*) FROM projects WHERE org_id = ? AND status = 'active'`, [orgId]) ?? 0;

  const headline = newOpportunityCount > 0
    ? `Good morning. ${BRAND.markPrimary} found ${newOpportunityCount} new opportunit${newOpportunityCount === 1 ? 'y' : 'ies'} overnight.`
    : `Good morning. Here's what ${BRAND.markPrimary} has for you.`;

  const subParts: string[] = [];
  if (highWebsite) subParts.push(`${highWebsite} have a high website opportunity.`);
  if (strongSocial) subParts.push(`${strongSocial} have strong social-media potential.`);
  if (readyForOutreach) subParts.push(`${readyForOutreach} are ready for outreach.`);
  if (conceptsViewed) subParts.push(`${conceptsViewed} prospect${conceptsViewed === 1 ? '' : 's'} viewed their website concept${conceptsViewed === 1 ? '' : 's'}.`);
  if (callsToday) subParts.push(`${callsToday} call${callsToday === 1 ? '' : 's'} scheduled today.`);
  if (proposalsAwaiting) subParts.push(`${proposalsAwaiting} proposal${proposalsAwaiting === 1 ? '' : 's'} awaiting a response.`);
  const subheadline = subParts.join(' ') || 'Nothing urgent overnight — the Action Queue is clear.';

  const sections: BriefingSection[] = [
    {
      label: 'New Opportunities',
      value: newOpportunityCount,
      detail: highWebsite ? `${highWebsite} with a high website opportunity` : 'Discovered since the last run',
      href: '/prospects?sort=score',
      tone: newOpportunityCount > 0 ? 'good' : 'neutral',
    },
    {
      label: 'Follow-ups',
      value: followUpsDue,
      detail: followUpsDue ? 'Due today or overdue' : 'Nothing due',
      href: '/prospects?queue=follow_up_today',
      tone: followUpsDue > 0 ? (followUpsDue > 6 ? 'critical' : 'high') : 'neutral',
    },
    {
      label: 'Hot Prospects',
      value: queues.find((q) => q.key === 'hot_prospects')?.count ?? 0,
      detail: 'Responded, engaged, or viewed their concept',
      href: '/prospects?queue=hot_prospects',
      tone: 'high',
    },
    {
      label: 'Concepts Viewed',
      value: conceptsViewed,
      detail: conceptsViewed ? 'Warmest signal available — follow up now' : 'No concept views overnight',
      href: '/mockups',
      tone: conceptsViewed > 0 ? 'critical' : 'neutral',
    },
    {
      label: 'Calls Today',
      value: callsToday,
      detail: callsToday ? 'Briefings ready' : 'No calls scheduled',
      href: '/calls',
      tone: callsToday > 0 ? 'high' : 'neutral',
    },
    {
      label: 'Proposals',
      value: proposalsAwaiting,
      detail: proposalsAwaiting ? 'Awaiting a response' : 'Nothing outstanding',
      href: '/proposals',
      tone: proposalsAwaiting > 0 ? 'medium' : 'neutral',
    },
    {
      label: 'Active Projects',
      value: activeProjects,
      detail: deliveryRisks ? `${deliveryRisks} at risk or delayed` : 'All on track',
      href: '/projects',
      tone: deliveryRisks > 0 ? 'critical' : 'good',
    },
    {
      label: 'Growth Opportunities',
      value: queues.find((q) => q.key === 'growth_opportunities')?.count ?? 0,
      detail: 'Upsell potential across existing clients',
      href: '/clients?tab=growth',
      tone: 'medium',
    },
    {
      label: 'Forge Automation',
      value: automation.enabled ? 'Active' : 'Paused',
      detail: automation.enabled
        ? `${automation.successRate}% success over ${automation.runs} run${automation.runs === 1 ? '' : 's'}`
        : 'Enable in Settings to run daily discovery',
      href: '/automation',
      tone: automation.enabled ? (automation.failureRate > 20 ? 'high' : 'good') : 'critical',
    },
  ];

  // Top action — the single most valuable thing to do next.
  const top = queue[0];
  const topAction = top
    ? { title: `${top.kind}: ${top.title}`, detail: top.reason, href: top.actionHref }
    : null;

  const priorityList = queue.slice(0, 5).map((q, i) => ({
    rank: i + 1,
    label: `${q.kind} — ${q.title}`,
    detail: q.reason,
    href: q.actionHref,
  }));

  const aiInsights = buildInsights(orgId, {
    newOpportunityCount,
    highWebsite,
    strongSocial,
    conceptsViewed,
    followUpsDue,
    deliveryRisks,
    outreach,
    revenue,
    automation,
  });

  const briefing: DailyBriefing = {
    forDate,
    greeting: `Good morning`,
    headline,
    subheadline,
    sections,
    topAction,
    priorityList,
    aiInsights,
    generatedAt: nowIso(),
  };

  const now = nowIso();
  const existing = get<{ id: string }>('SELECT id FROM briefings WHERE org_id = ? AND for_date = ?', [orgId, forDate]);
  if (existing) {
    run('UPDATE briefings SET payload = ?, generated_at = ? WHERE id = ?', [toJson(briefing), now, existing.id]);
  } else {
    run('INSERT INTO briefings (id, org_id, for_date, payload, generated_at, created_at) VALUES (?,?,?,?,?,?)', [
      id('brf'), orgId, forDate, toJson(briefing), now, now,
    ]);
  }
  return briefing;
}

function buildInsights(
  orgId: string,
  ctx: {
    newOpportunityCount: number;
    highWebsite: number;
    strongSocial: number;
    conceptsViewed: number;
    followUpsDue: number;
    deliveryRisks: number;
    outreach: ReturnType<typeof outreachStats>;
    revenue: ReturnType<typeof revenueAnalytics>;
    automation: ReturnType<typeof automationHealth>;
  }
): string[] {
  const out: string[] = [];

  if (ctx.conceptsViewed > 0) {
    const hot = all<{ name: string; view_count: number; business_id: string }>(
      `SELECT b.name, m.view_count, m.business_id FROM mockups m JOIN businesses b ON b.id = m.business_id
        WHERE m.org_id = ? AND m.view_count >= 2 ORDER BY m.view_count DESC LIMIT 1`,
      [orgId]
    )[0];
    out.push(
      hot
        ? `${hot.name} has opened their website concept ${hot.view_count} times without replying. This is the highest-intent signal in the pipeline — reach out today.`
        : `${ctx.conceptsViewed} prospect(s) opened their concept. Follow up while the idea is fresh.`
    );
  }

  if (ctx.outreach.sent > 0 && ctx.outreach.replyRate > 0) {
    out.push(
      `Outreach is converting at ${ctx.outreach.replyRate}% reply rate across ${ctx.outreach.sent} message${ctx.outreach.sent === 1 ? '' : 's'}. ${
        ctx.outreach.simulated > 0
          ? `${ctx.outreach.simulated} of those were queued in the local outbox — connect a provider in Settings → Integrations to send for real.`
          : ''
      }`
    );
  }

  const funnel = acquisitionFunnel(orgId);
  const worst = [...funnel.funnel]
    .filter((s, i) => i > 0 && s.conversionFromPrev !== null && funnel.funnel[i - 1].count >= 5)
    .sort((a, b) => (a.conversionFromPrev ?? 0) - (b.conversionFromPrev ?? 0))[0];
  if (worst && (worst.conversionFromPrev ?? 0) < 25) {
    out.push(
      `The weakest step in the pipeline is ${funnel.funnel[funnel.funnel.indexOf(worst) - 1].label} → ${worst.label} at ${worst.conversionFromPrev}%. That is where effort will move the most revenue.`
    );
  }

  if (ctx.deliveryRisks > 0) {
    out.push(`${ctx.deliveryRisks} project${ctx.deliveryRisks === 1 ? ' is' : 's are'} at risk. Delivery problems cost more than lost prospects — protect the existing revenue first.`);
  }

  if (ctx.highWebsite > 0 && ctx.strongSocial > 0) {
    out.push(`Of the new opportunities, ${ctx.highWebsite} have a website gap and ${ctx.strongSocial} a social gap. Bundling both into a Digital Presence package is the highest-value pitch available today.`);
  }

  if (ctx.automation.failureRate > 15) {
    out.push(`Forge Automation is failing ${ctx.automation.failureRate}% of runs. Check the error log before relying on overnight discovery.`);
  }

  if (ctx.revenue.mrr > 0) {
    out.push(`Recurring revenue is $${round(ctx.revenue.mrr, 0)}/mo across ${ctx.revenue.activeClients} active client${ctx.revenue.activeClients === 1 ? '' : 's'}. Growth Opportunities are the cheapest revenue you have.`);
  }

  if (!out.length) {
    out.push('No urgent signals. Use the time on the highest-scoring prospects in the Prospect Hub — the queue is otherwise clear.');
  }
  return out.slice(0, 5);
}

/** The dashboard Action Center payload (§59). */
export function actionCenter(orgId: string) {
  const briefing = buildDailyBriefing(orgId);
  const queue = buildActionQueue(orgId, { limit: 12 });
  const funnel = acquisitionFunnel(orgId);
  const automation = automationHealth(orgId);
  const opportunities = newOpportunities(orgId, 6);
  const projects = all<{ id: string; name: string; stage: string; progress: number; health: string; due_at: string | null }>(
    `SELECT p.id, b.name || ' — ' || p.kind name, p.stage, p.progress, p.health, p.due_at
       FROM projects p JOIN businesses b ON b.id = p.business_id
      WHERE p.org_id = ? AND p.status = 'active' ORDER BY p.health = 'delayed' DESC, p.due_at ASC LIMIT 5`,
    [orgId]
  );

  // AI recommendations — the reasoning behind the top few actions.
  const recommendations = queue.slice(0, 5).map((q) => {
    const si = computeSalesIntelligence(orgId, q.businessId);
    return {
      businessId: q.businessId,
      businessName: q.businessName,
      action: q.actionLabel,
      reason: q.reason,
      closeProbability: si?.closeProbability ?? null,
      revenuePotential: si?.revenuePotential ?? null,
      dealHealth: si?.dealHealth.label ?? null,
      href: q.actionHref,
      service: q.service ? serviceLabel(q.service) : null,
    };
  });

  return { briefing, queue, funnel, automation, opportunities, projects, recommendations };
}

export function markBriefingRead(orgId: string): void {
  run('UPDATE briefings SET read_at = ? WHERE org_id = ? AND for_date = ?', [nowIso(), orgId, todayKey()]);
}

/** Highest-priority prospect right now, with the reason — used across the UI. */
export function topPriority(orgId: string) {
  const row = get<{ id: string; name: string; opportunity_score: number | null; next_best_action_reason: string | null; recommended_service: string | null }>(
    `SELECT id, name, opportunity_score, next_best_action_reason, recommended_service FROM businesses
      WHERE org_id = ? AND merged_into IS NULL AND is_archived = 0
        AND stage NOT IN ('won','onboarding','delivery','active_client','expansion','lost')
      ORDER BY opportunity_score DESC LIMIT 1`,
    [orgId]
  );
  if (!row) return null;
  return {
    ...row,
    serviceLabel: serviceLabel(row.recommended_service),
    reason: row.next_best_action_reason ? truncate(row.next_best_action_reason, 160) : null,
  };
}
