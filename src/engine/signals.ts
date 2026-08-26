/**
 * Growth-signal detection (§5, §10).
 *
 * Growth signals are the "this business is worth talking to *now*" layer:
 * strong reputation with a weak website, hiring, new locations, active social.
 * Each signal carries the evidence it was derived from — a signal without
 * evidence is not emitted.
 */
import { all, get, json, run } from '@/db';
import { nowIso, round } from '@/lib/id';
import type { Business } from '@/repo/business';

export interface GrowthSignal {
  key: string;
  label: string;
  weight: number;
  evidence: string;
}

export function buildGrowthSignals(orgId: string, businessId: string): { signals: GrowthSignal[]; score: number } {
  const business = get<Business>('SELECT * FROM businesses WHERE id = ? AND org_id = ?', [businessId, orgId]);
  if (!business) return { signals: [], score: 0 };

  const audit = get<Record<string, unknown>>('SELECT * FROM digital_audits WHERE business_id = ? ORDER BY created_at DESC LIMIT 1', [businessId]);
  const social = get<Record<string, unknown>>('SELECT * FROM social_audits WHERE business_id = ? ORDER BY created_at DESC LIMIT 1', [businessId]);
  const cohortGap = get<{ gap_score: number; gap_summary: string | null }>(
    "SELECT gap_score, gap_summary FROM competitors WHERE business_id = ? AND name = '__cohort_summary__' ORDER BY created_at DESC LIMIT 1",
    [businessId]
  );

  const signals: GrowthSignal[] = [];
  const rating = business.rating ?? null;
  const reviews = business.review_count ?? 0;
  const websiteScore = (audit?.website_score as number) ?? null;
  const websiteWeak = business.website_status !== 'live' || (websiteScore !== null && websiteScore < 55);

  if (rating !== null && rating >= 4.5 && reviews >= 20 && websiteWeak) {
    signals.push({
      key: 'strong_reviews_weak_website',
      label: 'Strong reviews, weak website',
      weight: 1.0,
      evidence: `${rating.toFixed(1)}★ from ${reviews} reviews, but the website scores ${websiteScore ?? 'n/a'}/100. Demand is proven; the digital route to it is not.`,
    });
  }
  if (reviews >= 100) {
    signals.push({
      key: 'high_review_volume',
      label: 'High review volume',
      weight: 0.7,
      evidence: `${reviews} reviews — sustained customer throughput.`,
    });
  }
  if (rating !== null && rating >= 4.7) {
    signals.push({ key: 'high_rating', label: 'Excellent public rating', weight: 0.6, evidence: `${rating.toFixed(1)}★ average.` });
  }

  const socialScore = (social?.social_score as number) ?? null;
  const activePlatforms = (social?.active_platforms as number) ?? 0;
  if (socialScore !== null && socialScore >= 60 && activePlatforms >= 2) {
    signals.push({
      key: 'active_social',
      label: 'Active social engagement',
      weight: 0.6,
      evidence: `${activePlatforms} active channel(s), social score ${socialScore}/100 — an audience that a website could convert.`,
    });
  }

  if (business.is_new_business === 1) {
    signals.push({
      key: 'new_business',
      label: 'Newly established business',
      weight: 0.7,
      evidence: business.founded_year ? `Founded ${business.founded_year}.` : 'Flagged as newly established by the source.',
    });
  }
  if (business.hiring_signal === 1) {
    signals.push({ key: 'hiring', label: 'Hiring activity', weight: 0.6, evidence: 'Hiring signal present in source data — usually accompanies growth.' });
  }

  const memories = all<{ value: string }>(
    "SELECT value FROM ai_memory WHERE business_id = ? AND kind = 'fact' AND key IN ('new_location','new_service','new_product')",
    [businessId]
  );
  for (const m of memories) {
    const key = m.value.toLowerCase().includes('location') ? 'new_location' : m.value.toLowerCase().includes('service') ? 'new_service' : 'new_service';
    signals.push({
      key,
      label: key === 'new_location' ? 'New location' : 'New service launched',
      weight: 0.65,
      evidence: m.value,
    });
  }

  if (cohortGap && cohortGap.gap_score > 20) {
    signals.push({
      key: 'competitor_digital_advantage',
      label: 'Competitors are digitally ahead',
      weight: 0.8,
      evidence: cohortGap.gap_summary ?? `Measured peers ahead by ${cohortGap.gap_score}/100.`,
    });
  }

  const hasProof = rating !== null && rating >= 4.3 && reviews >= 10;
  const conversionScore = (audit?.conversion_score as number) ?? null;
  if (hasProof && conversionScore !== null && conversionScore < 45) {
    signals.push({
      key: 'strong_reputation_weak_conversion',
      label: 'Strong reputation, weak conversion path',
      weight: 0.9,
      evidence: `Reputation is strong (${rating!.toFixed(1)}★/${reviews}) but the site's conversion score is ${conversionScore}/100 — enquiries are leaking.`,
    });
  }

  const score = round(Math.min(100, signals.reduce((a, s) => a + s.weight * 22, 0)));
  return { signals, score };
}

/** Website + social + growth signals combined, for the intelligence view. */
export function allSignals(orgId: string, businessId: string) {
  const audit = get<Record<string, unknown>>('SELECT signals FROM digital_audits WHERE business_id = ? ORDER BY created_at DESC LIMIT 1', [businessId]);
  const social = get<Record<string, unknown>>('SELECT signals FROM social_audits WHERE business_id = ? ORDER BY created_at DESC LIMIT 1', [businessId]);
  const growth = buildGrowthSignals(orgId, businessId);
  return {
    website: json<{ key: string; label: string; severity: string; evidence: string; service: string }[]>((audit?.signals as string) ?? '[]', []),
    social: json<{ key: string; label: string; severity: string; evidence: string; service: string }[]>((social?.signals as string) ?? '[]', []),
    growth: growth.signals,
  };
}

export function persistGrowthSignals(orgId: string, businessId: string): GrowthSignal[] {
  const { signals } = buildGrowthSignals(orgId, businessId);
  run("DELETE FROM ai_memory WHERE org_id = ? AND business_id = ? AND kind = 'fact' AND key LIKE 'growth:%'", [orgId, businessId]);
  for (const s of signals) {
    run(
      `INSERT INTO ai_memory (id, org_id, business_id, kind, key, value, confidence, source, pinned, created_at, updated_at)
       VALUES (?,?,?,?,?,?,0.9,'signal_engine',0,?,?)`,
      [
        `mem_${businessId}_${s.key}`.slice(0, 60),
        orgId,
        businessId,
        'fact',
        `growth:${s.key}`,
        `${s.label} — ${s.evidence}`,
        nowIso(),
        nowIso(),
      ]
    );
  }
  return signals;
}
