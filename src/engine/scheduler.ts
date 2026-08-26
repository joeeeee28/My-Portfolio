/**
 * Forge Automation scheduler (§4, §39).
 *
 * Runs in-process. Every job re-reads its own settings on each tick, so
 * schedule changes in the UI take effect without a restart. Failures are
 * recorded against the job row and the automation log — never swallowed.
 */
import cron, { type ScheduledTask } from 'node-cron';
import { all, get, run, scalar } from '@/db';
import { nowIso } from '@/lib/id';
import { logAutomation } from '@/lib/logging';
import { getSettings } from '@/lib/settings';
import { nextRunForCron } from '@/lib/time';
import { registerAllProviders } from '@/lib/providers';

let started = false;
const tasks = new Map<string, ScheduledTask>();

const HANDLERS: Record<string, (orgId: string) => Promise<{ detail: string }>> = {
  daily_discovery: async (orgId) => {
    const { runDiscovery } = await import('@/engine/discovery');
    const res = await runDiscovery(orgId, { kind: 'scheduled', trigger: 'cron' });
    return { detail: `${res.stats.discovered} discovered · ${res.stats.qualified} qualified · ${res.stats.errors} error(s)` };
  },
  sequence_dispatch: async (orgId) => {
    const { dispatchSequences } = await import('@/engine/outreach');
    const res = await dispatchSequences(orgId, { actor: 'scheduler' });
    return { detail: `${res.dispatched} dispatched · ${res.stopped} stopped · ${res.errors} error(s)` };
  },
  followup_sweep: async (orgId) => {
    const { sweepFollowUps } = await import('@/engine/discovery');
    const n = await sweepFollowUps(orgId);
    const { applyNba } = await import('@/engine/nba');
    const targets = all<{ id: string }>(
      `SELECT id FROM businesses WHERE org_id = ? AND merged_into IS NULL AND is_archived = 0 AND opportunity_score IS NOT NULL LIMIT 300`,
      [orgId]
    );
    for (const t of targets) applyNba(orgId, t.id);
    return { detail: `${n} follow-up(s) created, ${targets.length} next-best-action(s) refreshed` };
  },
  analytics_rollup: async (orgId) => {
    const { refreshAnalyticsSnapshot } = await import('@/engine/analytics');
    const { buildDailyBriefing } = await import('@/engine/briefing');
    const { refreshClientMetrics, assessDeliveryHealth, scanUpsells } = await import('@/engine/crm');
    refreshAnalyticsSnapshot(orgId);
    buildDailyBriefing(orgId, { regenerate: true });
    refreshClientMetrics(orgId);
    assessDeliveryHealth(orgId);
    const upsells = scanUpsells(orgId);
    return { detail: `snapshot refreshed, ${upsells.length} growth opportunit(ies) found` };
  },
  upsell_scan: async (orgId) => {
    const { scanUpsells } = await import('@/engine/crm');
    const { generateOptimizationRecommendations, learnIcp } = await import('@/engine/experiments');
    const upsells = scanUpsells(orgId);
    const opts = generateOptimizationRecommendations(orgId);
    learnIcp(orgId);
    return { detail: `${upsells.length} growth opportunit(ies), ${opts.length} optimization proposal(s)` };
  },
  reverify_sweep: async (orgId) => {
    const { runDiscovery } = await import('@/engine/discovery');
    const res = await runDiscovery(orgId, { kind: 'scheduled', trigger: 'reverify', limit: 120 });
    return { detail: `${res.stats.websiteVerified} website(s) re-verified` };
  },
};

function orgIds(): string[] {
  return all<{ id: string }>('SELECT id FROM organizations ORDER BY created_at ASC').map((o) => o.id);
}

