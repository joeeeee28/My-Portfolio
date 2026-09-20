/**
 * Health checks and monitoring (§43).
 *
 * Liveness answers "is the process up". Readiness answers "can it serve
 * traffic" — database reachable, migrations applied, scheduler registered.
 * Individual components are reported separately so a degraded AI provider does
 * not take the whole service out of rotation.
 */
import { all, get, run, scalar } from '@/db';
import { nowIso } from '@/lib/id';
import { verifySchema, migrationStatus } from '@/db/migrations';
import { schedulerStatus } from '@/engine/scheduler';
import { deadLetterSummary } from '@/engine/jobs';
import { providers } from '@/lib/providers/registry';
import { getSecret } from '@/lib/secrets';

export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';

export interface ComponentHealth {
  component: string;
  status: HealthStatus;
  latencyMs?: number;
  detail?: string;
}

export interface HealthReport {
  status: HealthStatus;
  version: string;
  uptimeSec: number;
  timestamp: string;
  components: ComponentHealth[];
}

const STARTED_AT = Date.now();

/** Liveness: the process is running. Always cheap, never touches the database. */
export function liveness(): { status: 'ok'; uptimeSec: number; timestamp: string } {
  return { status: 'ok', uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000), timestamp: nowIso() };
}

export async function checkDatabase(): Promise<ComponentHealth> {
  const started = Date.now();
  try {
    const result = scalar<number>('SELECT 1');
    if (result !== 1) return { component: 'database', status: 'unhealthy', detail: 'probe query returned no rows' };

    const integrity = scalar<string>('PRAGMA integrity_check');
    if (integrity !== 'ok') {
      return { component: 'database', status: 'unhealthy', latencyMs: Date.now() - started, detail: `integrity_check: ${integrity}` };
    }
    return { component: 'database', status: 'healthy', latencyMs: Date.now() - started };
  } catch (err) {
    return { component: 'database', status: 'unhealthy', latencyMs: Date.now() - started, detail: err instanceof Error ? err.message : String(err) };
  }
}

export function checkMigrations(): ComponentHealth {
  try {
    const status = migrationStatus();
    if (status.pending.length) {
      return { component: 'migrations', status: 'degraded', detail: `${status.pending.length} pending: ${status.pending.join(', ')}` };
    }
    const schema = verifySchema();
    if (!schema.ok) return { component: 'migrations', status: 'degraded', detail: schema.problems.join('; ') };
    return { component: 'migrations', status: 'healthy', detail: `${schema.tableCount} tables, ${schema.indexCount} indexes` };
  } catch (err) {
    return { component: 'migrations', status: 'unhealthy', detail: err instanceof Error ? err.message : String(err) };
  }
}

export function checkScheduler(): ComponentHealth {
  const status = schedulerStatus();
  if (!status.running) return { component: 'scheduler', status: 'unhealthy', detail: 'not started' };
  if (status.scheduledTasks === 0) return { component: 'scheduler', status: 'degraded', detail: 'running but no jobs registered' };
  return { component: 'scheduler', status: 'healthy', detail: `${status.scheduledTasks} jobs registered` };
}

export function checkQueue(orgId: string): ComponentHealth {
  const dlq = deadLetterSummary(orgId);
  if (dlq.open > 50) return { component: 'queue', status: 'degraded', detail: `${dlq.open} items in the dead-letter queue` };
  return { component: 'queue', status: 'healthy', detail: `${dlq.open} open, ${dlq.resolved} resolved` };
}

/** Provider readiness. A provider with no credentials is "not configured", not unhealthy. */
export function checkProviders(orgId: string): ComponentHealth[] {
  const groups: { name: string; list: { key: string; label: string; requiresCredentials: boolean }[] }[] = [
    { name: 'providers.ai', list: providers.ai },
    { name: 'providers.discovery', list: providers.discovery },
    { name: 'providers.communication', list: providers.communication },
    { name: 'providers.hosting', list: providers.hosting },
    { name: 'providers.payment', list: providers.payment },
  ];

  return groups.map(({ name, list }) => {
    const usable = list.filter((p) => !p.requiresCredentials || !!getSecret(orgId, p.key));
    const needsKey = list.filter((p) => p.requiresCredentials && !getSecret(orgId, p.key));
    if (usable.length === 0) {
      return { component: name, status: 'degraded' as HealthStatus, detail: `none configured (${needsKey.length} awaiting credentials)` };
    }
    return {
      component: name,
      status: 'healthy' as HealthStatus,
      detail: `${usable.length}/${list.length} usable${needsKey.length ? `, ${needsKey.length} awaiting credentials` : ''}`,
    };
  });
}

