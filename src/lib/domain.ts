/** Canonical domain vocabulary. Every stage/status used across the platform lives here. */

// ── Pipeline (§26) ───────────────────────────────────────────
export const PIPELINE_STAGES = [
  'discovered',
  'qualified',
  'outreach_ready',
  'outreach_sent',
  'engaged',
  'interested',
  'mockup_generated',
  'mockup_shared',
  'mockup_viewed',
  'call_scheduled',
  'call_completed',
  'proposal_sent',
  'negotiation',
  'won',
  'onboarding',
  'delivery',
  'active_client',
  'expansion',
  'lost',
] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export const STAGE_LABELS: Record<PipelineStage, string> = {
  discovered: 'Discovered',
  qualified: 'Qualified',
  outreach_ready: 'Outreach Ready',
  outreach_sent: 'Outreach Sent',
  engaged: 'Engaged',
  interested: 'Interested',
  mockup_generated: 'Mockup Generated',
  mockup_shared: 'Mockup Shared',
  mockup_viewed: 'Mockup Viewed',
  call_scheduled: 'Call Scheduled',
  call_completed: 'Call Completed',
  proposal_sent: 'Proposal Sent',
  negotiation: 'Negotiation',
  won: 'Won',
  onboarding: 'Onboarding',
  delivery: 'Delivery',
  active_client: 'Active Client',
  expansion: 'Expansion',
  lost: 'Lost',
};

/** Numeric order so stage transitions can be validated and funnel maths computed. */
export const STAGE_ORDER: Record<PipelineStage, number> = PIPELINE_STAGES.reduce(
  (acc, s, i) => ({ ...acc, [s]: i }),
  {} as Record<PipelineStage, number>
);

/** Stages that mean the relationship is over (no further outreach). */
export const TERMINAL_STAGES: PipelineStage[] = ['won', 'onboarding', 'delivery', 'active_client', 'expansion', 'lost'];

export const FUNNEL_STEPS: { key: PipelineStage[]; label: string }[] = [
  { key: ['discovered', 'qualified', 'outreach_ready'], label: 'Discovery' },
  { key: ['qualified', 'outreach_ready'], label: 'Qualification' },
  { key: ['outreach_sent', 'engaged'], label: 'Outreach' },
  { key: ['engaged', 'interested'], label: 'Response' },
  { key: ['mockup_generated', 'mockup_shared', 'mockup_viewed'], label: 'Mockup' },
  { key: ['call_scheduled', 'call_completed'], label: 'Call' },
  { key: ['proposal_sent', 'negotiation'], label: 'Proposal' },
  { key: ['won', 'onboarding', 'delivery', 'active_client', 'expansion'], label: 'Won' },
];

// ── Priorities (§6) ──────────────────────────────────────────
export const PRIORITIES = ['low', 'medium', 'high', 'critical'] as const;
export type Priority = (typeof PRIORITIES)[number];

export function priorityFromScore(score: number, thresholds: Partial<Record<Priority, number>> = {}): Priority {
  const t = { low: 0, medium: thresholds.medium ?? 45, high: thresholds.high ?? 70, critical: thresholds.critical ?? 88 };
  if (score >= t.critical) return 'critical';
  if (score >= t.high) return 'high';
  if (score >= t.medium) return 'medium';
  return 'low';
}

// ── Project delivery stages (§33) ────────────────────────────
export const PROJECT_STAGES = [
  'onboarding',
  'requirements',
  'design',
  'development',
  'content',
  'testing',
  'client_review',
  'revisions',
  'approval',
  'deployment',
  'handover',
  'complete',
] as const;
export type ProjectStage = (typeof PROJECT_STAGES)[number];

export const PROJECT_STAGE_LABELS: Record<ProjectStage, string> = {
  onboarding: 'Onboarding',
  requirements: 'Requirements',
  design: 'Design',
  development: 'Development',
  content: 'Content',
  testing: 'Testing',
  client_review: 'Client Review',
  revisions: 'Revisions',
  approval: 'Approval',
  deployment: 'Deployment',
  handover: 'Handover',
  complete: 'Complete',
};

export const PROJECT_STAGE_PROGRESS: Record<ProjectStage, number> = {
  onboarding: 5,
  requirements: 12,
  design: 28,
  development: 48,
  content: 62,
  testing: 74,
  client_review: 82,
  revisions: 88,
  approval: 93,
  deployment: 97,
  handover: 99,
  complete: 100,
};

