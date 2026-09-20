/**
 * Mockup engine (§20–§25).
 *
 * generate → version → edit conversationally → share → track → pitch kit.
 * Every edit creates a new immutable version so history, compare and rollback
 * are always available.
 */
import { all, get, json, run, scalar, toJson, tx } from '@/db';
import { id, nowIso, round, slugify, stableHash } from '@/lib/id';
import { logActivity } from '@/lib/activity';
import { logAutomation } from '@/lib/logging';
import { buildSiteModel, buildTheme, type DesignDirection, type Section, type SiteModel } from './site';
import { diffModels, renderSite } from './render';
import { runAiTask } from '@/lib/ai/router';
import { businessContext, contextPrompt, remember } from '@/lib/ai/memory';
import { recordOutcome } from './scoring';
import type { Business } from '@/repo/business';

export interface MockupRow {
  id: string;
  org_id: string;
  business_id: string;
  slug: string;
  title: string;
  design_direction: string;
  theme: string;
  layout_variant: string;
  status: string;
  share_token: string;
  share_enabled: number;
  view_count: number;
  unique_viewers: number;
  first_viewed_at: string | null;
  last_viewed_at: string | null;
  total_view_ms: number;
  devices: string;
  returning_viewers: number;
  intent_score: number;
  current_version: number;
  cost: number;
  pitch_kit: string;
  created_at: string;
  updated_at: string;
}

export interface GenerateResult {
  mockupId: string;
  version: number;
  direction: string;
  notes: string[];
  model: SiteModel;
  html: string;
}

/** Builds the site model from the business's real record + audits. */
export async function buildModelForBusiness(orgId: string, businessId: string, opts: { direction?: DesignDirection; palette?: string[] } = {}): Promise<SiteModel> {
  const ctx = businessContext(orgId, businessId);
  if (!ctx) throw new Error('business_not_found');
  const b = ctx.business;

  const services = await deriveServices(orgId, ctx);
  const differentiators = deriveDifferentiators(ctx);
  const testimonials = deriveTestimonials(ctx);

  return buildSiteModel({
    name: b.name,
    category: b.category,
    industry: b.industry,
    description: b.description,
    services,
    rating: b.rating,
    reviewCount: b.review_count,
    phone: b.phone,
    email: b.email,
    address: [b.address_line, b.locality, b.region].filter(Boolean).join(', ') || null,
    social: b.social ?? {},
    foundedYear: b.founded_year,
    testimonials,
    differentiators,
    bookingAvailable: ctx.audit?.has_booking === 1,
    direction: opts.direction,
    palette: opts.palette,
    seed: b.id,
  });
}

/**
 * Services come from research, the audit's service pages, or the category —
 * in that order. If none exist we return nothing and the renderer shows
 * clearly-marked placeholders rather than invented services.
 */
async function deriveServices(orgId: string, ctx: NonNullable<Awaited<ReturnType<typeof businessContext>>>): Promise<string[]> {
  const fromResearch = json<string[]>((ctx.research?.services_offered as string) ?? '[]', []);
  if (fromResearch.length) return fromResearch.slice(0, 8);

  const fromAudit = json<string[]>((ctx.audit?.service_pages as string) ?? '[]', []);
  if (fromAudit.length) return fromAudit.slice(0, 8);

  const stored = all<{ value: string }>(
    `SELECT value FROM ai_memory WHERE org_id = ? AND business_id = ? AND kind = 'fact' AND key LIKE 'service%'`,
    [orgId, ctx.business.id]
  ).map((r) => r.value);
  if (stored.length) return stored.slice(0, 8);

  return [];
}

function deriveDifferentiators(ctx: NonNullable<Awaited<ReturnType<typeof businessContext>>>): string[] {
  const out: string[] = [];
  const b = ctx.business;
  if (b.rating && b.rating >= 4.5 && b.review_count) out.push(`${b.rating.toFixed(1)}★ from ${b.review_count} reviews`);
  if (b.founded_year) out.push(`Operating since ${b.founded_year}`);
  if (b.is_new_business === 1) out.push('Newly established');
  const socials = Object.keys(b.social ?? {});
  if (socials.length >= 2) out.push(`Active on ${socials.slice(0, 3).join(', ')}`);
  return out;
}

/**
 * Testimonials are only included when real review text exists somewhere we
 * already hold it. We never compose a fake customer quote.
 */
function deriveTestimonials(ctx: NonNullable<Awaited<ReturnType<typeof businessContext>>>) {
  const fromMemory = ctx.memories.filter((m) => m.kind === 'fact' && m.key.startsWith('review:'));
  return fromMemory.map((m) => {
    const [quote, author] = m.value.split('||');
    return { quote: quote.trim(), author: (author ?? 'Verified customer').trim(), source: m.source ?? undefined };
  });
}

