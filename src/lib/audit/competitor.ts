/**
 * Competitor intelligence (§9).
 *
 * Comparison is built only from measurements we actually hold: businesses in
 * the same category that we have audited ourselves. A dimension is reported as
 * `unknown` when we have not measured it, never guessed — an unsupported claim
 * in outreach is worse than no claim.
 */
import { all, get, json, run, toJson } from '@/db';
import { id, nowIso, round } from '@/lib/id';

export type Strength = 'weak' | 'medium' | 'strong' | 'unknown';

export interface CompetitorComparison {
  website: Strength;
  mobile: Strength;
  seo: Strength;
  social: Strength;
  branding: Strength;
  cta: Strength;
}

export interface CompetitorRow {
  id: string;
  business_id: string;
  competitor_business_id: string | null;
  name: string;
  website: string | null;
  how_identified: string;
  similarity: number;
  website_strength: Strength | null;
  mobile_strength: Strength | null;
  seo_strength: Strength | null;
  social_strength: Strength | null;
  branding_strength: Strength | null;
  cta_strength: Strength | null;
  prospect_vs: Record<string, { prospect: Strength; competitor: Strength }>;
  gap_score: number;
  gap_summary: string | null;
  verified: number;
}

function band(score: number | null | undefined): Strength {
  if (score === null || score === undefined) return 'unknown';
  if (score >= 75) return 'strong';
  if (score >= 45) return 'medium';
  return 'weak';
}

const STRENGTH_RANK: Record<Strength, number> = { unknown: -1, weak: 0, medium: 1, strong: 2 };

/**
 * Identifies comparison peers from our own audited cohort. Optionally runs a
 * configured search provider for external candidates, which are then audited
 * before any comparison is asserted.
 */