async function executeJob(jobKey: string, orgId: string): Promise<void> {
  const handler = HANDLERS[jobKey];
  if (!handler) return;
  const job = get<{ id: string; enabled: number; label: string }>('SELECT id, enabled, label FROM automation_jobs WHERE org_id = ? AND key = ?', [orgId, jobKey]);
  if (!job || !job.enabled) return;

  const startedAt = Date.now();
  run('UPDATE automation_jobs SET last_run_at = ?, updated_at = ? WHERE id = ?', [nowIso(), nowIso(), job.id]);
  try {
    const { detail } = await handler(orgId);
    const duration = Date.now() - startedAt;
    run(
      `UPDATE automation_jobs SET last_status = 'completed', runs_total = runs_total + 1, avg_duration_ms = ?,
              next_run_at = ?, updated_at = ? WHERE id = ?`,
      [duration, nextRunForCron(jobCron(orgId, jobKey), jobTz(orgId, jobKey)).toISOString(), nowIso(), job.id]
    );
    logAutomation(orgId, 'system', `${job.label} completed — ${detail}`, { level: 'info', jobId: job.id });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    run(
      `UPDATE automation_jobs SET last_status = 'failed', runs_total = runs_total + 1, runs_failed = runs_failed + 1,
              avg_duration_ms = ?, updated_at = ? WHERE id = ?`,
      [Date.now() - startedAt, nowIso(), job.id]
    );
    logAutomation(orgId, 'system', `${job.label} failed: ${message}`, {
      level: 'error',
      jobId: job.id,
      detail: { stack: String(err) },
      retryable: true,
    });
  }
}

function jobCron(orgId: string, jobKey: string): string {
  return (get<{ cron: string }>('SELECT cron FROM automation_jobs WHERE org_id = ? AND key = ?', [orgId, jobKey])?.cron ?? '0 2 * * *');
}

function jobTz(orgId: string, jobKey: string): string {
  return get<{ timezone: string }>('SELECT timezone FROM automation_jobs WHERE org_id = ? AND key = ?', [orgId, jobKey])?.timezone ?? 'UTC';
}

/** Starts (or re-syncs) every enabled job across every org. Idempotent. */
export function startScheduler(): { started: number; jobs: { key: string; cron: string; nextRunAt: string }[] } {
  registerAllProviders();
  const now = nowIso();
  const registered: { key: string; cron: string; nextRunAt: string }[] = [];
  let count = 0;

  for (const orgId of orgIds()) {
    const jobs = all<{ key: string; cron: string; timezone: string; enabled: number }>(
      'SELECT key, cron, timezone, enabled FROM automation_jobs WHERE org_id = ?',
      [orgId]
    );
    for (const job of jobs) {
      // Keep next_run_at honest for the Automation Center even before first tick.
      run('UPDATE automation_jobs SET next_run_at = COALESCE(next_run_at, ?), updated_at = ? WHERE org_id = ? AND key = ?', [
        nextRunForCron(job.cron, job.timezone).toISOString(),
        now,
        orgId,
        job.key,
      ]);
      if (!job.enabled) continue;

      const taskKey = `${orgId}:${job.key}`;
      if (tasks.has(taskKey)) continue;
      if (!cron.validate(job.cron)) {
        logAutomation(orgId, 'system', `Invalid cron expression for ${job.key}: "${job.cron}" — job not scheduled.`, { level: 'error' });
        continue;
      }
      const task = cron.schedule(
        job.cron,
        () => {
          void executeJob(job.key, orgId);
        },
        { timezone: job.timezone === 'UTC' ? undefined : job.timezone }
      );
      tasks.set(taskKey, task);
      count++;
      registered.push({ key: job.key, cron: job.cron, nextRunAt: nextRunForCron(job.cron, job.timezone).toISOString() });
    }
  }

  started = true;
  return { started: count, jobs: registered };
}

export function stopScheduler(): void {
  for (const task of tasks.values()) task.stop();
  tasks.clear();
  started = false;
}

export function schedulerStatus(): { running: boolean; scheduledTasks: number; keys: string[] } {
  return { running: started, scheduledTasks: tasks.size, keys: Array.from(tasks.keys()) };
}