// ── Channels (§16) ───────────────────────────────────────────
export const CHANNELS = ['email', 'sms', 'whatsapp', 'linkedin', 'phone', 'custom'] as const;
export type Channel = (typeof CHANNELS)[number];
export const CHANNEL_LABELS: Record<Channel, string> = {
  email: 'Email',
  sms: 'SMS',
  whatsapp: 'WhatsApp',
  linkedin: 'LinkedIn',
  phone: 'Phone',
  custom: 'Custom',
};

// ── Tones (§16) ──────────────────────────────────────────────
export const TONES = ['friendly', 'professional', 'direct', 'value_first', 'consultative'] as const;
export type Tone = (typeof TONES)[number];
export const TONE_LABELS: Record<Tone, string> = {
  friendly: 'Friendly',
  professional: 'Professional',
  direct: 'Direct',
  value_first: 'Value-first',
  consultative: 'Consultative',
};

// ── Approval modes (§18) ─────────────────────────────────────
export const APPROVAL_MODES = ['manual', 'assisted', 'autonomous'] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];
export const APPROVAL_MODE_LABELS: Record<ApprovalMode, string> = {
  manual: 'Manual — AI drafts only',
  assisted: 'Assisted — AI drafts, you approve',
  autonomous: 'Autonomous — AI sends within limits',
};

// ── Message statuses (§19) ───────────────────────────────────
export const MESSAGE_STATUSES = [
  'draft',
  'queued',
  'approved',
  'sending',
  'sent',
  'delivered',
  'opened',
  'clicked',
  'replied',
  'bounced',
  'failed',
  'opted_out',
  'skipped',
] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

// ── Opportunity signal catalogue (§5) ────────────────────────
export const WEBSITE_SIGNALS = [
  { key: 'no_website', label: 'No website', weight: 1.0, service: 'website' },
  { key: 'website_unreachable', label: 'Website unreachable', weight: 0.95, service: 'website' },
  { key: 'website_broken', label: 'Broken website', weight: 0.9, service: 'website' },
  { key: 'no_ssl', label: 'No valid SSL certificate', weight: 0.7, service: 'website' },
  { key: 'not_mobile_responsive', label: 'Poor mobile experience', weight: 0.8, service: 'website' },
  { key: 'outdated_website', label: 'Outdated website', weight: 0.65, service: 'website_redesign' },
  { key: 'missing_cta', label: 'No clear call to action', weight: 0.6, service: 'conversion' },
  { key: 'missing_booking', label: 'No booking or enquiry system', weight: 0.75, service: 'website' },
  { key: 'no_contact_form', label: 'No contact form', weight: 0.55, service: 'conversion' },
  { key: 'weak_seo', label: 'Weak on-page SEO', weight: 0.6, service: 'seo' },
  { key: 'missing_metadata', label: 'Missing title or meta description', weight: 0.5, service: 'seo' },
  { key: 'poor_accessibility', label: 'Accessibility gaps', weight: 0.4, service: 'accessibility' },
  { key: 'weak_content', label: 'Thin or weak content', weight: 0.45, service: 'content' },
  { key: 'weak_branding', label: 'Weak visual branding', weight: 0.5, service: 'branding' },
  { key: 'slow_website', label: 'Slow page performance', weight: 0.5, service: 'performance' },
  { key: 'poor_information_architecture', label: 'Confusing navigation', weight: 0.45, service: 'website_redesign' },
  { key: 'no_testimonials', label: 'No social proof on site', weight: 0.4, service: 'conversion' },
] as const;

export const SOCIAL_SIGNALS = [
  { key: 'no_social', label: 'No social presence', weight: 1.0, service: 'social' },
  { key: 'single_platform', label: 'Only one platform', weight: 0.5, service: 'social' },
  { key: 'inactive_social', label: 'Inactive social account', weight: 0.85, service: 'social' },
  { key: 'low_posting_frequency', label: 'Low posting frequency', weight: 0.6, service: 'social' },
  { key: 'incomplete_profile', label: 'Incomplete profile', weight: 0.45, service: 'social' },
  { key: 'no_social_cta', label: 'No call to action in profile', weight: 0.4, service: 'social' },
  { key: 'no_contact_in_bio', label: 'No contact details in bio', weight: 0.4, service: 'social' },
  { key: 'weak_visual_consistency', label: 'Inconsistent visual branding', weight: 0.5, service: 'branding' },
] as const;

