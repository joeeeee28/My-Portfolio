/**
 * ClientForge AI — brand and product language.
 *
 * Single source of truth for naming. Every surface reads from here so the
 * product speaks one language: Prospect, not Lead. Opportunity Score, not
 * Lead Score. Website Concept, not "AI website".
 */

export const BRAND = {
  name: 'ClientForge AI',
  /** The wordmark renders `ClientForge` dominant with `AI` visually secondary. */
  markPrimary: 'ClientForge',
  markSecondary: 'AI',
  tagline: 'Discover. Personalize. Convert. Deliver.',
  promise:
    'ClientForge AI finds the right businesses, understands what they need, helps you win them, and helps you deliver the work.',
  description:
    'ClientForge AI is an autonomous client acquisition and digital agency operating system that discovers high-opportunity businesses, understands their digital gaps, creates personalized sales assets, manages outreach and follow-ups, converts prospects into clients, and manages delivery and growth from one centralized platform.',
  assistant: 'Forge AI',
  automation: 'Forge Automation',
  conceptLabel: 'Website Concept',
  conceptLabelPlural: 'Website Concepts',
  workspaceLabel: 'Business Workspace',
  queueLabel: 'Action Queue',
  scoreLabel: 'Opportunity Score',
} as const;

/** The seven brand pillars (§ brand pillars) — the conceptual spine of the product. */
export const PILLARS = [
  { key: 'discover', label: 'Discover', summary: 'Find businesses with a real digital-service opportunity.' },
  { key: 'intelligence', label: 'Intelligence', summary: 'Understand the business, its site, its social presence and its gaps.' },
  { key: 'engage', label: 'Engage', summary: 'Personalized outreach and intelligent follow-up.' },
  { key: 'create', label: 'Create', summary: 'Turn the opportunity into a sales asset they can see.' },
  { key: 'convert', label: 'Convert', summary: 'Manage the conversation through to a signed client.' },
  { key: 'deliver', label: 'Deliver', summary: 'Turn the win into a delivered project.' },
  { key: 'grow', label: 'Grow', summary: 'Retain, expand and find the next opportunity.' },
] as const;

export type PillarKey = (typeof PILLARS)[number]['key'];

/** Product loop — the lifecycle the UI communicates visually. */
export const PRODUCT_LOOP: { key: PillarKey; label: string }[] = [
  ...PILLARS.map((p) => ({ key: p.key, label: p.label })),
  { key: 'discover', label: 'Discover more' },
];

/**
 * Product terminology. Applied at the presentation layer so internal keys stay
 * stable while every user-facing string speaks ClientForge.
 */
export const TERMS = {
  lead: 'Prospect',
  leads: 'Prospects',
  leadScore: 'Opportunity Score',
  leadDatabase: 'Prospect Hub',
  leadResearch: 'Business Intelligence',
  leadGeneration: 'Business Discovery',
  crmRecord: 'Business Workspace',
  emailCampaign: 'Outreach Sequence',
  salesActivity: 'Engagement',
  websiteProposal: 'Website Concept',
  websiteDemo: 'Mockup',
  customer: 'Client',
  crmPipeline: 'Client Pipeline',
  automation: 'Forge Automation',
  aiAssistant: 'Forge AI',
  taskQueue: 'Action Queue',
  leadQualification: 'Opportunity Qualification',
  leadConversion: 'Client Conversion',
  upsell: 'Growth Opportunity',
  upsells: 'Growth Opportunities',
} as const;

/** Client Pipeline (§ ClientForge Pipeline). */
export const PIPELINE = [
  { key: 'discovered', label: 'Discovered', pillar: 'discover' },
  { key: 'qualified', label: 'Qualified', pillar: 'discover' },
  { key: 'outreach_sent', label: 'Outreach', pillar: 'engage' },
  { key: 'engaged', label: 'Engaged', pillar: 'engage' },
  { key: 'interested', label: 'Interested', pillar: 'engage' },
  { key: 'mockup_generated', label: 'Mockup', pillar: 'create' },
  { key: 'call_scheduled', label: 'Call', pillar: 'convert' },
  { key: 'proposal_sent', label: 'Proposal', pillar: 'convert' },
  { key: 'negotiation', label: 'Negotiation', pillar: 'convert' },
  { key: 'won', label: 'Won', pillar: 'convert' },
  { key: 'onboarding', label: 'Onboarding', pillar: 'deliver' },
  { key: 'delivery', label: 'Delivery', pillar: 'deliver' },
  { key: 'active_client', label: 'Active Client', pillar: 'deliver' },
  { key: 'expansion', label: 'Growth', pillar: 'grow' },
] as const;

export type PipelineKey = (typeof PIPELINE)[number]['key'];

export const PIPELINE_LABELS: Record<string, string> = Object.fromEntries(PIPELINE.map((p) => [p.key, p.label]));

