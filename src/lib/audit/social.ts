/**
 * Social media audit (§8).
 *
 * Works from profile URLs we actually hold. Platform APIs are not scraped —
 * follower counts and activity are only reported when a configured provider
 * returns them, or when the page itself states them. Everything else is
 * recorded as unknown rather than estimated.
 */
import { httpText } from '@/lib/http';
import { clamp, round } from '@/lib/id';
import type { WebsiteSignal } from './website';

export const PLATFORMS = ['instagram', 'facebook', 'twitter', 'linkedin', 'youtube', 'tiktok', 'pinterest'] as const;
export type Platform = (typeof PLATFORMS)[number];

export interface SocialPlatformAudit {
  platform: string;
  url: string;
  followers: number | null;
  posts: number | null;
  lastActivityDays: number | null;
  verified: boolean;
  reachable: boolean;
  error?: string;
}

export interface SocialAuditResult {
  socialScore: number;
  platforms: SocialPlatformAudit[];
  platformCount: number;
  activePlatforms: number;
  lastActivityDays: number | null;
  postingFrequency: 'daily' | 'weekly' | 'monthly' | 'dormant' | 'none' | 'unknown';
  engagementIndicators: string[];
  profileCompleteness: number;
  visualConsistency: number | null;
  hasCta: boolean;
  contactInBio: boolean;
  contentGaps: string[];
  signals: WebsiteSignal[];
  growthOpportunity: string;
  recommendedService: string | null;
  verified: boolean;
  error: string | null;
}

const PLATFORM_WEIGHT: Record<string, number> = {
  instagram: 1,
  facebook: 0.9,
  google: 0.85,
  tiktok: 0.8,
  youtube: 0.7,
  linkedin: 0.7,
  twitter: 0.6,
  pinterest: 0.5,
};

/**
 * @param social map of platform → profile URL as recorded on the business
 * @param opts.live allow a real HTTP probe of each profile (network permitting)
 */
export async function auditSocial(
  social: Record<string, string> | null | undefined,
  opts: { businessName?: string; industry?: string; live?: boolean; timeoutMs?: number } = {}
): Promise<SocialAuditResult> {
  const entries = Object.entries(social ?? {}).filter(([, url]) => !!url);
  const result: SocialAuditResult = {
    socialScore: 0,
    platforms: [],
    platformCount: entries.length,
    activePlatforms: 0,
    lastActivityDays: null,
    postingFrequency: entries.length ? 'unknown' : 'none',
    engagementIndicators: [],
    profileCompleteness: 0,
    visualConsistency: null,
    hasCta: false,
    contactInBio: false,
    contentGaps: [],
    signals: [],
    growthOpportunity: '',
    recommendedService: null,
    verified: false,
    error: null,
  };

  if (!entries.length) {
    result.signals.push({
      key: 'no_social',
      label: 'No social presence',
      severity: 'high',
      evidence: 'No social profile is recorded for this business.',
      service: 'social',
    });
    result.contentGaps.push('No channel exists for customers to discover recent work, offers or availability.');
    result.growthOpportunity =
      'A single well-run channel (matched to where this industry\'s customers actually look) plus a consistent monthly posting rhythm would give the business a discovery surface it currently lacks.';
    result.recommendedService = 'social';
    result.socialScore = 5;
    result.profileCompleteness = 0;
    return result;
  }

  for (const [platform, url] of entries) {
    const entry: SocialPlatformAudit = {
      platform: platform.toLowerCase(),
      url,
      followers: null,
      posts: null,
      lastActivityDays: null,
      verified: false,
      reachable: false,
    };

    if (opts.live) {
      const probe = await probeProfile(url, opts.timeoutMs ?? 9000);
      entry.reachable = probe.reachable;
      entry.followers = probe.followers;
      entry.posts = probe.posts;
      entry.verified = probe.reachable;
      if (probe.error) entry.error = probe.error;
      // A stated follower count in public markup is evidence; absence is not.
      if (probe.hasCta) result.hasCta = true;
      if (probe.hasContact) result.contactInBio = true;
    }
    result.platforms.push(entry);
  }

  if (opts.live) result.verified = result.platforms.some((p) => p.reachable);
  result.activePlatforms = result.platforms.filter((p) => !p.error).length;

  const knownActivity = result.platforms.map((p) => p.lastActivityDays).filter((d): d is number => d !== null);
  result.lastActivityDays = knownActivity.length ? Math.min(...knownActivity) : null;

  if (result.lastActivityDays !== null) {
    result.postingFrequency =
      result.lastActivityDays <= 2 ? 'daily'
      : result.lastActivityDays <= 8 ? 'weekly'
      : result.lastActivityDays <= 35 ? 'monthly'
      : 'dormant';
  } else if (!opts.live) {
    result.postingFrequency = 'unknown';
  }

  // ── Scoring ──
  // Breadth: more channels is better, with diminishing returns past three.
  const breadth = clamp(
    entries.reduce((a, [p]) => a + (PLATFORM_WEIGHT[p.toLowerCase()] ?? 0.4), 0) * 16,
    0,
    45
  );

  // Recency: only scored when we actually observed activity.
  const recencyKnown = result.lastActivityDays !== null;
  const recency = !recencyKnown
    ? 18 // neutral midpoint — we do not penalise what we could not measure
    : result.lastActivityDays! <= 2 ? 30
    : result.lastActivityDays! <= 8 ? 24
    : result.lastActivityDays! <= 35 ? 15
    : result.lastActivityDays! <= 90 ? 7
    : 0;

  // Completeness of what we know about the profiles.
  let completeness = 0;
  completeness += entries.length ? 30 : 0;
  completeness += result.hasCta ? 25 : 0;
  completeness += result.contactInBio ? 25 : 0;
  completeness += result.platforms.some((p) => p.reachable) ? 20 : 0;
  result.profileCompleteness = round(clamp(completeness));

  const engagement = clamp(result.engagementIndicators.length * 12, 0, 25);

  result.socialScore = round(clamp(breadth + recency * 0.5 + result.profileCompleteness * 0.25 + engagement));

  // ── Signals ──
  if (entries.length === 1) {
    result.signals.push({
      key: 'single_platform',
      label: 'Only one social channel',
      severity: 'medium',
      evidence: `Only ${entries[0][0]} is on record.`,
      service: 'social',
    });
  }
  if (result.postingFrequency === 'dormant') {
    result.signals.push({
      key: 'inactive_social',
      label: 'Social account appears inactive',
      severity: 'high',
      evidence: `Last observed activity was ${result.lastActivityDays} days ago.`,
      service: 'social',
    });
  } else if (result.postingFrequency === 'monthly') {
    result.signals.push({
      key: 'low_posting_frequency',
      label: 'Infrequent posting',
      severity: 'medium',
      evidence: `Roughly monthly cadence (${result.lastActivityDays} days since last activity).`,
      service: 'social',
    });
  }
  if (opts.live && !result.hasCta) {
    result.signals.push({
      key: 'no_social_cta',
      label: 'No call to action on profiles',
      severity: 'medium',
      evidence: 'No booking, enquiry or website call to action detected in the profile markup.',
      service: 'social',
    });
  }
  if (opts.live && !result.contactInBio) {
    result.signals.push({
      key: 'no_contact_in_bio',
      label: 'No contact details in profile',
      severity: 'low',
      evidence: 'No phone, email or website link detected in the profile.',
      service: 'social',
    });
  }

  // ── Content gaps ──
  if (entries.length < 3) {
    result.contentGaps.push('Customers searching other channels will not find the business there.');
  }
  if (result.postingFrequency === 'dormant' || result.postingFrequency === 'monthly') {
    result.contentGaps.push('Irregular posting means the profile looks abandoned, which undermines trust even when the work is good.');
  }
  if (!result.hasCta) {
    result.contentGaps.push('Profile interest has no route to an enquiry — there is nothing telling a viewer what to do next.');
  }
  if (!result.contentGaps.length) {
    result.contentGaps.push('No obvious gaps detected from the data available.');
  }

  result.growthOpportunity = buildGrowthOpportunity(result, opts);
  result.recommendedService = result.socialScore >= 75 ? 'content' : 'social';
  return result;
}