export const GROWTH_SIGNALS = [
  { key: 'strong_reviews_weak_website', label: 'Strong reviews, weak website', weight: 1.0 },
  { key: 'high_review_volume', label: 'High review volume', weight: 0.7 },
  { key: 'high_rating', label: 'Excellent public rating', weight: 0.6 },
  { key: 'active_social', label: 'Active social engagement', weight: 0.6 },
  { key: 'new_business', label: 'Newly established business', weight: 0.7 },
  { key: 'hiring', label: 'Hiring activity', weight: 0.6 },
  { key: 'new_location', label: 'New location', weight: 0.7 },
  { key: 'new_service', label: 'New service launched', weight: 0.6 },
  { key: 'competitor_digital_advantage', label: 'Competitors are digitally ahead', weight: 0.8 },
  { key: 'strong_reputation_weak_conversion', label: 'Strong reputation, weak conversion path', weight: 0.9 },
] as const;

export type SignalKey =
  | (typeof WEBSITE_SIGNALS)[number]['key']
  | (typeof SOCIAL_SIGNALS)[number]['key']
  | (typeof GROWTH_SIGNALS)[number]['key'];

export const SIGNAL_LABELS: Record<string, string> = Object.fromEntries(
  [...WEBSITE_SIGNALS, ...SOCIAL_SIGNALS, ...GROWTH_SIGNALS].map((s) => [s.key, s.label])
);
export const SIGNAL_WEIGHTS: Record<string, number> = Object.fromEntries(
  [...WEBSITE_SIGNALS, ...SOCIAL_SIGNALS, ...GROWTH_SIGNALS].map((s) => [s.key, s.weight])
);
export const SIGNAL_SERVICE: Record<string, string> = Object.fromEntries(
  [...WEBSITE_SIGNALS, ...SOCIAL_SIGNALS].map((s) => [s.key, s.service])
);

// ── Scoring factors (§13) ────────────────────────────────────
export const SCORING_FACTORS = [
  { key: 'website_opportunity', label: 'Website Opportunity', defaultWeight: 0.25 },
  { key: 'social_opportunity', label: 'Social Opportunity', defaultWeight: 0.2 },
  { key: 'business_quality', label: 'Business Quality', defaultWeight: 0.15 },
  { key: 'digital_gap', label: 'Digital Gap', defaultWeight: 0.15 },
  { key: 'growth_signals', label: 'Growth Signals', defaultWeight: 0.1 },
  { key: 'contactability', label: 'Contactability', defaultWeight: 0.05 },
  { key: 'competitive_gap', label: 'Competitive Gap', defaultWeight: 0.05 },
  { key: 'service_fit', label: 'Service Fit', defaultWeight: 0.05 },
] as const;
export type ScoringFactorKey = (typeof SCORING_FACTORS)[number]['key'];

export const DEFAULT_WEIGHTS: Record<ScoringFactorKey, number> = Object.fromEntries(
  SCORING_FACTORS.map((f) => [f.key, f.defaultWeight])
) as Record<ScoringFactorKey, number>;

// ── AI task categories (§43) ─────────────────────────────────
export const AI_TASKS = [
  { key: 'web_research', label: 'Web research', minTier: 'strong', priority: 'quality' },
  { key: 'classification', label: 'Classification', minTier: 'nano', priority: 'cost' },
  { key: 'lead_scoring', label: 'Lead scoring', minTier: 'standard', priority: 'balanced' },
  { key: 'summarization', label: 'Summarization', minTier: 'standard', priority: 'balanced' },
  { key: 'outreach', label: 'Outreach generation', minTier: 'strong', priority: 'quality' },
  { key: 'website_copy', label: 'Website copy', minTier: 'strong', priority: 'quality' },
  { key: 'website_design', label: 'Website design planning', minTier: 'standard', priority: 'balanced' },
  { key: 'image_generation', label: 'Image generation', minTier: 'image', priority: 'quality' },
  { key: 'call_summary', label: 'Call summarization', minTier: 'standard', priority: 'balanced' },
  { key: 'proposal', label: 'Proposal generation', minTier: 'strong', priority: 'quality' },
  { key: 'command', label: 'Command center', minTier: 'standard', priority: 'speed' },
  { key: 'social_content', label: 'Social content', minTier: 'standard', priority: 'balanced' },
] as const;
export type AiTaskKey = (typeof AI_TASKS)[number]['key'];

