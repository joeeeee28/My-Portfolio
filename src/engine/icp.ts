/**
 * Ideal Customer Profile engine (§8).
 *
 * Applies user-defined ICP rules during discovery: industries, size, services,
 * revenue potential, website/social characteristics, exclusions and a minimum
 * score. Prospects that fail are marked, never silently deleted — the evidence
 * for the decision is stored so the rule can be audited and tuned.
 */
import { all, get, json, run, scalar, toJson } from '@/db';
import { nowIso } from '@/lib/id';
import { changeStage } from '@/lib/activity';
import { logActivity } from '@/lib/activity';

export interface IcpProfile {
  id: string;
  name: string;
  is_active: number;
  preferred_industries: string[];
  excluded_industries: string[];
  business_sizes: string[];
  services: string[];
  min_opportunity_score: number;
  excluded_businesses: string[];
  preferred_packages: string[];
  price_range_min: number | null;
  price_range_max: number | null;
  digital_problems: string[];
  contact_requirements: { requireEmail?: boolean; requirePhone?: boolean; requireDecisionMaker?: boolean };
  website_characteristics: { requireNoWebsite?: boolean; maxWebsiteScore?: number; requireNoBooking?: boolean };
  social_characteristics: { requireSocial?: boolean; maxSocialScore?: number };
  learned_signals: Record<string, number>;
}

export function getActiveIcp(orgId: string): IcpProfile | null {
  const row = get<Record<string, unknown>>(
    'SELECT * FROM icp_profiles WHERE org_id = ? AND is_active = 1 ORDER BY created_at ASC LIMIT 1',
    [orgId]
  );
  if (!row) return null;
  return {
    id: row.id as string,
    name: row.name as string,
    is_active: row.is_active as number,
    preferred_industries: json<string[]>(row.preferred_industries as string, []),
    excluded_industries: json<string[]>(row.excluded_industries as string, []),
    business_sizes: json<string[]>(row.business_sizes as string, []),
    services: json<string[]>(row.services as string, []),
    min_opportunity_score: (row.min_opportunity_score as number) ?? 0,
    excluded_businesses: json<string[]>(row.excluded_businesses as string, []),
    preferred_packages: json<string[]>(row.preferred_packages as string, []),
    price_range_min: (row.price_range_min as number | null) ?? null,
    price_range_max: (row.price_range_max as number | null) ?? null,
    digital_problems: json<string[]>(row.digital_problems as string, []),
    contact_requirements: json<IcpProfile['contact_requirements']>(row.contact_requirements as string, {}),
    website_characteristics: json<IcpProfile['website_characteristics']>(row.website_characteristics as string, {}),
    social_characteristics: json<IcpProfile['social_characteristics']>(row.social_characteristics as string, {}),
    learned_signals: json<Record<string, number>>(row.learned_signals as string, {}),
  };
}

export interface IcpVerdict {
  matches: boolean;
  reasons: string[];
  exclusions: string[];
  score: number;
}

/**
 * Evaluates one prospect against the ICP. Returns the reasoning, not just a
 * boolean, so "why was this excluded" is always answerable.
 */
