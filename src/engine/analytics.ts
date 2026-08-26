/**
 * Analytics (§47), Forge Automation observability (§42) and cost control (§65).
 *
 * Every figure here is computed from stored rows — nothing is projected or
 * invented. Unit economics are only reported when there is a denominator.
 */
import { all, get, run, scalar, toJson } from '@/db';
import { id, nowIso, round } from '@/lib/id';
import { daysBetween } from '@/lib/time';
import { PIPELINE, STAGE_TO_PIPELINE } from '@/lib/brand';
import { PIPELINE_STAGES } from '@/lib/domain';
import { monthlySpend } from '@/lib/ai/router';
import { getSettings } from '@/lib/settings';

export interface FunnelStep {
  label: string;
  key: string;
  count: number;
  conversionFromPrev: number | null;
  conversionFromTop: number;
}

export function acquisitionFunnel(orgId: string) {
  const c = (sql: string, params: unknown[] = []) => scalar<number>(sql, [orgId, ...params]) ?? 0;

  const discovered = c(`SELECT COUNT(*) FROM businesses WHERE org_id = ? AND merged_into IS NULL`);
  const qualified = c(`SELECT COUNT(*) FROM businesses WHERE org_id = ? AND merged_into IS NULL AND stage NOT IN ('discovered')`);

  // A funnel must be monotonic: each step counts prospects that reached *at
  // least* that stage, measured on the pipeline position rather than on whether
  // one particular artefact happens to exist. Counting artefacts independently
  // produces nonsense like more concepts than replies.
  const reachedAtLeast = (stage: string) =>
    scalar<number>(
      `SELECT COUNT(*) FROM businesses
        WHERE org_id = ? AND merged_into IS NULL AND is_archived = 0
          AND stage IN (${PIPELINE_STAGES.map(() => '?').join(',')})`,
      [
        orgId,
        ...PIPELINE_STAGES.slice(
          PIPELINE_STAGES.indexOf(stage as (typeof PIPELINE_STAGES)[number])
        ),
      ]
    ) ?? 0;

  const contacted = Math.max(
    reachedAtLeast('outreach_sent'),
    c(`SELECT COUNT(DISTINCT business_id) FROM outreach_messages WHERE org_id = ? AND direction = 'outbound' AND sent_at IS NOT NULL`)
  );
  const responded = Math.max(
    reachedAtLeast('engaged'),
    c(`SELECT COUNT(DISTINCT business_id) FROM outreach_messages WHERE org_id = ? AND direction = 'inbound'`)
  );
  const positive = c(
    `SELECT COUNT(DISTINCT business_id) FROM outreach_messages WHERE org_id = ? AND direction = 'inbound' AND status = 'replied'`
  );
  const mockups = Math.max(
    reachedAtLeast('mockup_generated'),
    c(`SELECT COUNT(DISTINCT business_id) FROM mockups WHERE org_id = ?`)
  );
  const calls = Math.max(
    reachedAtLeast('call_scheduled'),
    c(`SELECT COUNT(DISTINCT business_id) FROM calls WHERE org_id = ? AND status IN ('scheduled','completed')`)
  );
  const proposals = Math.max(
    reachedAtLeast('proposal_sent'),
    c(`SELECT COUNT(DISTINCT business_id) FROM proposals WHERE org_id = ?`)
  );
  const won = Math.max(
    reachedAtLeast('won'),
    c(`SELECT COUNT(DISTINCT business_id) FROM proposals WHERE org_id = ? AND status = 'accepted'`)
  );

  const steps: { key: string; label: string; count: number }[] = [
    { key: 'discovery', label: 'Discovery', count: discovered },
    { key: 'qualification', label: 'Qualification', count: qualified },
    { key: 'outreach', label: 'Outreach', count: contacted },
    { key: 'response', label: 'Response', count: responded },
    { key: 'mockup', label: 'Website Concept', count: mockups },
    { key: 'call', label: 'Call', count: calls },
    { key: 'proposal', label: 'Proposal', count: proposals },
    { key: 'won', label: 'Won', count: won },
  ];

  const top = steps[0].count || 1;
  const funnel: FunnelStep[] = steps.map((s, i) => ({
    ...s,
    conversionFromPrev: i === 0 ? null : steps[i - 1].count ? round((s.count / steps[i - 1].count) * 100, 1) : 0,
    conversionFromTop: round((s.count / top) * 100, 2),
  }));

  return { funnel, discovered, qualified, contacted, responded, positive, mockups, calls, proposals, won };
}

