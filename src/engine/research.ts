/**
 * AI research agent (§12) — Business Intelligence.
 *
 * The agent answers only from evidence it holds: the business record, the
 * measured audits, competitor comparisons and stored memory. Where a question
 * cannot be answered from that evidence it says so and records the gap in
 * `unverified_claims` instead of guessing.
 */
import { all, get, json, run, scalar, toJson } from '@/db';
import { id, nowIso, round, truncate } from '@/lib/id';
import { daysBetween } from '@/lib/time';
import { logActivity } from '@/lib/activity';
import { getSettings } from '@/lib/settings';
import { businessContext, contextPrompt, remember, type BusinessContext } from '@/lib/ai/memory';
import { runAiTask } from '@/lib/ai/router';
import { buildGrowthSignals } from './signals';
import { listCompetitors } from '@/lib/audit/competitor';
import { listSources } from '@/repo/business';
import { serviceLabel } from '@/lib/brand';

export interface ResearchDoc {
  id: string;
  business_id: string;
  what_they_do: string | null;
  customers: string | null;
  services_offered: string[];
  digital_weaknesses: string[];
  website_lacks: string[];
  social_lacks: string[];
  competitor_edges: string[];
  opportunity: string | null;
  what_to_sell: string | null;
  outreach_angles: string[];
  custom_answers: { question: string; answer: string; sources: string[] }[];
  citations: { claim: string; source: string; url: string | null }[];
  confidence: number;
  unverified_claims: string[];
  model_used: string | null;
  cost: number;
  generated_at: string;
}

export interface ResearchOptions {
  customQuestions?: string[];
  force?: boolean;
  actor?: string;
}

/**
 * Produces (or refreshes) the Business Intelligence brief.
 * Caching (§64): a fresh brief inside the TTL is returned as-is unless forced.
 */