export function evaluateAgainstIcp(orgId: string, businessId: string, icp?: IcpProfile | null): IcpVerdict {
  const profile = icp ?? getActiveIcp(orgId);
  if (!profile) return { matches: true, reasons: ['No active ICP profile — nothing to filter on'], exclusions: [], score: 100 };

  const b = get<Record<string, unknown>>('SELECT * FROM businesses WHERE id = ? AND org_id = ?', [businessId, orgId]);
  if (!b) return { matches: false, reasons: ['Business not found'], exclusions: ['not_found'], score: 0 };

  const reasons: string[] = [];
  const exclusions: string[] = [];
  let score = 100;

  const industry = (b.industry as string | null) ?? '';
  const category = (b.category as string | null) ?? '';
  const name = (b.name as string | null) ?? '';
  const opportunityScore = (b.opportunity_score as number | null) ?? 0;
  const websiteStatus = (b.website_status as string | null) ?? 'unknown';
  const social = json<Record<string, string>>(b.social as string, {});
  const socialCount = Object.keys(social).length;

  // Hard exclusions
  if (profile.excluded_businesses.some((e) => name.toLowerCase().includes(e.toLowerCase()))) {
    exclusions.push(`business name matches exclusion "${name}"`);
  }
  if (profile.excluded_industries.some((e) => industry.toLowerCase() === e.toLowerCase() || category.toLowerCase().includes(e.toLowerCase()))) {
    exclusions.push(`industry "${industry || category}" is excluded`);
  }

  // Minimum score
  if (opportunityScore < profile.min_opportunity_score) {
    exclusions.push(`Opportunity Score ${Math.round(opportunityScore)} is below the ${profile.min_opportunity_score} minimum`);
    score -= 40;
  }

  // Preferred industries (only filters when a list is defined)
  if (profile.preferred_industries.length) {
    const matchesIndustry = profile.preferred_industries.some(
      (p) => industry.toLowerCase().includes(p.toLowerCase()) || category.toLowerCase().includes(p.toLowerCase())
    );
    if (matchesIndustry) {
      reasons.push(`industry "${industry || category}" is a preferred industry`);
      score = Math.min(100, score + 10);
    } else {
      exclusions.push(`industry "${industry || category}" is not in the preferred list`);
      score -= 25;
    }
  }

  // Contact requirements
  const cr = profile.contact_requirements;
  if (cr.requireEmail && !b.email) {
    exclusions.push('no email on record but one is required');
    score -= 20;
  }
  if (cr.requirePhone && !b.phone) {
    exclusions.push('no phone on record but one is required');
    score -= 15;
  }
  if (cr.requireDecisionMaker) {
    const dm = scalar<number>(
      'SELECT COUNT(*) FROM contacts WHERE business_id = ? AND is_decision_maker = 1',
      [businessId]
    ) ?? 0;
    if (dm === 0) {
      exclusions.push('no decision maker identified but one is required');
      score -= 20;
    } else {
      reasons.push('a decision maker is identified');
    }
  }

  // Website characteristics
  const wc = profile.website_characteristics;
  if (wc.requireNoWebsite && websiteStatus !== 'missing') {
    exclusions.push(`ICP targets businesses with no website; this one is "${websiteStatus}"`);
    score -= 30;
  }
  if (typeof wc.maxWebsiteScore === 'number') {
    const ws = scalar<number>('SELECT website_score FROM digital_audits WHERE business_id = ? ORDER BY created_at DESC LIMIT 1', [businessId]);
    if (ws !== null && ws > wc.maxWebsiteScore) {
      exclusions.push(`website score ${ws} exceeds the ${wc.maxWebsiteScore} ceiling`);
      score -= 20;
    } else if (ws !== null) {
      reasons.push(`website score ${ws} is within the target range`);
    }
  }
  if (wc.requireNoBooking) {
    const booking = scalar<number>('SELECT has_booking FROM digital_audits WHERE business_id = ? ORDER BY created_at DESC LIMIT 1', [businessId]);
    if (booking === 1) {
      exclusions.push('already has online booking');
      score -= 15;
    }
  }

  // Social characteristics
  const sc = profile.social_characteristics;
  if (sc.requireSocial && socialCount === 0) {
    exclusions.push('no social presence but one is required');
    score -= 15;
  }
  if (typeof sc.maxSocialScore === 'number') {
    const ss = scalar<number>('SELECT social_score FROM social_audits WHERE business_id = ? ORDER BY created_at DESC LIMIT 1', [businessId]);
    if (ss !== null && ss > sc.maxSocialScore) {
      exclusions.push(`social score ${ss} exceeds the ${sc.maxSocialScore} ceiling`);
      score -= 15;
    }
  }

  // Digital problems the ICP wants to see
  if (profile.digital_problems.length) {
    const signals = json<{ key: string }[]>(
      (scalar<string>('SELECT signals FROM digital_audits WHERE business_id = ? ORDER BY created_at DESC LIMIT 1', [businessId]) as string) ?? '[]',
      []
    );
    const keys = new Set(signals.map((s) => s.key));
    const present = profile.digital_problems.filter((p) => keys.has(p));
    if (present.length) {
      reasons.push(`has targeted digital problem(s): ${present.join(', ')}`);
      score = Math.min(100, score + present.length * 5);
    }
  }

  // Learned signals (§9) — small, capped nudges from realised outcomes
  for (const [feature, rate] of Object.entries(profile.learned_signals)) {
    if (rate > 0.6) {
      score = Math.min(100, score + 5);
      reasons.push(`prospects like this converted ${Math.round(rate * 100)}% of the time`);
      break;
    }
  }

  return {
    matches: exclusions.length === 0,
    reasons,
    exclusions,
    score: Math.max(0, Math.min(100, score)),
  };
}

export interface IcpRunResult {
  evaluated: number;
  qualified: number;
  rejected: number;
  alreadyDecided: number;
}

/**
 * Applies ICP rules across the working set and moves matching prospects to
 * Qualified. Idempotent: prospects already qualified or terminal are skipped,
 * and exclusions are recorded rather than re-applied.
 */
