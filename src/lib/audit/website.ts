/**
 * Deep website analysis (§7).
 *
 * When a business has a URL this performs a real HTTP fetch and a real parse:
 * TLS state, response time, metadata, heading structure, forms, CTAs, booking
 * and commerce markers, accessibility signals, schema markup and internal
 * linking. Every derived signal carries the evidence it came from.
 *
 * When there is no URL, or the fetch fails, the audit says so. `verified` is
 * only ever 1 when an actual response was inspected — an absent website is a
 * finding, not an assumption.
 */
import { parse as parseHtml, type HTMLElement as ParsedElement } from 'node-html-parser';
import { httpText, probeTls } from '@/lib/http';
import { assertSafeUrl } from '@/lib/ssrf';
import { normalizeDomain } from '@/lib/id';
import { clamp, round } from '@/lib/id';

export interface WebsiteSignal {
  key: string;
  label: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  evidence: string;
  service: string;
}

export interface WebsiteAuditResult {
  verified: boolean;
  websiteStatus: 'live' | 'unreachable' | 'insecure' | 'parked' | 'missing' | 'unknown';
  httpStatus: number | null;
  responseMs: number;
  sslValid: boolean | null;
  sslIssuer: string | null;
  sslDaysRemaining: number | null;
  mobileResponsive: boolean | null;
  viewportMeta: boolean | null;
  pageCountEst: number | null;
  internalLinks: number | null;
  wordCount: number | null;
  title: string | null;
  metaDescription: string | null;
  metaDescLength: number | null;
  h1Count: number | null;
  h2Count: number | null;
  imageCount: number | null;
  imagesMissingAlt: number | null;
  formCount: number | null;
  ctaCount: number | null;
  hasBooking: boolean;
  hasEcommerce: boolean;
  hasLiveChat: boolean;
  hasSchemaMarkup: boolean;
  hasAnalytics: boolean;
  hasSitemap: boolean;
  hasRobots: boolean;
  canonicalPresent: boolean | null;
  ogTags: boolean | null;
  socialLinksFound: string[];
  testimonialsFound: number;
  servicePages: string[];
  phoneFound: string | null;
  emailFound: string | null;
  langAttr: string | null;
  scores: {
    website: number;
    seo: number;
    accessibility: number;
    performance: number;
    conversion: number;
    content: number;
    branding: number;
    trust: number;
  };
  signals: WebsiteSignal[];
  criticalIssues: string[];
  highImpact: string[];
  niceToHave: string[];
  recommendedService: string | null;
  improvementReport: string;
  error: string | null;
  fetchedAt: string | null;
  rawExcerpt: string | null;
}

const PARKING_MARKERS = [
  'domain is for sale',
  'buy this domain',
  'parked domain',
  'this domain has expired',
  'sedoparking',
  'godaddy.com/parkweb',
  'domain parking',
  'register this domain',
];

const BOOKING_MARKERS = [
  'calendly', 'book-online', 'book now', 'book an appointment', 'booking.com/widget', 'squareup.com/appointments',
  'fresha', 'vagaro', 'mindbody', 'setmore', 'acuity', 'tidycal', 'savvycal', 'booking-widget', 'schedule-a-call',
  'reserve', 'make a reservation', 'opentable', 'reserv',
];

const COMMERCE_MARKERS = [
  'shopify', 'woocommerce', 'add to cart', 'add-to-cart', 'bigcommerce', 'squarespace commerce', 'wix store',
  'ecwid', 'magento', 'prestashop', 'checkout', 'cart-total', 'product-price', 'stripe.com/pay',
];

const CHAT_MARKERS = ['intercom', 'drift.com', 'tawk.to', 'crisp.chat', 'livechat', 'zendesk', 'hubspot.com/conversations', 'tidio', 'live chat'];

const ANALYTICS_MARKERS = ['google-analytics', 'gtag(', 'googletagmanager', 'plausible', 'fathom', 'matomo', 'mixpanel', 'segment.com', 'clarity.ms', 'hotjar'];

const TESTIMONIAL_MARKERS = ['testimonial', 'testimonials', 'what our clients say', 'client reviews', 'customer reviews', 'review-carousel', 'trustpilot', 'google reviews', 'star-rating'];

