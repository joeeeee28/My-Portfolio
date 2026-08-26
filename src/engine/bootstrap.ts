/**
 * Workspace defaults: scoring profile, ICP, service packages, sequences and
 * automation jobs. Idempotent — safe to call on every boot.
 */
import { get, run, toJson } from '@/db';
import { id, nowIso } from '@/lib/id';
import { AI_TASKS, DEFAULT_WEIGHTS, SCORING_FACTORS } from '@/lib/domain';

export function ensureScoringProfile(orgId: string): string {
  const existing = get<{ id: string }>('SELECT id FROM scoring_profiles WHERE org_id = ? AND is_default = 1', [orgId]);
  if (existing) return existing.id;
  const profileId = id('scp');
  const now = nowIso();
  run(
    `INSERT INTO scoring_profiles (id, org_id, name, is_default, weights, custom_rules, priority_thresholds, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      profileId, orgId, 'Default opportunity model', 1, toJson(DEFAULT_WEIGHTS),
      toJson([
        {
          id: 'rule_no_site_strong_reviews',
          text: 'Prioritize businesses with no website, strong reviews, active social media and high service value.',
          when: { website_status: ['missing', 'unreachable', 'parked'], minRating: 4.3, minReviews: 20 },
          bonus: 12,
          enabled: true,
        },
        {
          id: 'rule_high_value_service',
          text: 'Give extra weight to industries where a single new customer is worth a lot (dental, legal, home services, real estate).',
          when: { industries: ['Health & Wellness', 'Professional Services', 'Home Services', 'Real Estate', 'Automotive'] },
          bonus: 6,
          enabled: true,
        },
        {
          id: 'rule_uncontactable_penalty',
          text: 'Deprioritise businesses with no reachable contact details — outreach cannot start.',
          when: { noContact: true },
          bonus: -10,
          enabled: true,
        },
      ]),
      toJson({ low: 0, medium: 45, high: 70, critical: 88 }),
      now, now,
    ]
  );
  return profileId;
}

export function ensureIcpProfile(orgId: string): string {
  const existing = get<{ id: string }>('SELECT id FROM icp_profiles WHERE org_id = ? AND is_active = 1 ORDER BY created_at ASC LIMIT 1', [orgId]);
  if (existing) return existing.id;
  const icpId = id('icp');
  const now = nowIso();
  run(
    `INSERT INTO icp_profiles (id, org_id, name, is_active, preferred_industries, excluded_industries, business_sizes,
        services, min_opportunity_score, excluded_businesses, preferred_packages, price_range_min, price_range_max,
        digital_problems, contact_requirements, learned_signals, created_at, updated_at)
     VALUES (?,?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      icpId, orgId, 'Default ICP', toJson([]), toJson([]), toJson(['1-10', '11-50']),
      toJson(['website', 'website_redesign', 'seo', 'social', 'conversion', 'maintenance']),
      55, toJson([]), toJson([]), 800, 15_000,
      toJson(['no_website', 'website_unreachable', 'not_mobile_responsive', 'missing_booking', 'missing_cta', 'inactive_social']),
      toJson({ requireEmail: false, requirePhone: false, requireDecisionMaker: false }),
      toJson({}), now, now,
    ]
  );
  return icpId;
}

interface PackageSeed {
  name: string;
  tier: string;
  summary: string;
  oneTime: number;
  monthly: number;
  includes: string[];
  deliverables: string[];
  weeks: number;
  signals: string[];
}

