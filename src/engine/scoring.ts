/**
 * Opportunity scoring (§13) with configurable weights, custom rules and
 * outcome learning (§14, §67). Every score ships with the arithmetic that
 * produced it, so "why is this 94?" is always answerable.
 */
import { all, get, json, run, scalar, toJson } from '@/db';
import { id, nowIso, round, clamp } from '@/lib/id';
import { DEFAULT_WEIGHTS, priorityFromScore, SCORING_FACTORS, type ScoringFactorKey } from '@/lib/domain';
import { ensureScoringProfile } from './bootstrap';
import { logActivity } from '@/lib/activity';

export interface FactorBreakdown {
  key: string;
  label: string;
  score: number;
  weight: number;
  contribution: number;
  evidence: string[];
}

export interface ScoreResult {
  total: number;
  priority: 'low' | 'medium' | 'high' | 'critical';
  breakdown: FactorBreakdown[];
  reasons: string[];
  serviceFit: string | null;
  recommendedPackageId: string | null;
}

interface ScoreInputs {
  business: Record<string, unknown>;
  audit: Record<string, unknown> | null;
  socialAudit: Record<string, unknown> | null;
  competitors: Record<string, unknown>[];
  contacts: Record<string, unknown>[];
  packages: Record<string, unknown>[];
  learnedBoost?: number;
}

export function getActiveProfile(orgId: string) {
  ensureScoringProfile(orgId);
  const row = get<Record<string, unknown>>('SELECT * FROM scoring_profiles WHERE org_id = ? AND is_default = 1', [orgId]);
  return {
    id: row?.id as string,
    name: (row?.name as string) ?? 'Default',
    weights: json<Record<string, number>>(row?.weights as string, DEFAULT_WEIGHTS),
    rules: json<CustomRule[]>(row?.custom_rules as string, []),
    thresholds: json<Record<string, number>>(row?.priority_thresholds as string, { low: 0, medium: 45, high: 70, critical: 88 }),
  };
}

export interface CustomRule {
  id: string;
  text: string;
  when: Record<string, unknown>;
  bonus: number;
  enabled: boolean;
}

export function normalizeWeights(weights: Record<string, number>): Record<ScoringFactorKey, number> {
  const out = { ...DEFAULT_WEIGHTS };
  for (const f of SCORING_FACTORS) {
    if (typeof weights[f.key] === 'number' && weights[f.key] >= 0) out[f.key] = weights[f.key];
  }
  const total = SCORING_FACTORS.reduce((a, f) => a + out[f.key], 0);
  if (total <= 0) return DEFAULT_WEIGHTS;
  for (const f of SCORING_FACTORS) out[f.key] = out[f.key] / total;
  return out;
}