/** Creates a mockup + version 1, then the pitch kit. */
export async function generateMockup(
  orgId: string,
  businessId: string,
  opts: { direction?: DesignDirection; palette?: string[]; actor?: string } = {}
): Promise<GenerateResult> {
  const business = get<Business & Record<string, unknown>>('SELECT * FROM businesses WHERE id = ? AND org_id = ?', [businessId, orgId]);
  if (!business) throw new Error('business_not_found');

  const existing = get<MockupRow>('SELECT * FROM mockups WHERE business_id = ? ORDER BY created_at DESC LIMIT 1', [businessId]);
  if (existing) {
    // Re-generate as a new version of the existing mockup so history is kept.
    return addVersion(orgId, existing.id, { command: 'Regenerate concept', actor: opts.actor, direction: opts.direction, palette: opts.palette });
  }

  const model = await buildModelForBusiness(orgId, businessId, opts);
  const now = nowIso();
  const mockupId = id('mkp');
  const shareToken = stableHash(`${mockupId}:${now}`, 'share');
  // The tracking beacon is always present: a shared concept is always measured.
  const html = renderSite(model, { showReviewMarkers: true, trackingToken: shareToken });
  const slug = uniqueSlug(orgId, `${slugify(business.name)}-concept`);

  tx(() => {
    run(
      `INSERT INTO mockups (id, org_id, business_id, slug, title, design_direction, theme, layout_variant, status,
          share_token, share_enabled, view_count, unique_viewers, total_view_ms, devices, returning_viewers,
          intent_score, current_version, cost, pitch_kit, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?, 'draft', ?,1,0,0,0,'{}',0,0,1,0,'{}',?,?)`,
      [
        mockupId, orgId, businessId, slug, `${business.name} — concept`, model.theme.label,
        toJson(model.theme), model.layout, shareToken, now, now,
      ]
    );
    run(
      `INSERT INTO mockup_versions (id, mockup_id, version, html, theme, sections, change_summary, change_command,
          parent_version, tokens_in, tokens_out, cost, model_used, created_at)
       VALUES (?,?,1,?,?,?,?,NULL,NULL,0,0,0,?,?)`,
      [
        id('mkv'), mockupId, html, toJson(model.theme), toJson(model.sections),
        `Initial concept — ${model.theme.label} direction, ${model.sections.length} sections`,
        'local-design-v1', now,
      ]
    );
  });

  const pitchKit = buildPitchKit(orgId, businessId, mockupId, model, shareToken);
  run('UPDATE mockups SET pitch_kit = ? WHERE id = ?', [toJson(pitchKit), mockupId]);

  logActivity(orgId, 'mockup', `Website concept generated for ${business.name}`, {
    businessId,
    actor: opts.actor ?? 'ai',
    detail: `${model.theme.label} direction · ${model.sections.length} sections${model.generationNotes.length ? ` · ${model.generationNotes.length} content gap(s) flagged` : ''}`,
    entityType: 'mockup',
    entityId: mockupId,
  });
  remember(orgId, businessId, 'history', 'mockup:direction', model.theme.label, { source: 'mockup_engine' });

  advanceStageIfBehind(orgId, businessId, 'mockup_generated');
  return { mockupId, version: 1, direction: model.theme.direction, notes: model.generationNotes, model, html };
}

/** Adds a new version — used by conversational edits and regeneration. */
export async function addVersion(
  orgId: string,
  mockupId: string,
  opts: { command?: string; actor?: string; direction?: DesignDirection; palette?: string[]; model?: SiteModel }
): Promise<GenerateResult> {
  const mockup = get<MockupRow>('SELECT * FROM mockups WHERE id = ? AND org_id = ?', [mockupId, orgId]);
  if (!mockup) throw new Error('mockup_not_found');

  const previousVersion = get<{ html: string; sections: string; theme: string; version: number }>(
    'SELECT * FROM mockup_versions WHERE mockup_id = ? ORDER BY version DESC LIMIT 1',
    [mockupId]
  );
  const previousModel: SiteModel | null = previousVersion
    ? ({
        ...reconstructModel(mockup, previousVersion),
      } as SiteModel)
    : null;

  let model: SiteModel;
  if (opts.model) {
    model = opts.model;
  } else if (opts.command && previousModel) {
    model = await applyCommand(orgId, mockup.business_id, previousModel, opts.command);
  } else {
    model = await buildModelForBusiness(orgId, mockup.business_id, { direction: opts.direction, palette: opts.palette });
  }

  const html = renderSite(model, { showReviewMarkers: true, trackingToken: mockup.share_token });
  const version = (mockup.current_version ?? 0) + 1;
  const diff = previousModel ? diffModels(previousModel, model) : null;
  const summary = diff
    ? [
        diff.themeChanged ? 'design direction changed' : null,
        diff.added.length ? `added ${diff.added.join(', ')}` : null,
        diff.removed.length ? `removed ${diff.removed.join(', ')}` : null,
        diff.changed.length ? `${diff.changed.length} section edit(s)` : null,
      ]
        .filter(Boolean)
        .join(' · ') || 'no structural change'
    : `Version ${version}`;
  const now = nowIso();

  run(
    `INSERT INTO mockup_versions (id, mockup_id, version, html, theme, sections, change_summary, change_command,
        parent_version, tokens_in, tokens_out, cost, model_used, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,0,0,?,?)`,
    [
      id('mkv'), mockupId, version, html, toJson(model.theme), toJson(model.sections),
      summary, opts.command ?? null, previousVersion?.version ?? null, 0, 'local-design-v1', now,
    ]
  );
  run(
    `UPDATE mockups SET current_version = ?, theme = ?, design_direction = ?, layout_variant = ?, updated_at = ? WHERE id = ?`,
    [version, toJson(model.theme), model.theme.label, model.layout, now, mockupId]
  );

  logActivity(orgId, 'mockup', `Concept v${version} — ${summary}`, {
    businessId: mockup.business_id,
    actor: opts.actor ?? (opts.command ? 'ai' : 'user'),
    detail: opts.command ? `Instruction: "${opts.command}"` : undefined,
    entityType: 'mockup_version',
    entityId: mockupId,
  });
  advanceStageIfBehind(orgId, mockup.business_id, 'mockup_generated');

  return { mockupId, version, direction: model.theme.direction, notes: model.generationNotes, model, html };
}

