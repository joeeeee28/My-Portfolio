/**
 * Action Queue (§59, §63) — the most important surface in ClientForge.
 *
 * One ranked list of everything that needs a human decision, each item carrying
 * the evidence that put it there and the single action that resolves it.
 */
import { all, get, scalar } from '@/db';
import { nowIso, round, truncate } from '@/lib/id';
import { relativeFromNow } from '@/lib/time';
import { BRAND, serviceLabel } from '@/lib/brand';
import type { NextAction } from '@/lib/domain';
import { NEXT_ACTION_LABELS } from '@/lib/domain';

export type QueueTone = 'critical' | 'high' | 'medium' | 'low' | 'good';

export interface ActionItem {
  id: string;
  tone: QueueTone;
  kind: string;
  title: string;
  businessId: string;
  businessName: string;
  reason: string;
  action: NextAction;
  actionLabel: string;
  actionHref: string;
  dueAt: string | null;
  score: number | null;
  priority: string | null;
  service: string | null;
}

interface RawItem extends ActionItem {
  sortKey: number;
}

/**
 * Builds the Action Queue. Ordered by urgency first (a prospect who viewed a
 * concept twice beats a cold discovery), then by opportunity value.
 */
export function buildActionQueue(orgId: string, opts: { limit?: number } = {}): ActionItem[] {
  const items: RawItem[] = [];
  const now = nowIso();

  const biz = (id: string) =>
    get<{ name: string; opportunity_score: number | null; priority: string | null; recommended_service: string | null }>(
      'SELECT name, opportunity_score, priority, recommended_service FROM businesses WHERE id = ?',
      [id]
    );

  const push = (
    item: Omit<RawItem, 'actionLabel' | 'sortKey'> & { sortKey: number }
  ) => {
    items.push({ ...item, actionLabel: NEXT_ACTION_LABELS[item.action] });
  };

  // ── 1. Concept viewed, no reply — the warmest signal available ──
  const viewed = all<{ business_id: string; view_count: number; intent_score: number; last_viewed_at: string | null }>(
    `SELECT m.business_id, m.view_count, m.intent_score, m.last_viewed_at FROM mockups m
      JOIN businesses b ON b.id = m.business_id
     WHERE m.org_id = ? AND m.view_count > 0 AND b.merged_into IS NULL AND b.is_archived = 0
       AND b.stage NOT IN ('won','onboarding','delivery','active_client','expansion','lost')
       AND NOT EXISTS (SELECT 1 FROM outreach_messages o WHERE o.business_id = m.business_id AND o.direction = 'inbound')
     ORDER BY m.view_count DESC, m.last_viewed_at DESC LIMIT 25`,
    [orgId]
  );
  for (const v of viewed) {
    const b = biz(v.business_id);
    if (!b) continue;
    push({
      id: `concept-viewed-${v.business_id}`,
      tone: v.view_count >= 2 ? 'critical' : 'high',
      kind: 'Follow up',
      title: b.name,
      businessId: v.business_id,
      businessName: b.name,
      reason:
        v.view_count >= 2
          ? `Viewed the concept ${v.view_count} times${v.last_viewed_at ? `, last ${relativeFromNow(v.last_viewed_at)}` : ''}. No reply yet.`
          : `Viewed the concept once. No reply yet.`,
      action: 'follow_up',
      actionHref: `/prospects/${v.business_id}?tab=outreach`,
      dueAt: now,
      score: b.opportunity_score,
      priority: b.priority,
      service: b.recommended_service,
      sortKey: 1000 + v.view_count * 50 + (b.opportunity_score ?? 0),
    });
  }

  // ── 2. Positive reply not yet converted to a call ──
  const replied = all<{ business_id: string; created_at: string }>(
    `SELECT o.business_id, MAX(o.created_at) created_at FROM outreach_messages o
       JOIN businesses b ON b.id = o.business_id
      WHERE o.org_id = ? AND o.direction = 'inbound' AND b.merged_into IS NULL
        AND b.stage IN ('outreach_sent','engaged','interested')
        AND NOT EXISTS (SELECT 1 FROM calls c WHERE c.business_id = o.business_id AND c.status IN ('scheduled','proposed'))
      GROUP BY o.business_id ORDER BY created_at DESC LIMIT 15`,
    [orgId]
  );
  for (const r of replied) {
    const b = biz(r.business_id);
    if (!b) continue;
    const ageH = (Date.now() - new Date(r.created_at).getTime()) / 3_600_000;
    push({
      id: `reply-${r.business_id}`,
      tone: ageH < 24 ? 'critical' : 'high',
      kind: 'Book the call',
      title: b.name,
      businessId: r.business_id,
      businessName: b.name,
      reason: `Replied ${relativeFromNow(r.created_at)}. Convert the conversation into a booked call.`,
      action: 'schedule_call',
      actionHref: `/prospects/${r.business_id}?tab=calls`,
      dueAt: r.created_at,
      score: b.opportunity_score,
      priority: b.priority,
      service: b.recommended_service,
      sortKey: 950 - ageH + (b.opportunity_score ?? 0) * 0.5,
    });
  }

  // ── 3. Due follow-ups ──
  const followUps = all<{ id: string; business_id: string; title: string; reason: string; due_at: string; kind: string; priority: string }>(
    `SELECT f.id, f.business_id, f.title, f.reason, f.due_at, f.kind, f.priority FROM follow_ups f
       JOIN businesses b ON b.id = f.business_id
      WHERE f.org_id = ? AND f.status IN ('pending','overdue') AND b.merged_into IS NULL
      ORDER BY f.due_at ASC LIMIT 30`,
    [orgId]
  );
  for (const f of followUps) {
    const b = biz(f.business_id);
    if (!b) continue;
    const overdue = new Date(f.due_at).getTime() < Date.now();
    push({
      id: f.id,
      tone: overdue || f.priority === 'critical' ? 'critical' : f.priority === 'high' ? 'high' : 'medium',
      kind: f.kind === 'call' ? 'Prepare call' : f.kind === 'proposal' ? 'Proposal' : f.kind === 'mockup' ? 'Review concept' : 'Follow up',
      title: b.name,
      businessId: f.business_id,
      businessName: b.name,
      reason: truncate(f.reason, 140),
      action: f.kind === 'call' ? 'schedule_call' : f.kind === 'proposal' ? 'close_deal' : 'follow_up',
      actionHref: `/prospects/${f.business_id}?tab=${f.kind === 'call' ? 'calls' : f.kind === 'proposal' ? 'proposal' : f.kind === 'mockup' ? 'concept' : 'outreach'}`,
      dueAt: f.due_at,
      score: b.opportunity_score,
      priority: b.priority,
      service: b.recommended_service,
      sortKey: (overdue ? 900 : 700) - (Date.now() - new Date(f.due_at).getTime()) / 3_600_000,
    });
  }

  // ── 4. Concepts generated but not reviewed/shared ──
  const drafts = all<{ business_id: string; title: string; status: string }>(
    `SELECT m.business_id, m.title, m.status FROM mockups m JOIN businesses b ON b.id = m.business_id
      WHERE m.org_id = ? AND m.status = 'draft' AND b.merged_into IS NULL AND b.is_archived = 0
      ORDER BY b.opportunity_score DESC LIMIT 15`,
    [orgId]
  );
  for (const d of drafts) {
    const b = biz(d.business_id);
    if (!b) continue;
    push({
      id: `concept-draft-${d.business_id}`,
      tone: (b.opportunity_score ?? 0) >= 85 ? 'high' : 'medium',
      kind: 'Review concept',
      title: b.name,
      businessId: d.business_id,
      businessName: b.name,
      reason: `${BRAND.conceptLabel} generated and waiting for review. Sharing it is the next step.`,
      action: 'share_mockup',
      actionHref: `/prospects/${d.business_id}?tab=concept`,
      dueAt: null,
      score: b.opportunity_score,
      priority: b.priority,
      service: b.recommended_service,
      sortKey: 600 + (b.opportunity_score ?? 0),
    });
  }

  // ── 5. Calls in the next 24 hours ──
  const calls = all<{ business_id: string; scheduled_at: string; title: string }>(
    `SELECT c.business_id, c.scheduled_at, c.title FROM calls c JOIN businesses b ON b.id = c.business_id
      WHERE c.org_id = ? AND c.status = 'scheduled' AND c.scheduled_at BETWEEN ? AND ?
      ORDER BY c.scheduled_at ASC LIMIT 15`,
    [orgId, now, new Date(Date.now() + 86_400_000).toISOString()]
  );
  for (const c of calls) {
    const b = biz(c.business_id);
    if (!b) continue;
    const inHours = (new Date(c.scheduled_at).getTime() - Date.now()) / 3_600_000;
    push({
      id: `call-${c.business_id}-${c.scheduled_at}`,
      tone: inHours < 3 ? 'high' : 'medium',
      kind: 'Prepare call',
      title: b.name,
      businessId: c.business_id,
      businessName: b.name,
      reason: `${c.title} — ${relativeFromNow(c.scheduled_at)}.`,
      action: 'schedule_call',
      actionHref: `/prospects/${c.business_id}?tab=calls`,
      dueAt: c.scheduled_at,
      score: b.opportunity_score,
      priority: b.priority,
      service: b.recommended_service,
      sortKey: 650 - inHours,
    });
  }

  // ── 6. Proposals awaiting response ──
  const proposals = all<{ business_id: string; number: string; total: number; status: string; sent_at: string | null }>(
    `SELECT p.business_id, p.number, p.total, p.status, p.sent_at FROM proposals p
      WHERE p.org_id = ? AND p.status IN ('sent','viewed') ORDER BY p.sent_at ASC LIMIT 15`,
    [orgId]
  );
  for (const p of proposals) {
    const b = biz(p.business_id);
    if (!b) continue;
    const ageDays = p.sent_at ? Math.floor((Date.now() - new Date(p.sent_at).getTime()) / 86_400_000) : 0;
    push({
      id: `proposal-${p.business_id}-${p.number}`,
      tone: ageDays > 5 ? 'high' : 'medium',
      kind: 'Proposal',
      title: b.name,
      businessId: p.business_id,
      businessName: b.name,
      reason: `${p.number} · $${round(p.total, 0)} · ${p.status === 'viewed' ? 'opened' : 'sent'}${ageDays ? ` ${ageDays}d ago` : ''}.`,
      action: ageDays > 4 ? 'follow_up' : 'close_deal',
      actionHref: `/prospects/${p.business_id}?tab=proposal`,
      dueAt: p.sent_at,
      score: b.opportunity_score,
      priority: b.priority,
      service: b.recommended_service,
      sortKey: 500 + (ageDays > 4 ? 150 : 0) + p.total / 100,
    });
  }

  // ── 7. Drafts awaiting approval ──
  const draftsPending = all<{ business_id: string; id: string; subject: string | null; channel: string }>(
    `SELECT o.business_id, o.id, o.subject, o.channel FROM outreach_messages o
       JOIN businesses b ON b.id = o.business_id
      WHERE o.org_id = ? AND o.status IN ('draft','queued') AND b.consent_state NOT IN ('opted_out','do_not_contact')
      ORDER BY b.opportunity_score DESC LIMIT 20`,
    [orgId]
  );
  for (const d of draftsPending) {
    const b = biz(d.business_id);
    if (!b) continue;
    push({
      id: `draft-${d.id}`,
      tone: (b.opportunity_score ?? 0) >= 80 ? 'medium' : 'low',
      kind: 'Approve outreach',
      title: b.name,
      businessId: d.business_id,
      businessName: b.name,
      reason: `${d.channel} draft ready${d.subject ? ` — "${truncate(d.subject, 48)}"` : ''}.`,
      action: 'send_first_outreach',
      actionHref: `/prospects/${d.business_id}?tab=outreach`,
      dueAt: null,
      score: b.opportunity_score,
      priority: b.priority,
      service: b.recommended_service,
      sortKey: 300 + (b.opportunity_score ?? 0),
    });
  }

  // ── 8. High scorers with no concept yet ──
  const highNoConcept = all<{ id: string; name: string; opportunity_score: number | null; priority: string | null; recommended_service: string | null }>(
    `SELECT b.id, b.name, b.opportunity_score, b.priority, b.recommended_service FROM businesses b
      WHERE b.org_id = ? AND b.priority IN ('high','critical') AND b.merged_into IS NULL AND b.is_archived = 0
        AND b.stage NOT IN ('won','onboarding','delivery','active_client','expansion','lost')
        AND NOT EXISTS (SELECT 1 FROM mockups m WHERE m.business_id = b.id)
      ORDER BY b.opportunity_score DESC LIMIT 12`,
    [orgId]
  );
  for (const h of highNoConcept) {
    push({
      id: `needs-concept-${h.id}`,
      tone: h.priority === 'critical' ? 'high' : 'medium',
      kind: 'Generate concept',
      title: h.name,
      businessId: h.id,
      businessName: h.name,
      reason: `${h.opportunity_score ?? 0}/100 ${h.priority} opportunity with no ${BRAND.conceptLabel.toLowerCase()} yet.`,
      action: 'generate_mockup',
      actionHref: `/prospects/${h.id}?tab=concept`,
      dueAt: null,
      score: h.opportunity_score,
      priority: h.priority,
      service: h.recommended_service,
      sortKey: 250 + (h.opportunity_score ?? 0),
    });
  }

  // ── 9. Delivery risks ──
  const delayed = all<{ id: string; business_id: string; name: string; stage: string; health_reason: string | null; due_at: string | null }>(
    `SELECT p.id, p.business_id, b.name, p.stage, p.health_reason, p.due_at FROM projects p
       JOIN businesses b ON b.id = p.business_id
      WHERE p.org_id = ? AND p.status = 'active' AND p.health IN ('delayed','at_risk') ORDER BY p.health = 'delayed' DESC LIMIT 10`,
    [orgId]
  );
  for (const d of delayed) {
    push({
      id: `delivery-${d.id}`,
      tone: d.stage === 'delayed' ? 'critical' : 'high',
      kind: 'Delivery risk',
      title: d.name,
      businessId: d.business_id,
      businessName: d.name,
      reason: `${d.stage.replace(/_/g, ' ')} stage${d.health_reason ? ` — ${d.health_reason}` : ''}.`,
      action: 'deliver_project',
      actionHref: `/projects/${d.id}`,
      dueAt: d.due_at,
      score: null,
      priority: null,
      service: null,
      sortKey: 800,
    });
  }

  items.sort((a, b) => b.sortKey - a.sortKey);
  return items.slice(0, opts.limit ?? 40).map(({ sortKey: _s, ...rest }) => rest);
}