/** Computes the score without persisting — used for previews and what-if UI. */
export function computeScore(orgId: string, inputs: ScoreInputs): ScoreResult {
  const profile = getActiveProfile(orgId);
  const weights = normalizeWeights(profile.weights);
  const b = inputs.business;
  const a = inputs.audit;
  const s = inputs.socialAudit;

  const breakdown: FactorBreakdown[] = [];
  const reasons: string[] = [];

  const add = (key: ScoringFactorKey, score: number, evidence: string[]) => {
    const label = SCORING_FACTORS.find((f) => f.key === key)?.label ?? key;
    const clamped = round(clamp(score));
    // A weighted contribution, not a percentage of a percentage. Each factor is
    // 0-100 and the weights sum to 1, so the total is itself a 0-100 score.
    const contribution = round(clamped * weights[key]);
    breakdown.push({ key, label, score: clamped, weight: weights[key], contribution, evidence });
    return clamped;
  };

  // ── Website opportunity (25%) ──
  const websiteStatus = (b.website_status as string) ?? 'unknown';
  let websiteOpp = 0;
  const websiteEvidence: string[] = [];
  if (websiteStatus === 'missing') {
    websiteOpp = 100;
    websiteEvidence.push('No website at all — the entire digital surface is missing.');
  } else if (websiteStatus === 'parked') {
    websiteOpp = 95;
    websiteEvidence.push('The domain serves a parking page rather than a business site.');
  } else if (websiteStatus === 'unreachable') {
    websiteOpp = 92;
    websiteEvidence.push('The website does not respond, so visitors hit an error.');
  } else if (a) {
    const ws = (a.website_score as number) ?? 0;
    websiteOpp = clamp(100 - ws);
    websiteEvidence.push(`Measured website score ${ws}/100.`);
    const signals = json<{ key: string; label: string; severity: string; evidence: string }[]>(a.signals as string, []);
    const critical = signals.filter((x) => x.severity === 'critical');
    const high = signals.filter((x) => x.severity === 'high');
    if (critical.length) websiteEvidence.push(`${critical.length} critical issue(s): ${critical.map((c) => c.label).join(', ')}.`);
    if (high.length) websiteEvidence.push(`${high.length} high-impact issue(s): ${high.map((c) => c.label).slice(0, 3).join(', ')}${high.length > 3 ? '…' : ''}.`);
    if (a.mobile_responsive === 0) websiteEvidence.push('Not mobile responsive (no viewport meta).');
    if (a.has_booking === 0) websiteEvidence.push('No booking or enquiry system detected.');
    if (a.cta_count === 0) websiteEvidence.push('No clear call to action on the page.');
  } else {
    websiteOpp = websiteStatus === 'live' ? 45 : 60;
    websiteEvidence.push('No audit on record yet — provisional estimate pending measurement.');
  }
  add('website_opportunity', websiteOpp, websiteEvidence);

  // ── Social opportunity (20%) ──
  let socialOpp = 0;
  const socialEvidence: string[] = [];
  const socialProfiles = json<Record<string, string>>(b.social as string, {});
  const platformCount = Object.keys(socialProfiles).length;
  if (platformCount === 0) {
    socialOpp = 100;
    socialEvidence.push('No social presence on record.');
  } else if (s) {
    const ss = (s.social_score as number) ?? 0;
    socialOpp = clamp(100 - ss);
    socialEvidence.push(`Measured social score ${ss}/100 across ${platformCount} channel(s).`);
    const freq = s.posting_frequency as string;
    if (freq === 'dormant') socialEvidence.push('Profiles appear dormant.');
    else if (freq === 'monthly') socialEvidence.push('Posting is roughly monthly.');
    else if (freq === 'unknown') socialEvidence.push('Posting cadence could not be measured.');
    const sigs = json<{ label: string }[]>(s.signals as string, []);
    for (const sg of sigs.slice(0, 3)) socialEvidence.push(sg.label);
  } else {
    socialOpp = platformCount === 1 ? 70 : 50;
    socialEvidence.push(`${platformCount} channel(s) on record; no social audit yet.`);
  }
  add('social_opportunity', socialOpp, socialEvidence);

  // ── Business quality (15%) ──
  let quality = 0;
  const qualityEvidence: string[] = [];
  const rating = b.rating as number | null;
  const reviews = (b.review_count as number | null) ?? 0;
  if (rating) {
    quality += clamp((rating - 3) / 2) * 45;
    qualityEvidence.push(`${rating.toFixed(1)}★ public rating.`);
  } else {
    quality += 18;
    qualityEvidence.push('No public rating on record.');
  }
  if (reviews >= 200) {
    quality += 35;
    qualityEvidence.push(`${reviews} reviews — high, sustained customer volume.`);
  } else if (reviews >= 50) {
    quality += 28;
    qualityEvidence.push(`${reviews} reviews — steady customer volume.`);
  } else if (reviews >= 10) {
    quality += 18;
    qualityEvidence.push(`${reviews} reviews.`);
  } else if (reviews > 0) {
    quality += 8;
    qualityEvidence.push(`${reviews} review(s) only — low social proof volume.`);
  }
  if (b.is_new_business === 1) {
    quality += 10;
    qualityEvidence.push('Newly established — actively building its presence.');
  }
  if (b.hiring_signal === 1) {
    quality += 8;
    qualityEvidence.push('Hiring activity — a growth indicator.');
  }
  if (b.description) quality += 6;
  add('business_quality', quality, qualityEvidence);

  // ── Digital gap (15%) ──
  // How far the business is from a complete digital presence.
  let gap = 0;
  const gapEvidence: string[] = [];
  const has = {
    website: !!b.website && websiteStatus === 'live',
    booking: a?.has_booking === 1,
    form: ((a?.form_count as number) ?? 0) > 0,
    schema: a?.has_schema_markup === 1,
    ssl: a?.ssl_valid === 1,
    social: platformCount > 0,
    multiSocial: platformCount >= 3,
    testimonials: ((a?.testimonials_found as number) ?? 0) > 0,
    analytics: a?.has_analytics === 1,
  };
  const checks: [keyof typeof has, number, string][] = [
    ['website', 22, 'live website'],
    ['ssl', 8, 'valid SSL'],
    ['booking', 16, 'online booking/enquiry'],
    ['form', 10, 'contact form'],
    ['schema', 8, 'structured data'],
    ['social', 14, 'social presence'],
    ['multiSocial', 8, 'three or more social channels'],
    ['testimonials', 8, 'on-site social proof'],
    ['analytics', 6, 'measurement installed'],
  ];
  let present = 0;
  const missing: string[] = [];
  for (const [k, weight, label] of checks) {
    if (has[k]) present += weight;
    else missing.push(label);
  }
  gap = clamp(100 - present);
  gapEvidence.push(missing.length ? `Missing: ${missing.join(', ')}.` : 'Digital presence is complete across the checks we run.');
  add('digital_gap', gap, gapEvidence);

  // ── Growth signals (10%) ──
  let growth = 0;
  const growthEvidence: string[] = [];
  if (rating && rating >= 4.5 && reviews >= 20 && websiteOpp > 60) {
    growth += 40;
    growthEvidence.push('Strong reviews combined with a weak digital presence — demand is already proven.');
  }
  if (platformCount >= 2 && (s?.social_score as number ?? 0) >= 60) {
    growth += 18;
    growthEvidence.push('Active social engagement that a website could convert.');
  }
  if (b.is_new_business === 1) {
    growth += 14;
    growthEvidence.push('New business — usually still establishing its digital presence.');
  }
  if (b.hiring_signal === 1) {
    growth += 12;
    growthEvidence.push('Hiring activity.');
  }
  const cohortGap = inputs.competitors.find((c) => c.name === '__cohort_summary__')?.gap_score as number | undefined;
  if (cohortGap && cohortGap > 0) {
    growth += clamp(cohortGap * 0.4);
    growthEvidence.push(`Audited peers score ahead by ${cohortGap} points on average.`);
  }
  add('growth_signals', growth, growthEvidence);

  // ── Contactability (5%) ──
  let contactability = 0;
  const contactEvidence: string[] = [];
  const decisionMaker = inputs.contacts.find((c) => c.is_decision_maker === 1);
  const anyContact = inputs.contacts[0];
  if (decisionMaker?.email) {
    contactability = 100;
    contactEvidence.push(`Named decision maker with email: ${decisionMaker.full_name}.`);
  } else if (anyContact?.email) {
    contactability = 78;
    contactEvidence.push(`Contact with email: ${anyContact.full_name}.`);
  } else if (anyContact?.phone) {
    contactability = 55;
    contactEvidence.push('Phone contact only.');
  } else if (b.email) {
    contactability = 50;
    contactEvidence.push('Generic business email only — no named contact.');
  } else if (b.phone) {
    contactability = 35;
    contactEvidence.push('Phone number only.');
  } else {
    contactability = 10;
    contactEvidence.push('No contact details on record — outreach cannot start.');
  }
  add('contactability', contactability, contactEvidence);

  // ── Competitive gap (5%) ──
  let competitive = 0;
  const compEvidence: string[] = [];
  if (cohortGap !== undefined) {
    competitive = clamp(cohortGap);
    compEvidence.push(
      cohortGap > 0
        ? `Measured peers ahead by ${cohortGap}/100 on audited dimensions.`
        : 'No measured disadvantage against audited peers.'
    );
  } else {
    compEvidence.push('No audited peers in the same category yet.');
  }
  add('competitive_gap', competitive, compEvidence);

  // ── Service fit (5%) ──
  const { service, packageId, fitEvidence } = recommendService(orgId, b, a, s, inputs.packages);
  add('service_fit', service ? 85 : 40, fitEvidence);

  let total = breakdown.reduce((sum, f) => sum + f.contribution, 0);

  // ── Custom rules (§13) ──
  const ruleNotes: string[] = [];
  for (const rule of profile.rules.filter((r) => r.enabled)) {
    if (ruleMatches(rule, { business: b, audit: a, socialAudit: s, contacts: inputs.contacts })) {
      total += rule.bonus;
      ruleNotes.push(`${rule.bonus > 0 ? '+' : ''}${rule.bonus} — ${rule.text}`);
    }
  }

  // ── Learned adjustment (§14, §67) ──
  if (inputs.learnedBoost) {
    total += inputs.learnedBoost;
    ruleNotes.push(`${inputs.learnedBoost > 0 ? '+' : ''}${round(inputs.learnedBoost, 1)} — outcome learning`);
  }

  total = round(clamp(total));
  const priority = priorityFromScore(total, profile.thresholds as never);

  // Reasons are the human-readable "why", ordered by contribution.
  const ordered = [...breakdown].sort((x, y) => y.contribution - x.contribution);
  for (const f of ordered) {
    if (f.score >= 60 || f.key === 'website_opportunity' || f.key === 'business_quality') {
      for (const e of f.evidence.slice(0, 2)) reasons.push(e);
    }
  }
  reasons.push(...ruleNotes);

  return { total, priority, breakdown, reasons: reasons.slice(0, 12), serviceFit: service, recommendedPackageId: packageId };
}