function reconstructModel(mockup: MockupRow, version: { sections: string; theme: string }): Partial<SiteModel> {
  const theme = json<SiteModel['theme']>(version.theme, json<SiteModel['theme']>(mockup.theme, {} as SiteModel['theme']));
  const sections = json<Section[]>(version.sections, []);
  const first = sections.find((s) => s.type === 'hero');
  return {
    theme,
    sections,
    businessName: mockup.title.replace(' — concept', ''),
    tagline: first?.title ?? null,
    layout: mockup.layout_variant,
    logo: '',
    palette: [theme.palette?.ink ?? '#111', theme.palette?.accent ?? '#4f46e5'],
    contact: {},
    social: {},
    rating: null,
    seed: mockup.slug,
    generationNotes: [],
  };
}

// ── Conversational editing (§21) ─────────────────────────────
export interface CommandResult {
  applied: boolean;
  summary: string;
  model: SiteModel;
}

const DIRECTION_WORDS: { words: string[]; direction: DesignDirection }[] = [
  { words: ['premium', 'luxury', 'luxe', 'upscale', 'high-end', 'elegant', 'sophisticated', 'refined'], direction: 'luxe' },
  { words: ['modern', 'minimal', 'clean', 'simple', 'less', 'airy'], direction: 'minimal' },
  { words: ['bold', 'strong', 'loud', 'energetic', 'punchy'], direction: 'bold' },
  { words: ['editorial', 'magazine', 'story', 'serif'], direction: 'editorial' },
  { words: ['technical', 'engineered', 'precise', 'data'], direction: 'technical' },
  { words: ['warm', 'friendly', 'cosy', 'cozy', 'welcoming', 'soft'], direction: 'warm' },
  { words: ['clinical', 'medical', 'trustworthy', 'professional', 'healthcare'], direction: 'clinical' },
  { words: ['artisan', 'craft', 'handmade', 'heritage', 'rustic'], direction: 'artisan' },
];

/**
 * Interprets a natural-language instruction and returns a new model.
 * Structural instructions are applied deterministically; copy rewrites are
 * routed to the AI task layer (which falls back to grounded local rewriting).
 */
export async function applyCommand(orgId: string, businessId: string, model: SiteModel, command: string): Promise<SiteModel> {
  const cmd = command.toLowerCase().trim();
  const next: SiteModel = { ...model, sections: model.sections.map((s) => ({ ...s, items: s.items?.map((i) => ({ ...i })) })) };
  let handled = false;

  // 1. Design direction / mood
  const mood = DIRECTION_WORDS.find((d) => d.words.some((w) => cmd.includes(w)));
  if (mood && !cmd.includes('image')) {
    next.theme = buildTheme(model.seed, {
      category: undefined,
      direction: mood.direction,
      palette: [model.theme.palette.ink, model.theme.palette.accent],
    });
    handled = true;
  }

  // 2. Palette / colour
  const colorMatch = cmd.match(/\b(blue|green|red|orange|purple|pink|black|white|gold|teal|navy|brown|grey|gray)\b/);
  if (colorMatch && (cmd.includes('color') || cmd.includes('colour') || cmd.includes('palette'))) {
    const hex = COLOR_MAP[colorMatch[1]];
    if (hex) {
      next.theme = { ...next.theme, palette: { ...next.theme.palette, accent: hex } };
      handled = true;
    }
  }

  // 3. Section add / remove
  const addable: { words: string[]; type: Section['type'] }[] = [
    { words: ['testimonial', 'review', 'social proof'], type: 'testimonials' },
    { words: ['booking', 'appointment', 'reservation', 'schedule'], type: 'booking' },
    { words: ['faq', 'question'], type: 'faq' },
    { words: ['gallery', 'photo', 'portfolio', 'our work'], type: 'gallery' },
    { words: ['process', 'how it works', 'steps'], type: 'process' },
    { words: ['about', 'story'], type: 'about' },
    { words: ['service'], type: 'services' },
  ];
  if (/\b(add|include|insert)\b/.test(cmd)) {
    for (const a of addable) {
      if (a.words.some((w) => cmd.includes(w)) && !next.sections.some((s) => s.type === a.type)) {
        next.sections.splice(insertIndex(next.sections, a.type), 0, defaultSection(a.type, next));
        handled = true;
        break;
      }
    }
  }
  if (/\b(remove|delete|drop)\b/.test(cmd)) {
    for (const a of addable) {
      if (a.words.some((w) => cmd.includes(w))) {
        const before = next.sections.length;
        next.sections = next.sections.filter((s) => s.type !== a.type);
        if (next.sections.length !== before) handled = true;
        break;
      }
    }
  }

  // 4. CTA change
  if (cmd.includes('cta') || cmd.includes('button')) {
    const label = extractQuoted(command) ?? guessCtaLabel(cmd);
    for (const s of next.sections) {
      if (s.cta) s.cta = { ...s.cta, label };
    }
    handled = true;
  }

  // 5. Headline / copy rewrite → AI task
  if (/hero|headline|title|copy|rewrite|wording|text/.test(cmd)) {
    const rewritten = await rewriteCopy(orgId, businessId, next, command);
    if (rewritten) {
      next.sections = rewritten;
      handled = true;
    }
  }

  // 6. Image / artwork
  if (cmd.includes('image') || cmd.includes('photo') || cmd.includes('artwork') || cmd.includes('hero image')) {
    // Artwork is procedural and re-seeded, so a new seed produces new artwork.
    next.seed = `${model.seed}:${Date.now().toString(36)}`;
    handled = true;
  }

  // 7. Layout density
  if (cmd.includes('more space') || cmd.includes('more whitespace') || cmd.includes('airier')) {
    next.theme = { ...next.theme, spacing: { section: 'clamp(6rem,12vw,10rem)', gap: '2.25rem' } };
    handled = true;
  }
  if (cmd.includes('tighter') || cmd.includes('compact') || cmd.includes('less space')) {
    next.theme = { ...next.theme, spacing: { section: 'clamp(3.5rem,7vw,5.5rem)', gap: '1.25rem' } };
    handled = true;
  }

  if (!handled) {
    // Unknown instruction: still route copy through the AI layer so the user
    // gets a real attempt rather than a silent no-op.
    const rewritten = await rewriteCopy(orgId, businessId, next, command);
    if (rewritten) next.sections = rewritten;
  }

  return next;
}

