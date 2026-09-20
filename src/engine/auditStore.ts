/**
 * Persistence for website and social audits.
 * Shared by the discovery pipeline and the manual "Run audit" action so both
 * write identically-shaped rows.
 */
import { run } from '@/db';
import { id, nowIso, round } from '@/lib/id';
import { toJson } from '@/db';
import { updateBusiness } from '@/repo/business';
import type { auditWebsite } from '@/lib/audit/website';
import type { auditSocial } from '@/lib/audit/social';

export type WebsiteAuditResult = Awaited<ReturnType<typeof auditWebsite>>;
export type SocialAuditResult = Awaited<ReturnType<typeof auditSocial>>;

export function persistAudit(orgId: string, businessId: string, r: WebsiteAuditResult): void {
  const now = nowIso();
  run(
    `INSERT INTO digital_audits (id, org_id, business_id, website, website_status, website_score, digital_presence_score,
        verified, fetched_at, http_status, response_ms, ssl_valid, ssl_issuer, ssl_days_remaining, mobile_responsive,
        viewport_meta, page_count_est, internal_links, word_count, title, meta_description, meta_desc_length, h1_count,
        h2_count, image_count, images_missing_alt, form_count, cta_count, has_booking, has_ecommerce, has_live_chat,
        has_schema_markup, has_analytics, has_sitemap, has_robots, canonical_present, og_tags, social_links_found,
        testimonials_found, service_pages, phone_found, email_found, accessibility_score, seo_score, performance_score,
        conversion_score, content_score, branding_score, trust_score, signals, critical_issues, high_impact,
        nice_to_have, recommended_service, improvement_report, raw_excerpt, error, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id('aud'), orgId, businessId, null, r.websiteStatus, r.scores.website, r.scores.website,
      r.verified ? 1 : 0, r.fetchedAt, r.httpStatus, r.responseMs, r.sslValid === null ? null : r.sslValid ? 1 : 0,
      r.sslIssuer, r.sslDaysRemaining, r.mobileResponsive === null ? null : r.mobileResponsive ? 1 : 0,
      r.viewportMeta === null ? null : r.viewportMeta ? 1 : 0, r.pageCountEst, r.internalLinks, r.wordCount,
      r.title, r.metaDescription, r.metaDescLength, r.h1Count, r.h2Count, r.imageCount, r.imagesMissingAlt,
      r.formCount, r.ctaCount, r.hasBooking ? 1 : 0, r.hasEcommerce ? 1 : 0, r.hasLiveChat ? 1 : 0,
      r.hasSchemaMarkup ? 1 : 0, r.hasAnalytics ? 1 : 0, r.hasSitemap ? 1 : 0, r.hasRobots ? 1 : 0,
      r.canonicalPresent === null ? null : r.canonicalPresent ? 1 : 0, r.ogTags === null ? null : r.ogTags ? 1 : 0,
      toJson(r.socialLinksFound), r.testimonialsFound, toJson(r.servicePages), r.phoneFound, r.emailFound,
      r.scores.accessibility, r.scores.seo, r.scores.performance, r.scores.conversion, r.scores.content,
      r.scores.branding, r.scores.trust, toJson(r.signals), toJson(r.criticalIssues), toJson(r.highImpact),
      toJson(r.niceToHave), r.recommendedService, r.improvementReport, r.rawExcerpt, r.error, now, now,
    ]
  );

  const digitalPresence = round(r.scores.website * 0.6 + ((r.scores.seo + r.scores.trust + r.scores.branding) / 3) * 0.4);
  run('UPDATE digital_audits SET digital_presence_score = ? WHERE business_id = ? AND created_at = ?', [
    digitalPresence,
    businessId,
    now,
  ]);
  updateBusiness(orgId, businessId, { website_status: r.websiteStatus, website_checked_at: r.fetchedAt ?? now });
}

export function persistSocialAudit(orgId: string, businessId: string, r: SocialAuditResult): void {
  const now = nowIso();
  run(
    `INSERT INTO social_audits (id, org_id, business_id, social_score, platforms, platform_count, active_platforms,
        last_activity_days, posting_frequency, engagement_indicators, profile_completeness, visual_consistency,
        has_cta, contact_in_bio, content_gaps, signals, growth_opportunity, recommended_service, verified, error,
        created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id('sau'), orgId, businessId, r.socialScore, toJson(r.platforms), r.platformCount, r.activePlatforms,
      r.lastActivityDays, r.postingFrequency, toJson(r.engagementIndicators), r.profileCompleteness,
      r.visualConsistency, r.hasCta ? 1 : 0, r.contactInBio ? 1 : 0, toJson(r.contentGaps), toJson(r.signals),
      r.growthOpportunity, r.recommendedService, r.verified ? 1 : 0, r.error, now, now,
    ]
  );
}

export function persistAuditResults(
  orgId: string,
  businessId: string,
  website: WebsiteAuditResult,
  social: SocialAuditResult
): void {
  persistAudit(orgId, businessId, website);
  persistSocialAudit(orgId, businessId, social);
}