function ruleMatches(rule: CustomRule, ctx: { business: Record<string, unknown>; audit: Record<string, unknown> | null; socialAudit: Record<string, unknown> | null; contacts: Record<string, unknown>[] }): boolean {
  const w = rule.when ?? {};
  const b = ctx.business;
  let ok = true;
  if (Array.isArray(w.website_status) && !w.website_status.includes(b.website_status)) ok = false;
  if (typeof w.minRating === 'number' && !((b.rating as number) >= w.minRating)) ok = false;
  if (typeof w.maxRating === 'number' && !((b.rating as number) <= w.maxRating)) ok = false;
  if (typeof w.minReviews === 'number' && !((b.review_count as number) >= w.minReviews)) ok = false;
  if (Array.isArray(w.industries) && !w.industries.includes(b.industry)) ok = false;
  if (Array.isArray(w.excludedIndustries) && w.excludedIndustries.includes(b.industry)) ok = false;
  if (w.noContact === true && ctx.contacts.length > 0) ok = false;
  if (w.requireContact === true && ctx.contacts.length === 0) ok = false;
  if (Array.isArray(w.signals)) {
    const have = json<{ key: string }[]>((ctx.audit?.signals as string) ?? '[]', []);
    const keys = new Set(have.map((x) => x.key));
    if (!w.signals.some((s: string) => keys.has(s))) ok = false;
  }
  if (typeof w.minSocialPlatforms === 'number') {
    const count = Object.keys(json<Record<string, string>>(b.social as string, {})).length;
    if (count < w.minSocialPlatforms) ok = false;
  }
  return ok;
}