const COLOR_MAP: Record<string, string> = {
  blue: '#2563eb',
  navy: '#1e3a5f',
  teal: '#0f766e',
  green: '#16a34a',
  red: '#dc2626',
  orange: '#ea580c',
  gold: '#b45309',
  purple: '#7c3aed',
  pink: '#db2777',
  black: '#111827',
  brown: '#78350f',
  grey: '#4b5563',
  gray: '#4b5563',
  white: '#f8fafc',
};

function insertIndex(sections: Section[], type: Section['type']): number {
  const order: Section['type'][] = ['hero', 'trustbar', 'services', 'about', 'process', 'gallery', 'testimonials', 'booking', 'faq', 'contact', 'cta', 'footer'];
  const target = order.indexOf(type);
  for (let i = 0; i < sections.length; i++) {
    if (order.indexOf(sections[i].type) > target) return i;
  }
  return Math.max(0, sections.length - 1);
}

function defaultSection(type: Section['type'], model: SiteModel): Section {
  switch (type) {
    case 'testimonials':
      return {
        type,
        id: 'testimonials',
        title: 'What people say',
        items: [{ title: '[Add a real customer review]', needsReview: true }],
        needsReview: true,
        note: 'No review text on record — no quote has been invented.',
      };
    case 'booking':
      return { type, id: 'booking', title: 'Book online', subtitle: 'Choose a time that suits you.', cta: { label: 'Check availability', href: '#contact' } };
    case 'faq':
      return {
        type,
        id: 'faq',
        title: 'Questions',
        items: [
          { title: 'How do I get started?', body: 'Send an enquiry and we will come back to you with next steps.' },
          { title: '[Add your most common question]', needsReview: true },
        ],
        needsReview: true,
      };
    case 'gallery':
      return { type, id: 'gallery', title: 'Our work', items: [{ title: '[Add project photos]', needsReview: true }], needsReview: true };
    case 'process':
      return {
        type,
        id: 'process',
        title: 'How it works',
        items: [
          { title: 'Enquire', body: 'Tell us what you need.' },
          { title: 'We respond', body: 'We come back with next steps.' },
          { title: 'We deliver', body: 'Clear scope and timing.' },
        ],
      };
    case 'about':
      return { type, id: 'about', title: `About ${model.businessName}`, body: `[Add a short paragraph about ${model.businessName}.]`, needsReview: true };
    case 'services':
      return { type, id: 'services', title: 'Services', items: [{ title: '[Add your services]', needsReview: true }], needsReview: true };
    default:
      return { type, id: type, title: type };
  }
}

function extractQuoted(s: string): string | null {
  const m = s.match(/["'“”]([^"'“”]+)["'“”]/);
  return m ? m[1] : null;
}

function guessCtaLabel(cmd: string): string {
  if (cmd.includes('book')) return 'Book now';
  if (cmd.includes('quote')) return 'Request a quote';
  if (cmd.includes('call')) return 'Call us';
  if (cmd.includes('buy') || cmd.includes('shop')) return 'Shop now';
  return 'Get in touch';
}