/** Re-syncs a single job after its schedule or enabled flag changes. */
export function resyncJob(orgId: string, jobKey: string): void {
  const taskKey = `${orgId}:${jobKey}`;
  tasks.get(taskKey)?.stop();
  tasks.delete(taskKey);
  const job = get<{ cron: string; timezone: string; enabled: number }>(
    'SELECT cron, timezone, enabled FROM automation_jobs WHERE org_id = ? AND key = ?',
    [orgId, jobKey]
  );
  if (!job) return;
  run('UPDATE automation_jobs SET next_run_at = ?, updated_at = ? WHERE org_id = ? AND key = ?', [
    job.enabled ? nextRunForCron(job.cron, job.timezone).toISOString() : null,
    nowIso(),
    orgId,
    jobKey,
  ]);
  if (!job.enabled || !cron.validate(job.cron)) return;
  tasks.set(
    taskKey,
    cron.schedule(job.cron, () => void executeJob(jobKey, orgId), { timezone: job.timezone === 'UTC' ? undefined : job.timezone })
  );
}

export function updateJobSchedule(
  orgId: string,
  jobKey: string,
  patch: { enabled?: boolean; cron?: string; schedule?: string; timezone?: string }
): void {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.enabled !== undefined) {
    sets.push('enabled = ?');
    params.push(patch.enabled ? 1 : 0);
  }
  if (patch.cron) {
    if (!cron.validate(patch.cron)) throw new Error(`Invalid cron expression: ${patch.cron}`);
    sets.push('cron = ?');
    params.push(patch.cron);
  }
  if (patch.schedule) {
    sets.push('schedule = ?');
    params.push(patch.schedule);
  }
  if (patch.timezone) {
    sets.push('timezone = ?');
    params.push(patch.timezone);
  }
  if (!sets.length) return;
  params.push(nowIso(), orgId, jobKey);
  run(`UPDATE automation_jobs SET ${sets.join(', ')}, updated_at = ? WHERE org_id = ? AND key = ?`, params);
  resyncJob(orgId, jobKey);
}

/** Manual "Run now" — synchronous so the UI can show the result. */
export async function runJobNow(orgId: string, jobKey: string): Promise<{ ok: boolean; detail: string }> {
  const handler = HANDLERS[jobKey];
  if (!handler) return { ok: false, detail: `Unknown job: ${jobKey}` };
  const startedAt = Date.now();
  try {
    const { detail } = await handler(orgId);
    run(
      `UPDATE automation_jobs SET last_run_at = ?, last_status = 'completed', runs_total = runs_total + 1,
              avg_duration_ms = ?, next_run_at = ?, updated_at = ?
        WHERE org_id = ? AND key = ?`,
      [nowIso(), Date.now() - startedAt, nextRunForCron(jobCron(orgId, jobKey), jobTz(orgId, jobKey)).toISOString(), nowIso(), orgId, jobKey]
    );
    return { ok: true, detail };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    run(`UPDATE automation_jobs SET last_run_at = ?, last_status = 'failed', runs_failed = runs_failed + 1, updated_at = ? WHERE org_id = ? AND key = ?`, [
      nowIso(),
      nowIso(),
      orgId,
      jobKey,
    ]);
    logAutomation(orgId, 'system', `Manual run of ${jobKey} failed: ${message}`, { level: 'error', retryable: true });
    return { ok: false, detail: message };
  }
}

export function listJobs(orgId: string) {
  return all<{
    key: string; label: string; enabled: number; schedule: string; cron: string; timezone: string;
    last_run_at: string | null; last_status: string | null; next_run_at: string | null;
    runs_total: number; runs_failed: number; avg_duration_ms: number;
  }>('SELECT * FROM automation_jobs WHERE org_id = ? ORDER BY key', [orgId]).map((j) => ({
    ...j,
    running: tasks.has(`${orgId}:${j.key}`),
    successRate: j.runs_total ? Number((((j.runs_total - j.runs_failed) / j.runs_total) * 100).toFixed(1)) : 0,
  }));
}

export { getSettings, scalar };