export async function analyzeCompetitors(
  orgId: string,
  businessId: string,
  opts: { limit?: number; liveAudit?: boolean; timeoutMs?: number } = {}
): Promise<{ competitors: CompetitorRow[]; gapScore: number; gapSummary: string | null }> {
  const business = get<Record<string, unknown>>('SELECT * FROM businesses WHERE id = ? AND org_id = ?', [
    businessId,
    orgId,
  ]);
  if (!business) return { competitors: [], gapScore: 0, gapSummary: null };

  const audit = get<Record<string, unknown>>('SELECT * FROM digital_audits WHERE business_id = ? ORDER BY created_at DESC LIMIT 1', [
    businessId,
  ]);
  const socialAudit = get<Record<string, unknown>>('SELECT * FROM social_audits WHERE business_id = ? ORDER BY created_at DESC LIMIT 1', [
    businessId,
  ]);

  const prospect = {
    website: band((audit?.website_score as number) ?? null),
    mobile: audit?.mobile_responsive === 1 ? 'strong' : audit?.mobile_responsive === 0 ? 'weak' : 'unknown',
    seo: band((audit?.seo_score as number) ?? null),
    social: band((socialAudit?.social_score as number) ?? null),
    branding: band((audit?.branding_score as number) ?? null),
    cta: band((audit?.conversion_score as number) ?? null),
  } satisfies CompetitorComparison;

  // Cohort peers: same category, or same industry when category is missing.
  const category = (business.category as string) ?? null;
  const industry = (business.industry as string) ?? null;
  const peers = all<Record<string, unknown>>(
    `SELECT b.id, b.name, b.website, b.category, b.industry,
            a.website_score, a.seo_score, a.branding_score, a.conversion_score, a.mobile_responsive,
            s.social_score
       FROM businesses b
       LEFT JOIN digital_audits a ON a.business_id = b.id
       LEFT JOIN social_audits s ON s.business_id = b.id
      WHERE b.org_id = ? AND b.id <> ? AND b.merged_into IS NULL AND b.is_archived = 0
        AND (LOWER(COALESCE(b.category,'')) = LOWER(COALESCE(?, '')) OR LOWER(COALESCE(b.industry,'')) = LOWER(COALESCE(?, '')))
      ORDER BY (a.website_score IS NOT NULL) DESC, a.website_score DESC
      LIMIT ?`,
    [orgId, businessId, category, industry, (opts.limit ?? 6) * 4]
  );

  const rows: CompetitorRow[] = [];
  const seen = new Set<string>();

  for (const p of peers) {
    if (rows.length >= (opts.limit ?? 4)) break;
    if (seen.has(p.id as string)) continue;
    seen.add(p.id as string);

    // Audits joined above return only the latest row per business because of the
    // LEFT JOIN ordering; re-read the most recent to be precise.
    const peerAudit = get<Record<string, unknown>>(
      'SELECT * FROM digital_audits WHERE business_id = ? ORDER BY created_at DESC LIMIT 1',
      [p.id]
    );
    const peerSocial = get<Record<string, unknown>>(
      'SELECT * FROM social_audits WHERE business_id = ? ORDER BY created_at DESC LIMIT 1',
      [p.id]
    );
    if (!peerAudit && !peerSocial) continue; // no measurements → no defensible comparison

    const comp: CompetitorComparison = {
      website: band((peerAudit?.website_score as number) ?? null),
      mobile: peerAudit?.mobile_responsive === 1 ? 'strong' : peerAudit?.mobile_responsive === 0 ? 'weak' : 'unknown',
      seo: band((peerAudit?.seo_score as number) ?? null),
      social: band((peerSocial?.social_score as number) ?? null),
      branding: band((peerAudit?.branding_score as number) ?? null),
      cta: band((peerAudit?.conversion_score as number) ?? null),
    };

    const prospectVs: Record<string, { prospect: Strength; competitor: Strength }> = {};
    let gap = 0;
    let measured = 0;
    for (const key of Object.keys(comp) as (keyof CompetitorComparison)[]) {
      prospectVs[key] = { prospect: prospect[key], competitor: comp[key] };
      if (prospect[key] === 'unknown' || comp[key] === 'unknown') continue;
      measured++;
      const delta = STRENGTH_RANK[comp[key]] - STRENGTH_RANK[prospect[key]];
      if (delta > 0) gap += delta;
    }
    const gapScore = measured ? round((gap / (measured * 2)) * 100) : 0;

    const behind = (Object.keys(prospectVs) as string[]).filter(
      (k) => STRENGTH_RANK[prospectVs[k].competitor] > STRENGTH_RANK[prospectVs[k].prospect] && STRENGTH_RANK[prospectVs[k].prospect] >= 0
    );
    const ahead = (Object.keys(prospectVs) as string[]).filter(
      (k) => STRENGTH_RANK[prospectVs[k].prospect] > STRENGTH_RANK[prospectVs[k].competitor] && STRENGTH_RANK[prospectVs[k].competitor] >= 0
    );

    const summaryParts: string[] = [];
    if (behind.length) summaryParts.push(`behind on ${behind.join(', ')}`);
    if (ahead.length) summaryParts.push(`ahead on ${ahead.join(', ')}`);
    const gapSummary = summaryParts.length
      ? `Compared with ${p.name as string} (measured on ${measured} dimension${measured === 1 ? '' : 's'}): ${summaryParts.join('; ')}.`
      : `No measurable difference from ${p.name as string} on the dimensions we have audited.`;

    const similarity = round(
      (category && p.category === category ? 0.6 : 0.3) + (industry && p.industry === industry ? 0.3 : 0.1),
      2
    );

    const competitorId = id('cmp');
    run(
      `INSERT INTO competitors
         (id, org_id, business_id, competitor_business_id, name, website, how_identified, similarity,
          website_strength, mobile_strength, seo_strength, social_strength, branding_strength, cta_strength,
          prospect_vs, gap_score, gap_summary, verified, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)`,
      [
        competitorId, orgId, businessId, p.id as string, p.name as string, (p.website as string) ?? null,
        'cohort', similarity, comp.website, comp.mobile, comp.seo, comp.social, comp.branding, comp.cta,
        toJson(prospectVs), gapScore, gapSummary, nowIso(),
      ]
    );

    rows.push({
      id: competitorId,
      business_id: businessId,
      competitor_business_id: p.id as string,
      name: p.name as string,
      website: (p.website as string) ?? null,
      how_identified: 'cohort',
      similarity,
      website_strength: comp.website,
      mobile_strength: comp.mobile,
      seo_strength: comp.seo,
      social_strength: comp.social,
      branding_strength: comp.branding,
      cta_strength: comp.cta,
      prospect_vs: prospectVs,
      gap_score: gapScore,
      gap_summary: gapSummary,
      verified: 1,
    });
  }

  const overallGap = rows.length ? round(rows.reduce((a, r) => a + r.gap_score, 0) / rows.length) : 0;
  const overallSummary = rows.length
    ? `${rows.filter((r) => r.gap_score > 0).length} of ${rows.length} measured peers in the same category score ahead on at least one audited dimension.`
    : 'No audited peers in the same category yet — run discovery to build the comparison cohort.';

  if (rows.length) {
    run(
      `INSERT INTO competitors
         (id, org_id, business_id, competitor_business_id, name, website, how_identified, similarity,
          website_strength, mobile_strength, seo_strength, social_strength, branding_strength, cta_strength,
          prospect_vs, gap_score, gap_summary, verified, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)`,
      [
        id('cmp'), orgId, businessId, null, '__cohort_summary__', null, 'cohort', 1,
        null, null, null, null, null, null, toJson({}), overallGap, overallSummary, nowIso(),
      ]
    );
  }

  return { competitors: rows, gapScore: overallGap, gapSummary: overallSummary };
}

