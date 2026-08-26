/**
 * Next-best-action (§15) and sales intelligence (§27).
 *
 * The action engine is a transparent decision ladder over real state, not a
 * black box: every recommendation carries the specific condition that produced
 * it, so the user can see and disagree with the reasoning.
 */
import { all, get, json, run, scalar } from '@/db';
import { nowIso, round, clamp } from '@/lib/id';
import { daysBetween, relativeFromNow } from '@/lib/time';
import type { Business, Contact } from '@/repo/business';
import type { NextAction } from '@/lib/domain';
import { NEXT_ACTION_LABELS } from '@/lib/domain';
import { getSettings } from '@/lib/settings';

export interface NbaResult {
  action: NextAction;
  label: string;
  reason: string;
  dueAt: string;
  confidence: number;
  alternatives: { action: NextAction; label: string; reason: string }[];
}

interface State {
  business: Business;
  contact: Contact | null;
  hasAudit: boolean;
  hasResearch: boolean;
  auditSignals: number;
  outboundCount: number;
  inboundCount: number;
  lastOutboundAt: string | null;
  mockup: { status: string; viewCount: number; intent: number; shared: boolean } | null;
  call: { status: string; scheduledAt: string | null } | null;
  proposal: { status: string; total: number; sentAt: string | null } | null;
  project: { stage: string; status: string; health: string } | null;
  pendingFollowUps: number;
  activeSequence: boolean;
  objections: string[];
  client: { id: string; status: string; mrr: number } | null;
}

function loadState(orgId: string, businessId: string): State | null {
  const business = get<Business>('SELECT * FROM businesses WHERE id = ? AND org_id = ?', [businessId, orgId]);
  if (!business) return null;

  const contact = get<Contact>(
    'SELECT * FROM contacts WHERE business_id = ? ORDER BY is_decision_maker DESC, confidence DESC LIMIT 1',
    [businessId]
  );
  const audit = get<{ signals: string }>('SELECT signals FROM digital_audits WHERE business_id = ? ORDER BY created_at DESC LIMIT 1', [businessId]);
  const hasResearch = (scalar<number>('SELECT COUNT(*) FROM research_docs WHERE business_id = ?', [businessId]) ?? 0) > 0;
  const outbound = get<{ c: number; last: string | null }>(
    "SELECT COUNT(*) c, MAX(sent_at) last FROM outreach_messages WHERE business_id = ? AND direction = 'outbound'",
    [businessId]
  );
  const inboundCount = scalar<number>("SELECT COUNT(*) FROM outreach_messages WHERE business_id = ? AND direction = 'inbound'", [businessId]) ?? 0;
  const mockupRow = get<{ status: string; view_count: number; intent_score: number; share_enabled: number }>(
    'SELECT status, view_count, intent_score, share_enabled FROM mockups WHERE business_id = ? ORDER BY created_at DESC LIMIT 1',
    [businessId]
  );
  const callRow = get<{ status: string; scheduled_at: string | null }>(
    "SELECT status, scheduled_at FROM calls WHERE business_id = ? AND status IN ('scheduled','proposed') ORDER BY scheduled_at ASC LIMIT 1",
    [businessId]
  );
  const proposalRow = get<{ status: string; total: number; sent_at: string | null }>(
    "SELECT status, total, sent_at FROM proposals WHERE business_id = ? AND status IN ('draft','sent','viewed') ORDER BY created_at DESC LIMIT 1",
    [businessId]
  );
  const projectRow = get<{ stage: string; status: string; health: string }>(
    "SELECT stage, status, health FROM projects WHERE business_id = ? AND status <> 'cancelled' ORDER BY created_at DESC LIMIT 1",
    [businessId]
  );
  const pendingFollowUps = scalar<number>("SELECT COUNT(*) FROM follow_ups WHERE business_id = ? AND status IN ('pending','overdue')", [businessId]) ?? 0;
  const activeSequence = (scalar<number>("SELECT COUNT(*) FROM sequence_enrollments WHERE business_id = ? AND status = 'active'", [businessId]) ?? 0) > 0;
  const objections = all<{ value: string }>("SELECT value FROM ai_memory WHERE business_id = ? AND kind = 'objection'", [businessId]).map((o) => o.value);
  const client = get<{ id: string; status: string; mrr: number }>('SELECT id, status, mrr FROM clients WHERE business_id = ?', [businessId]);

  return {
    business,
    contact,
    hasAudit: !!audit,
    hasResearch,
    auditSignals: audit ? json<unknown[]>(audit.signals, []).length : 0,
    outboundCount: outbound?.c ?? 0,
    inboundCount,
    lastOutboundAt: outbound?.last ?? null,
    mockup: mockupRow
      ? { status: mockupRow.status, viewCount: mockupRow.view_count, intent: mockupRow.intent_score, shared: mockupRow.share_enabled === 1 }
      : null,
    call: callRow ? { status: callRow.status, scheduledAt: callRow.scheduled_at } : null,
    proposal: proposalRow ? { status: proposalRow.status, total: proposalRow.total, sentAt: proposalRow.sent_at } : null,
    project: projectRow ?? null,
    pendingFollowUps,
    activeSequence,
    objections,
    client,
  };
}