/** Counts per queue kind, for the dashboard priority strip. */
export function actionQueueCounts(orgId: string) {
  const items = buildActionQueue(orgId, { limit: 500 });
  const byKind: Record<string, number> = {};
  const byTone: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0, good: 0 };
  for (const i of items) {
    byKind[i.kind] = (byKind[i.kind] ?? 0) + 1;
    byTone[i.tone] = (byTone[i.tone] ?? 0) + 1;
  }
  return { total: items.length, byKind, byTone };
}

// ── Smart queues (§63) ───────────────────────────────────────
export interface SmartQueue {
  key: string;
  label: string;
  description: string;
  count: number;
}

export function smartQueues(orgId: string): SmartQueue[] {
  const c = (sql: string, params: unknown[] = []) => scalar<number>(sql, [orgId, ...params]) ?? 0;
  const base = `FROM businesses b WHERE b.org_id = ? AND b.merged_into IS NULL AND b.is_archived = 0`;
  const active = `${base} AND b.stage NOT IN ('won','onboarding','delivery','active_client','expansion','lost')`;

  return [
    {
      key: 'best_opportunities',
      label: 'Best Opportunities',
      description: 'Highest Opportunity Score across the Prospect Hub.',
      count: c(`SELECT COUNT(*) ${active} AND b.priority IN ('high','critical')`),
    },
    {
      key: 'no_website',
      label: 'No Website',
      description: "No site at all — the largest single gap we can close.",
      count: c(`SELECT COUNT(*) ${active} AND b.website_status = 'missing'`),
    },
    {
      key: 'website_needs_work',
      label: 'Website Needs Improvement',
      description: 'A site exists but measured below a usable standard.',
      count: c(
        `SELECT COUNT(*) ${active} AND b.website_status IN ('live','insecure')
           AND EXISTS (SELECT 1 FROM digital_audits a WHERE a.business_id = b.id AND a.website_score < 55)`
      ),
    },
    {
      key: 'social_opportunity',
      label: 'Social Opportunity',
      description: 'Weak or absent social presence.',
      count: c(
        `SELECT COUNT(*) ${active}
           AND EXISTS (SELECT 1 FROM social_audits s WHERE s.business_id = b.id AND s.social_score < 45)`
      ),
    },
    {
      key: 'needs_contact',
      label: 'Needs Contact',
      description: 'Worth pursuing but we have no way to reach them yet.',
      count: c(
        `SELECT COUNT(*) ${active} AND b.email IS NULL AND b.phone IS NULL
           AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.business_id = b.id)`
      ),
    },
    {
      key: 'ready_for_outreach',
      label: 'Ready for Outreach',
      description: 'Qualified, reachable, and not yet contacted.',
      count: c(
        `SELECT COUNT(*) ${active} AND b.stage IN ('qualified','outreach_ready')
           AND (b.email IS NOT NULL OR b.phone IS NOT NULL OR EXISTS (SELECT 1 FROM contacts c WHERE c.business_id = b.id))
           AND NOT EXISTS (SELECT 1 FROM outreach_messages o WHERE o.business_id = b.id AND o.direction = 'outbound')`
      ),
    },
    {
      key: 'follow_up_today',
      label: 'Follow-up Today',
      description: 'Follow-ups due now or overdue.',
      count: c(
        `SELECT COUNT(*) FROM follow_ups f JOIN businesses b ON b.id = f.business_id
          WHERE f.org_id = ? AND f.status IN ('pending','overdue') AND f.due_at <= ?`,
        [new Date(Date.now() + 86_400_000).toISOString()]
      ),
    },
    {
      key: 'hot_prospects',
      label: 'Hot Prospects',
      description: 'Responded, engaged, or viewed their concept.',
      count: c(
        `SELECT COUNT(*) ${active} AND (b.engagement_score >= 40 OR b.intent_score >= 40
           OR EXISTS (SELECT 1 FROM outreach_messages o WHERE o.business_id = b.id AND o.direction = 'inbound'))`
      ),
    },
    {
      key: 'concept_ready',
      label: 'Concept Ready',
      description: `${BRAND.conceptLabel} generated and waiting to be shared.`,
      count: c(`SELECT COUNT(*) FROM mockups m JOIN businesses b ON b.id = m.business_id WHERE m.org_id = ? AND m.status = 'draft'`),
    },
    {
      key: 'concept_viewed',
      label: 'Concept Viewed',
      description: 'They opened the concept — follow up now.',
      count: c(`SELECT COUNT(*) FROM mockups m JOIN businesses b ON b.id = m.business_id WHERE m.org_id = ? AND m.view_count > 0 AND b.stage NOT IN ('won','active_client','lost')`),
    },
    {
      key: 'call_ready',
      label: 'Call Ready',
      description: 'Engaged enough to book a conversation.',
      count: c(
        `SELECT COUNT(*) ${active} AND b.stage IN ('engaged','interested')
           AND NOT EXISTS (SELECT 1 FROM calls c WHERE c.business_id = b.id AND c.status IN ('scheduled','proposed'))`
      ),
    },
    {
      key: 'proposal_followup',
      label: 'Proposal Follow-up',
      description: 'Proposals open for more than four days.',
      count: c(
        `SELECT COUNT(*) FROM proposals p JOIN businesses b ON b.id = p.business_id
          WHERE p.org_id = ? AND p.status IN ('sent','viewed') AND p.sent_at < ?`,
        [new Date(Date.now() - 4 * 86_400_000).toISOString()]
      ),
    },
    {
      key: 'closing_soon',
      label: 'Closing Soon',
      description: 'Close probability above 50%.',
      count: c(`SELECT COUNT(*) ${active} AND b.close_probability >= 0.5`),
    },
    {
      key: 'growth_opportunities',
      label: 'Growth Opportunities',
      description: `${TERMS_UPSELL} for existing clients.`,
      count: c(`SELECT COUNT(*) FROM upsell_opportunities u WHERE u.org_id = ? AND u.status IN ('identified','pitched')`),
    },
    {
      key: 'delivery_risks',
      label: 'Delivery Risks',
      description: 'Projects at risk or delayed.',
      count: c(`SELECT COUNT(*) FROM projects p WHERE p.org_id = ? AND p.status = 'active' AND p.health IN ('at_risk','delayed')`),
    },
  ];
}