const SOCIAL_PLATFORMS: { key: string; patterns: string[] }[] = [
  { key: 'facebook', patterns: ['facebook.com/', 'fb.com/'] },
  { key: 'instagram', patterns: ['instagram.com/'] },
  { key: 'twitter', patterns: ['twitter.com/', 'x.com/'] },
  { key: 'linkedin', patterns: ['linkedin.com/company/', 'linkedin.com/in/'] },
  { key: 'youtube', patterns: ['youtube.com/', 'youtu.be/'] },
  { key: 'tiktok', patterns: ['tiktok.com/'] },
  { key: 'pinterest', patterns: ['pinterest.com/'] },
];

const CTA_VERBS = [
  'book', 'buy', 'get started', 'get a quote', 'request a quote', 'contact us', 'call now', 'sign up', 'subscribe',
  'download', 'learn more', 'enquire', 'enquire now', 'inquire', 'order now', 'reserve', 'schedule', 'start today',
  'free consultation', 'get in touch', 'shop now',
];

/** Main entry. `timeoutMs` keeps the daily job bounded. */
export async function auditWebsite(
  url: string | null | undefined,
  opts: { timeoutMs?: number; crawl?: boolean; maxPages?: number } = {}
): Promise<WebsiteAuditResult> {
  const timeoutMs = opts.timeoutMs ?? 12_000;
  const base = emptyAudit();

  if (!url) {
    base.websiteStatus = 'missing';
    base.signals.push({
      key: 'no_website',
      label: 'No website',
      severity: 'critical',
      evidence: 'No URL on record for this business.',
      service: 'website',
    });
    base.criticalIssues.push('The business has no website at all — every enquiry currently depends on phone, walk-ins or third-party listings.');
    base.highImpact.push('A single-page site with services, proof and a clear enquiry route would capture demand that is currently lost.');
    base.recommendedService = 'website';
    base.scores.website = 4;
    base.improvementReport = renderReport(base, null);
    return base;
  }

  const absolute = url.startsWith('http') ? url : `https://${url}`;
  const domain = normalizeDomain(absolute);

  // SSRF guard (§17): the URL comes from a discovered or imported record, so it
  // is attacker-influenceable. Resolve and require a publicly routable address
  // before any request leaves this process.
  const verdict = await assertSafeUrl(absolute);
  if (!verdict.safe) {
    base.websiteStatus = 'unreachable';
    base.error = `Refused: ${verdict.reason}`;
    base.improvementReport = renderReport(base, absolute);
    return base;
  }

  const started = Date.now();
  const res = await httpText(absolute, { timeoutMs, headers: { 'user-agent': 'AcquisitionOS-Audit/1.0 (+compatible; digital presence audit)' } });
  const responseMs = Date.now() - started;
  base.responseMs = responseMs;

  if (!res.ok && res.status === 0) {
    // Try the other scheme once before declaring it unreachable.
    const alt = absolute.startsWith('https://') ? absolute.replace('https://', 'http://') : absolute.replace('http://', 'https://');
    const altVerdict = await assertSafeUrl(alt);
    const retry = altVerdict.safe
      ? await httpText(alt, { timeoutMs: Math.min(timeoutMs, 8000) })
      : { ok: false, status: 0, data: '', text: '', elapsedMs: 0, error: `Refused: ${altVerdict.reason}` };
    if (!retry.ok) {
      base.websiteStatus = 'unreachable';
      base.error = res.error ?? 'no response';
      base.signals.push({
        key: 'website_unreachable',
        label: 'Website unreachable',
        severity: 'critical',
        evidence: `${absolute} did not respond (${res.error ?? 'timeout/DNS'}).`,
        service: 'website',
      });
      base.criticalIssues.push(`The website at ${absolute} does not respond — visitors are hitting an error, so the business is effectively invisible online.`);
      base.recommendedService = 'website';
      base.scores.website = 8;
      base.improvementReport = renderReport(base, absolute);
      return base;
    }
  }

  base.verified = true;
  base.fetchedAt = new Date().toISOString();
  base.httpStatus = res.status;

  const html = res.text ?? '';
  const lower = html.toLowerCase();
  base.rawExcerpt = html.slice(0, 4000);

  if (PARKING_MARKERS.some((m) => lower.includes(m)) && html.length < 20_000) {
    base.websiteStatus = 'parked';
    base.signals.push({
      key: 'website_broken',
      label: 'Domain is parked or expired',
      severity: 'critical',
      evidence: 'The page content is a domain-parking placeholder, not a business site.',
      service: 'website',
    });
    base.criticalIssues.push('The domain currently serves a parking page — anyone typing the address finds a domain advertisement instead of the business.');
    base.recommendedService = 'website';
    base.scores.website = 6;
    base.improvementReport = renderReport(base, absolute);
    return base;
  }

  let doc: ParsedElement;
  try {
    doc = parseHtml(html, { comment: false, blockTextElements: { script: false, noscript: false, style: false } });
  } catch (e) {
    base.websiteStatus = 'live';
    base.error = `parse failed: ${e instanceof Error ? e.message : String(e)}`;
    base.improvementReport = renderReport(base, absolute);
    return base;
  }

  // ── TLS ──
  if (absolute.startsWith('https://') && domain) {
    const tls = await probeTls(domain, 8000);
    base.sslValid = tls.ok;
    base.sslIssuer = tls.issuer ?? null;
    base.sslDaysRemaining = tls.daysRemaining ?? null;
  } else {
    base.sslValid = false;
  }

  // ── Metadata / SEO ──
  base.title = (doc.querySelector('title')?.textContent ?? '').trim() || null;
  base.metaDescription =
    (doc.querySelector('meta[name="description"]')?.getAttribute('content') ?? '').trim() || null;
  base.metaDescLength = base.metaDescription ? base.metaDescription.length : 0;
  base.canonicalPresent = !!doc.querySelector('link[rel="canonical"]');
  base.ogTags = !!doc.querySelector('meta[property^="og:"]');
  base.langAttr = doc.querySelector('html')?.getAttribute('lang') ?? null;
  base.hasSchemaMarkup = lower.includes('application/ld+json') || lower.includes('itemtype="http://schema.org');
  base.hasAnalytics = ANALYTICS_MARKERS.some((m) => lower.includes(m));
  base.hasRobots = !!doc.querySelector('meta[name="robots"]');

  // ── Structure ──
  const h1 = doc.querySelectorAll('h1');
  const h2 = doc.querySelectorAll('h2');
  base.h1Count = h1.length;
  base.h2Count = h2.length;

  const links = doc.querySelectorAll('a[href]');
  const internal = new Set<string>();
  const servicePages: string[] = [];
  for (const a of links) {
    const href = a.getAttribute('href') ?? '';
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) continue;
    const isInternal = href.startsWith('/') || (domain ? href.includes(domain) : false);
    if (isInternal) {
      internal.add(href.split('#')[0]);
      const label = (a.textContent ?? '').trim().toLowerCase();
      if (/service|treatment|menu|pricing|price|what we do|offerings|solutions/.test(label + ' ' + href.toLowerCase())) {
        servicePages.push((a.textContent ?? '').trim() || href);
      }
    }
  }
  base.internalLinks = internal.size;
  base.pageCountEst = Math.min(internal.size + 1, 60);
  base.servicePages = Array.from(new Set(servicePages)).slice(0, 12);

  // ── Content volume ──
  const bodyText = (doc.querySelector('body')?.textContent ?? doc.textContent ?? '').replace(/\s+/g, ' ').trim();
  base.wordCount = bodyText.split(/\s+/).filter(Boolean).length;

  // ── Images / accessibility ──
  const images = doc.querySelectorAll('img');
  base.imageCount = images.length;
  base.imagesMissingAlt = images.filter((i) => !(i.getAttribute('alt') ?? '').trim()).length;

  const inputs = doc.querySelectorAll('input, textarea, select');
  const labels = doc.querySelectorAll('label').length;
  const ariaCount = lower.match(/aria-/g)?.length ?? 0;

  base.mobileResponsive = !!doc.querySelector('meta[name="viewport"]');
  base.viewportMeta = base.mobileResponsive;

  // ── Forms & CTAs ──
  base.formCount = doc.querySelectorAll('form').length;
  const anchors = doc.querySelectorAll('a');
  const buttons = doc.querySelectorAll('button');
  let cta = 0;
  for (const el of [...anchors, ...buttons]) {
    const text = ((el.textContent ?? '') + ' ' + (el.getAttribute('aria-label') ?? '') + ' ' + (el.getAttribute('title') ?? '')).toLowerCase();
    if (CTA_VERBS.some((v) => text.includes(v))) cta++;
  }
  base.ctaCount = cta;

  base.hasBooking = BOOKING_MARKERS.some((m) => lower.includes(m));
  base.hasEcommerce = COMMERCE_MARKERS.some((m) => lower.includes(m));
  base.hasLiveChat = CHAT_MARKERS.some((m) => lower.includes(m));
  base.testimonialsFound = TESTIMONIAL_MARKERS.filter((m) => lower.includes(m)).length;

  // ── Social + contact extraction ──
  const found: string[] = [];
  for (const p of SOCIAL_PLATFORMS) {
    if (p.patterns.some((pat) => lower.includes(pat))) found.push(p.key);
  }
  base.socialLinksFound = found;
  base.phoneFound = bodyText.match(/(\+?\d[\d\s().-]{7,}\d)/)?.[1]?.trim() ?? doc.querySelector('a[href^="tel:"]')?.getAttribute('href')?.replace('tel:', '') ?? null;
  base.emailFound =
    bodyText.match(/[\w.+-]+@[\w-]+\.[\w.]{2,}/)?.[0] ?? doc.querySelector('a[href^="mailto:"]')?.getAttribute('href')?.replace('mailto:', '') ?? null;

  // ── Subscores ──
  const seo = round(
    clamp(
      (base.title ? 18 : 0) +
        (base.metaDescription ? 16 : 0) +
        (base.metaDescLength! >= 70 && base.metaDescLength! <= 170 ? 8 : base.metaDescription ? 4 : 0) +
        (base.h1Count === 1 ? 14 : base.h1Count === 0 ? 0 : 6) +
        (base.canonicalPresent ? 8 : 0) +
        (base.ogTags ? 8 : 0) +
        (base.hasSchemaMarkup ? 12 : 0) +
        (base.hasSitemap ? 6 : 0) +
        (base.hasRobots ? 5 : 0) +
        (base.internalLinks! >= 5 ? 5 : base.internalLinks! > 0 ? 3 : 0)
    )
  );

  const altRatio = base.imageCount ? 1 - base.imagesMissingAlt! / base.imageCount : 1;
  const accessibility = round(
    clamp(
      altRatio * 38 +
        (base.langAttr ? 14 : 0) +
        (base.h1Count >= 1 ? 12 : 0) +
        (labels >= Math.max(1, inputs.length) ? 16 : inputs.length ? 6 : 16) +
        Math.min(20, ariaCount * 2)
    )
  );

  const performance = round(
    clamp(
      (responseMs < 600 ? 45 : responseMs < 1200 ? 34 : responseMs < 2500 ? 22 : responseMs < 5000 ? 12 : 5) +
        (html.length < 250_000 ? 22 : html.length < 600_000 ? 14 : 6) +
        (base.imageCount! < 40 ? 18 : 10) +
        (base.hasAnalytics ? 8 : 4) +
        (lower.includes('loading="lazy"') ? 7 : 0)
    )
  );

  const conversion = round(
    clamp(
      (base.formCount! > 0 ? 26 : 0) +
        Math.min(24, base.ctaCount! * 6) +
        (base.hasBooking ? 22 : 0) +
        (base.phoneFound ? 10 : 0) +
        (base.emailFound ? 8 : 0) +
        (base.testimonialsFound > 0 ? 10 : 0)
    )
  );

  const content = round(
    clamp(
      (base.wordCount! >= 400 ? 34 : base.wordCount! >= 200 ? 24 : base.wordCount! >= 80 ? 12 : 4) +
        Math.min(24, base.h2Count! * 4) +
        (base.pageCountEst! >= 4 ? 20 : base.pageCountEst! >= 2 ? 12 : 5) +
        (base.servicePages.length ? 14 : 0) +
        (base.metaDescription ? 8 : 0)
    )
  );

  const branding = round(
    clamp(
      (doc.querySelector('link[rel*="icon"]') ? 18 : 0) +
        (base.ogTags ? 16 : 0) +
        (base.imageCount! > 0 ? 18 : 4) +
        (doc.querySelectorAll('link[href*="fonts.googleapis"], style').length ? 14 : 6) +
        (base.h2Count! > 2 ? 16 : 8) +
        (base.internalLinks! >= 4 ? 18 : 8)
    )
  );

  const trust = round(
    clamp(
      (base.sslValid ? 30 : 0) +
        (base.testimonialsFound > 0 ? 24 : 0) +
        (base.hasSchemaMarkup ? 14 : 0) +
        (base.phoneFound ? 12 : 0) +
        (base.emailFound ? 10 : 0) +
        (found.length ? 10 : 0)
    )
  );

  const website = round(clamp(seo * 0.22 + accessibility * 0.13 + performance * 0.16 + conversion * 0.24 + content * 0.13 + branding * 0.06 + trust * 0.06));

  base.scores = { website, seo, accessibility, performance, conversion, content, branding, trust };
  base.websiteStatus = base.sslValid === false ? 'insecure' : 'live';

  // ── Signals with evidence ──
  const push = (s: WebsiteSignal) => base.signals.push(s);

  if (!base.title) {
    push({ key: 'missing_metadata', label: 'No page title', severity: 'high', evidence: 'The homepage <title> tag is empty.', service: 'seo' });
  } else if (base.title.length < 15 || base.title.length > 65) {
    push({ key: 'missing_metadata', label: 'Page title is not search-optimised', severity: 'medium', evidence: `Title is ${base.title.length} characters: "${base.title.slice(0, 60)}".`, service: 'seo' });
  }
  if (!base.metaDescription) {
    push({ key: 'missing_metadata', label: 'No meta description', severity: 'high', evidence: 'Search engines will generate their own snippet.', service: 'seo' });
  }
  if (base.h1Count === 0) {
    push({ key: 'weak_seo', label: 'No H1 heading', severity: 'high', evidence: 'The page has no primary heading for search engines or screen readers.', service: 'seo' });
  } else if (base.h1Count! > 1) {
    push({ key: 'poor_information_architecture', label: 'Multiple H1 headings', severity: 'low', evidence: `${base.h1Count} H1 tags found; one is expected.`, service: 'website_redesign' });
  }
  if (!base.mobileResponsive) {
    push({ key: 'not_mobile_responsive', label: 'Not mobile responsive', severity: 'critical', evidence: 'No viewport meta tag — the page will not scale on phones.', service: 'website_redesign' });
  }
  if (base.sslValid === false) {
    push({ key: 'no_ssl', label: 'No valid SSL certificate', severity: 'critical', evidence: base.sslDaysRemaining != null && base.sslDaysRemaining < 0 ? 'Certificate has expired.' : 'The site is not served over a valid HTTPS connection, so browsers show a security warning.', service: 'website' });
  } else if (base.sslDaysRemaining != null && base.sslDaysRemaining < 30) {
    push({ key: 'no_ssl', label: 'SSL certificate expiring soon', severity: 'high', evidence: `${base.sslDaysRemaining} days remaining.`, service: 'maintenance' });
  }
  if (base.formCount === 0) {
    push({ key: 'no_contact_form', label: 'No contact form', severity: 'high', evidence: 'No <form> element found on the homepage.', service: 'conversion' });
  }
  if (base.ctaCount === 0) {
    push({ key: 'missing_cta', label: 'No clear call to action', severity: 'high', evidence: 'No button or link uses action language (book, enquire, get a quote…).', service: 'conversion' });
  } else if (base.ctaCount! <= 1) {
    push({ key: 'missing_cta', label: 'Weak call to action coverage', severity: 'medium', evidence: `Only ${base.ctaCount} actionable element found.`, service: 'conversion' });
  }
  if (!base.hasBooking) {
    push({ key: 'missing_booking', label: 'No online booking or enquiry system', severity: 'high', evidence: 'No booking widget, scheduling link or reservation system detected.', service: 'website' });
  }
  if (base.imageCount! > 0 && base.imagesMissingAlt! > 0) {
    push({ key: 'poor_accessibility', label: 'Images missing alternative text', severity: 'medium', evidence: `${base.imagesMissingAlt} of ${base.imageCount} images have no alt text.`, service: 'accessibility' });
  }
  if (!base.langAttr) {
    push({ key: 'poor_accessibility', label: 'No language declared', severity: 'low', evidence: 'The <html> element has no lang attribute, so screen readers guess.', service: 'accessibility' });
  }
  if (base.wordCount! < 200) {
    push({ key: 'weak_content', label: 'Very little written content', severity: 'high', evidence: `Only ~${base.wordCount} words on the homepage.`, service: 'content' });
  } else if (base.wordCount! < 400) {
    push({ key: 'weak_content', label: 'Thin homepage content', severity: 'medium', evidence: `~${base.wordCount} words — not enough to explain the offer or rank.`, service: 'content' });
  }
  if (base.pageCountEst! < 3) {
    push({ key: 'poor_information_architecture', label: 'Very few pages', severity: 'medium', evidence: `About ${base.pageCountEst} internal page(s) linked from the homepage.`, service: 'website' });
  }
  if (!base.servicePages.length) {
    push({ key: 'poor_information_architecture', label: 'No dedicated service pages', severity: 'high', evidence: 'No service, menu, treatment or pricing page is linked from the homepage.', service: 'website' });
  }
  if (!base.hasSchemaMarkup) {
    push({ key: 'weak_seo', label: 'No structured data', severity: 'medium', evidence: 'No schema.org / JSON-LD markup, so no rich results in search.', service: 'seo' });
  }
  if (!base.ogTags) {
    push({ key: 'weak_seo', label: 'No social sharing metadata', severity: 'low', evidence: 'Missing Open Graph tags — links shared socially show no image or description.', service: 'social' });
  }
  if (base.testimonialsFound === 0) {
    push({ key: 'no_testimonials', label: 'No social proof on the site', severity: 'medium', evidence: 'No testimonials, reviews or trust markers found in the page content.', service: 'conversion' });
  }
  if (responseMs > 2500) {
    push({ key: 'slow_website', label: 'Slow to respond', severity: 'high', evidence: `Homepage took ${(responseMs / 1000).toFixed(1)}s to respond.`, service: 'performance' });
  } else if (responseMs > 1500) {
    push({ key: 'slow_website', label: 'Sluggish response time', severity: 'medium', evidence: `Homepage took ${(responseMs / 1000).toFixed(1)}s to respond.`, service: 'performance' });
  }
  if (html.length > 600_000) {
    push({ key: 'slow_website', label: 'Very heavy page', severity: 'medium', evidence: `Homepage HTML is ${(html.length / 1024).toFixed(0)} KB before assets.`, service: 'performance' });
  }
  if (base.internalLinks! <= 2) {
    push({ key: 'poor_information_architecture', label: 'Confusing navigation', severity: 'medium', evidence: `Only ${base.internalLinks} internal links found on the homepage.`, service: 'website_redesign' });
  }
  if (!base.hasAnalytics) {
    push({ key: 'weak_seo', label: 'No analytics installed', severity: 'low', evidence: 'No analytics or measurement tag detected, so the owner cannot see what is working.', service: 'analytics' });
  }

  // Legacy technology markers — a defensible "outdated" signal.
  if (/<table[\s>]/i.test(html) && base.h2Count! < 2) {
    push({ key: 'outdated_website', label: 'Table-based layout', severity: 'high', evidence: 'The layout is built with HTML tables, which dates the site and breaks on mobile.', service: 'website_redesign' });
  }
  if (lower.includes('dreamweaver') || lower.includes('frontpage') || lower.includes('microsoft office')) {
    push({ key: 'outdated_website', label: 'Built with legacy authoring tools', severity: 'medium', evidence: 'Legacy editor markers present in the source.', service: 'website_redesign' });
  }

  // ── Issue buckets ──
  for (const s of base.signals) {
    const line = `${s.label} — ${s.evidence}`;
    if (s.severity === 'critical') base.criticalIssues.push(line);
    else if (s.severity === 'high') base.highImpact.push(line);
    else base.niceToHave.push(line);
  }

  base.recommendedService = recommendService(base);
  base.improvementReport = renderReport(base, absolute);
  return base;
}

