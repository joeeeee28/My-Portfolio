/**
 * Merge review queue (§5).
 *
 * V1 auto-merged anything scoring >= 0.93. That is safe for an exact domain or
 * phone match, but a fuzzy name match at 0.93 can still be two different
 * businesses in the same city — merging them destroys data irrecoverably.
 *
 * This splits the decision in two:
 *  - certain matches (exact domain / phone / email / source id) merge immediately
 *  - uncertain matches (fuzzy name, name+locality) go to a review queue
 */
import { all, get, json, run, scalar, toJson } from '@/db';
import { nowIso } from '@/lib/id';
import { logActivity } from '@/lib/activity';
import { audit } from '@/lib/logging';
import { findDuplicates, mergeBusinesses, recordDuplicateEvent, type DuplicateMatch } from '@/repo/business';

/** Match methods that are certain enough to merge without a human. */
const CERTAIN_METHODS = new Set(['domain', 'phone', 'email', 'source_id', 'social']);

/** Below this score a match is not even worth queuing. */
const REVIEW_FLOOR = 0.72;
/** At or above this score a certain method merges immediately. */
const AUTO_MERGE_SCORE = 0.9;

export interface MergeReviewRow {
  id: string;
  org_id: string;
  keep_id: string;
  candidate_id: string;
  match_method: string;
  match_score: number;
  evidence: Record<string, unknown>;
  status: string;
  decided_by: string | null;
  decided_at: string | null;
  reason: string | null;
  created_at: string;
  keep?: { name: string; website: string | null; locality: string | null; opportunity_score: number | null };
  candidate?: { name: string; website: string | null; locality: string | null; opportunity_score: number | null };
}

export interface DedupeOutcome {
  merged: number;
  queued: number;
  ignored: number;
}

/**
 * Evaluates a candidate against the hub and either merges it, queues it for
 * review, or ignores it. Idempotent: an existing pending review for the same
 * pair is not duplicated.
 */
export function evaluateForMerge(orgId: string, candidate: {
  name: string;
  domain?: string | null;
  email?: string | null;
  phone?: string | null;
  addressLine?: string | null;
  locality?: string | null;
  externalId?: string | null;
  providerKey?: string | null;
  social?: Record<string, string>;
}): DedupeOutcome {
  const outcome: DedupeOutcome = { merged: 0, queued: 0, ignored: 0 };
  const matches = findDuplicates(orgId, candidate);
  if (!matches.length) return outcome;

  for (const match of matches) {
    if (match.score < REVIEW_FLOOR) {
      outcome.ignored++;
      continue;
    }

    const certain = CERTAIN_METHODS.has(match.method) && match.score >= AUTO_MERGE_SCORE;
    if (certain) {
      const result = mergeBusinesses(orgId, match.id, match.id, match.method, match.score);
      void result; // the candidate was never inserted; the match itself is the record
      outcome.merged++;
      continue;
    }

    // Uncertain: queue for a human rather than guessing.
    const queued = queueMergeReview(orgId, match, candidate);
    if (queued) outcome.queued++;
    else outcome.ignored++;
  }

  return outcome;
}