const TERMS_UPSELL = 'Growth Opportunities';

/** Filter set for a named smart queue — feeds the Prospects table. */
export function queueFilter(key: string): Record<string, unknown> {
  const activeStages = ['discovered', 'qualified', 'outreach_ready', 'outreach_sent', 'engaged', 'interested',
    'mockup_generated', 'mockup_shared', 'mockup_viewed', 'call_scheduled', 'call_completed',
    'proposal_sent', 'negotiation'];
  switch (key) {
    case 'best_opportunities':
      return { priority: ['high', 'critical'], stages: activeStages, sortBy: 'score' };
    case 'no_website':
      return { websiteStatus: 'missing', stages: activeStages, sortBy: 'score' };
    case 'website_needs_work':
      return { websiteStatus: ['live', 'insecure'], stages: activeStages, sortBy: 'score' };
    case 'ready_for_outreach':
      return { stages: ['qualified', 'outreach_ready'], outreachStatus: 'none', hasContact: true };
    case 'hot_prospects':
      return { stages: ['engaged', 'interested', 'mockup_viewed', 'call_scheduled'], sortBy: 'intent' };
    case 'closing_soon':
      return { stages: ['proposal_sent', 'negotiation'], sortBy: 'revenue' };
    default:
      return { sortBy: 'score' };
  }
}

/** The "New Opportunities" strip on the dashboard. */
export function newOpportunities(orgId: string, limit = 8) {
  return all<{
    id: string; name: string; category: string | null; locality: string | null; opportunity_score: number | null;
    priority: string; recommended_service: string | null; website_status: string; rating: number | null;
    review_count: number | null; next_best_action: string | null; next_best_action_reason: string | null;
    first_discovered_at: string; is_demo: number;
  }>(
    `SELECT id, name, category, locality, opportunity_score, priority, recommended_service, website_status,
            rating, review_count, next_best_action, next_best_action_reason, first_discovered_at, is_demo
       FROM businesses
      WHERE org_id = ? AND merged_into IS NULL AND is_archived = 0
        AND stage NOT IN ('won','onboarding','delivery','active_client','expansion','lost')
      ORDER BY opportunity_score DESC, first_discovered_at DESC LIMIT ?`,
    [orgId, limit]
  ).map((b) => ({ ...b, serviceLabel: serviceLabel(b.recommended_service) }));
}