export const AI_TASK_LABELS: Record<string, string> = Object.fromEntries(AI_TASKS.map((t) => [t.key, t.label]));

// ── Roles & permissions (§69) ────────────────────────────────
export const ROLES = ['owner', 'admin', 'sales', 'designer', 'developer', 'social_manager', 'client'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  owner: 'Owner',
  admin: 'Admin',
  sales: 'Sales',
  designer: 'Designer',
  developer: 'Developer',
  social_manager: 'Social Manager',
  client: 'Client',
};

/** Capability matrix. Checked by `can()` in src/lib/auth.ts. */
export const ROLE_PERMISSIONS: Record<Role, string[]> = {
  owner: ['*'],
  admin: ['*'],
  sales: [
    'prospects.read',
    'prospects.write',
    'outreach.draft',
    'outreach.send',
    'calls.write',
    'proposals.write',
    'mockups.read',
    'analytics.read',
    'clients.read',
  ],
  designer: ['prospects.read', 'mockups.read', 'mockups.write', 'websites.write', 'projects.write', 'social.write'],
  developer: ['prospects.read', 'websites.write', 'deployments.write', 'projects.write'],
  social_manager: ['clients.read', 'social.write', 'social.publish', 'projects.read'],
  client: ['portal.read'],
};

export function can(role: Role, capability: string): boolean {
  const perms = ROLE_PERMISSIONS[role] ?? [];
  return perms.includes('*') || perms.includes(capability);
}

// ── Smart queues (§63) ───────────────────────────────────────
export const SMART_QUEUES = [
  { key: 'best_opportunities', label: 'Best Opportunities' },
  { key: 'no_website', label: 'No Website' },
  { key: 'website_needs_work', label: 'Website Needs Improvement' },
  { key: 'social_opportunity', label: 'Social Opportunity' },
  { key: 'needs_contact', label: 'Needs Contact' },
  { key: 'ready_for_outreach', label: 'Ready for Outreach' },
  { key: 'follow_up_today', label: 'Follow-up Today' },
  { key: 'hot_leads', label: 'Hot Leads' },
  { key: 'mockup_ready', label: 'Mockup Ready' },
  { key: 'mockup_viewed', label: 'Mockup Viewed' },
  { key: 'call_ready', label: 'Call Ready' },
  { key: 'proposal_followup', label: 'Proposal Follow-up' },
  { key: 'closing_soon', label: 'Closing Soon' },
  { key: 'upsell_opportunities', label: 'Upsell Opportunities' },
  { key: 'delivery_risks', label: 'Delivery Risks' },
] as const;
export type QueueKey = (typeof SMART_QUEUES)[number]['key'];

// ── Next best actions (§15) ──────────────────────────────────
export const NEXT_ACTIONS = [
  'research_business',
  'enrich_contact',
  'send_first_outreach',
  'follow_up',
  'generate_mockup',
  'share_mockup',
  'schedule_call',
  'send_proposal',
  'close_deal',
  'stop_outreach',
  'deliver_project',
  'request_approval',
  'upsell',
  'review_audit',
] as const;
export type NextAction = (typeof NEXT_ACTIONS)[number];

export const NEXT_ACTION_LABELS: Record<NextAction, string> = {
  research_business: 'Research business',
  enrich_contact: 'Enrich contact',
  send_first_outreach: 'Send first outreach',
  follow_up: 'Follow up',
  generate_mockup: 'Generate mockup',
  share_mockup: 'Share mockup',
  schedule_call: 'Schedule call',
  send_proposal: 'Send proposal',
  close_deal: 'Close deal',
  stop_outreach: 'Stop outreach',
  deliver_project: 'Deliver project',
  request_approval: 'Request approval',
  upsell: 'Pitch an upsell',
  review_audit: 'Review audit',
};

// ── Website statuses ─────────────────────────────────────────
export const WEBSITE_STATUSES = ['live', 'unreachable', 'insecure', 'parked', 'missing', 'unknown'] as const;
export type WebsiteStatus = (typeof WEBSITE_STATUSES)[number];