export function queueMergeReview(
  orgId: string,
  match: DuplicateMatch,
  candidate: { name: string; locality?: string | null }
): boolean {
  // The candidate may not exist as a row yet (pre-insert dedupe). In that case
  // there is nothing to merge — record the evidence but do not create a review.
  const candidateRow = get<{ id: string }>(
    'SELECT id FROM businesses WHERE org_id = ? AND LOWER(name) = LOWER(?) AND merged_into IS NULL AND is_archived = 0',
    [orgId, candidate.name]
  );
  if (!candidateRow || candidateRow.id === match.id) return false;

  const existing = get<{ id: string; status: string }>(
    'SELECT id, status FROM merge_reviews WHERE org_id = ? AND keep_id = ? AND candidate_id = ?',
    [orgId, match.id, candidateRow.id]
  );
  if (existing) {
    if (existing.status === 'pending') return false; // already queued
    // A human already decided this pair — respect it.
    return false;
  }

  run(
    `INSERT INTO merge_reviews (id, org_id, keep_id, candidate_id, match_method, match_score, evidence, status, created_at)
     VALUES (?,?,?,?,?,?,?,'pending',?)`,
    [
      `mr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      orgId,
      match.id,
      candidateRow.id,
      match.method,
      match.score,
      toJson({ ...match.evidence, candidateName: candidate.name, candidateLocality: candidate.locality ?? null }),
      nowIso(),
    ]
  );

  logActivity(orgId, 'discovery', `Possible duplicate queued for review: ${candidate.name}`, {
    businessId: match.id,
    actor: 'dedupe_engine',
    detail: `${Math.round(match.score * 100)}% match on ${match.method} — awaiting review`,
  });
  return true;
}

export function listMergeReviews(orgId: string, opts: { status?: string; limit?: number } = {}): MergeReviewRow[] {
  const status = opts.status ?? 'pending';
  const rows = all<MergeReviewRow>(
    `SELECT * FROM merge_reviews WHERE org_id = ? AND status = ? ORDER BY match_score DESC LIMIT ?`,
    [orgId, status, opts.limit ?? 100]
  );
  return rows.map((r) => ({
    ...r,
    evidence: typeof r.evidence === 'string' ? (json(r.evidence as unknown as string, {}) as Record<string, unknown>) : r.evidence,
    keep: summaryOf(orgId, r.keep_id),
    candidate: summaryOf(orgId, r.candidate_id),
  }));
}

function summaryOf(orgId: string, businessId: string) {
  return get<{ name: string; website: string | null; locality: string | null; opportunity_score: number | null }>(
    'SELECT name, website, locality, opportunity_score FROM businesses WHERE id = ? AND org_id = ?',
    [businessId, orgId]
  ) ?? undefined;
}

/** Merges the candidate into the keeper after a human confirms. */
export function approveMerge(orgId: string, reviewId: string, by: string): { ok: boolean; message: string; moved?: Record<string, number> } {
  const review = get<{ keep_id: string; candidate_id: string; match_method: string; match_score: number; status: string }>(
    'SELECT keep_id, candidate_id, match_method, match_score, status FROM merge_reviews WHERE id = ? AND org_id = ?',
    [reviewId, orgId]
  );
  if (!review) return { ok: false, message: 'Review not found' };
  if (review.status !== 'pending') return { ok: false, message: `Already ${review.status}` };

  const result = mergeBusinesses(orgId, review.keep_id, review.candidate_id, review.match_method, review.match_score);
  if (!result.ok) return { ok: false, message: result.reason ?? 'Merge failed' };

  run(`UPDATE merge_reviews SET status = 'merged', decided_by = ?, decided_at = ?, reason = 'approved' WHERE id = ?`, [
    by,
    nowIso(),
    reviewId,
  ]);
  audit(orgId, 'business.merged', {
    actor: by,
    entityType: 'business',
    entityId: review.keep_id,
    detail: { candidate: review.candidate_id, method: review.match_method, score: review.match_score, moved: result.moved },
  });
  logActivity(orgId, 'discovery', 'Duplicate merged after review', {
    businessId: review.keep_id,
    actor: by,
    detail: `${review.candidate_id} merged into ${review.keep_id} (${review.match_method}, ${Math.round(review.match_score * 100)}%)`,
  });
  return { ok: true, message: 'Merged. Every related record was repointed to the surviving business.', moved: result.moved };
}

export function rejectMerge(orgId: string, reviewId: string, by: string, reason?: string): { ok: boolean; message: string } {
  const { changes } = run(
    `UPDATE merge_reviews SET status = 'rejected', decided_by = ?, decided_at = ?, reason = ? WHERE id = ? AND org_id = ? AND status = 'pending'`,
    [by, nowIso(), reason ?? 'not a duplicate', reviewId, orgId]
  );
  if (!changes) return { ok: false, message: 'Review not found or already decided' };
  audit(orgId, 'business.merge_rejected', { actor: by, entityType: 'merge_review', entityId: reviewId, detail: { reason } });
  return { ok: true, message: 'Marked as separate businesses. They will not be suggested again.' };
}

export function deferMerge(orgId: string, reviewId: string, by: string): { ok: boolean; message: string } {
  const { changes } = run(
    `UPDATE merge_reviews SET status = 'deferred', decided_by = ?, decided_at = ? WHERE id = ? AND org_id = ? AND status = 'pending'`,
    [by, nowIso(), reviewId, orgId]
  );
  return changes ? { ok: true, message: 'Deferred.' } : { ok: false, message: 'Review not found or already decided' };
}

export function mergeReviewSummary(orgId: string) {
  return get<{ pending: number; merged: number; rejected: number; deferred: number }>(
    `SELECT
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status = 'merged' THEN 1 ELSE 0 END) AS merged,
        SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
        SUM(CASE WHEN status = 'deferred' THEN 1 ELSE 0 END) AS deferred
       FROM merge_reviews WHERE org_id = ?`,
    [orgId]
  ) ?? { pending: 0, merged: 0, rejected: 0, deferred: 0 };
}

/**
 * Scans the whole hub for uncertain duplicates and queues them. Run as part of
 * the daily job or on demand from Settings.
 */
export function scanForMergeCandidates(orgId: string, limit = 500): { scanned: number; queued: number } {
  const businesses = all<{ id: string; name: string; website_domain: string | null; email: string | null; phone: string | null; locality: string | null }>(
    `SELECT id, name, website_domain, email, phone, locality FROM businesses
      WHERE org_id = ? AND merged_into IS NULL AND is_archived = 0
      ORDER BY opportunity_score DESC LIMIT ?`,
    [orgId, limit]
  );

  let queued = 0;
  for (const b of businesses) {
    const matches = findDuplicates(orgId, {
      name: b.name,
      domain: b.website_domain,
      email: b.email,
      phone: b.phone,
      locality: b.locality,
    });
    for (const m of matches) {
      if (m.id === b.id) continue;
      if (m.score < REVIEW_FLOOR) continue;
      if (CERTAIN_METHODS.has(m.method)) continue; // already handled at insert time
      const ok = queueMergeReview(orgId, m, { name: b.name, locality: b.locality });
      if (ok) queued++;
    }
  }
  return { scanned: businesses.length, queued };
}

export { recordDuplicateEvent, scalar };