/**
 * The ladder is ordered by "what unblocks the most value next". The first
 * matching rule wins, and every rule names the exact condition it matched.
 */
export function computeNba(orgId: string, businessId: string, opts: { persist?: boolean } = {}): NbaResult | null {
  const s = loadState(orgId, businessId);
  if (!s) return null;
  const b = s.business;
  const settings = getSettings(orgId);
  const score = b.opportunity_score ?? 0;

  const result = (
    action: NextAction,
    reason: string,
    dueInHours: number,
    confidence: number,
    alternatives: { action: NextAction; reason: string }[] = []
  ): NbaResult => ({
    action,
    label: NEXT_ACTION_LABELS[action],
    reason,
    dueAt: new Date(Date.now() + dueInHours * 3_600_000).toISOString(),
    confidence: round(clamp(confidence, 0, 1), 2),
    alternatives: alternatives.map((a) => ({ ...a, label: NEXT_ACTION_LABELS[a.action] })),
  });

  // ── Terminal / client states ──
  if (b.consent_state === 'do_not_contact' || b.consent_state === 'opted_out') {
    return result('stop_outreach', `They are marked ${b.consent_state.replace(/_/g, ' ')}. No further contact is permitted.`, 0, 1);
  }
  if (s.client && b.stage === 'active_client') {
    return result('upsell', `${s.client.status} client on $${round(s.client.mrr, 0)}/mo. Check the upsell queue for the next service to pitch.`, 168, 0.7);
  }
  if (b.stage === 'lost') {
    return result('stop_outreach', 'Marked lost. Review in 90 days at the earliest.', 0, 0.9);
  }

  // ── Delivery takes precedence over acquisition ──
  if (s.project && s.project.status === 'active') {
    if (s.project.health === 'delayed') {
      return result('deliver_project', `Project is delayed at the ${s.project.stage.replace(/_/g, ' ')} stage. Delivery risk outranks new pipeline.`, 8, 0.95);
    }
    return result('deliver_project', `Active project at ${s.project.stage.replace(/_/g, ' ')}.`, 48, 0.6);
  }

  // ── Deal progression ──
  if (s.proposal?.status === 'draft') {
    return result('send_proposal', `A $${round(s.proposal.total, 0)} proposal is drafted and unsent.`, 6, 0.9);
  }
  if (s.proposal && ['sent', 'viewed'].includes(s.proposal.status)) {
    const age = s.proposal.sentAt ? Math.floor(daysBetween(s.proposal.sentAt)) : 99;
    if (age >= 4) {
      return result('follow_up', `Proposal sent ${age} days ago with no answer. A short check-in usually unblocks it.`, 8, 0.85);
    }
    return result('close_deal', `Proposal is with them (${s.proposal.status}). Be ready to close.`, 48, 0.6);
  }
  if (s.call?.status === 'scheduled' && s.call.scheduledAt) {
    const inHours = (new Date(s.call.scheduledAt).getTime() - Date.now()) / 3_600_000;
    if (inHours <= 24) {
      return result('schedule_call', `Call in ${relativeFromNow(s.call.scheduledAt)}. Generate the briefing and review the audit first.`, Math.max(1, inHours - 2), 0.95);
    }
    return result('follow_up', `Call booked for ${relativeFromNow(s.call.scheduledAt)}. Nothing needed until closer to the time.`, inHours * 0.6, 0.5);
  }

  // ── Mockup engagement (§24) ──
  if (s.mockup && s.mockup.viewCount > 0 && s.inboundCount === 0) {
    if (s.mockup.viewCount >= 2 || s.mockup.intent >= 60) {
      return result(
        'follow_up',
        `They have opened the concept ${s.mockup.viewCount} times (intent ${Math.round(s.mockup.intent)}/100) without replying. Follow up now, while it is fresh.`,
        3,
        0.92,
        [{ action: 'schedule_call', reason: 'Skip straight to a call if they respond positively.' }]
      );
    }
    return result('follow_up', 'They viewed the concept once. A short, specific follow-up converts far better than waiting.', 16, 0.8);
  }
  if (s.mockup && s.mockup.status === 'draft') {
    return result('share_mockup', `A concept is generated but not shared. Sharing it is the highest-leverage next step at ${Math.round(score)}/100.`, 4, 0.88);
  }

  // ── Response handling ──
  if (s.inboundCount > 0 && !s.call) {
    const lastReply = get<{ created_at: string }>(
      "SELECT created_at FROM outreach_messages WHERE business_id = ? AND direction = 'inbound' ORDER BY created_at DESC LIMIT 1",
      [businessId]
    );
    const ageHours = lastReply ? (Date.now() - new Date(lastReply.created_at).getTime()) / 3_600_000 : 999;
    if (ageHours < 72) {
      return result('schedule_call', 'They replied. Convert the reply into a booked call before momentum fades.', 3, 0.9);
    }
    return result('follow_up', 'Their reply has gone quiet for over three days. Re-engage with something specific.', 12, 0.7);
  }

  // ── Outreach readiness ──
  if (s.outboundCount === 0) {
    if (!s.contact && !b.email && !b.phone) {
      return result('enrich_contact', `No contact details on record — outreach cannot start. Score is ${Math.round(score)}/100, so this is worth resolving.`, 24, 0.85);
    }
    if (!s.hasAudit) {
      return result('review_audit', 'No digital audit yet. The audit is what makes the first message specific instead of generic.', 12, 0.8);
    }
    if (score >= settings.discovery.minScoreToQualify) {
      return result(
        'send_first_outreach',
        `Score ${Math.round(score)}/100 with ${s.auditSignals} measured signal(s) and a reachable contact. Ready for first contact.`,
        6,
        0.88,
        [{ action: 'generate_mockup', reason: `Score is above the mockup threshold (${settings.discovery.minScoreToMockup}) — a concept would strengthen the first message.` }]
      );
    }
    return result('review_audit', `Score is ${Math.round(score)}/100, below the ${settings.discovery.minScoreToQualify} qualification bar. Review before spending outreach on it.`, 72, 0.5);
  }

  // ── Follow-up cadence ──
  if (s.outboundCount > 0 && s.lastOutboundAt) {
    const days = daysBetween(s.lastOutboundAt);
    if (days >= 5 && !s.activeSequence && s.pendingFollowUps === 0) {
      if (s.outboundCount >= 4) {
        return result('stop_outreach', `${s.outboundCount} touches with no response. Continuing risks the domain's reputation — close it out or park it.`, 24, 0.75);
      }
      return result('follow_up', `No reply in ${Math.floor(days)} days and no active sequence. Send a value-first follow-up or enrol them in a sequence.`, 12, 0.7);
    }
  }

  // ── Mockup generation for high scorers ──
  if (!s.mockup && score >= settings.discovery.minScoreToMockup) {
    return result('generate_mockup', `Score ${Math.round(score)}/100 is above the mockup threshold of ${settings.discovery.minScoreToMockup}. A concept materially lifts reply rates at this level.`, 12, 0.82);
  }

  // ── Research gap ──
  if (!s.hasResearch && score >= 70) {
    return result('research_business', 'High score but no research brief. Research before outreach makes the message specific.', 24, 0.6);
  }

  return result('review_audit', 'Nothing is currently blocked. Review the audit for anything the score is not capturing.', 96, 0.4);
}