/** Routes copy rewrites through the AI layer, keeping structure intact. */
async function rewriteCopy(orgId: string, businessId: string, model: SiteModel, command: string): Promise<Section[] | null> {
  const targets = model.sections.filter((s) => ['hero', 'services', 'about', 'cta', 'testimonials'].includes(s.type));
  if (!targets.length) return null;

  const ctx = businessContext(orgId, businessId);
  const payload = {
    instruction: command,
    currentCopy: targets.map((s) => ({ id: s.id, title: s.title, subtitle: s.subtitle, body: s.body })),
    constraints: [
      'Do not invent business facts, prices, years, awards or customer names.',
      'Keep every section id unchanged.',
      'Return JSON: {"sections":[{"id":string,"title":string,"subtitle":string|null,"body":string|null}]}',
    ],
  };

  const res = await runAiTask(
    orgId,
    'website_copy',
    {
      task: 'website_copy',
      system: 'You rewrite website copy for a specific business. You only use facts provided. Output strict JSON.',
      prompt: `${ctx ? contextPrompt(ctx) : ''}\n\n## Instruction\n${command}\n\n## Payload\n${JSON.stringify(payload, null, 2)}`,
      json: true,
      maxTokens: 900,
    },
    { entityType: 'business', entityId: businessId }
  );

  const parsed = res.json as { sections?: { id: string; title?: string; subtitle?: string | null; body?: string | null }[] } | undefined;
  if (!parsed?.sections?.length) return null;

  const byId = new Map(parsed.sections.map((s) => [s.id, s]));
  return model.sections.map((s) => {
    const patch = byId.get(s.id);
    if (!patch) return s;
    return {
      ...s,
      title: patch.title ?? s.title,
      subtitle: patch.subtitle === null ? undefined : (patch.subtitle ?? s.subtitle),
      body: patch.body === null ? undefined : (patch.body ?? s.body),
    };
  });
}

// ── Sharing & tracking (§23, §24) ────────────────────────────
export function shareMockup(orgId: string, mockupId: string, opts: { enabled?: boolean; actor?: string } = {}): { url: string; token: string } {
  const enabled = opts.enabled !== false;
  const mockup = get<MockupRow>('SELECT * FROM mockups WHERE id = ? AND org_id = ?', [mockupId, orgId]);
  if (!mockup) throw new Error('mockup_not_found');
  run('UPDATE mockups SET share_enabled = ?, status = ?, updated_at = ? WHERE id = ?', [
    enabled ? 1 : 0,
    enabled ? 'shared' : mockup.status,
    nowIso(),
    mockupId,
  ]);
  if (enabled && mockup.status !== 'shared') {
    logActivity(orgId, 'mockup', `Concept shared for ${mockup.title.replace(' — concept', '')}`, {
      businessId: mockup.business_id,
      actor: opts.actor ?? 'user',
      entityType: 'mockup',
      entityId: mockupId,
    });
    advanceStageIfBehind(orgId, mockup.business_id, 'mockup_shared');
  }
  return { url: `/mockup/${mockup.share_token}`, token: mockup.share_token };
}

export interface ViewEvent {
  mockupId: string;
  visitorToken: string;
  isReturning: boolean;
  device: string | null;
  viewport: string | null;
  userAgent: string | null;
  referrer: string | null;
  durationMs: number;
  scrolledPct: number;
  sectionsSeen: string[];
  ctaClicked: boolean;
}