const PACKAGES: PackageSeed[] = [
  {
    name: 'Website Starter',
    tier: 'starter',
    summary: 'A focused site plus hosting — the fastest route from invisible to findable.',
    oneTime: 1450,
    monthly: 39,
    includes: ['5-page responsive website', 'Mobile-first design', 'Contact & enquiry form', 'SSL + hosting', 'Basic on-page SEO', 'Google Business Profile alignment'],
    deliverables: ['Homepage', 'About', 'Services', 'Contact', 'Thank-you page', 'Analytics setup'],
    weeks: 3,
    signals: ['no_website', 'website_unreachable', 'website_broken', 'missing_cta', 'no_contact_form'],
  },
  {
    name: 'Website Growth',
    tier: 'growth',
    summary: 'A conversion-focused site with ongoing SEO and maintenance.',
    oneTime: 2900,
    monthly: 149,
    includes: ['Up to 10 pages', 'Conversion-focused copy', 'Online booking or quote flow', 'Local SEO setup', 'Schema markup', 'Monthly maintenance', 'Speed optimisation'],
    deliverables: ['Homepage', 'About', 'Service pages (up to 5)', 'Booking/quote flow', 'Testimonials', 'Blog foundation', 'Analytics + search console'],
    weeks: 5,
    signals: ['not_mobile_responsive', 'outdated_website', 'missing_booking', 'weak_seo', 'slow_website', 'poor_information_architecture'],
  },
  {
    name: 'Digital Presence',
    tier: 'standard',
    summary: 'Website plus managed social so the business shows up consistently everywhere.',
    oneTime: 2400,
    monthly: 249,
    includes: ['5-page website', '2 managed social channels', '12 posts per month', 'Content calendar', 'Profile optimisation', 'Monthly reporting'],
    deliverables: ['Website', 'Social profiles optimised', 'Content calendar', '12 monthly posts', 'Monthly performance report'],
    weeks: 4,
    signals: ['no_social', 'single_platform', 'inactive_social', 'low_posting_frequency', 'no_social_cta'],
  },
  {
    name: 'Growth Package',
    tier: 'premium',
    summary: 'Website, SEO, social and content working together — for businesses ready to compete.',
    oneTime: 4800,
    monthly: 549,
    includes: ['Up to 15 pages', 'Technical + local SEO', '3 managed social channels', '20 posts per month', '4 blog articles per month', 'Conversion tracking', 'Quarterly strategy review'],
    deliverables: ['Website', 'SEO implementation', 'Social management', 'Monthly content', 'Conversion tracking', 'Quarterly review'],
    weeks: 7,
    signals: ['competitor_digital_advantage', 'strong_reviews_weak_website', 'strong_reputation_weak_conversion', 'weak_seo', 'weak_content'],
  },
  {
    name: 'Conversion Rescue',
    tier: 'standard',
    summary: 'Keep the site, fix the leak — rebuild the pages that are losing enquiries.',
    oneTime: 1800,
    monthly: 99,
    includes: ['Homepage rebuild', 'CTA and form redesign', 'Booking integration', 'Speed fixes', 'Trust section', 'A/B test setup'],
    deliverables: ['Rebuilt homepage', 'New CTA system', 'Booking flow', 'Trust/testimonial section', 'Test configuration'],
    weeks: 3,
    signals: ['missing_cta', 'no_contact_form', 'missing_booking', 'no_testimonials', 'slow_website'],
  },
  {
    name: 'SEO & Content',
    tier: 'standard',
    summary: 'Rank for the searches that already have buying intent.',
    oneTime: 950,
    monthly: 349,
    includes: ['Technical SEO audit + fixes', 'Local SEO', 'Keyword map', '4 articles per month', 'Internal linking', 'Monthly reporting'],
    deliverables: ['SEO audit', 'Implementation', 'Keyword map', 'Monthly content', 'Monthly report'],
    weeks: 4,
    signals: ['weak_seo', 'missing_metadata', 'weak_content', 'no_testimonials'],
  },
  {
    name: 'Care Plan',
    tier: 'retainer',
    summary: 'Ongoing hosting, updates, security and small changes — so the site never rots.',
    oneTime: 0,
    monthly: 79,
    includes: ['Managed hosting', 'Security updates', 'Backups', 'Uptime monitoring', '2 content edits per month', 'Priority support'],
    deliverables: ['Monthly maintenance report', 'Backups', 'Uptime monitoring', 'Content edits'],
    weeks: 1,
    signals: ['no_ssl', 'slow_website'],
  },
];

export function ensurePackages(orgId: string): void {
  const count = get<{ c: number }>('SELECT COUNT(*) c FROM service_packages WHERE org_id = ?', [orgId])?.c ?? 0;
  if (count > 0) return;
  const now = nowIso();
  for (const p of PACKAGES) {
    run(
      `INSERT INTO service_packages (id, org_id, name, tier, summary, one_time_price, monthly_price, includes,
          deliverables, timeline_weeks, targets_signals, currency, is_active, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,'USD',1,?,?)`,
      [
        id('pkg'), orgId, p.name, p.tier, p.summary, p.oneTime, p.monthly, toJson(p.includes),
        toJson(p.deliverables), p.weeks, toJson(p.signals), now, now,
      ]
    );
  }
}

