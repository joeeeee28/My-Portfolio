/**
 * Background job architecture (§30, §31, §32).
 *
 * Provides what the V1 discovery pipeline lacked:
 *  - resumable runs — a failed run continues from its last successful step
 *  - advisory locking — two workers cannot run the same job at once
 *  - idempotency — a retried operation cannot double-apply
 *  - retry with backoff, and a dead-letter queue for work that exhausts retries
 *  - progress + per-step accounting so the Automation Center can show state
 *
 * Jobs are executed by a worker loop, never inline in an HTTP request.
 */
import { all, db, get, run, scalar, toJson } from '@/db';
import { id, nowIso } from '@/lib/id';
import { logAutomation } from '@/lib/logging';

export type JobStatus = 'running' | 'paused' | 'completed' | 'partial' | 'failed' | 'cancelled';
export type StepStatus = 'pending' | 'running' | 'completed' | 'skipped' | 'failed';

export interface StepContext {
  runId: string;
  orgId: string;
  attempt: number;
  /** Records progress inside a step. */
  report: (processed: number, succeeded?: number, failed?: number, detail?: string) => void;
  /** Lets a step stop early (e.g. cancellation) and report why. */
  shouldStop: () => boolean;
}

export type StepFn = (ctx: StepContext) => Promise<{ processed?: number; succeeded?: number; failed?: number; detail?: string } | void>;

export interface StepDef {
  key: string;
  label: string;
  run: StepFn;
  /** Steps that may fail without failing the whole run. */
  optional?: boolean;
  maxAttempts?: number;
}

export interface JobDef {
  key: string;
  label: string;
  steps: StepDef[];
  maxRetries?: number;
}

export interface RunHandle {
  runId: string;
  status: JobStatus;
  resumedFrom: string | null;
}

// ═══════════════════════════════════════════════════════════
// IDEMPOTENCY (§32)
// ═══════════════════════════════════════════════════════════

/**
 * Runs `fn` at most once per (org, key). If the key was already used, the
 * stored result is returned and `fn` is not executed again.
 */
export function withIdempotency<T>(orgId: string, key: string, operation: string, fn: () => T): { result: T; deduplicated: boolean } {
  pruneIdempotencyKeys(orgId);
  const existing = get<{ result: string | null }>(
    'SELECT result FROM idempotency_keys WHERE org_id = ? AND key = ?',
    [orgId, key]
  );
  if (existing) {
    let parsed: T;
    try {
      parsed = (existing.result ? JSON.parse(existing.result) : undefined) as T;
    } catch {
      parsed = undefined as T;
    }
    return { result: parsed, deduplicated: true };
  }

  const result = fn();
  const expires = new Date(Date.now() + 7 * 86_400_000).toISOString();
  run(
    `INSERT OR IGNORE INTO idempotency_keys (id, org_id, key, operation, result, created_at, expires_at)
     VALUES (?,?,?,?,?,?,?)`,
    [id('idem'), orgId, key, operation, toJson(result ?? null), nowIso(), expires]
  );
  return { result, deduplicated: false };
}

export function pruneIdempotencyKeys(orgId: string): number {
  const { changes } = run('DELETE FROM idempotency_keys WHERE org_id = ? AND expires_at < ?', [orgId, nowIso()]);
  return changes;
}

/**
 * A deterministic key for "this operation on this entity in this run window".
 * Used so a retried discovery run cannot create the same business twice and a
 * retried send cannot emit the same message twice.
 */
export function idempotencyKey(parts: (string | number | null | undefined)[]): string {
  const crypto = require('node:crypto') as typeof import('node:crypto');
  return crypto.createHash('sha256').update(parts.filter(Boolean).join('|')).digest('hex').slice(0, 32);
}

// ═══════════════════════════════════════════════════════════
// LOCKING (§31)
// ═══════════════════════════════════════════════════════════

const LOCK_TTL_MS = 30 * 60_000;

/**
 * Acquires an advisory lock for a job key. Returns a token to release it, or
 * null when another run holds the lock. Expired locks are reclaimed so a
 * crashed worker cannot block the job forever.
 */