function recommendService(a: WebsiteAuditResult): string | null {
  if (a.websiteStatus === 'missing' || a.websiteStatus === 'parked' || a.websiteStatus === 'unreachable') return 'website';
  if (a.scores.website >= 80) return a.scores.seo < 70 ? 'seo' : 'maintenance';
  if (a.signals.some((s) => s.key === 'not_mobile_responsive' || s.key === 'outdated_website')) return 'website_redesign';
  if (a.scores.conversion < 45) return 'conversion';
  if (a.scores.seo < 55) return 'seo';
  if (a.scores.accessibility < 55) return 'accessibility';
  return 'website_redesign';
}

function renderReport(a: WebsiteAuditResult, url: string | null): string {
  const lines: string[] = ['# Website Improvement Report', ''];
  lines.push(`**Site:** ${url ?? 'No website on record'}`);
  lines.push(`**Verified by live fetch:** ${a.verified ? 'yes' : 'no'}`);
  if (a.responseMs) lines.push(`**Response time:** ${(a.responseMs / 1000).toFixed(2)}s`);
  lines.push(`**Website score:** ${a.scores.website}/100`);
  lines.push('');
  lines.push('| Area | Score |');
  lines.push('| --- | --- |');
  for (const [k, v] of Object.entries(a.scores)) lines.push(`| ${k[0].toUpperCase() + k.slice(1)} | ${v} |`);
  lines.push('');
  lines.push('## Critical Issues');
  lines.push(a.criticalIssues.length ? a.criticalIssues.map((i) => `- ${i}`).join('\n') : '_None detected._');
  lines.push('');
  lines.push('## High-Impact Improvements');
  lines.push(a.highImpact.length ? a.highImpact.map((i) => `- ${i}`).join('\n') : '_None detected._');
  lines.push('');
  lines.push('## Nice-to-Have Improvements');
  lines.push(a.niceToHave.length ? a.niceToHave.map((i) => `- ${i}`).join('\n') : '_None detected._');
  lines.push('');
  lines.push('## Recommended Service');
  lines.push(a.recommendedService ? `**${a.recommendedService.replace(/_/g, ' ')}**` : '_No recommendation — insufficient data._');
  return lines.join('\n');
}