export function recordMockupView(orgId: string, mockup: MockupRow, event: Omit<ViewEvent, 'mockupId'>): { views: number; intent: number } {
  const now = nowIso();
  run(
    `INSERT INTO mockup_views (id, mockup_id, business_id, version, visitor_token, is_returning, device, viewport,
        user_agent, referrer, duration_ms, scrolled_pct, sections_seen, cta_clicked, ip_hash, viewed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id('mvw'), mockup.id, mockup.business_id, mockup.current_version, event.visitorToken,
      event.isReturning ? 1 : 0, event.device, event.viewport, event.userAgent, event.referrer,
      event.durationMs, event.scrolledPct, toJson(event.sectionsSeen), event.ctaClicked ? 1 : 0,
      stableHash(event.visitorToken, 'ip'), now,
    ]
  );

  const stats = get<{ views: number; unique_viewers: number; returning_views: number; totalMs: number; first_view: string; last_view: string; devices: string }>(
    `SELECT COUNT(*) AS views, COUNT(DISTINCT visitor_token) AS unique_viewers,
            SUM(CASE WHEN is_returning = 1 THEN 1 ELSE 0 END) AS returning_views,
            COALESCE(SUM(duration_ms),0) AS totalMs, MIN(viewed_at) AS first_view, MAX(viewed_at) AS last_view,
            (SELECT GROUP_CONCAT(DISTINCT device) FROM mockup_views WHERE mockup_id = ?) AS devices
       FROM mockup_views WHERE mockup_id = ?`,
    [mockup.id, mockup.id]
  );

  // Intent (§24): views, dwell, scroll depth and CTA interaction all count.
  const views = stats?.views ?? 1;
  const avgMs = views ? (stats?.totalMs ?? 0) / views : 0;
  const intent = round(
    Math.min(
      100,
      Math.min(45, views * 15) +
        Math.min(25, (avgMs / 1000) * 3) +
        Math.min(15, (event.scrolledPct / 100) * 15) +
        (event.ctaClicked ? 15 : 0)
    )
  );

  run(
    `UPDATE mockups SET view_count = ?, unique_viewers = ?, returning_viewers = ?, total_view_ms = ?,
            devices = ?, first_viewed_at = COALESCE(first_viewed_at, ?), last_viewed_at = ?,
            intent_score = ?, status = 'viewed', updated_at = ? WHERE id = ?`,
    [
      views,
      stats?.unique_viewers ?? 1,
      stats?.returning_views ?? 0,
      stats?.totalMs ?? 0,
      toJson(deviceCounts(mockup.id)),
      now,
      now,
      intent,
      now,
      mockup.id,
    ]
  );

  run('UPDATE businesses SET intent_score = ?, engagement_score = ?, updated_at = ? WHERE id = ?', [
    intent,
    Math.min(100, intent + (event.ctaClicked ? 10 : 0)),
    now,
    mockup.business_id,
  ]);

  logActivity(orgId, 'mockup', `Concept viewed${event.isReturning ? ' again' : ''} — ${views} view${views === 1 ? '' : 's'}`, {
    businessId: mockup.business_id,
    actor: 'client',
    detail: `${event.device ?? 'unknown'} device · ${Math.round((event.durationMs ?? 0) / 1000)}s · ${event.scrolledPct ?? 0}% scrolled${event.ctaClicked ? ' · CTA clicked' : ''}`,
    entityType: 'mockup_view',
    entityId: mockup.id,
    importance: views >= 2 || event.ctaClicked ? 'high' : 'normal',
  });

  recordOutcome(orgId, 'mockup_view', mockup.business_id, { value: intent });
  advanceStageIfBehind(orgId, mockup.business_id, 'mockup_viewed');

  // §24: a view means follow up now.
  createFollowUp(orgId, mockup.business_id, {
    kind: 'mockup',
    title: `Follow up — ${mockup.title.replace(' — concept', '')} viewed`,
    reason: views >= 2
      ? `They have opened the concept ${views} times. Interest is rising — reach out while it is fresh.`
      : event.ctaClicked
        ? 'They clicked a call to action inside the concept. This is the warmest signal available.'
        : 'They opened the concept. A short, specific follow-up now converts far better than waiting.',
    dueInHours: views >= 2 || event.ctaClicked ? 2 : 20,
    priority: views >= 2 || event.ctaClicked ? 'high' : 'medium',
  });

  return { views, intent };
}

function deviceCounts(mockupId: string): Record<string, number> {
  const rows = all<{ device: string | null; c: number }>(
    'SELECT device, COUNT(*) c FROM mockup_views WHERE mockup_id = ? GROUP BY device',
    [mockupId]
  );
  return Object.fromEntries(rows.map((r) => [r.device ?? 'unknown', r.c]));
}

// ── Follow-ups (§4, §24) ─────────────────────────────────────
export function createFollowUp(
  orgId: string,
  businessId: string,
  opts: { kind: string; title: string; reason: string; dueInHours: number; priority?: string; suggestedAction?: string; contactId?: string }
): string {
  // De-duplicate an identical pending follow-up so automation cannot spam the queue.
  const existing = get<{ id: string }>(
    `SELECT id FROM follow_ups WHERE org_id = ? AND business_id = ? AND title = ? AND status = 'pending'`,
    [orgId, businessId, opts.title]
  );
  if (existing) return existing.id;

  const fuId = id('fup');
  const due = new Date(Date.now() + opts.dueInHours * 3_600_000).toISOString();
  run(
    `INSERT INTO follow_ups (id, org_id, business_id, contact_id, kind, title, reason, due_at, status, priority, suggested_action, created_at)
     VALUES (?,?,?,?,?,?,?,?, 'pending', ?,?,?)`,
    [fuId, orgId, businessId, opts.contactId ?? null, opts.kind, opts.title, opts.reason, due, opts.priority ?? 'medium', opts.suggestedAction ?? null, nowIso()]
  );
  return fuId;
}

// ── Pitch kit (§25) ──────────────────────────────────────────
export interface PitchKit {
  valueProposition: string;
  email: { subjectLines: string[]; body: string };
  sms: string;
  whatsapp: string;
  callBriefing: string;
  suggestedCta: string;
  previewUrl: string;
  groundedIn: string[];
}

export function buildPitchKit(orgId: string, businessId: string, mockupId: string, model: SiteModel, shareToken: string): PitchKit {
  const ctx = businessContext(orgId, businessId);
  const b = ctx?.business;
  const name = b?.name ?? model.businessName;
  const previewUrl = `/mockup/${shareToken}`;
  const firstName = ctx?.contact?.first_name ?? 'there';

  const gaps = (ctx?.signals ?? []).slice(0, 3);
  const groundedIn: string[] = [`Concept built from the ${model.theme.label.toLowerCase()} design direction`];
  if (b?.category) groundedIn.push(`Category: ${b.category}`);
  if (b?.rating && b.review_count) groundedIn.push(`${b.rating.toFixed(1)}★ from ${b.review_count} reviews`);
  for (const g of gaps) groundedIn.push(`Audit signal: ${g}`);

  const problemLine = gaps.length
    ? `While putting this together I noticed ${gaps.map((g) => g.toLowerCase()).join(', ')}.`
    : 'I put this together from what is publicly available about your business.';

  const valueProposition =
    `A concept website for ${name}, built specifically for ${b?.category ? b.category.toLowerCase() : 'your business'} — not a template. ` +
    `It already includes your services, your contact routes and a clear way for customers to enquire.`;

  const subjectLines = [
    `I made a website concept for ${name}`,
    `${name} — a concept site, no strings`,
    `Quick idea for ${name}${b?.locality ? ` in ${b.locality}` : ''}`,
  ];

  const emailBody = [
    `Hi ${firstName},`,
    '',
    `${problemLine}`,
    '',
    `So rather than describe what I mean, I built it. It is a full concept site for ${name} — homepage, services, reviews, enquiry form and contact — using the ${model.theme.label.toLowerCase()} direction:`,
    '',
    `{{preview_url}}`,
    '',
    `It takes about a minute to look at. If it is anywhere near useful, I am happy to talk through what a real version would involve. If it is not for you, no need to reply — I will not chase.`,
    '',
    `Either way, the concept is yours to keep.`,
  ].join('\n');

  const sms = `Hi ${firstName} — I put together a website concept for ${name} (not a template). Takes a minute to look at: {{preview_url}}`;

  const whatsapp = `Hi ${firstName} 👋 I built a concept website for ${name} based on what you offer — services, reviews and an enquiry route all laid out. Have a look when you get a moment: {{preview_url}}`;

  const callBriefing = [
    `## Call briefing — ${name}`,
    '',
    `**What you built:** A ${model.theme.label.toLowerCase()}-direction concept site with ${model.sections.length} sections.`,
    gaps.length ? `**Why it matters to them:** ${gaps.join('; ')}.` : '**Why it matters to them:** the concept demonstrates a complete enquiry path they do not currently have.',
    b?.rating && b.review_count ? `**Proof you can reference:** ${b.rating.toFixed(1)}★ from ${b.review_count} reviews — the demand is already there.` : '',
    model.generationNotes.length ? `**Be honest about:** ${model.generationNotes.join(' ')}` : '',
    '',
    '**Open with:** "I made you something rather than emailing you about something."',
    '**Goal:** agree a scope conversation, not a sale on this call.',
  ]
    .filter(Boolean)
    .join('\n');

  const kit: PitchKit = {
    valueProposition,
    email: { subjectLines, body: emailBody.replaceAll('{{preview_url}}', previewUrl) },
    sms: sms.replaceAll('{{preview_url}}', previewUrl),
    whatsapp: whatsapp.replaceAll('{{preview_url}}', previewUrl),
    callBriefing,
    suggestedCta: 'Take a look — it takes about a minute',
    previewUrl,
    groundedIn,
  };

  void mockupId;
  void orgId;
  return kit;
}