export function acquireJobLock(orgId: string, jobKey: string, ttlMs = LOCK_TTL_MS): string | null {
  const now = Date.now();
  const holder = get<{ id: string; lock_token: string | null; lock_expires_at: string | null; status: string }>(
    `SELECT id, lock_token, lock_expires_at, status FROM job_runs
      WHERE org_id = ? AND job_key = ? AND status = 'running'
      ORDER BY started_at DESC LIMIT 1`,
    [orgId, jobKey]
  );

  if (holder) {
    const expires = holder.lock_expires_at ? new Date(holder.lock_expires_at).getTime() : 0;
    if (expires > now) return null; // a live lock — refuse
    // Expired: the owning worker died. Reclaim by marking it failed.
    run(
      `UPDATE job_runs SET status = 'failed', error = 'lock expired — worker presumed dead', finished_at = ?, updated_at = ?
        WHERE id = ?`,
      [nowIso(), nowIso(), holder.id]
    );
    logAutomation(orgId, 'system', `Reclaimed expired lock for ${jobKey} (run ${holder.id})`, { level: 'warn' });
  }

  const token = id('lock');
  // The lock lives on the run row, created by startRun.
  pendingLock.set(`${orgId}:${jobKey}`, { token, expiresAt: new Date(now + ttlMs).toISOString() });
  return token;
}

const pendingLock = new Map<string, { token: string; expiresAt: string }>();

export function releaseJobLock(orgId: string, jobKey: string, runId: string, token: string | null): void {
  run(`UPDATE job_runs SET lock_token = NULL, lock_expires_at = NULL, updated_at = ? WHERE id = ? AND lock_token = ?`, [
    nowIso(),
    runId,
    token,
  ]);
  pendingLock.delete(`${orgId}:${jobKey}`);
}

export function isJobLocked(orgId: string, jobKey: string): boolean {
  const holder = get<{ lock_expires_at: string | null }>(
    `SELECT lock_expires_at FROM job_runs WHERE org_id = ? AND job_key = ? AND status = 'running'
      ORDER BY started_at DESC LIMIT 1`,
    [orgId, jobKey]
  );
  if (!holder?.lock_expires_at) return false;
  return new Date(holder.lock_expires_at).getTime() > Date.now();
}

// ═══════════════════════════════════════════════════════════
// RUN LIFECYCLE
// ═══════════════════════════════════════════════════════════

export interface StartRunOptions {
  trigger?: string;
  idempotencyKey?: string;
  inputCount?: number;
  resumeRunId?: string;
}

export function startRun(orgId: string, job: JobDef, opts: StartRunOptions = {}): RunHandle {
  // Idempotent start: the same key cannot launch two runs.
  if (opts.idempotencyKey) {
    const dup = get<{ id: string; status: JobStatus }>(
      'SELECT id, status FROM job_runs WHERE org_id = ? AND idempotency_key = ?',
      [orgId, opts.idempotencyKey]
    );
    if (dup) return { runId: dup.id, status: dup.status, resumedFrom: null };
  }

  const lock = pendingLock.get(`${orgId}:${job.key}`);
  if (!lock) throw new Error(`startRun called without acquiring a lock for ${job.key}`);

  // Resuming: reuse the existing run row and skip completed steps.
  if (opts.resumeRunId) {
    const existing = get<{ id: string; completed_steps: string; status: JobStatus; last_successful_step: string | null }>(
      'SELECT id, completed_steps, status, last_successful_step FROM job_runs WHERE id = ? AND org_id = ?',
      [opts.resumeRunId, orgId]
    );
    if (existing) {
      run(
        `UPDATE job_runs SET status = 'running', lock_token = ?, lock_expires_at = ?, paused_at = NULL,
                retry_count = retry_count + 1, updated_at = ? WHERE id = ?`,
        [lock.token, lock.expiresAt, nowIso(), existing.id]
      );
      return { runId: existing.id, status: 'running', resumedFrom: existing.last_successful_step };
    }
  }

  const runId = id('jrun');
  const now = nowIso();
  run(
    `INSERT INTO job_runs (id, org_id, job_key, run_group, status, trigger, current_step, last_successful_step,
        completed_steps, progress, total_steps, input_count, stats, retry_count, max_retries, lock_token,
        lock_expires_at, started_at, idempotency_key, created_at, updated_at)
     VALUES (?,?,?,?,'running',?,NULL,NULL,'[]',0,?,?,'{}',0,?,?,?,?,?,?,?)`,
    [
      runId, orgId, job.key, runId, opts.trigger ?? 'manual', job.steps.length,
      opts.inputCount ?? 0, job.maxRetries ?? 2, lock.token, lock.expiresAt, now,
      opts.idempotencyKey ?? null, now, now,
    ]
  );

  // Register every step as pending so progress is visible immediately.
  job.steps.forEach((step, i) => {
    run(
      `INSERT OR IGNORE INTO job_steps (id, run_id, step, position, status, attempts, processed, succeeded, failed)
       VALUES (?,?,?,?,'pending',0,0,0,0)`,
      [id('jstep'), runId, step.key, i]
    );
  });

  return { runId, status: 'running', resumedFrom: null };
}