export function applyIcpRules(orgId: string): IcpRunResult {
  const icp = getActiveIcp(orgId);
  const result: IcpRunResult = { evaluated: 0, qualified: 0, rejected: 0, alreadyDecided: 0 };
  if (!icp) return result;

  const candidates = all<{ id: string; name: string; stage: string }>(
    `SELECT id, name, stage FROM businesses
      WHERE org_id = ? AND merged_into IS NULL AND is_archived = 0
        AND stage IN ('discovered','qualified')
      ORDER BY opportunity_score DESC LIMIT 1000`,
    [orgId]
  );

  for (const c of candidates) {
    result.evaluated++;
    const verdict = evaluateAgainstIcp(orgId, c.id, icp);
    recordIcpEvaluation(orgId, c.id, verdict);

    if (c.stage === 'qualified') {
      result.alreadyDecided++;
      continue;
    }

    if (verdict.matches) {
      changeStage(orgId, c.id, 'qualified', { actor: 'icp_engine', reason: verdict.reasons[0] ?? 'Met ICP criteria' });
      result.qualified++;
    } else {
      // Not deleted — archived with the reason, so the rule can be reviewed.
      run(`UPDATE businesses SET is_archived = 1, archived_reason = ?, updated_at = ? WHERE id = ?`, [
        `ICP: ${verdict.exclusions.join('; ')}`,
        nowIso(),
        c.id,
      ]);
      logActivity(orgId, 'score', `${c.name} excluded by ICP`, {
        businessId: c.id,
        actor: 'icp_engine',
        detail: verdict.exclusions.join('; '),
      });
      result.rejected++;
    }
  }

  return result;
}

/** Stores the verdict so "why was this prospect rejected" is always answerable. */
export function recordIcpEvaluation(orgId: string, businessId: string, verdict: IcpVerdict): void {
  const key = `icp:${verdict.matches ? 'match' : 'reject'}`;
  run(
    `INSERT INTO ai_memory (id, org_id, business_id, kind, key, value, confidence, source, pinned, created_at, updated_at)
     VALUES (?,?,?,?,?,?,0.9,'icp_engine',0,?,?)
     ON CONFLICT DO NOTHING`,
    [
      `mem_${businessId}_${key}`.slice(0, 60),
      orgId,
      businessId,
      'fact',
      key,
      verdict.matches
        ? `ICP match: ${verdict.reasons.join('; ') || 'met all criteria'}`
        : `ICP exclusion: ${verdict.exclusions.join('; ')}`,
      nowIso(),
      nowIso(),
    ]
  );
}

/** Persists ICP edits. Only the fields supplied are changed. */
export function saveIcp(
  orgId: string,
  patch: Partial<Omit<IcpProfile, 'id' | 'name' | 'is_active' | 'learned_signals'>> & { name?: string }
): void {
  const current = getActiveIcp(orgId);
  if (!current) throw new Error('no active ICP profile');
  const sets: string[] = [];
  const params: unknown[] = [];
  const jsonFields: (keyof IcpProfile)[] = [
    'preferred_industries', 'excluded_industries', 'business_sizes', 'services',
    'excluded_businesses', 'preferred_packages', 'digital_problems',
    'contact_requirements', 'website_characteristics', 'social_characteristics',
  ];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    sets.push(`${k} = ?`);
    params.push(jsonFields.includes(k as keyof IcpProfile) ? toJson(v) : v);
  }
  if (!sets.length) return;
  params.push(nowIso(), current.id);
  run(`UPDATE icp_profiles SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, params);
}

/** A readable summary of the active rules, for the Settings screen. */
export function describeIcp(icp: IcpProfile | null): string[] {
  if (!icp) return ['No active ICP profile.'];
  const lines: string[] = [];
  if (icp.preferred_industries.length) lines.push(`Preferred industries: ${icp.preferred_industries.join(', ')}`);
  if (icp.excluded_industries.length) lines.push(`Excluded industries: ${icp.excluded_industries.join(', ')}`);
  if (icp.excluded_businesses.length) lines.push(`Excluded businesses: ${icp.excluded_businesses.join(', ')}`);
  lines.push(`Minimum Opportunity Score: ${icp.min_opportunity_score}`);
  if (icp.services.length) lines.push(`Services offered: ${icp.services.join(', ')}`);
  if (icp.digital_problems.length) lines.push(`Targeted digital problems: ${icp.digital_problems.join(', ')}`);
  const cr = icp.contact_requirements;
  const reqs = [cr.requireEmail && 'email', cr.requirePhone && 'phone', cr.requireDecisionMaker && 'decision maker'].filter(Boolean);
  if (reqs.length) lines.push(`Contact requirements: ${reqs.join(', ')}`);
  const wc = icp.website_characteristics;
  if (wc.requireNoWebsite) lines.push('Only businesses with no website');
  if (typeof wc.maxWebsiteScore === 'number') lines.push(`Website score ceiling: ${wc.maxWebsiteScore}`);
  const sc = icp.social_characteristics;
  if (sc.requireSocial) lines.push('Must have a social presence');
  if (typeof sc.maxSocialScore === 'number') lines.push(`Social score ceiling: ${sc.maxSocialScore}`);
  if (Object.keys(icp.learned_signals).length) lines.push(`Learned from ${Object.keys(icp.learned_signals).length} outcome signal(s)`);
  return lines;
}