function emptyAudit(): WebsiteAuditResult {
  return {
    verified: false,
    websiteStatus: 'unknown',
    httpStatus: null,
    responseMs: 0,
    sslValid: null,
    sslIssuer: null,
    sslDaysRemaining: null,
    mobileResponsive: null,
    viewportMeta: null,
    pageCountEst: null,
    internalLinks: null,
    wordCount: null,
    title: null,
    metaDescription: null,
    metaDescLength: null,
    h1Count: null,
    h2Count: null,
    imageCount: null,
    imagesMissingAlt: null,
    formCount: null,
    ctaCount: null,
    hasBooking: false,
    hasEcommerce: false,
    hasLiveChat: false,
    hasSchemaMarkup: false,
    hasAnalytics: false,
    hasSitemap: false,
    hasRobots: false,
    canonicalPresent: null,
    ogTags: null,
    socialLinksFound: [],
    testimonialsFound: 0,
    servicePages: [],
    phoneFound: null,
    emailFound: null,
    langAttr: null,
    scores: { website: 0, seo: 0, accessibility: 0, performance: 0, conversion: 0, content: 0, branding: 0, trust: 0 },
    signals: [],
    criticalIssues: [],
    highImpact: [],
    niceToHave: [],
    recommendedService: null,
    improvementReport: '',
    error: null,
    fetchedAt: null,
    rawExcerpt: null,
  };
}