function buildGrowthOpportunity(r: SocialAuditResult, opts: { businessName?: string; industry?: string }): string {
  const name = opts.businessName ?? 'The business';
  const parts: string[] = [];
  if (r.platformCount === 0) parts.push(`${name} has no social presence at all`);
  else if (r.platformCount === 1) parts.push(`${name} relies on a single channel (${r.platforms[0].platform})`);
  else parts.push(`${name} maintains ${r.platformCount} channels`);

  if (r.postingFrequency === 'dormant') parts.push('but the profile appears dormant');
  else if (r.postingFrequency === 'monthly') parts.push('but posting is infrequent');
  else if (r.postingFrequency === 'weekly' || r.postingFrequency === 'daily') parts.push('and posting is regular');

  const action =
    r.socialScore < 40
      ? 'a managed content calendar with consistent posting would turn existing goodwill into steady inbound interest'
      : r.socialScore < 70
        ? 'tightening cadence and adding a clear call to action would convert profile visits into enquiries'
        : 'the opportunity is repurposing this activity into website and search demand';
  return `${parts.join(', ')}. Given that, ${action}.`;
}

/**
 * Best-effort public probe. Reads only what the page itself states — no
 * scraping of private endpoints, no inference of follower counts.
 */
async function probeProfile(
  url: string,
  timeoutMs: number
): Promise<{ reachable: boolean; followers: number | null; posts: number | null; hasCta: boolean; hasContact: boolean; error?: string }> {
  try {
    const res = await httpText(url, {
      timeoutMs,
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; AcquisitionOS-Audit/1.0)' },
    });
    if (!res.ok || !res.text) return { reachable: false, followers: null, posts: null, hasCta: false, hasContact: false, error: res.error ?? `HTTP ${res.status}` };
    const html = res.text;
    const lower = html.toLowerCase();

    // Open Graph / meta descriptions sometimes state these numbers.
    const followers =
      matchNumber(html, /"follower_?count"\s*:\s*"?([\d,]+)/i) ??
      matchNumber(html, /([\d.,]+[kKmM]?)\s+followers/i) ??
      matchNumber(html, /([\d.,]+[kKmM]?)\s+people follow/i);
    const posts = matchNumber(html, /"media_?count"\s*:\s*"?([\d,]+)/i) ?? matchNumber(html, /([\d.,]+[kKmM]?)\s+posts/i);
    const hasCta = /(book now|enquire|get in touch|order online|visit our website|linktr\.ee|wa\.me)/i.test(html);
    const hasContact = /(tel:|mailto:|wa\.me|\+?\d[\d\s()-]{8,})/i.test(lower);

    return { reachable: true, followers, posts, hasCta, hasContact };
  } catch (e) {
    return { reachable: false, followers: null, posts: null, hasCta: false, hasContact: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function matchNumber(text: string, re: RegExp): number | null {
  const m = text.match(re);
  if (!m) return null;
  const raw = m[1].replace(/,/g, '');
  const multiplier = /k$/i.test(raw) ? 1000 : /m$/i.test(raw) ? 1_000_000 : 1;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? Math.round(n * multiplier) : null;
}