export async function researchBusiness(orgId: string, businessId: string, opts: ResearchOptions = {}): Promise<ResearchDoc | null> {
  const ctx = businessContext(orgId, businessId);
  if (!ctx) return null;
  const settings = getSettings(orgId);

  const existing = get<Record<string, unknown>>('SELECT * FROM research_docs WHERE business_id = ? ORDER BY generated_at DESC LIMIT 1', [businessId]);
  if (existing && !opts.force) {
    const ageHours = daysBetween(existing.generated_at as string) * 24;
    // Research is the most expensive step — never rerun unnecessarily.
    if (ageHours < settings.discovery.cacheTtlHours * 2) return hydrate(existing);
  }

  const growth = buildGrowthSignals(orgId, businessId);
  const competitors = listCompetitors(orgId, businessId);
  const evidence = buildEvidence(ctx, growth.signals, competitors);

  const res = await runAiTask(
    orgId,
    'web_research',
    {
      task: 'web_research',
      system: [
        'You are a business research analyst preparing a brief for a digital agency.',
        'You may ONLY use the evidence supplied below. You have no internet access in this task.',
        'If a question cannot be answered from the evidence, say "Not established from available data" and list it under unverified_claims.',
        'Never invent reviews, revenue, employee counts, founding dates, client names or competitor claims.',
        'Return JSON with keys: whatTheyDo, customers, servicesOffered[], digitalWeaknesses[], websiteLacks[], socialLacks[], competitorEdges[], opportunity, whatToSell, outreachAngles[], unverifiedClaims[].',
      ].join('\n'),
      prompt: `${contextPrompt(ctx)}\n\n## Evidence pack\n${evidence}\n\n## Growth signals detected\n${growth.signals.map((s) => `- ${s.label}: ${s.evidence}`).join('\n') || 'none'}`,
      json: true,
      maxTokens: 1400,
    },
    { entityType: 'business', entityId: businessId, needsTokens: evidence.length / 3 }
  );

  const parsed = (res.json ?? {}) as Record<string, unknown>;
  const arr = (k: string) => (Array.isArray(parsed[k]) ? (parsed[k] as unknown[]).map((x) => String(x)).filter(Boolean) : []);
  const str = (k: string) => (typeof parsed[k] === 'string' && (parsed[k] as string).trim() ? (parsed[k] as string) : null);

  const doc: Omit<ResearchDoc, 'id' | 'generated_at'> = {
    business_id: businessId,
    what_they_do: str('whatTheyDo') ?? fallbackWhatTheyDo(ctx),
    customers: str('customers') ?? fallbackCustomers(ctx),
    services_offered: arr('servicesOffered').length ? arr('servicesOffered') : fallbackServices(ctx),
    digital_weaknesses: arr('digitalWeaknesses').length ? arr('digitalWeaknesses') : ctx.signals.slice(0, 6),
    website_lacks: arr('websiteLacks').length ? arr('websiteLacks') : fallbackWebsiteLacks(ctx),
    social_lacks: arr('socialLacks').length ? arr('socialLacks') : fallbackSocialLacks(ctx),
    competitor_edges: arr('competitorEdges').length ? arr('competitorEdges') : fallbackCompetitorEdges(competitors),
    opportunity: str('opportunity') ?? fallbackOpportunity(ctx, growth.signals),
    what_to_sell: str('whatToSell') ?? ctx.business.recommended_service ?? null,
    outreach_angles: arr('outreachAngles').length ? arr('outreachAngles') : fallbackAngles(ctx),
    custom_answers: [],
    citations: buildCitations(ctx, competitors),
    confidence: computeConfidence(ctx),
    unverified_claims: arr('unverifiedClaims'),
    model_used: res.route.modelLabel,
    cost: res.cost,
  };

  const now = nowIso();
  const docId = id('res');
  run(
    `INSERT INTO research_docs (id, org_id, business_id, status, what_they_do, customers, services_offered,
        digital_weaknesses, website_lacks, social_lacks, competitor_edges, opportunity, what_to_sell, outreach_angles,
        custom_answers, citations, confidence, unverified_claims, model_used, cost, tokens_in, tokens_out, generated_at, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      docId, orgId, businessId, 'complete', doc.what_they_do, doc.customers, toJson(doc.services_offered),
      toJson(doc.digital_weaknesses), toJson(doc.website_lacks), toJson(doc.social_lacks),
      toJson(doc.competitor_edges), doc.opportunity, doc.what_to_sell, toJson(doc.outreach_angles),
      toJson(doc.custom_answers), toJson(doc.citations), doc.confidence, toJson(doc.unverified_claims),
      doc.model_used, doc.cost, res.tokensIn, res.tokensOut, now, now,
    ]
  );

  // Answer any custom questions against the same evidence, then fold the
  // answers back into the object we return so the caller sees one document.
  if (opts.customQuestions?.length) {
    for (const q of opts.customQuestions) {
      const answered = await askCustomQuestion(orgId, businessId, q, evidence);
      doc.custom_answers.push(answered);
    }
  }

  // Persist the durable findings as memory (§44).
  for (const s of doc.services_offered.slice(0, 6)) remember(orgId, businessId, 'fact', `service:${s.toLowerCase().slice(0, 40)}`, s, { source: 'research' });
  if (doc.what_they_do) remember(orgId, businessId, 'fact', 'what_they_do', doc.what_they_do, { source: 'research' });

  logActivity(orgId, 'research', `Business Intelligence brief updated for ${ctx.business.name}`, {
    businessId,
    actor: opts.actor ?? 'ai',
    detail: `${doc.digital_weaknesses.length} weakness(es) · ${doc.outreach_angles.length} outreach angle(s)${doc.unverified_claims.length ? ` · ${doc.unverified_claims.length} claim(s) left unverified` : ''}`,
    entityType: 'research_doc',
    entityId: docId,
  });

  return { ...doc, id: docId, generated_at: now };
}

function hydrate(row: Record<string, unknown>): ResearchDoc {
  return {
    id: row.id as string,
    business_id: row.business_id as string,
    what_they_do: row.what_they_do as string | null,
    customers: row.customers as string | null,
    services_offered: json<string[]>(row.services_offered as string, []),
    digital_weaknesses: json<string[]>(row.digital_weaknesses as string, []),
    website_lacks: json<string[]>(row.website_lacks as string, []),
    social_lacks: json<string[]>(row.social_lacks as string, []),
    competitor_edges: json<string[]>(row.competitor_edges as string, []),
    opportunity: row.opportunity as string | null,
    what_to_sell: row.what_to_sell as string | null,
    outreach_angles: json<string[]>(row.outreach_angles as string, []),
    custom_answers: json<ResearchDoc['custom_answers']>(row.custom_answers as string, []),
    citations: json<ResearchDoc['citations']>(row.citations as string, []),
    confidence: (row.confidence as number) ?? 0,
    unverified_claims: json<string[]>(row.unverified_claims as string, []),
    model_used: row.model_used as string | null,
    cost: (row.cost as number) ?? 0,
    generated_at: row.generated_at as string,
  };
}

export function getResearch(orgId: string, businessId: string): ResearchDoc | null {
  const row = get<Record<string, unknown>>('SELECT * FROM research_docs WHERE org_id = ? AND business_id = ? ORDER BY generated_at DESC LIMIT 1', [orgId, businessId]);
  return row ? hydrate(row) : null;
}

// ── Custom research questions (§12) ──────────────────────────
export async function askCustomQuestion(orgId: string, businessId: string, question: string, evidence?: string): Promise<{ question: string; answer: string; sources: string[] }> {
  const ctx = businessContext(orgId, businessId);
  if (!ctx) return { question, answer: 'Business not found.', sources: [] };
  const pack = evidence ?? buildEvidence(ctx, buildGrowthSignals(orgId, businessId).signals, listCompetitors(orgId, businessId));

  const res = await runAiTask(
    orgId,
    'web_research',
    {
      task: 'web_research',
      system: [
        'Answer the question using ONLY the supplied evidence.',
        'If the evidence does not support an answer, say so explicitly — do not guess.',
        'Return JSON: {"answer":string,"sources":string[],"unverified":boolean}',
      ].join('\n'),
      prompt: `${contextPrompt(ctx)}\n\n## Evidence pack\n${pack}\n\n## Question\n${question}`,
      json: true,
      maxTokens: 500,
    },
    { entityType: 'business', entityId: businessId }
  );
  const parsed = (res.json ?? {}) as { answer?: string; sources?: string[]; unverified?: boolean };
  const answer =
    parsed.answer?.trim() ||
    (parsed.unverified
      ? 'Not established from available data. This would need a live source check or a conversation with the business.'
      : 'Not established from available data.');
  const sources = Array.isArray(parsed.sources) ? parsed.sources : [];

  const qId = id('rq');
  run(
    `INSERT INTO research_questions (id, org_id, business_id, question, answer, sources, answered_at, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [qId, orgId, businessId, question, answer, toJson(sources), nowIso(), nowIso()]
  );
  // Attach to the current brief so the workspace shows one coherent document.
  const doc = get<{ id: string; custom_answers: string }>('SELECT id, custom_answers FROM research_docs WHERE business_id = ? ORDER BY generated_at DESC LIMIT 1', [businessId]);
  if (doc) {
    const existing = json<ResearchDoc['custom_answers']>(doc.custom_answers, []);
    run('UPDATE research_docs SET custom_answers = ? WHERE id = ?', [toJson([...existing, { question, answer, sources }]), doc.id]);
  }
  return { question, answer, sources };
}

export function listCustomQuestions(orgId: string, businessId?: string) {
  return businessId
    ? all('SELECT * FROM research_questions WHERE org_id = ? AND business_id = ? ORDER BY created_at DESC', [orgId, businessId])
    : all('SELECT * FROM research_questions WHERE org_id = ? ORDER BY created_at DESC LIMIT 100', [orgId]);
}

// ── Evidence pack ────────────────────────────────────────────
function buildEvidence(ctx: BusinessContext, growth: { label: string; evidence: string }[], competitors: { name: string; gap_summary: string | null; prospectVs?: unknown }[]): string {
  const b = ctx.business;
  const a = ctx.audit;
  const s = ctx.socialAudit;
  const lines: string[] = [];

  lines.push('### Registry facts');
  lines.push(`- Name: ${b.name}`);
  if (b.legal_name) lines.push(`- Legal name: ${b.legal_name}`);
  if (b.category) lines.push(`- Category: ${b.category}`);
  if (b.industry) lines.push(`- Industry: ${b.industry}`);
  if (b.description) lines.push(`- Description (as recorded): ${b.description}`);
  if (b.founded_year) lines.push(`- Founded: ${b.founded_year}`);
  if (b.employee_estimate) lines.push(`- Employee estimate: ${b.employee_estimate}`);
  lines.push(`- Website: ${b.website ?? 'none on record'} (status: ${b.website_status})`);
  if (b.rating) lines.push(`- Public rating: ${b.rating}${b.review_count ? ` from ${b.review_count} reviews` : ''}`);
  lines.push(`- Social profiles on record: ${Object.keys(b.social ?? {}).join(', ') || 'none'}`);

  if (a) {
    lines.push('', '### Measured website audit');
    lines.push(`- Verified by live fetch: ${a.verified ? 'yes' : 'no'}`);
    lines.push(`- Scores — website ${a.website_score}, SEO ${a.seo_score}, accessibility ${a.accessibility_score}, performance ${a.performance_score}, conversion ${a.conversion_score}, content ${a.content_score}, branding ${a.branding_score}, trust ${a.trust_score}`);
    lines.push(`- Title: ${a.title ?? 'missing'}`);
    lines.push(`- Meta description: ${a.meta_description ? `${String(a.meta_description).slice(0, 140)} (${a.meta_desc_length} chars)` : 'missing'}`);
    lines.push(`- Structure: ${a.h1_count} H1, ${a.h2_count} H2, ~${a.word_count} words, ${a.page_count_est} pages, ${a.internal_links} internal links`);
    lines.push(`- Conversion elements: ${a.form_count} form(s), ${a.cta_count} CTA(s), booking ${a.has_booking ? 'yes' : 'no'}, ecommerce ${a.has_ecommerce ? 'yes' : 'no'}`);
    lines.push(`- Trust: SSL ${a.ssl_valid === 1 ? 'valid' : a.ssl_valid === 0 ? 'invalid' : 'unknown'}, testimonials found ${a.testimonials_found}, schema ${a.has_schema_markup ? 'yes' : 'no'}`);
    lines.push(`- Accessibility: ${a.images_missing_alt} of ${a.image_count} images missing alt, lang attr ${a.lang_attr ?? 'missing'}`);
    lines.push(`- Response time: ${a.response_ms}ms`);
    const sigs = json<{ label: string; evidence: string; severity: string }[]>(a.signals as string, []);
    if (sigs.length) {
      lines.push('- Signals:');
      for (const sig of sigs) lines.push(`  - [${sig.severity}] ${sig.label} — ${sig.evidence}`);
    }
  } else {
    lines.push('', '### Measured website audit', '- No audit on record.');
  }

  if (s) {
    lines.push('', '### Measured social audit');
    lines.push(`- Social score: ${s.social_score}`);
    lines.push(`- Channels: ${s.platform_count}, active ${s.active_platforms}, cadence ${s.posting_frequency}`);
    const platforms = json<{ platform: string; followers: number | null; last_activity_days: number | null }[]>(s.platforms as string, []);
    for (const p of platforms) lines.push(`  - ${p.platform}: followers ${p.followers ?? 'not stated'}, last activity ${p.last_activity_days ?? 'not measured'}d ago`);
    const gaps = json<string[]>(s.content_gaps as string, []);
    if (gaps.length) lines.push(`- Content gaps: ${gaps.join('; ')}`);
  } else {
    lines.push('', '### Measured social audit', '- No social audit on record.');
  }

  if (competitors.length) {
    lines.push('', '### Competitor comparison (measured on both sides)');
    for (const c of competitors) lines.push(`- ${c.name}${c.gap_summary ? `: ${c.gap_summary}` : ''}`);
  }

  if (growth.length) {
    lines.push('', '### Growth signals');
    for (const g of growth) lines.push(`- ${g.label}: ${g.evidence}`);
  }

  const enrichment = all<{ field: string; value: string; provider_key: string; verified: number }>(
    'SELECT field, value, provider_key, verified FROM enrichment_records WHERE business_id = ? ORDER BY created_at DESC LIMIT 20',
    [b.id]
  );
  if (enrichment.length) {
    lines.push('', '### Enrichment records');
    for (const e of enrichment) lines.push(`- ${e.field}: ${truncate(e.value ?? '', 120)} (via ${e.provider_key}${e.verified ? ', verified' : ', unverified'})`);
  }

  return lines.join('\n');
}

// ── Grounded fallbacks (used when the model returns nothing usable) ──
function fallbackWhatTheyDo(ctx: BusinessContext): string {
  const b = ctx.business;
  if (b.description) return b.description;
  const parts = [b.name];
  if (b.category) parts.push(`is a ${b.category.toLowerCase()}`);
  else if (b.industry) parts.push(`operates in ${b.industry.toLowerCase()}`);
  else parts.push('— category not established from available data');
  if (b.locality) parts.push(`in ${b.locality}`);
  return `${parts.join(' ')}.`;
}

function fallbackCustomers(ctx: BusinessContext): string {
  const b = ctx.business;
  if (b.review_count && b.review_count > 0) {
    return `At least ${b.review_count} customer${b.review_count === 1 ? '' : 's'} have left a public review${b.rating ? `, averaging ${b.rating.toFixed(1)}★` : ''}. Beyond that, the customer profile is not established from available data.`;
  }
  return 'Not established from available data. No public review volume or customer information on record.';
}

function fallbackServices(ctx: BusinessContext): string[] {
  const fromAudit = json<string[]>((ctx.audit?.service_pages as string) ?? '[]', []);
  if (fromAudit.length) return fromAudit;
  const fromMemory = ctx.memories.filter((m) => m.key.startsWith('service:')).map((m) => m.value);
  if (fromMemory.length) return fromMemory;
  return [];
}

function fallbackWebsiteLacks(ctx: BusinessContext): string[] {
  if (!ctx.audit) return ctx.business.website ? ['No website audit on record'] : ['No website exists to assess'];
  const sigs = json<{ label: string; evidence: string }[]>(ctx.audit.signals as string, []);
  return sigs.map((s) => `${s.label} — ${s.evidence}`);
}

function fallbackSocialLacks(ctx: BusinessContext): string[] {
  if (!ctx.socialAudit) return ['No social audit on record'];
  const gaps = json<string[]>(ctx.socialAudit.content_gaps as string, []);
  const sigs = json<{ label: string; evidence: string }[]>(ctx.socialAudit.signals as string, []);
  return [...sigs.map((s) => `${s.label} — ${s.evidence}`), ...gaps];
}

function fallbackCompetitorEdges(competitors: { name: string; gap_summary: string | null }[]): string[] {
  return competitors.filter((c) => c.gap_summary).map((c) => `${c.name}: ${c.gap_summary}`);
}

function fallbackOpportunity(ctx: BusinessContext, growth: { label: string; evidence: string }[]): string {
  const b = ctx.business;
  const gaps = ctx.signals.slice(0, 3);
  if (!gaps.length && !growth.length) return 'No measured opportunity signals on record. Run an audit before assessing.';
  const proof = b.rating && b.review_count ? ` Demand is already proven (${b.rating.toFixed(1)}★ from ${b.review_count} reviews),` : '';
  return `${gaps.map((g) => g.toLowerCase()).join(', ')}.${proof} so the gap between existing demand and how that demand is captured online is the opportunity.`;
}

function fallbackAngles(ctx: BusinessContext): string[] {
  const b = ctx.business;
  const angles: string[] = [];
  if (b.rating && b.review_count && b.rating >= 4.5) {
    angles.push(`Their ${b.rating.toFixed(1)}★ from ${b.review_count} reviews proves demand — the question is where that demand lands.`);
  }
  const top = ctx.signals[0];
  if (top) angles.push(`Lead with the specific finding: ${top.toLowerCase()}.`);
  if (ctx.competitors.length) angles.push('Reference the measured competitor comparison — it is evidence, not opinion.');
  if (b.website_status === 'missing') angles.push('There is no site to defend, so the conversation can start from a blank page.');
  return angles;
}

/** Every factual claim gets attributed where we can attribute it (§62). */
function buildCitations(ctx: BusinessContext, competitors: { name: string; website: string | null }[]): ResearchDoc['citations'] {
  const citations: ResearchDoc['citations'] = [];
  const b = ctx.business;

  const sources = all<{ provider_key: string; source_url: string | null; field: string; value: string | null; confidence: number }>(
    'SELECT provider_key, source_url, field, value, confidence FROM business_sources WHERE business_id = ? ORDER BY confidence DESC LIMIT 12',
    [b.id]
  );
  for (const s of sources) {
    citations.push({
      claim: s.field === '*' ? `Business record (${s.value ?? b.name})` : `${s.field}: ${s.value ?? 'recorded'}`,
      source: s.provider_key,
      url: s.source_url,
    });
  }
  if (ctx.audit?.verified) {
    citations.push({
      claim: `Website audit — score ${(ctx.audit as { website_score?: number }).website_score}/100, measured by live fetch`,
      source: 'ClientForge website audit',
      url: b.website ?? null,
    });
  }
  if (ctx.socialAudit) {
    citations.push({
      claim: `Social audit — score ${(ctx.socialAudit as { social_score?: number }).social_score}/100 across ${(ctx.socialAudit as { platform_count?: number }).platform_count} channel(s)`,
      source: 'ClientForge social audit',
      url: Object.values(b.social ?? {})[0] ?? null,
    });
  }
  for (const c of competitors.slice(0, 3)) {
    citations.push({ claim: `Competitor comparison: ${c.name}`, source: 'ClientForge cohort audit', url: c.website });
  }
  return citations;
}

function computeConfidence(ctx: BusinessContext): number {
  let c = 0.2;
  if (ctx.audit?.verified) c += 0.3;
  if (ctx.socialAudit) c += 0.15;
  if (ctx.business.rating && ctx.business.review_count) c += 0.1;
  if (ctx.competitors.length) c += 0.1;
  if (ctx.contact) c += 0.1;
  if (ctx.business.description) c += 0.05;
  return round(Math.min(0.98, c), 2);
}

export interface WebsiteSignalView {
  key: string;
  label: string;
  severity: string;
  evidence: string;
  service: string;
}

export interface IntelligenceView {
  business: import('@/repo/business').Business;
  contact: import('@/repo/business').Contact | null;
  contacts: import('@/repo/business').Contact[];
  audit: Record<string, unknown> | null;
  socialAudit: Record<string, unknown> | null;
  competitors: ReturnType<typeof listCompetitors>;
  research: ResearchDoc | null;
  growthSignals: { key: string; label: string; weight: number; evidence: string }[];
  growthScore: number;
  signals: string[];
  website: WebsiteSignalView[];
  sources: import('@/repo/business').SourceRow[];
  dataConfidence: { overall: number; per_field: Record<string, number>; last_verified_at: string | null } | null;
  memories: { id: string; kind: string; key: string; value: string; confidence: number }[];
  unknowns: string[];
  objections: string[];
  outreachHistory: { channel: string; subject: string | null; status: string; sent_at: string | null; body: string; direction: string }[];
  serviceLabel: string;
  citations: ResearchDoc['citations'];
  unverifiedClaims: string[];
  lastResearchAt: string | null;
  researchAgeHours: number | null;
}

/** The full Business Intelligence page payload (§62). */
export function intelligenceView(orgId: string, businessId: string): IntelligenceView | null {
  const ctx = businessContext(orgId, businessId);
  if (!ctx) return null;
  const research = getResearch(orgId, businessId);
  const competitors = listCompetitors(orgId, businessId);
  const growth = buildGrowthSignals(orgId, businessId);
  const contacts = all<import('@/repo/business').Contact>('SELECT * FROM contacts WHERE business_id = ? ORDER BY is_decision_maker DESC, confidence DESC', [businessId]);
  const sources = listSources(orgId, businessId);
  const confidence = get<{ overall: number; per_field: string; last_verified_at: string | null }>(
    'SELECT * FROM data_confidence WHERE business_id = ?',
    [businessId]
  );
  const memories = all<{ id: string; kind: string; key: string; value: string; confidence: number }>(
    "SELECT id, kind, key, value, confidence FROM ai_memory WHERE business_id = ? AND superseded_by IS NULL ORDER BY kind, updated_at DESC",
    [businessId]
  );

  return {
    business: ctx.business,
    contact: ctx.contact,
    contacts,
    audit: ctx.audit,
    socialAudit: ctx.socialAudit,
    competitors,
    research,
    growthSignals: growth.signals,
    growthScore: growth.score,
    signals: ctx.signals,
    website: json<WebsiteSignalView[]>((ctx.audit?.signals as string) ?? '[]', []),
    sources,
    dataConfidence: confidence ? { overall: confidence.overall, per_field: json<Record<string, number>>(confidence.per_field, {}), last_verified_at: confidence.last_verified_at } : null,
    memories,
    unknowns: ctx.unknowns,
    objections: ctx.objections,
    outreachHistory: ctx.outreachHistory,
    serviceLabel: serviceLabel(ctx.business.recommended_service),
    citations: research?.citations ?? buildCitations(ctx, competitors),
    unverifiedClaims: research?.unverified_claims ?? [],
    lastResearchAt: research?.generated_at ?? null,
    researchAgeHours: research ? round(daysBetween(research.generated_at) * 24, 1) : null,
  };
}

export function researchStats(orgId: string) {
  return {
    total: scalar<number>('SELECT COUNT(*) FROM research_docs WHERE org_id = ?', [orgId]) ?? 0,
    questions: scalar<number>('SELECT COUNT(*) FROM research_questions WHERE org_id = ?', [orgId]) ?? 0,
    cost: round(scalar<number>('SELECT COALESCE(SUM(cost),0) FROM research_docs WHERE org_id = ?', [orgId]) ?? 0, 4),
    avgConfidence: round(scalar<number>('SELECT COALESCE(AVG(confidence),0) FROM research_docs WHERE org_id = ?', [orgId]) ?? 0, 2),
  };
}