/** Maps the internal stage vocabulary onto the ClientForge pipeline column. */
export const STAGE_TO_PIPELINE: Record<string, PipelineKey> = {
  discovered: 'discovered',
  qualified: 'qualified',
  outreach_ready: 'qualified',
  outreach_sent: 'outreach_sent',
  engaged: 'engaged',
  interested: 'interested',
  mockup_generated: 'mockup_generated',
  mockup_shared: 'mockup_generated',
  mockup_viewed: 'mockup_generated',
  call_scheduled: 'call_scheduled',
  call_completed: 'call_scheduled',
  proposal_sent: 'proposal_sent',
  negotiation: 'negotiation',
  won: 'won',
  onboarding: 'onboarding',
  delivery: 'delivery',
  active_client: 'active_client',
  expansion: 'expansion',
  lost: 'negotiation',
};

/** Opportunity Score banding language. */
export function scoreBand(score: number): { label: string; tone: 'critical' | 'high' | 'medium' | 'low' } {
  if (score >= 88) return { label: 'Critical Opportunity', tone: 'critical' };
  if (score >= 70) return { label: 'High Opportunity', tone: 'high' };
  if (score >= 45) return { label: 'Medium Opportunity', tone: 'medium' };
  return { label: 'Low Opportunity', tone: 'low' };
}

/**
 * Brand-voice rewrites (§ brand voice). Applied to human-facing copy so the
 * product never says "AI generated 200 leads".
 */
export const VOICE: Record<string, string> = {
  leadsGenerated: 'opportunities identified',
  sendEmails: 'Start outreach',
  leadScore: 'Opportunity Score',
  crmRecord: 'Business Workspace',
  aiWebsite: 'Website Concept',
  leads: 'prospects',
};

export function brandVoice(template: string, vars: Record<string, string | number> = {}): string {
  let out = template;
  for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{${k}}`, String(v));
  return out;
}

/**
 * Service catalogue is intentionally open-ended: the platform is service-agnostic
 * so it can expand past website + social without architectural change.
 */
export const SERVICE_CATALOGUE = [
  { key: 'website', label: 'Website Development', core: true },
  { key: 'social', label: 'Social Media Management', core: true },
  { key: 'seo', label: 'SEO', core: false },
  { key: 'content', label: 'Content Marketing', core: false },
  { key: 'branding', label: 'Branding', core: false },
  { key: 'landing_page', label: 'Landing Pages', core: false },
  { key: 'ads', label: 'Paid Advertising', core: false },
  { key: 'marketing_automation', label: 'Marketing Automation', core: false },
  { key: 'crm_implementation', label: 'CRM Implementation', core: false },
  { key: 'business_automation', label: 'Business Automation', core: false },
  { key: 'ai_automation', label: 'AI Automation', core: false },
  { key: 'custom_software', label: 'Custom Software Development', core: false },
  { key: 'ecommerce', label: 'Ecommerce', core: false },
  { key: 'analytics', label: 'Analytics', core: false },
  { key: 'consulting', label: 'Consulting', core: false },
  { key: 'maintenance', label: 'Maintenance & Hosting', core: false },
] as const;

export function serviceLabel(key: string | null | undefined): string {
  if (!key) return '—';
  const normalized = key.toLowerCase().replace(/-/g, '_');
  return SERVICE_CATALOGUE.find((s) => s.key === normalized)?.label ?? key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export const NAV = [
  { href: '/', label: 'Dashboard', pillar: 'discover' },
  { href: '/discover', label: 'Discover', pillar: 'discover' },
  { href: '/prospects', label: 'Prospects', pillar: 'discover' },
  { href: '/research', label: 'Intelligence', pillar: 'intelligence' },
  { href: '/audits', label: 'Audits', pillar: 'intelligence' },
  { href: '/outreach', label: 'Outreach', pillar: 'engage' },
  { href: '/sequences', label: 'Sequences', pillar: 'engage' },
  { href: '/mockups', label: 'Concepts', pillar: 'create' },
  { href: '/pipeline', label: 'Client Pipeline', pillar: 'convert' },
  { href: '/calls', label: 'Calls', pillar: 'convert' },
  { href: '/proposals', label: 'Proposals', pillar: 'convert' },
  { href: '/clients', label: 'Clients', pillar: 'deliver' },
  { href: '/projects', label: 'Projects', pillar: 'deliver' },
  { href: '/social', label: 'Social', pillar: 'deliver' },
  { href: '/websites', label: 'Websites', pillar: 'deliver' },
  { href: '/automation', label: 'Forge Automation', pillar: 'discover' },
  { href: '/analytics', label: 'Analytics', pillar: 'grow' },
  { href: '/forge-ai', label: 'Forge AI', pillar: 'intelligence' },
  { href: '/settings', label: 'Settings', pillar: 'grow' },
] as const;