export function checkDisk(): ComponentHealth {
  try {
    const stats = require('fs').statfsSync(process.cwd()) as { bavail: bigint; bsize: bigint };
    const freeBytes = Number(stats.bavail * stats.bsize);
    const freeGb = freeBytes / 1024 ** 3;
    if (freeGb < 1) return { component: 'disk', status: 'unhealthy', detail: `${freeGb.toFixed(2)} GB free` };
    if (freeGb < 5) return { component: 'disk', status: 'degraded', detail: `${freeGb.toFixed(2)} GB free` };
    return { component: 'disk', status: 'healthy', detail: `${freeGb.toFixed(1)} GB free` };
  } catch {
    return { component: 'disk', status: 'healthy', detail: 'statfs unavailable' };
  }
}

/**
 * Full readiness report. Overall status is the worst component status: any
 * unhealthy component makes the service unhealthy, any degraded makes it
 * degraded. Used by /api/health and by the Automation Center.
 */
export async function readiness(orgId: string): Promise<HealthReport> {
  const components: ComponentHealth[] = [];
  components.push(await checkDatabase());
  components.push(checkMigrations());
  components.push(checkScheduler());
  components.push(checkQueue(orgId));
  components.push(checkDisk());
  components.push(...checkProviders(orgId));

  const rank: Record<HealthStatus, number> = { healthy: 0, degraded: 1, unhealthy: 2 };
  const worst = components.reduce<HealthStatus>(
    (acc, c) => (rank[c.status] > rank[acc] ? c.status : acc),
    'healthy'
  );

  const report: HealthReport = {
    status: worst,
    version: process.env.APP_VERSION ?? '2.0.0',
    uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
    timestamp: nowIso(),
    components,
  };

  recordHealth(report);
  return report;
}

/** Persists each check so the Automation Center can chart history. */
function recordHealth(report: HealthReport): void {
  for (const c of report.components) {
    try {
      run(
        'INSERT INTO health_checks (id, org_id, component, status, latency_ms, detail, checked_at) VALUES (?,?,?,?,?,?,?)',
        [
          `hc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
          null,
          c.component,
          c.status,
          c.latencyMs ?? null,
          c.detail ?? null,
          nowIso(),
        ]
      );
    } catch {
      // Recording health must never break the health check itself.
    }
  }
}

export interface HealthHistoryRow {
  component: string;
  status: string;
  latency_ms: number | null;
  detail: string | null;
  checked_at: string;
}

export function healthHistory(component?: string, limit = 100): HealthHistoryRow[] {
  return component
    ? all<HealthHistoryRow>(
        'SELECT component, status, latency_ms, detail, checked_at FROM health_checks WHERE component = ? ORDER BY checked_at DESC LIMIT ?',
        [component, limit]
      )
    : all<HealthHistoryRow>(
        'SELECT component, status, latency_ms, detail, checked_at FROM health_checks ORDER BY checked_at DESC LIMIT ?',
        [limit]
      );
}

/** Aggregate error-rate and latency metrics for the Automation Center (§29, §43). */
export function apiMetrics(orgId: string, minutes = 60) {
  const since = new Date(Date.now() - minutes * 60_000).toISOString();
  const row = get<{ total: number; errors: number; avgMs: number; p95: number }>(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status >= 500 THEN 1 ELSE 0 END) AS errors,
            COALESCE(AVG(duration_ms), 0) AS avgMs,
            COALESCE(MAX(duration_ms), 0) AS p95
       FROM api_requests WHERE created_at >= ?`,
    [since]
  );
  const ai = get<{ calls: number; errors: number; cost: number }>(
    `SELECT COUNT(*) AS calls,
            SUM(CASE WHEN status <> 'ok' THEN 1 ELSE 0 END) AS errors,
            COALESCE(SUM(cost), 0) AS cost
       FROM ai_model_usage WHERE created_at >= ?`,
    [since]
  );
  return {
    windowMinutes: minutes,
    requests: row?.total ?? 0,
    errorRate: row?.total ? Math.round(((row.errors ?? 0) / row.total) * 1000) / 10 : 0,
    avgLatencyMs: Math.round(row?.avgMs ?? 0),
    maxLatencyMs: Math.round(row?.p95 ?? 0),
    aiCalls: ai?.calls ?? 0,
    aiErrors: ai?.errors ?? 0,
    aiCost: Math.round((ai?.cost ?? 0) * 10000) / 10000,
  };
}

export { get };