export function pipelineSnapshot(orgId: string) {
  const counts = all<{ stage: string; c: number; value: number }>(
    `SELECT stage, COUNT(*) c, COALESCE(SUM(revenue_potential),0) value FROM businesses
      WHERE org_id = ? AND merged_into IS NULL AND is_archived = 0 GROUP BY stage`,
    [orgId]
  );
  const byStage: Record<string, { count: number; value: number }> = {};
  for (const r of counts) byStage[r.stage] = { count: r.c, value: round(r.value, 2) };

  const columns = PIPELINE.map((p) => {
    const stages = Object.entries(STAGE_TO_PIPELINE).filter(([, col]) => col === p.key).map(([s]) => s);
    const count = stages.reduce((a, s) => a + (byStage[s]?.count ?? 0), 0);
    const value = stages.reduce((a, s) => a + (byStage[s]?.value ?? 0), 0);
    return { key: p.key, label: p.label, pillar: p.pillar, count, value: round(value, 2), stages };
  });

  return {
    columns,
    byStage,
    openValue: round(
      columns.filter((c) => !['won', 'onboarding', 'delivery', 'active_client'].includes(c.key)).reduce((a, c) => a + c.value, 0),
      2
    ),
    lost: byStage.lost?.count ?? 0,
  };
}

export function revenueAnalytics(orgId: string) {
  const mrrMonthly = scalar<number>("SELECT COALESCE(SUM(amount),0) FROM subscriptions WHERE org_id = ? AND status = 'active' AND interval = 'month'", [orgId]) ?? 0;
  const mrrYearly = scalar<number>("SELECT COALESCE(SUM(amount),0) FROM subscriptions WHERE org_id = ? AND status = 'active' AND interval = 'year'", [orgId]) ?? 0;
  const mrr = mrrMonthly + mrrYearly / 12;
  const wonRevenue = scalar<number>("SELECT COALESCE(SUM(total),0) FROM proposals WHERE org_id = ? AND status = 'accepted'", [orgId]) ?? 0;
  const paidRevenue = scalar<number>("SELECT COALESCE(SUM(amount),0) FROM payments WHERE org_id = ? AND status = 'paid'", [orgId]) ?? 0;
  const activeClients = scalar<number>("SELECT COUNT(*) FROM clients WHERE org_id = ? AND status = 'active'", [orgId]) ?? 0;
  const totalLtv = scalar<number>('SELECT COALESCE(SUM(lifetime_value),0) FROM clients WHERE org_id = ?', [orgId]) ?? 0;
  const openPipeline = scalar<number>(
    `SELECT COALESCE(SUM(revenue_potential),0) FROM businesses WHERE org_id = ? AND merged_into IS NULL
       AND stage NOT IN ('lost','won','onboarding','delivery','active_client','expansion')`,
    [orgId]
  ) ?? 0;

  // Average time to close — only over deals that actually closed.
  const closes = all<{ first_discovered_at: string; updated_at: string }>(
    `SELECT b.first_discovered_at, b.updated_at FROM businesses b JOIN clients c ON c.business_id = b.id WHERE b.org_id = ?`,
    [orgId]
  );
  const days = closes.map((r) => daysBetween(r.first_discovered_at, r.updated_at)).filter((d) => d >= 0);
  const avgDaysToClose = days.length ? round(days.reduce((a, b) => a + b, 0) / days.length, 1) : null;

  return {
    pipelineValue: round(openPipeline, 2),
    wonRevenue: round(wonRevenue, 2),
    paidRevenue: round(paidRevenue, 2),
    mrr: round(mrr, 2),
    arr: round(mrr * 12, 2),
    activeClients,
    averageDealValue: activeClients ? round(totalLtv / activeClients, 2) : 0,
    averageDaysToClose: avgDaysToClose,
    // recommended_service lives on businesses, so revenue-by-service joins through it.
    revenueByService: all<{ service: string; total: number; count: number }>(
      `SELECT COALESCE(b.recommended_service, 'unspecified') AS service,
              COALESCE(SUM(p.total), 0) AS total, COUNT(*) AS count
         FROM proposals p JOIN businesses b ON b.id = p.business_id
        WHERE p.org_id = ? AND p.status = 'accepted'
        GROUP BY service ORDER BY total DESC`,
      [orgId]
    ),
    monthlyRecurring: all<{ name: string; amount: number }>(
      "SELECT name, SUM(amount) amount FROM subscriptions WHERE org_id = ? AND status = 'active' GROUP BY name ORDER BY amount DESC",
      [orgId]
    ),
  };
}