/** Matches audit signals against package targets and returns the best fit. */
export function recommendService(
  orgId: string,
  business: Record<string, unknown>,
  audit: Record<string, unknown> | null,
  socialAudit: Record<string, unknown> | null,
  packages?: Record<string, unknown>[]
): { service: string | null; packageId: string | null; fitEvidence: string[] } {
  const pkgs = packages ?? all<Record<string, unknown>>('SELECT * FROM service_packages WHERE org_id = ? AND is_active = 1', [orgId]);
  const signals = new Set<string>();
  if (business.website_status === 'missing') signals.add('no_website');
  if (business.website_status === 'unreachable') signals.add('website_unreachable');
  if (business.website_status === 'parked') signals.add('website_broken');
  for (const s of json<{ key: string }[]>((audit?.signals as string) ?? '[]', [])) signals.add(s.key);
  for (const s of json<{ key: string }[]>((socialAudit?.signals as string) ?? '[]', [])) signals.add(s.key);
  const cohortGap = 0;
  if (cohortGap > 0) signals.add('competitor_digital_advantage');

  const fitEvidence: string[] = [];
  if (!signals.size) fitEvidence.push('No signals to match a package against yet.');

  let best: { pkg: Record<string, unknown>; hits: number } | null = null;
  for (const pkg of pkgs) {
    const targets = json<string[]>(pkg.targets_signals as string, []);
    const hits = targets.filter((t) => signals.has(t)).length;
    if (hits > 0 && (!best || hits > best.hits)) best = { pkg, hits };
  }

  if (best) {
    const pkg = best.pkg;
    fitEvidence.push(`Package "${pkg.name as string}" addresses ${best.hits} of the detected signal(s).`);
    return { service: (pkg.tier as string) === 'retainer' ? 'maintenance' : 'website', packageId: pkg.id as string, fitEvidence };
  }

  // Sensible fallbacks when no package targets the exact signals.
  if (signals.has('no_website') || signals.has('website_unreachable') || signals.has('website_broken')) {
    fitEvidence.push('Defaulting to a website build — no site exists.');
    return { service: 'website', packageId: (pkgs.find((p) => p.tier === 'starter')?.id as string) ?? null, fitEvidence };
  }
  if (signals.has('no_social') || signals.has('inactive_social')) {
    fitEvidence.push('Defaulting to social management.');
    return { service: 'social', packageId: (pkgs.find((p) => p.name === 'Digital Presence')?.id as string) ?? null, fitEvidence };
  }
  fitEvidence.push('No specific service fit determined yet.');
  return { service: null, packageId: null, fitEvidence };
}