export function completedSteps(runId: string): Set<string> {
  const row = get<{ completed_steps: string }>('SELECT completed_steps FROM job_runs WHERE id = ?', [runId]);
  if (!row) return new Set();
  try {
    return new Set(JSON.parse(row.completed_steps) as string[]);
  } catch {
    return new Set();
  }
}

/**
 * Executes a job, resuming from the last successful step when asked.
 * Each step is individually retryable; a step that exhausts its attempts goes
 * to the dead-letter queue and (unless optional) fails the run.
 */
export async function executeJob(
  orgId: string,
  job: JobDef,
  opts: StartRunOptions = {}
): Promise<{ runId: string; status: JobStatus; steps: { key: string; status: StepStatus }[]; error?: string }> {
  if (isJobLocked(orgId, job.key)) {
    return { runId: '', status: 'running', steps: [], error: `Job ${job.key} is already running` };
  }
  const token = acquireJobLock(orgId, job.key);
  if (!token) {
    return { runId: '', status: 'running', steps: [], error: `Could not acquire lock for ${job.key}` };
  }

  const handle = startRun(orgId, job, opts);
  const done = opts.resumeRunId ? completedSteps(handle.runId) : new Set<string>();
  let failure: string | undefined;
  const results: { key: string; status: StepStatus }[] = [];

  try {
    for (const step of job.steps) {
      if (done.has(step.key)) {
        results.push({ key: step.key, status: 'completed' });
        continue;
      }
      if (isCancelled(handle.runId)) {
        await markRun(handle.runId, 'cancelled');
        results.push({ key: step.key, status: 'pending' });
        return { runId: handle.runId, status: 'cancelled', results: results, error: 'cancelled' } as never;
      }
      if (isPaused(handle.runId)) {
        await markRun(handle.runId, 'paused');
        return { runId: handle.runId, status: 'paused', steps: results };
      }

      const outcome = await runStep(orgId, handle.runId, job, step);
      results.push({ key: step.key, status: outcome.status });

      if (outcome.status === 'completed' || outcome.status === 'skipped') {
        done.add(step.key);
        recordStepSuccess(handle.runId, step.key, job.steps.length);
      } else {
        if (!step.optional) {
          failure = outcome.error ?? `${step.key} failed`;
          break;
        }
        // Optional step failed: record it and keep going.
        done.add(step.key);
        recordStepSuccess(handle.runId, step.key, job.steps.length);
      }
    }

    const status: JobStatus = failure ? 'failed' : done.size === job.steps.length ? 'completed' : 'partial';
    await markRun(handle.runId, status, failure);
    return { runId: handle.runId, status, steps: results, error: failure };
  } finally {
    releaseJobLock(orgId, job.key, handle.runId, token);
  }
}

async function runStep(
  orgId: string,
  runId: string,
  job: JobDef,
  step: StepDef
): Promise<{ status: StepStatus; error?: string }> {
  const maxAttempts = step.maxAttempts ?? 2;
  const started = Date.now();
  run(`UPDATE job_steps SET status = 'running', started_at = ? WHERE run_id = ? AND step = ?`, [nowIso(), runId, step.key]);
  run(`UPDATE job_runs SET current_step = ?, updated_at = ? WHERE id = ?`, [step.key, nowIso(), runId]);

  let lastError = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (isCancelled(runId)) return { status: 'failed', error: 'cancelled' };

    const ctx: StepContext = {
      runId,
      orgId,
      attempt,
      report: (processed, succeeded, failed, detail) => {
        run(
          `UPDATE job_steps SET processed = ?, succeeded = ?, failed = ?, detail = ? WHERE run_id = ? AND step = ?`,
          [processed, succeeded ?? 0, failed ?? 0, detail ?? null, runId, step.key]
        );
      },
      shouldStop: () => isCancelled(runId) || isPaused(runId),
    };

    try {
      const out = await step.run(ctx);
      const duration = Date.now() - started;
      run(
        `UPDATE job_steps SET status = 'completed', attempts = ?, processed = ?, succeeded = ?, failed = ?,
                detail = ?, duration_ms = ?, finished_at = ? WHERE run_id = ? AND step = ?`,
        [
          attempt,
          out?.processed ?? 0,
          out?.succeeded ?? out?.processed ?? 0,
          out?.failed ?? 0,
          out?.detail ?? null,
          duration,
          nowIso(),
          runId,
          step.key,
        ]
      );
      return { status: 'completed' };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      run(`UPDATE job_steps SET attempts = ?, error = ? WHERE run_id = ? AND step = ?`, [attempt, lastError, runId, step.key]);
      logAutomation(orgId, 'system', `Step "${step.label}" failed (attempt ${attempt}/${maxAttempts}): ${lastError}`, {
        level: attempt === maxAttempts ? 'error' : 'warn',
        jobId: null,
        runId,
        retryable: attempt < maxAttempts,
      });
      if (attempt < maxAttempts) await backoff(attempt);
    }
  }

  run(`UPDATE job_steps SET status = 'failed', finished_at = ? WHERE run_id = ? AND step = ?`, [nowIso(), runId, step.key]);
  toDeadLetter(orgId, {
    runId,
    jobKey: job.key,
    step: step.key,
    category: 'automation',
    error: lastError,
    attempts: maxAttempts,
  });
  return { status: 'failed', error: lastError };
}