// ── Queries ──────────────────────────────────────────────────
export function getMockupByToken(orgId: string, token: string): MockupRow | null {
  return get<MockupRow>('SELECT * FROM mockups WHERE org_id = ? AND share_token = ?', [orgId, token]);
}

export function getMockup(orgId: string, mockupId: string): MockupRow | null {
  return get<MockupRow>('SELECT * FROM mockups WHERE org_id = ? AND id = ?', [orgId, mockupId]);
}

export function getMockupForBusiness(orgId: string, businessId: string): MockupRow | null {
  return get<MockupRow>('SELECT * FROM mockups WHERE org_id = ? AND business_id = ? ORDER BY created_at DESC LIMIT 1', [
    orgId,
    businessId,
  ]);
}

export function listVersions(mockupId: string) {
  return all<{ id: string; version: number; change_summary: string | null; change_command: string | null; created_at: string; model_used: string | null }>(
    'SELECT id, version, change_summary, change_command, created_at, model_used FROM mockup_versions WHERE mockup_id = ? ORDER BY version DESC',
    [mockupId]
  );
}

export function getVersionHtml(mockupId: string, version: number): string | null {
  return scalar<string>('SELECT html FROM mockup_versions WHERE mockup_id = ? AND version = ?', [mockupId, version]);
}

export function currentHtml(orgId: string, mockupId: string): string | null {
  const m = getMockup(orgId, mockupId);
  if (!m) return null;
  return getVersionHtml(mockupId, m.current_version);
}

export function rollback(orgId: string, mockupId: string, toVersion: number, actor?: string): number {
  const mockup = getMockup(orgId, mockupId);
  if (!mockup) throw new Error('mockup_not_found');
  const html = getVersionHtml(mockupId, toVersion);
  const target = get<{ theme: string; sections: string }>('SELECT theme, sections FROM mockup_versions WHERE mockup_id = ? AND version = ?', [
    mockupId,
    toVersion,
  ]);
  if (!html || !target) throw new Error('version_not_found');

  const newVersion = mockup.current_version + 1;
  const now = nowIso();
  run(
    `INSERT INTO mockup_versions (id, mockup_id, version, html, theme, sections, change_summary, change_command,
        parent_version, tokens_in, tokens_out, cost, model_used, created_at)
     VALUES (?,?,?,?,?,?,?,NULL,?,0,0,0,?,?)`,
    [id('mkv'), mockupId, newVersion, html, target.theme, target.sections, `Rolled back to v${toVersion}`, `rollback:${toVersion}`, mockup.current_version, now]
  );
  run('UPDATE mockups SET current_version = ?, updated_at = ? WHERE id = ?', [newVersion, now, mockupId]);
  logActivity(orgId, 'mockup', `Rolled concept back to v${toVersion}`, {
    businessId: mockup.business_id,
    actor: actor ?? 'user',
    entityType: 'mockup_version',
    entityId: mockupId,
  });
  return newVersion;
}