interface StepSeed {
  day: number;
  channel: string;
  purpose: string;
  tone: string;
  includeMockup: boolean;
  includeValue: string | null;
}

const DEFAULT_SEQUENCE_STEPS: StepSeed[] = [
  { day: 0, channel: 'email', purpose: 'intro', tone: 'professional', includeMockup: false, includeValue: null },
  { day: 2, channel: 'email', purpose: 'followup', tone: 'friendly', includeMockup: false, includeValue: null },
  { day: 5, channel: 'email', purpose: 'value', tone: 'value_first', includeMockup: false, includeValue: 'A specific, measurable improvement relevant to their audit — not a sales claim.' },
  { day: 8, channel: 'email', purpose: 'mockup', tone: 'consultative', includeMockup: true, includeValue: null },
  { day: 12, channel: 'email', purpose: 'final', tone: 'direct', includeMockup: false, includeValue: null },
];

export function ensureDefaultSequences(orgId: string): string {
  const existing = get<{ id: string }>('SELECT id FROM sequences WHERE org_id = ? AND is_default = 1', [orgId]);
  if (existing) return existing.id;
  const now = nowIso();
  const seqId = id('seq');
  run(
    `INSERT INTO sequences (id, org_id, name, description, goal, approval_mode, daily_send_limit, domain_daily_limit,
        quiet_hours_start, quiet_hours_end, timezone, stop_on_response, stop_on_optout, stop_on_client,
        stop_on_not_interested, max_touches, is_active, is_default, stats, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,1,'{}',?,?)`,
    [
      seqId, orgId, 'Standard 5-touch acquisition',
      'Introduce, follow up, add value, offer a mockup, then close the loop. Stops the moment they respond, opt out or become a client.',
      'Book a discovery call', 'assisted', 50, 30, '20:00', '08:00', 'UTC',
      1, 1, 1, 1, 5, now, now,
    ]
  );
  let position = 0;
  for (const step of DEFAULT_SEQUENCE_STEPS) {
    run(
      `INSERT INTO sequence_steps (id, sequence_id, position, day_offset, channel, purpose, tone, subject, body,
          template_id, include_mockup, include_value, enabled, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,NULL,?,?,1,?)`,
      [
        id('stp'), seqId, position++, step.day, step.channel, step.purpose, step.tone, null, null,
        step.includeMockup ? 1 : 0, step.includeValue, now,
      ]
    );
  }

  // A shorter, call-led variant for high-intent prospects.
  const hotId = id('seq');
  run(
    `INSERT INTO sequences (id, org_id, name, description, goal, approval_mode, daily_send_limit, domain_daily_limit,
        quiet_hours_start, quiet_hours_end, timezone, stop_on_response, stop_on_optout, stop_on_client,
        stop_on_not_interested, max_touches, is_active, is_default, stats, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,0,'{}',?,?)`,
    [
      hotId, orgId, 'Hot lead — call first',
      'For prospects who viewed a mockup or replied. Leads with a call task, then a written recap.',
      'Hold the call', 'assisted', 30, 20, '20:00', '08:00', 'UTC',
      1, 1, 1, 1, 3, now, now,
    ]
  );
  const hotSteps: StepSeed[] = [
    { day: 0, channel: 'phone', purpose: 'intro', tone: 'consultative', includeMockup: false, includeValue: null },
    { day: 1, channel: 'email', purpose: 'followup', tone: 'friendly', includeMockup: true, includeValue: null },
    { day: 4, channel: 'email', purpose: 'final', tone: 'direct', includeMockup: false, includeValue: null },
  ];
  position = 0;
  for (const step of hotSteps) {
    run(
      `INSERT INTO sequence_steps (id, sequence_id, position, day_offset, channel, purpose, tone, subject, body,
          template_id, include_mockup, include_value, enabled, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,NULL,?,?,1,?)`,
      [
        id('stp'), hotId, position++, step.day, step.channel, step.purpose, step.tone, null, null,
        step.includeMockup ? 1 : 0, step.includeValue, now,
      ]
    );
  }
  return seqId;
}