export function applyNba(orgId: string, businessId: string): NbaResult | null {
  const nba = computeNba(orgId, businessId);
  if (!nba) return null;
  run('UPDATE businesses SET next_best_action = ?, next_best_action_reason = ?, next_best_action_due = ?, updated_at = ? WHERE id = ?', [
    nba.action,
    nba.reason,
    nba.dueAt,
    nowIso(),
    businessId,
  ]);
  return nba;
}

// ── Sales intelligence (§27) ─────────────────────────────────
export interface SalesIntelligence {
  buyingIntent: number;
  engagementScore: number;
  responseProbability: number;
  closeProbability: number;
  revenuePotential: number;
  recommendedAction: NextAction;
  salesRisk: 'low' | 'medium' | 'high' | 'critical';
  dealHealth: { label: string; tone: 'good' | 'watch' | 'risk'; reasons: string[] };
}

const STAGE_CLOSE_PRIOR: Record<string, number> = {
  discovered: 0.01, qualified: 0.03, outreach_ready: 0.05, outreach_sent: 0.08, engaged: 0.14,
  interested: 0.25, mockup_generated: 0.2, mockup_shared: 0.24, mockup_viewed: 0.32,
  call_scheduled: 0.45, call_completed: 0.55, proposal_sent: 0.6, negotiation: 0.72,
  won: 1, onboarding: 1, delivery: 1, active_client: 1, expansion: 0.9, lost: 0,
};