export function listMockups(orgId: string, opts: { limit?: number; status?: string } = {}) {
  const where = ['m.org_id = ?'];
  const params: unknown[] = [orgId];
  if (opts.status) {
    where.push('m.status = ?');
    params.push(opts.status);
  }
  params.push(opts.limit ?? 100);
  return all<MockupRow & { business_name: string }>(
    `SELECT m.*, b.name business_name FROM mockups m JOIN businesses b ON b.id = m.business_id
      WHERE ${where.join(' AND ')} ORDER BY m.last_viewed_at IS NULL, m.last_viewed_at DESC, m.created_at DESC LIMIT ?`,
    params
  );
}

export interface MockupViewRow {
  id: string;
  mockup_id: string;
  business_id: string;
  version: number | null;
  visitor_token: string;
  is_returning: number;
  device: string | null;
  viewport: string | null;
  referrer: string | null;
  duration_ms: number;
  scrolled_pct: number;
  sections_seen: string;
  cta_clicked: number;
  viewed_at: string;
}

export function listViews(mockupId: string, limit = 50): MockupViewRow[] {
  return all<MockupViewRow>('SELECT * FROM mockup_views WHERE mockup_id = ? ORDER BY viewed_at DESC LIMIT ?', [mockupId, limit]);
}

export function compareVersions(mockupId: string, a: number, b: number) {
  const va = get<{ html: string; sections: string; theme: string }>('SELECT html, sections, theme FROM mockup_versions WHERE mockup_id = ? AND version = ?', [mockupId, a]);
  const vb = get<{ html: string; sections: string; theme: string }>('SELECT html, sections, theme FROM mockup_versions WHERE mockup_id = ? AND version = ?', [mockupId, b]);
  if (!va || !vb) return null;
  const ma = { sections: json<Section[]>(va.sections, []), theme: json<SiteModel['theme']>(va.theme, {} as SiteModel['theme']) };
  const mb = { sections: json<Section[]>(vb.sections, []), theme: json<SiteModel['theme']>(vb.theme, {} as SiteModel['theme']) };
  return {
    a: { version: a, sectionCount: ma.sections.length, direction: ma.theme.direction, accent: ma.theme.palette?.accent },
    b: { version: b, sectionCount: mb.sections.length, direction: mb.theme.direction, accent: mb.theme.palette?.accent },
    diff: diffModels(
      { ...ma, businessName: '', tagline: null, layout: '', logo: '', palette: [], contact: {}, social: {}, rating: null, seed: '', generationNotes: [] },
      { ...mb, businessName: '', tagline: null, layout: '', logo: '', palette: [], contact: {}, social: {}, rating: null, seed: '', generationNotes: [] }
    ),
  };
}

// ── helpers ──────────────────────────────────────────────────
function uniqueSlug(orgId: string, base: string): string {
  let candidate = base || 'concept';
  let n = 2;
  while (scalar<number>('SELECT COUNT(*) FROM mockups WHERE org_id = ? AND slug = ?', [orgId, candidate])) {
    candidate = `${base}-${n++}`;
  }
  return candidate;
}

const STAGE_RANK: Record<string, number> = {
  discovered: 0, qualified: 1, outreach_ready: 2, outreach_sent: 3, engaged: 4, interested: 5,
  mockup_generated: 6, mockup_shared: 7, mockup_viewed: 8, call_scheduled: 9, call_completed: 10,
  proposal_sent: 11, negotiation: 12, won: 13, onboarding: 14, delivery: 15, active_client: 16, expansion: 17, lost: 18,
};

/** Advances the stage but never past a stage the business has already reached. */
export function advanceStageIfBehind(orgId: string, businessId: string, target: keyof typeof STAGE_RANK): void {
  const row = get<{ stage: string; name: string }>('SELECT stage, name FROM businesses WHERE id = ? AND org_id = ?', [businessId, orgId]);
  if (!row) return;
  if ((STAGE_RANK[row.stage] ?? 0) >= (STAGE_RANK[target] ?? 0)) return;
  // Never auto-advance a business that has been won, is in delivery, or was lost.
  if (['won', 'onboarding', 'delivery', 'active_client', 'expansion', 'lost'].includes(row.stage)) return;
  run('UPDATE businesses SET stage = ?, updated_at = ? WHERE id = ?', [target, nowIso(), businessId]);
  logActivity(orgId, 'stage_change', `${row.name} → ${target.replace(/_/g, ' ')}`, {
    businessId,
    detail: 'Advanced automatically by the mockup engine.',
    entityType: 'business',
    entityId: businessId,
  });
}

export { renderSite, logAutomation };