/** Persists a computed score and updates the business row. */
export function scoreBusiness(orgId: string, businessId: string, opts: { actor?: string; log?: boolean } = {}): ScoreResult | null {
  const business = get<Record<string, unknown>>('SELECT * FROM businesses WHERE id = ? AND org_id = ?', [businessId, orgId]);
  if (!business) return null;
  const audit = get<Record<string, unknown>>('SELECT * FROM digital_audits WHERE business_id = ? ORDER BY created_at DESC LIMIT 1', [businessId]);
  const socialAudit = get<Record<string, unknown>>('SELECT * FROM social_audits WHERE business_id = ? ORDER BY created_at DESC LIMIT 1', [businessId]);
  const competitors = all<Record<string, unknown>>('SELECT * FROM competitors WHERE business_id = ?', [businessId]);
  const contacts = all<Record<string, unknown>>('SELECT * FROM contacts WHERE business_id = ?', [businessId]);
  const packages = all<Record<string, unknown>>('SELECT * FROM service_packages WHERE org_id = ? AND is_active = 1', [orgId]);
  const profile = getActiveProfile(orgId);

  const result = computeScore(orgId, {
    business,
    audit,
    socialAudit,
    competitors,
    contacts,
    packages,
    learnedBoost: learnedBoostFor(orgId, business),
  });

  const now = nowIso();
  run(
    `INSERT INTO opportunity_scores (id, org_id, business_id, profile_id, total, breakdown, reasons, priority, service_fit, computed_at, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id('ops'), orgId, businessId, profile.id, result.total, toJson(result.breakdown), toJson(result.reasons),
      result.priority, result.serviceFit, now, now,
    ]
  );

  run(
    `UPDATE businesses SET opportunity_score = ?, priority = ?, recommended_service = ?,
            recommended_package_id = COALESCE(?, recommended_package_id), updated_at = ? WHERE id = ?`,
    [result.total, result.priority, result.serviceFit, result.recommendedPackageId, now, businessId]
  );

  if (opts.log !== false) {
    logActivity(orgId, 'score', `${business.name as string} scored ${result.total}/100 (${result.priority})`, {
      businessId,
      actor: opts.actor ?? 'system',
      detail: result.reasons.slice(0, 4).join(' · '),
      entityType: 'opportunity_score',
    });
  }
  return result;
}

/** Re-scores every active prospect — used after audits, rules or weights change. */
export function rescoreAll(orgId: string, opts: { limit?: number } = {}): { scored: number; byPriority: Record<string, number> } {
  const rows = all<{ id: string }>(
    `SELECT id FROM businesses WHERE org_id = ? AND merged_into IS NULL AND is_archived = 0
      ORDER BY opportunity_score IS NULL DESC, updated_at DESC LIMIT ?`,
    [orgId, opts.limit ?? 5000]
  );
  const byPriority: Record<string, number> = {};
  for (const r of rows) {
    const res = scoreBusiness(orgId, r.id, { log: false });
    if (res) byPriority[res.priority] = (byPriority[res.priority] ?? 0) + 1;
  }
  return { scored: rows.length, byPriority };
}

export interface LatestScore {
  id: string;
  business_id: string;
  total: number;
  priority: string;
  service_fit: string | null;
  computed_at: string;
  breakdown: FactorBreakdown[];
  reasons: string[];
}

export function latestScore(orgId: string, businessId: string): LatestScore | null {
  const row = get<Record<string, unknown>>(
    'SELECT * FROM opportunity_scores WHERE org_id = ? AND business_id = ? ORDER BY computed_at DESC LIMIT 1',
    [orgId, businessId]
  );
  if (!row) return null;
  return {
    id: row.id as string,
    business_id: row.business_id as string,
    total: (row.total as number) ?? 0,
    priority: (row.priority as string) ?? 'low',
    service_fit: (row.service_fit as string | null) ?? null,
    computed_at: (row.computed_at as string) ?? '',
    breakdown: json<FactorBreakdown[]>(row.breakdown as string, []),
    reasons: json<string[]>(row.reasons as string, []),
  };
}

export function scoreHistory(orgId: string, businessId: string, limit = 30) {
  return all<Record<string, unknown>>(
    'SELECT total, priority, computed_at FROM opportunity_scores WHERE org_id = ? AND business_id = ? ORDER BY computed_at DESC LIMIT ?',
    [orgId, businessId, limit]
  );
}

// ── Outcome learning (§14, §67) ──────────────────────────────
/**
 * Adjusts a score using realised outcomes. Features that appear more often in
 * won deals than in the general population earn a small positive boost; the
 * adjustment is capped so learning can never overwhelm measured evidence.
 */
export function learnedBoostFor(orgId: string, business: Record<string, unknown>): number {
  const features = extractFeatures(business);
  const stats = get<{ won: number; total: number }>(
    `SELECT SUM(CASE WHEN kind IN ('won','positive') THEN 1 ELSE 0 END) won, COUNT(*) total
       FROM outcome_events WHERE org_id = ? AND kind IN ('won','lost','positive','response')`,
    [orgId]
  );
  if (!stats?.total || stats.total < 8) return 0;

  let boost = 0;
  for (const f of features) {
    const rate = scalar<number>(
      `SELECT AVG(CASE WHEN kind IN ('won','positive') THEN 1.0 ELSE 0.0 END)
         FROM outcome_events WHERE org_id = ? AND kind IN ('won','lost','positive','response')
           AND json_extract(features, ?) = 1`,
      [orgId, `$."${f}"`]
    );
    if (rate === null) continue;
    const baseline = stats.won / stats.total;
    boost += (rate - baseline) * 30;
  }
  return round(clamp(boost, -8, 10), 2);
}

export function extractFeatures(business: Record<string, unknown>): string[] {
  const f: string[] = [];
  if (business.website_status === 'missing') f.push('no_website');
  if (business.website_status === 'unreachable') f.push('unreachable');
  if ((business.rating as number) >= 4.5) f.push('high_rating');
  if ((business.review_count as number) >= 50) f.push('high_reviews');
  if (Object.keys(json<Record<string, string>>(business.social as string, {})).length >= 2) f.push('active_social');
  if (business.industry) f.push(`industry:${business.industry}`);
  if (business.priority === 'critical') f.push('priority_critical');
  return f;
}

export function recordOutcome(
  orgId: string,
  kind: 'won' | 'lost' | 'response' | 'positive' | 'mockup_view' | 'call' | 'proposal' | 'revenue' | 'outreach_variant',
  businessId: string | null,
  opts: { features?: Record<string, unknown>; variantId?: string; value?: number; weight?: number } = {}
): void {
  const features = opts.features ?? (businessId ? Object.fromEntries(extractFeatures(get<Record<string, unknown>>('SELECT * FROM businesses WHERE id = ?', [businessId]) ?? {}).map((k) => [k, 1])) : {});
  run(
    `INSERT INTO outcome_events (id, org_id, business_id, kind, weight, features, variant_id, value, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [id('out'), orgId, businessId, kind, opts.weight ?? 1, toJson(features), opts.variantId ?? null, opts.value ?? null, nowIso()]
  );
}

export function saveProfile(orgId: string, patch: { name?: string; weights?: Record<string, number>; rules?: CustomRule[]; thresholds?: Record<string, number> }): void {
  ensureScoringProfile(orgId);
  const current = getActiveProfile(orgId);
  run(
    'UPDATE scoring_profiles SET name = ?, weights = ?, custom_rules = ?, priority_thresholds = ?, updated_at = ? WHERE org_id = ? AND is_default = 1',
    [
      patch.name ?? current.name,
      toJson(patch.weights ? normalizeWeights(patch.weights) : current.weights),
      toJson(patch.rules ?? current.rules),
      toJson(patch.thresholds ?? current.thresholds),
      nowIso(),
      orgId,
    ]
  );
}