/** Service value bands — used for revenue potential. Conservative by design. */
const SERVICE_VALUE: Record<string, { oneTime: number; mrr: number }> = {
  website: { oneTime: 1800, mrr: 45 },
  website_redesign: { oneTime: 2600, mrr: 75 },
  seo: { oneTime: 900, mrr: 349 },
  social: { oneTime: 600, mrr: 249 },
  content: { oneTime: 500, mrr: 299 },
  conversion: { oneTime: 1500, mrr: 99 },
  branding: { oneTime: 1200, mrr: 0 },
  performance: { oneTime: 900, mrr: 79 },
  accessibility: { oneTime: 800, mrr: 0 },
  analytics: { oneTime: 400, mrr: 99 },
  maintenance: { oneTime: 0, mrr: 79 },
};

export function computeSalesIntelligence(orgId: string, businessId: string): SalesIntelligence | null {
  const s = loadState(orgId, businessId);
  if (!s) return null;
  const b = s.business;

  // Engagement from observed behaviour.
  const opens = scalar<number>("SELECT COALESCE(SUM(open_count),0) FROM outreach_messages WHERE business_id = ?", [businessId]) ?? 0;
  const clicks = scalar<number>("SELECT COALESCE(SUM(click_count),0) FROM outreach_messages WHERE business_id = ?", [businessId]) ?? 0;
  const engagement = round(
    clamp(
      Math.min(20, s.outboundCount * 4) +
        Math.min(20, opens * 6) +
        Math.min(20, clicks * 10) +
        Math.min(20, s.inboundCount * 18) +
        Math.min(20, (s.mockup?.viewCount ?? 0) * 7) +
        (s.call ? 15 : 0) +
        (s.proposal ? 20 : 0)
    )
  );

  const intentBase = STAGE_CLOSE_PRIOR[b.stage] ?? 0.05;
  const buyingIntent = round(
    clamp(
      (intentBase * 100) * 0.4 +
        Math.min(100, (s.mockup?.intent ?? 0)) * 0.25 +
        engagement * 0.25 +
        (b.intent_score ?? 0) * 0.1
    )
  );

  // Response probability: decays with touches sent, rises with engagement.
  const touches = s.outboundCount;
  const responseProbability = round(
    clamp(
      s.inboundCount > 0
        ? 100
        : Math.max(2, 42 - touches * 7 + engagement * 0.25 + (b.opportunity_score ?? 0) * 0.08),
      0,
      100
    ),
    1
  );

  const closeProbability = round(clamp(buyingIntent * 0.6 + intentBase * 100 * 0.4, 0, 100), 1);

  const service = b.recommended_service ?? 'website';
  const value = SERVICE_VALUE[service] ?? SERVICE_VALUE.website;
  const sizeMultiplier = b.employee_estimate && /(\d+)/.test(b.employee_estimate) ? 1.25 : 1;
  const revenuePotential = round((value.oneTime + value.mrr * 12) * sizeMultiplier, 0);

  // Sales risk.
  const reasons: string[] = [];
  let riskScore = 0;
  if (!s.contact && !b.email && !b.phone) {
    riskScore += 40;
    reasons.push('No reachable contact');
  }
  if (s.outboundCount >= 3 && s.inboundCount === 0) {
    riskScore += 25;
    reasons.push(`${s.outboundCount} touches with no reply`);
  }
  if (s.lastOutboundAt && daysBetween(s.lastOutboundAt) > 10) {
    riskScore += 15;
    reasons.push('Went quiet over 10 days ago');
  }
  if (s.objections.length) {
    riskScore += 15;
    reasons.push(`${s.objections.length} objection(s) on record`);
  }
  if (s.proposal && s.proposal.sentAt && daysBetween(s.proposal.sentAt) > 7) {
    riskScore += 20;
    reasons.push('Proposal open for over a week');
  }
  if (!s.hasAudit) {
    riskScore += 10;
    reasons.push('No audit — messaging cannot be specific');
  }
  const salesRisk: SalesIntelligence['salesRisk'] =
    riskScore >= 60 ? 'critical' : riskScore >= 40 ? 'high' : riskScore >= 20 ? 'medium' : 'low';

  const nba = computeNba(orgId, businessId);

  const healthLabel =
    closeProbability >= 60 ? 'Strong' : closeProbability >= 35 ? 'Developing' : closeProbability >= 15 ? 'Early' : 'Cold';
  const tone: SalesIntelligence['dealHealth']['tone'] =
    salesRisk === 'critical' || salesRisk === 'high' ? 'risk' : salesRisk === 'medium' ? 'watch' : 'good';

  return {
    buyingIntent,
    engagementScore: engagement,
    responseProbability,
    closeProbability,
    revenuePotential,
    recommendedAction: nba?.action ?? 'review_audit',
    salesRisk,
    dealHealth: { label: healthLabel, tone, reasons: reasons.length ? reasons : ['No risk signals detected'] },
  };
}

export function persistSalesIntelligence(orgId: string, businessId: string): SalesIntelligence | null {
  const si = computeSalesIntelligence(orgId, businessId);
  if (!si) return null;
  run(
    `UPDATE businesses SET intent_score = ?, engagement_score = ?, close_probability = ?, revenue_potential = ?, updated_at = ?
      WHERE id = ?`,
    [si.buyingIntent, si.engagementScore, si.closeProbability / 100, si.revenuePotential, nowIso(), businessId]
  );
  return si;
}

export function dealHealthSummary(orgId: string) {
  const rows = all<{ tone: string; c: number }>(
    `SELECT CASE
              WHEN close_probability >= 0.6 THEN 'Strong'
              WHEN close_probability >= 0.35 THEN 'Developing'
              WHEN close_probability >= 0.15 THEN 'Early'
              ELSE 'Cold' END tone, COUNT(*) c
       FROM businesses WHERE org_id = ? AND merged_into IS NULL AND is_archived = 0
         AND stage NOT IN ('lost')
      GROUP BY tone`,
    [orgId]
  );
  return Object.fromEntries(rows.map((r) => [r.tone, r.c]));
}

export { loadState };