/** Unit economics (§47 efficiency, §65 cost per X). */
export function efficiencyAnalytics(orgId: string) {
  const totalCost = scalar<number>('SELECT COALESCE(SUM(amount),0) FROM cost_ledger WHERE org_id = ?', [orgId]) ?? 0;
  const aiCost = monthlySpend(orgId);
  const byCategory = all<{ category: string; amount: number; units: number }>(
    'SELECT category, COALESCE(SUM(amount),0) amount, COALESCE(SUM(units),0) units FROM cost_ledger WHERE org_id = ? GROUP BY category ORDER BY amount DESC',
    [orgId]
  );

  const prospects = scalar<number>('SELECT COUNT(*) FROM businesses WHERE org_id = ? AND merged_into IS NULL', [orgId]) ?? 0;
  const qualified = scalar<number>("SELECT COUNT(*) FROM businesses WHERE org_id = ? AND stage <> 'discovered' AND merged_into IS NULL", [orgId]) ?? 0;
  const opportunities = scalar<number>("SELECT COUNT(*) FROM businesses WHERE org_id = ? AND priority IN ('high','critical')", [orgId]) ?? 0;
  const customers = scalar<number>('SELECT COUNT(*) FROM clients WHERE org_id = ?', [orgId]) ?? 0;
  const mockups = scalar<number>('SELECT COUNT(*) FROM mockups WHERE org_id = ?', [orgId]) ?? 0;
  const messages = scalar<number>("SELECT COUNT(*) FROM outreach_messages WHERE org_id = ? AND sent_at IS NOT NULL", [orgId]) ?? 0;
  const discoveries = scalar<number>('SELECT COUNT(*) FROM discovery_runs WHERE org_id = ?', [orgId]) ?? 0;

  const per = (n: number) => (n > 0 ? round(totalCost / n, 4) : null);

  return {
    totalCost: round(totalCost, 4),
    aiCost: round(aiCost, 4),
    byCategory,
    costPerProspect: per(prospects),
    costPerQualifiedProspect: per(qualified),
    costPerOpportunity: per(opportunities),
    costPerCustomer: per(customers),
    costPerMockup: per(mockups),
    costPerOutreach: per(messages),
    costPerDiscoveryRun: per(discoveries),
    counts: { prospects, qualified, opportunities, customers, mockups, messages, discoveries },
  };
}

// ── Forge Automation observability (§42) ─────────────────────
export interface AutomationHealth {
  runs: number;
  completed: number;
  partial: number;
  failed: number;
  successRate: number;
  failureRate: number;
  avgRuntimeMs: number;
  lastRunAt: string | null;
  lastStatus: string | null;
  nextRunAt: string | null;
  schedule: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  totalCost: number;
  errors: { category: string; count: number; unresolved: number }[];
  providerHealth: { key: string; label: string; status: string; lastRunAt: string | null; records: number }[];
}

