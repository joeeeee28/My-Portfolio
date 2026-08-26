/**
 * Rate limiting (§35, §40).
 *
 * Fixed-window counters persisted in SQLite so limits survive restarts and
 * apply across workers sharing the database. Used for login attempts, API
 * requests and AI calls.
 */
import { get, run } from '@/db';
import { nowIso } from '@/lib/id';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  resetAt: string;
  retryAfterSec: number;
}

/**
 * Checks a counter without incrementing. Returns whether the next call would
 * be permitted.
 */
export function isRateLimited(scope: string, bucket: string, limit: number, windowMinutes: number): boolean {
  const row = get<{ count: number; window_started_at: string }>(
    'SELECT count, window_started_at FROM rate_limits WHERE scope = ? AND bucket = ?',
    [scope, bucket]
  );
  if (!row) return false;

  const windowStart = new Date(row.window_started_at).getTime();
  const windowEnd = windowStart + windowMinutes * 60_000;
  if (Date.now() >= windowEnd) return false; // window elapsed

  return row.count >= limit;
}

/** Increments a counter, rolling the window over when it has elapsed. */
export function consumeRateLimit(scope: string, bucket: string, windowMinutes: number): RateLimitResult {
  const now = Date.now();
  const row = get<{ count: number; window_started_at: string; id: string }>(
    'SELECT id, count, window_started_at FROM rate_limits WHERE scope = ? AND bucket = ?',
    [scope, bucket]
  );

  const windowStart = row ? new Date(row.window_started_at).getTime() : now;
  const windowEnd = windowStart + windowMinutes * 60_000;
  const rolled = now >= windowEnd;

  if (!row) {
    run('INSERT INTO rate_limits (id, scope, bucket, count, window_started_at) VALUES (?,?,?,?,?)', [
      `rl_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      scope,
      bucket,
      1,
      new Date(now).toISOString(),
    ]);
    return { allowed: true, remaining: 0, limit: 0, resetAt: new Date(now + windowMinutes * 60_000).toISOString(), retryAfterSec: 0 };
  }

  const nextCount = rolled ? 1 : row.count + 1;
  const nextStart = rolled ? now : windowStart;
  run('UPDATE rate_limits SET count = ?, window_started_at = ? WHERE id = ?', [
    nextCount,
    new Date(nextStart).toISOString(),
    row.id,
  ]);

  const resetAt = nextStart + windowMinutes * 60_000;
  return {
    allowed: true,
    remaining: nextCount,
    limit: 0,
    resetAt: new Date(resetAt).toISOString(),
    retryAfterSec: Math.max(0, Math.ceil((resetAt - now) / 1000)),
  };
}

/**
 * Combined check-and-consume. Use this on request paths: it returns the
 * remaining budget so the caller can set standard rate-limit headers.
 */
export function checkAndConsume(
  scope: string,
  bucket: string,
  limit: number,
  windowMinutes: number
): RateLimitResult {
  const row = get<{ id: string; count: number; window_started_at: string }>(
    'SELECT id, count, window_started_at FROM rate_limits WHERE scope = ? AND bucket = ?',
    [scope, bucket]
  );

  const now = Date.now();
  const windowStart = row ? new Date(row.window_started_at).getTime() : now;
  const rolled = !row || now >= windowStart + windowMinutes * 60_000;
  const effectiveStart = rolled ? now : windowStart;
  const resetAt = effectiveStart + windowMinutes * 60_000;
  const count = rolled ? 1 : row!.count + 1;
  const retryAfterSec = Math.max(0, Math.ceil((resetAt - now) / 1000));

  if (!row) {
    run('INSERT INTO rate_limits (id, scope, bucket, count, window_started_at) VALUES (?,?,?,?,?)', [
      `rl_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      scope,
      bucket,
      count,
      new Date(effectiveStart).toISOString(),
    ]);
  } else {
    run('UPDATE rate_limits SET count = ?, window_started_at = ? WHERE id = ?', [
      count,
      new Date(effectiveStart).toISOString(),
      row.id,
    ]);
  }

  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    limit,
    resetAt: new Date(resetAt).toISOString(),
    retryAfterSec,
  };
}

/** Drops expired windows so the table does not grow without bound. */
export function pruneRateLimits(olderThanMinutes = 120): number {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000).toISOString();
  const { changes } = run('DELETE FROM rate_limits WHERE window_started_at < ?', [cutoff]);
  return changes;
}

export function currentUsage(scope: string, bucket: string): { count: number; windowStartedAt: string | null } {
  const row = get<{ count: number; window_started_at: string }>(
    'SELECT count, window_started_at FROM rate_limits WHERE scope = ? AND bucket = ?',
    [scope, bucket]
  );
  return { count: row?.count ?? 0, windowStartedAt: row?.window_started_at ?? null };
}

export { nowIso };
