/** Chronological activity timeline (§61). Every meaningful event lands here. */
import { all, get, run } from '@/db';
import { id, nowIso } from './id';
import { STAGE_LABELS, STAGE_ORDER, type PipelineStage } from './domain';

export interface Activity {
  id: string;
  org_id: string;
  business_id: string | null;
  client_id: string | null;
  project_id: string | null;
  actor: string;
  kind: string;
  title: string;
  detail: string | null;
  entity_type: string | null;
  entity_id: string | null;
  icon: string | null;
  importance: string;
  created_at: string;
}

const KIND_ICONS: Record<string, string> = {
  discovery: 'radar',
  audit: 'clipboard',
  score: 'gauge',
  research: 'search',
  outreach: 'send',
  mockup: 'layout',
  call: 'phone',
  proposal: 'file-text',
  project: 'folder',
  deployment: 'rocket',
  social: 'share-2',
  stage_change: 'arrow-right',
  note: 'message-square',
  error: 'alert-triangle',
  client: 'user-check',
  payment: 'credit-card',
  enrichment: 'database',
};

export function logActivity(
  orgId: string,
  kind: string,
  title: string,
  opts: {
    businessId?: string | null;
    clientId?: string | null;
    projectId?: string | null;
    actor?: string;
    detail?: string | null;
    entityType?: string | null;
    entityId?: string | null;
    importance?: 'normal' | 'high' | 'critical';
    at?: string;
  } = {}
): string {
  const activityId = id('act');
  run(
    `INSERT INTO activities
       (id, org_id, business_id, client_id, project_id, actor, kind, title, detail, entity_type, entity_id, icon, importance, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      activityId,
      orgId,
      opts.businessId ?? null,
      opts.clientId ?? null,
      opts.projectId ?? null,
      opts.actor ?? 'system',
      kind,
      title,
      opts.detail ?? null,
      opts.entityType ?? null,
      opts.entityId ?? null,
      KIND_ICONS[kind] ?? 'activity',
      opts.importance ?? 'normal',
      opts.at ?? nowIso(),
    ]
  );
  return activityId;
}

export function listBusinessActivity(orgId: string, businessId: string, limit = 200): Activity[] {
  return all<Activity>(
    `SELECT * FROM activities WHERE org_id = ? AND business_id = ? ORDER BY created_at DESC LIMIT ?`,
    [orgId, businessId, limit]
  );
}

export function listOrgActivity(orgId: string, limit = 100, since?: string): Activity[] {
  if (since) {
    return all<Activity>(
      `SELECT a.*, b.name AS business_name FROM activities a
         LEFT JOIN businesses b ON b.id = a.business_id
        WHERE a.org_id = ? AND a.created_at >= ?
        ORDER BY a.created_at DESC LIMIT ?`,
      [orgId, since, limit]
    );
  }
  return all<Activity>(
    `SELECT a.*, b.name AS business_name FROM activities a
       LEFT JOIN businesses b ON b.id = a.business_id
      WHERE a.org_id = ? ORDER BY a.created_at DESC LIMIT ?`,
    [orgId, limit]
  );
}

export interface StageChange {
  ok: boolean;
  from: string;
  to: string;
  forward: boolean;
  reason?: string;
}

/**
 * Move a business through the pipeline. Backward moves are allowed but flagged,
 * and terminal-stage moves are recorded as lifecycle events.
 */
export function changeStage(
  orgId: string,
  businessId: string,
  to: PipelineStage,
  opts: { actor?: string; reason?: string } = {}
): StageChange {
  const current = get<{ stage: string; name: string }>('SELECT stage, name FROM businesses WHERE id = ?', [
    businessId,
  ]);
  if (!current) return { ok: false, from: '', to, forward: false, reason: 'business_not_found' };
  if (current.stage === to) return { ok: false, from: current.stage, to, forward: false, reason: 'no_change' };

  const fromOrder = STAGE_ORDER[current.stage as PipelineStage] ?? 0;
  const toOrder = STAGE_ORDER[to] ?? 0;
  const forward = toOrder > fromOrder;

  run('UPDATE businesses SET stage = ?, updated_at = ? WHERE id = ?', [to, nowIso(), businessId]);
  logActivity(orgId, 'stage_change', `${current.name} → ${STAGE_LABELS[to]}`, {
    businessId,
    actor: opts.actor ?? 'system',
    detail: opts.reason ?? `Moved from ${STAGE_LABELS[current.stage as PipelineStage] ?? current.stage}`,
    entityType: 'business',
    entityId: businessId,
    importance: ['won', 'lost', 'active_client'].includes(to) ? 'high' : 'normal',
  });
  return { ok: true, from: current.stage, to, forward };
}

export function countActivitiesByKind(orgId: string, sinceIso: string): Record<string, number> {
  const rows = all<{ kind: string; c: number }>(
    `SELECT kind, COUNT(*) c FROM activities WHERE org_id = ? AND created_at >= ? GROUP BY kind`,
    [orgId, sinceIso]
  );
  return Object.fromEntries(rows.map((r) => [r.kind, r.c]));
}
