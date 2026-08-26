/** Audit logging + structured application logging (§41, §55). */
import { all, get, run } from '@/db';
import { id, nowIso } from './id';

export interface AuditEntry {
  id: string;
  org_id: string;
  user_id: string | null;
  actor: string;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  detail: string | null;
  severity: string;
  created_at: string;
}

export function audit(
  orgId: string,
  action: string,
  opts: {
    actor?: string;
    userId?: string | null;
    entityType?: string | null;
    entityId?: string | null;
    detail?: unknown;
    severity?: 'info' | 'warn' | 'critical';
    ip?: string | null;
  } = {}
): string {
  const entryId = id('aud');
  run(
    `INSERT INTO audit_logs (id, org_id, user_id, actor, action, entity_type, entity_id, detail, ip, severity, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [
      entryId,
      orgId,
      opts.userId ?? null,
      opts.actor ?? 'system',
      action,
      opts.entityType ?? null,
      opts.entityId ?? null,
      opts.detail === undefined ? null : JSON.stringify(opts.detail),
      opts.ip ?? null,
      opts.severity ?? 'info',
      nowIso(),
    ]
  );
  return entryId;
}

export function listAudit(orgId: string, limit = 100, entity?: { type: string; id: string }): AuditEntry[] {
  if (entity) {
    return all<AuditEntry>(
      `SELECT * FROM audit_logs WHERE org_id = ? AND entity_type = ? AND entity_id = ? ORDER BY created_at DESC LIMIT ?`,
      [orgId, entity.type, entity.id, limit]
    );
  }
  return all<AuditEntry>(`SELECT * FROM audit_logs WHERE org_id = ? ORDER BY created_at DESC LIMIT ?`, [
    orgId,
    limit,
  ]);
}

// ── Automation logs (§41) ────────────────────────────────────
export type LogCategory =
  | 'source_error'
  | 'api_error'
  | 'website_analysis'
  | 'enrichment'
  | 'ai'
  | 'outreach'
  | 'mockup'
  | 'deployment'
  | 'system';

export interface AutomationLog {
  id: string;
  org_id: string;
  job_id: string | null;
  run_id: string | null;
  level: string;
  category: LogCategory;
  message: string;
  entity_type: string | null;
  entity_id: string | null;
  detail: string | null;
  retryable: number;
  retry_count: number;
  resolution: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  created_at: string;
}

export function logAutomation(
  orgId: string,
  category: LogCategory,
  message: string,
  opts: {
    level?: 'debug' | 'info' | 'warn' | 'error';
    jobId?: string | null;
    runId?: string | null;
    entityType?: string | null;
    entityId?: string | null;
    detail?: unknown;
    retryable?: boolean;
  } = {}
): string {
  const logId = id('log');
  run(
    `INSERT INTO automation_logs
       (id, org_id, job_id, run_id, level, category, message, entity_type, entity_id, detail, retryable, retry_count, resolution, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,0,'pending',?)`,
    [
      logId,
      orgId,
      opts.jobId ?? null,
      opts.runId ?? null,
      opts.level ?? 'info',
      category,
      message,
      opts.entityType ?? null,
      opts.entityId ?? null,
      opts.detail === undefined ? null : JSON.stringify(opts.detail),
      opts.retryable ? 1 : 0,
      nowIso(),
    ]
  );
  if (opts.level === 'error') {
    // eslint-disable-next-line no-console
    console.error(`[automation:${category}] ${message}`, opts.detail ?? '');
  }
  return logId;
}

export function listAutomationLogs(
  orgId: string,
  opts: { limit?: number; category?: string; resolution?: string; level?: string } = {}
): AutomationLog[] {
  const where: string[] = ['org_id = ?'];
  const params: unknown[] = [orgId];
  if (opts.category) {
    where.push('category = ?');
    params.push(opts.category);
  }
  if (opts.resolution) {
    where.push('resolution = ?');
    params.push(opts.resolution);
  }
  if (opts.level) {
    where.push('level = ?');
    params.push(opts.level);
  }
  params.push(opts.limit ?? 200);
  return all<AutomationLog>(
    `SELECT * FROM automation_logs WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`,
    params
  );
}

export function resolveLog(logId: string, resolution: 'retried' | 'skipped' | 'investigated' | 'resolved', by: string): boolean {
  const { changes } = run('UPDATE automation_logs SET resolution = ?, resolved_at = ?, resolved_by = ? WHERE id = ?', [
    resolution,
    nowIso(),
    by,
    logId,
  ]);
  return changes > 0;
}

export function errorSummary(orgId: string): Record<string, { count: number; unresolved: number }> {
  const rows = all<{ category: string; c: number; u: number }>(
    `SELECT category, COUNT(*) c, SUM(CASE WHEN resolution = 'pending' THEN 1 ELSE 0 END) u
       FROM automation_logs WHERE org_id = ? AND level IN ('warn','error')
      GROUP BY category`,
    [orgId]
  );
  const out: Record<string, { count: number; unresolved: number }> = {};
  for (const r of rows) out[r.category] = { count: r.c, unresolved: r.u };
  return out;
}

export function logStats(orgId: string, sinceIso: string) {
  return get<{ total: number; errors: number; warns: number; unresolved: number }>(
    `SELECT COUNT(*) total,
            SUM(CASE WHEN level = 'error' THEN 1 ELSE 0 END) errors,
            SUM(CASE WHEN level = 'warn' THEN 1 THEN 0 END) warns,
            SUM(CASE WHEN resolution = 'pending' AND level IN ('warn','error') THEN 1 ELSE 0 END) unresolved
       FROM automation_logs WHERE org_id = ? AND created_at >= ?`,
    [orgId, sinceIso]
  ) ?? { total: 0, errors: 0, warns: 0, unresolved: 0 };
}