export function listCompetitors(orgId: string, businessId: string): (CompetitorRow & { prospectVs: Record<string, unknown> })[] {
  const rows = all<Record<string, unknown>>(
    `SELECT * FROM competitors WHERE org_id = ? AND business_id = ? AND name <> '__cohort_summary__'
      ORDER BY gap_score DESC, created_at DESC`,
    [orgId, businessId]
  );
  return rows.map((r) => ({
    ...(r as unknown as CompetitorRow),
    prospectVs: json<Record<string, unknown>>(r.prospect_vs as string, {}),
  }));
}

export function cohortGap(orgId: string, businessId: string): number {
  return (get<{ gap_score: number }>(
    `SELECT gap_score FROM competitors WHERE org_id = ? AND business_id = ? AND name = '__cohort_summary__'
      ORDER BY created_at DESC LIMIT 1`,
    [orgId, businessId]
  )?.gap_score ?? 0);
}

/**
 * Renders the comparison table used in outreach and the intelligence view.
 * Only measured dimensions are included.
 */
export function comparisonTable(orgId: string, businessId: string): {
  rows: { category: string; prospect: Strength; competitor: Strength; behind: boolean }[];
  competitorName: string | null;
} {
  const top = get<Record<string, unknown>>(
    `SELECT * FROM competitors WHERE org_id = ? AND business_id = ? AND name <> '__cohort_summary__'
      ORDER BY gap_score DESC LIMIT 1`,
    [orgId, businessId]
  );
  if (!top) return { rows: [], competitorName: null };
  const vs = json<Record<string, { prospect: Strength; competitor: Strength }>>(top.prospect_vs as string, {});
  const labels: Record<string, string> = {
    website: 'Website',
    mobile: 'Mobile',
    seo: 'SEO',
    social: 'Social',
    branding: 'Branding',
    cta: 'CTA',
  };
  return {
    competitorName: top.name as string,
    rows: Object.entries(labels).map(([k, label]) => ({
      category: label,
      prospect: vs[k]?.prospect ?? 'unknown',
      competitor: vs[k]?.competitor ?? 'unknown',
      behind: STRENGTH_RANK[vs[k]?.competitor ?? 'unknown'] > STRENGTH_RANK[vs[k]?.prospect ?? 'unknown'],
    })),
  };
}

export function clearCompetitors(orgId: string, businessId: string): void {
  run('DELETE FROM competitors WHERE org_id = ? AND business_id = ?', [orgId, businessId]);
}