function recordStepSuccess(runId: string, stepKey: string, totalSteps: number): void {
  const row = get<{ completed_steps: string; last_successful_step: string | null }>(
    'SELECT completed_steps, last_successful_step FROM job_runs WHERE id = ?',
    [runId]
  );
  let list: string[] = [];
  try {
    list = JSON.parse(row?.completed_steps ?? '[]') as string[];
  } catch {
    list = [];
  }
  if (!list.includes(stepKey)) list.push(stepKey);
  run(
    `UPDATE job_runs SET completed_steps = ?, last_successful_step = ?, progress = ?, updated_at = ? WHERE id = ?`,
    [toJson(list), stepKey, Math.round((list.length / Math.max(1, totalSteps)) * 100), nowIso(), runId]
  );
}

async function markRun(runId: string, status: JobStatus, error?: string): Promise<void> {
  const row = get<{ started_at: string; error_step: string | null; current_step: string | null }>(
    'SELECT started_at, error_step, current_step FROM job_runs WHERE id = ?',
    [runId]
  );
  run(
    `UPDATE job_runs SET status = ?, error = ?, error_step = ?, finished_at = ?, duration_ms = ?,
            lock_token = NULL, lock_expires_at = NULL, updated_at = ? WHERE id = ?`,
    [
      status,
      error ?? null,
      error ? (row?.current_step ?? null) : null,
      nowIso(),
      row ? Date.now() - new Date(row.started_at).getTime() : null,
      nowIso(),
      runId,
    ]
  );
}

async function backoff(attempt: number): Promise<void> {
  const ms = Math.min(30_000, 500 * 2 ** (attempt - 1));
  await new Promise((r) => setTimeout(r, ms));
}

// ═══════════════════════════════════════════════════════════
// CONTROL: pause / resume / retry / cancel (§30)
// ═══════════════════════════════════════════════════════════

export function pauseRun(runId: string): boolean {
  const { changes } = run(`UPDATE job_runs SET status = 'paused', paused_at = ?, updated_at = ? WHERE id = ? AND status = 'running'`, [
    nowIso(),
    nowIso(),
    runId,
  ]);
  return changes > 0;
}

export function cancelRun(runId: string): boolean {
  const { changes } = run(
    `UPDATE job_runs SET status = 'cancelled', finished_at = ?, lock_token = NULL, lock_expires_at = NULL, updated_at = ?
      WHERE id = ? AND status IN ('running','paused')`,
    [nowIso(), nowIso(), runId]
  );
  return changes > 0;
}

export function isCancelled(runId: string): boolean {
  return scalar<string>('SELECT status FROM job_runs WHERE id = ?', [runId]) === 'cancelled';
}

export function isPaused(runId: string): boolean {
  return scalar<string>('SELECT status FROM job_runs WHERE id = ?', [runId]) === 'paused';
}

/** The most recent resumable run for a job, if any. */
export function resumableRun(orgId: string, jobKey: string): { id: string; last_successful_step: string | null; progress: number } | null {
  return get<{ id: string; last_successful_step: string | null; progress: number }>(
    `SELECT id, last_successful_step, progress FROM job_runs
      WHERE org_id = ? AND job_key = ? AND status IN ('failed','paused','cancelled')
      ORDER BY started_at DESC LIMIT 1`,
    [orgId, jobKey]
  );
}

// ═══════════════════════════════════════════════════════════
// DEAD-LETTER QUEUE (§31, §42)
// ═══════════════════════════════════════════════════════════