const AUTOMATION_JOBS = [
  { key: 'daily_discovery', label: 'Daily Discovery', cron: '0 2 * * *', schedule: 'daily', enabled: 1 },
  { key: 'sequence_dispatch', label: 'Sequence Dispatch', cron: '*/15 * * * *', schedule: 'custom', enabled: 1 },
  { key: 'followup_sweep', label: 'Follow-up Sweep', cron: '30 7 * * *', schedule: 'daily', enabled: 1 },
  { key: 'analytics_rollup', label: 'Analytics Rollup', cron: '0 6 * * *', schedule: 'daily', enabled: 1 },
  { key: 'upsell_scan', label: 'Upsell Scan', cron: '0 9 * * 1', schedule: 'weekly', enabled: 1 },
  { key: 'reverify_sweep', label: 'Website Re-verification', cron: '0 3 * * 0', schedule: 'weekly', enabled: 1 },
];

export function ensureAutomationJobs(orgId: string): void {
  const now = nowIso();
  for (const job of AUTOMATION_JOBS) {
    const existing = get<{ id: string }>('SELECT id FROM automation_jobs WHERE org_id = ? AND key = ?', [orgId, job.key]);
    if (!existing) {
      run(
        `INSERT INTO automation_jobs (id, org_id, key, label, enabled, schedule, cron, timezone, runs_total,
            runs_failed, avg_duration_ms, config, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,0,0,0,'{}',?,?)`,
        [id('job'), orgId, job.key, job.label, job.enabled, job.schedule, job.cron, 'UTC', now, now]
      );
    }
  }
}

export function ensureAiTaskRoutes(orgId: string): void {
  const now = nowIso();
  for (const task of AI_TASKS) {
    const existing = get<{ id: string }>('SELECT id FROM ai_task_routes WHERE org_id = ? AND task = ?', [orgId, task.key]);
    if (!existing) {
      run(
        `INSERT INTO ai_task_routes (id, org_id, task, label, preferred_model_id, fallback_model_ids, priority, override, created_at, updated_at)
         VALUES (?,?,?,?,NULL,'[]',?,0,?,?)`,
        [id('rte'), orgId, task.key, task.label, task.priority, now, now]
      );
    }
  }
}

export function factorLabels(): Record<string, string> {
  return Object.fromEntries(SCORING_FACTORS.map((f) => [f.key, f.label]));
}

export function ensureExperiments(orgId: string): void {
  const count = get<{ c: number }>('SELECT COUNT(*) c FROM experiments WHERE org_id = ?', [orgId])?.c ?? 0;
  if (count > 0) return;
  const now = nowIso();
  const seeds = [
    {
      name: 'Subject line: problem-led vs mockup-led',
      hypothesis: 'Leading with the specific problem found in the audit will outperform leading with the mockup offer on reply rate.',
      target: 'subject_line',
      metric: 'reply_rate',
      split: { A: 50, B: 50 },
      variants: [
        { key: 'A', label: 'Problem-led', payload: { style: 'problem_first' } },
        { key: 'B', label: 'Mockup-led', payload: { style: 'mockup_first' } },
      ],
    },
    {
      name: 'Tone: consultative vs direct',
      hypothesis: 'A consultative tone will produce more calls; a direct tone will produce faster decisions.',
      target: 'message_style',
      metric: 'call_rate',
      split: { A: 50, B: 50 },
      variants: [
        { key: 'A', label: 'Consultative', payload: { tone: 'consultative' } },
        { key: 'B', label: 'Direct', payload: { tone: 'direct' } },
      ],
    },
    {
      name: 'Mockup style: editorial vs minimal',
      hypothesis: 'An editorial design direction will hold attention longer and drive more views per prospect.',
      target: 'mockup_style',
      metric: 'view_depth',
      split: { A: 50, B: 50 },
      variants: [
        { key: 'A', label: 'Editorial', payload: { direction: 'editorial' } },
        { key: 'B', label: 'Minimal', payload: { direction: 'minimal' } },
      ],
    },
  ];
  for (const s of seeds) {
    const expId = id('exp');
    run(
      `INSERT INTO experiments (id, org_id, name, hypothesis, target, metric, status, split, started_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?, 'running', ?,?,?,?)`,
      [expId, orgId, s.name, s.hypothesis, s.target, s.metric, toJson(s.split), now, now, now]
    );
    for (const v of s.variants) {
      run(
        `INSERT INTO experiment_variants (id, experiment_id, variant_key, label, payload, impressions, conversions, secondary, revenue, created_at)
         VALUES (?,?,?,?,?,0,0,0,0,?)`,
        [id('var'), expId, v.key, v.label, toJson(v.payload), now]
      );
    }
  }
}