/** Quick reachability check used by the daily job before a full audit. */
export async function verifyWebsiteStatus(url: string | null | undefined): Promise<{
  status: 'live' | 'unreachable' | 'missing' | 'unknown';
  httpStatus: number | null;
  responseMs: number;
}> {
  if (!url) return { status: 'missing', httpStatus: null, responseMs: 0 };
  const absolute = url.startsWith('http') ? url : `https://${url}`;
  const verdict = await assertSafeUrl(absolute);
  if (!verdict.safe) {
    return { status: 'unreachable', httpStatus: null, responseMs: 0 };
  }
  const started = Date.now();
  const res = await httpText(absolute, { timeoutMs: 10_000, headers: { 'user-agent': 'AcquisitionOS-Verify/1.0' } });
  return {
    status: res.ok ? 'live' : res.status === 0 ? 'unreachable' : res.status >= 500 ? 'unreachable' : 'live',
    httpStatus: res.status,
    responseMs: Date.now() - started,
  };
}

/** Fetches robots.txt / sitemap presence — cheap extra SEO evidence. */
export async function probeSeoFiles(baseUrl: string): Promise<{ sitemap: boolean; robots: boolean }> {
  const origin = baseUrl.replace(/\/+$/, '');
  if (!(await assertSafeUrl(origin)).safe) return { sitemap: false, robots: false };
  const [sitemap, robots] = await Promise.all([
    httpText(`${origin}/sitemap.xml`, { timeoutMs: 6000 }),
    httpText(`${origin}/robots.txt`, { timeoutMs: 6000 }),
  ]);
  return { sitemap: sitemap.ok && sitemap.text.includes('<urlset'), robots: robots.ok && /user-agent/i.test(robots.text) };
}