export function automationHealth(orgId: string): AutomationHealth {
  const job = get<{
    enabled: number; schedule: string; cron: string; timezone: string; last_run_at: string | null;
    last_status: string | null; next_run_at: string | null; runs_total: number; runs_failed: number; avg_duration_ms: number;
  }>("SELECT * FROM automation_jobs WHERE org_id = ? AND key = 'daily_discovery'", [orgId]);

  const runs = all<{ status: string; duration_ms: number | null; cost: number }>(
    'SELECT status, duration_ms, cost FROM discovery_runs WHERE org_id = ? ORDER BY started_at DESC LIMIT 50',
    [orgId]
  );
  const completed = runs.filter((r) => r.status === 'completed').length;
  const partial = runs.filter((r) => r.status === 'partial').length;
  const failed = runs.filter((r) => r.status === 'failed').length;
  const successful = completed + partial;
  const totalCost = runs.reduce((a, r) => a + (r.cost ?? 0), 0);
  const durations = runs.map((r) => r.duration_ms ?? 0).filter((d) => d > 0);

  const errors = all<{ category: string; count: number; unresolved: number }>(
    `SELECT category, COUNT(*) count, SUM(CASE WHEN resolution = 'pending' THEN 1 ELSE 0 END) unresolved
       FROM automation_logs WHERE org_id = ? AND level IN ('warn','error') GROUP BY category ORDER BY count DESC`,
    [orgId]
  );

  const providerHealth = all<{ provider_key: string; label: string; last_run_at: string | null; last_status: string | null; records_total: number; enabled: number; credentials_ready: number }>(
    'SELECT provider_key, label, last_run_at, last_status, records_total, enabled, credentials_ready FROM discovery_sources WHERE org_id = ? ORDER BY label',
    [orgId]
  ).map((p) => ({
    key: p.provider_key,
    label: p.label,
    status: !p.enabled ? 'disabled' : !p.credentials_ready ? 'needs credentials' : p.last_status ?? 'not run',
    lastRunAt: p.last_run_at,
    records: p.records_total,
  }));

  return {
    runs: runs.length,
    completed,
    partial,
    failed,
    successRate: runs.length ? round((successful / runs.length) * 100, 1) : 0,
    failureRate: runs.length ? round((failed / runs.length) * 100, 1) : 0,
    avgRuntimeMs: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0,
    lastRunAt: job?.last_run_at ?? null,
    lastStatus: job?.last_status ?? null,
    nextRunAt: job?.next_run_at ?? null,
    schedule: job?.schedule ?? 'daily',
    cron: job?.cron ?? '0 2 * * *',
    timezone: job?.timezone ?? 'UTC',
    enabled: job?.enabled === 1,
    totalCost: round(totalCost, 4),
    errors,
    providerHealth,
  };
}

// ── Cost dashboard (§65) ─────────────────────────────────────
export function costDashboard(orgId: string) {
  const eff = efficiencyAnalytics(orgId);
  const byDay = all<{ day: string; amount: number }>(
    `SELECT substr(created_at,1,10) day, COALESCE(SUM(amount),0) amount FROM cost_ledger
      WHERE org_id = ? AND created_at >= ? GROUP BY day ORDER BY day`,
    [orgId, new Date(Date.now() - 30 * 86_400_000).toISOString()]
  );
  const aiByTask = all<{ task: string; calls: number; cost: number }>(
    `SELECT task, COUNT(*) calls, COALESCE(SUM(cost),0) cost FROM ai_model_usage
      WHERE org_id = ? AND created_at >= ? GROUP BY task ORDER BY cost DESC`,
    [orgId, new Date(Date.now() - 30 * 86_400_000).toISOString()]
  );
  const settings = getSettings(orgId);
  const spent = monthlySpend(orgId);
  return {
    ...eff,
    byDay,
    aiByTask,
    monthlyBudget: settings.ai.monthlyBudgetUsd,
    monthlySpent: round(spent, 4),
    budgetUsedPct: settings.ai.monthlyBudgetUsd ? round((spent / settings.ai.monthlyBudgetUsd) * 100, 1) : 0,
  };
}