export function toDeadLetter(
  orgId: string,
  entry: {
    runId?: string | null;
    jobKey?: string | null;
    step?: string | null;
    category: string;
    entityType?: string | null;
    entityId?: string | null;
    payload?: Record<string, unknown>;
    error: string;
    attempts?: number;
    idempotencyKey?: string | null;
  }
): string {
  // Idempotent: the same failure is not queued twice.
  const key = entry.idempotencyKey ?? idempotencyKey([orgId, entry.category, entry.entityId, entry.step, entry.error.slice(0, 80)]);
  const existing = get<{ id: string }>('SELECT id FROM dead_letter WHERE org_id = ? AND idempotency_key = ?', [orgId, key]);
  if (existing) {
    run('UPDATE dead_letter SET attempts = attempts + 1 WHERE id = ?', [existing.id]);
    return existing.id;
  }

  const dlqId = id('dlq');
  run(
    `INSERT INTO dead_letter (id, org_id, run_id, job_key, step, category, entity_type, entity_id, payload,
        error, attempts, idempotency_key, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'open',?)`,
    [
      dlqId, orgId, entry.runId ?? null, entry.jobKey ?? null, entry.step ?? null, entry.category,
      entry.entityType ?? null, entry.entityId ?? null, toJson(entry.payload ?? {}), entry.error,
      entry.attempts ?? 1, key, nowIso(),
    ]
  );
  return dlqId;
}

export interface DeadLetterRow {
  id: string;
  org_id: string;
  run_id: string | null;
  job_key: string | null;
  step: string | null;
  category: string;
  entity_type: string | null;
  entity_id: string | null;
  payload: unknown;
  error: string;
  attempts: number;
  idempotency_key: string | null;
  status: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution: string | null;
  created_at: string;
}

export function listDeadLetter(orgId: string, opts: { status?: string; limit?: number } = {}): DeadLetterRow[] {
  const status = opts.status ?? 'open';
  return all<Omit<DeadLetterRow, 'payload'> & { payload: string }>(
    'SELECT * FROM dead_letter WHERE org_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?',
    [orgId, status, opts.limit ?? 100]
  ).map((r) => ({ ...r, payload: safeJson(r.payload) }));
}

export function resolveDeadLetter(dlqId: string, resolution: 'resolved' | 'discarded', by: string, reason?: string): boolean {
  const { changes } = run('UPDATE dead_letter SET status = ?, resolved_at = ?, resolved_by = ?, resolution = ? WHERE id = ?', [
    resolution,
    nowIso(),
    by,
    reason ?? null,
    dlqId,
  ]);
  return changes > 0;
}

export function deadLetterSummary(orgId: string) {
  return get<{ open: number; resolved: number; discarded: number; byCategory: string }>(
    `SELECT
        COALESCE(SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END), 0) AS open,
        COALESCE(SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END), 0) AS resolved,
        COALESCE(SUM(CASE WHEN status = 'discarded' THEN 1 ELSE 0 END), 0) AS discarded,
        (SELECT group_concat(category || ':' || c, ', ') FROM (
           SELECT category, COUNT(*) c FROM dead_letter WHERE org_id = ? AND status = 'open' GROUP BY category
         )) AS byCategory
       FROM dead_letter WHERE org_id = ?`,
    [orgId, orgId]
  ) ?? { open: 0, resolved: 0, discarded: 0, byCategory: '' };
}

// ═══════════════════════════════════════════════════════════
// OBSERVABILITY (§29)
// ═══════════════════════════════════════════════════════════

export function listRuns(orgId: string, opts: { jobKey?: string; limit?: number } = {}) {
  const where = ['org_id = ?'];
  const params: unknown[] = [orgId];
  if (opts.jobKey) {
    where.push('job_key = ?');
    params.push(opts.jobKey);
  }
  params.push(opts.limit ?? 30);
  return all(
    `SELECT * FROM job_runs WHERE ${where.join(' AND ')} ORDER BY started_at DESC LIMIT ?`,
    params
  ).map((r) => ({
    ...r,
    completed_steps: safeJson(r.completed_steps as string) as string[],
    stats: safeJson(r.stats as string),
  }));
}

export function getRunWithSteps(orgId: string, runId: string) {
  const row = get<Record<string, unknown>>('SELECT * FROM job_runs WHERE id = ? AND org_id = ?', [runId, orgId]);
  if (!row) return null;
  return {
    ...row,
    completed_steps: safeJson(row.completed_steps as string) as string[],
    stats: safeJson(row.stats as string),
    steps: all('SELECT * FROM job_steps WHERE run_id = ? ORDER BY position', [runId]),
  };
}

export function activeRuns(orgId: string) {
  return all(
    "SELECT id, job_key, status, current_step, progress, started_at FROM job_runs WHERE org_id = ? AND status = 'running' ORDER BY started_at DESC",
    [orgId]
  );
}

function safeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export { db };