/** Cached snapshot so the dashboard does not recompute on every render (§64). */
export function refreshAnalyticsSnapshot(orgId: string): void {
  const snapshot = {
    funnel: acquisitionFunnel(orgId),
    pipeline: pipelineSnapshot(orgId),
    revenue: revenueAnalytics(orgId),
    efficiency: efficiencyAnalytics(orgId),
    automation: automationHealth(orgId),
    generatedAt: nowIso(),
  };
  const now = nowIso();
  const existing = get<{ id: string }>("SELECT id FROM settings WHERE org_id = ? AND key = 'analytics_snapshot'", [orgId]);
  if (existing) {
    run('UPDATE settings SET value = ?, updated_at = ? WHERE id = ?', [toJson(snapshot), now, existing.id]);
  } else {
    run('INSERT INTO settings (id, org_id, key, value, created_at, updated_at) VALUES (?,?,?,?,?,?)', [
      id('set'), orgId, 'analytics_snapshot', toJson(snapshot), now, now,
    ]);
  }
}

export function cachedSnapshot(orgId: string, maxAgeMinutes = 30) {
  const row = get<{ value: string; updated_at: string }>("SELECT value, updated_at FROM settings WHERE org_id = ? AND key = 'analytics_snapshot'", [orgId]);
  if (!row) return null;
  if (daysBetween(row.updated_at) * 1440 > maxAgeMinutes) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

/** Engagement rollup used by the dashboard's "Engagement" figure. */
/** ClientForge Opportunity Score summary for the dashboard header (§59). */
export function opportunitySummary(orgId: string): {
  top: number;
  topName: string;
  critical: number;
  high: number;
  medium: number;
  average: number;
} {
  const top = get<{ name: string; opportunity_score: number | null }>(
    `SELECT name, opportunity_score FROM businesses
      WHERE org_id = ? AND merged_into IS NULL AND is_archived = 0
        AND stage NOT IN ('won','onboarding','delivery','active_client','expansion','lost')
      ORDER BY opportunity_score DESC LIMIT 1`,
    [orgId]
  );
  const counts = get<{ critical: number; high: number; medium: number; average: number }>(
    `SELECT
        SUM(CASE WHEN priority = 'critical' THEN 1 ELSE 0 END) AS critical,
        SUM(CASE WHEN priority = 'high' THEN 1 ELSE 0 END) AS high,
        SUM(CASE WHEN priority = 'medium' THEN 1 ELSE 0 END) AS medium,
        COALESCE(AVG(opportunity_score), 0) AS average
      FROM businesses
      WHERE org_id = ? AND merged_into IS NULL AND is_archived = 0
        AND stage NOT IN ('won','onboarding','delivery','active_client','expansion','lost')`,
    [orgId]
  );
  return {
    top: Math.round(top?.opportunity_score ?? 0),
    topName: top?.name ?? 'No prospects yet',
    critical: counts?.critical ?? 0,
    high: counts?.high ?? 0,
    medium: counts?.medium ?? 0,
    average: round(counts?.average ?? 0, 0),
  };
}

export function engagementSummary(orgId: string) {
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  return {
    opens: scalar<number>(`SELECT COALESCE(SUM(open_count),0) FROM outreach_messages WHERE org_id = ? AND updated_at >= ?`, [orgId, since]) ?? 0,
    clicks: scalar<number>(`SELECT COALESCE(SUM(click_count),0) FROM outreach_messages WHERE org_id = ? AND updated_at >= ?`, [orgId, since]) ?? 0,
    replies: scalar<number>(`SELECT COUNT(*) FROM outreach_messages WHERE org_id = ? AND direction = 'inbound' AND created_at >= ?`, [orgId, since]) ?? 0,
    conceptViews: scalar<number>(`SELECT COUNT(*) FROM mockup_views mv JOIN mockups m ON m.id = mv.mockup_id WHERE m.org_id = ? AND mv.viewed_at >= ?`, [orgId, since]) ?? 0,
    proposalViews: scalar<number>(`SELECT COALESCE(SUM(view_count),0) FROM proposals WHERE org_id = ? AND updated_at >= ?`, [orgId, since]) ?? 0,
  };
}
