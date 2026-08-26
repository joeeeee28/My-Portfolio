/**
 * Business repository: identity, provenance, contacts, deduplication.
 *
 * Provenance rule (§3): every fact written from an external source gets a
 * `business_sources` row carrying source, source URL, timestamp and confidence.
 * Nothing is fabricated — absent facts stay absent.
 */
import { all, get, json, run, scalar, toJson, tx } from '@/db';
import {
  domainOfEmail,
  id,
  normalizeDomain,
  normalizeEmail,
  normalizePhone,
  nowIso,
  seededRandom,
  slugify,
} from '@/lib/id';
import { priorityFromScore, type PipelineStage } from '@/lib/domain';
import type { Priority } from '@/lib/domain';

export interface Business {
  id: string;
  org_id: string;
  name: string;
  legal_name: string | null;
  slug: string;
  industry: string | null;
  category: string | null;
  subcategory: string | null;
  description: string | null;
  founded_year: number | null;
  address_line: string | null;
  locality: string | null;
  region: string | null;
  country: string | null;
  postal_code: string | null;
  timezone: string | null;
  website: string | null;
  website_domain: string | null;
  website_status: string;
  website_checked_at: string | null;
  phone: string | null;
  email: string | null;
  social: Record<string, string>;
  rating: number | null;
  review_count: number | null;
  price_level: string | null;
  employee_estimate: string | null;
  is_new_business: number;
  hiring_signal: number;
  stage: PipelineStage;
  priority: Priority;
  opportunity_score: number | null;
  intent_score: number;
  engagement_score: number;
  close_probability: number;
  revenue_potential: number;
  recommended_service: string | null;
  recommended_package_id: string | null;
  next_best_action: string | null;
  next_best_action_reason: string | null;
  next_best_action_due: string | null;
  owner_id: string | null;
  consent_state: string;
  first_discovered_at: string;
  last_verified_at: string | null;
  source_confidence: number | null;
  is_demo: number;
  merged_into: string | null;
  is_archived: number;
  created_at: string;
  updated_at: string;
}

export interface BusinessInput {
  name: string;
  legalName?: string | null;
  industry?: string | null;
  category?: string | null;
  subcategory?: string | null;
  description?: string | null;
  foundedYear?: number | null;
  addressLine?: string | null;
  locality?: string | null;
  region?: string | null;
  country?: string | null;
  postalCode?: string | null;
  timezone?: string | null;
  website?: string | null;
  phone?: string | null;
  email?: string | null;
  social?: Record<string, string>;
  rating?: number | null;
  reviewCount?: number | null;
  priceLevel?: string | null;
  employeeEstimate?: string | null;
  isNewBusiness?: boolean;
  hiringSignal?: boolean;
  isDemo?: boolean;
  stage?: PipelineStage;
  ownerId?: string | null;
}

export interface SourceAttribution {
  providerKey: string;
  sourceId?: string | null;
  sourceUrl?: string | null;
  externalId?: string | null;
  confidence: number;
  field?: string;
  value?: string | null;
}

const JSON_COLS = ['social'] as const;

export function hydrateBusiness(row: Record<string, unknown> | null): Business | null {
  if (!row) return null;
  return { ...row, social: json<Record<string, string>>(row.social as string, {}) } as unknown as Business;
}

export function getBusiness(orgId: string, businessId: string): Business | null {
  return hydrateBusiness(
    get<Record<string, unknown>>('SELECT * FROM businesses WHERE id = ? AND org_id = ?', [businessId, orgId])
  );
}

export function findBusinessIdByName(orgId: string, name: string): string | null {
  return scalar<string>('SELECT id FROM businesses WHERE org_id = ? AND LOWER(name) = LOWER(?)', [orgId, name]);
}

function uniqueSlug(orgId: string, name: string): string {
  const base = slugify(name) || 'business';
  let candidate = base;
  let n = 2;
  while (scalar<number>('SELECT COUNT(*) FROM businesses WHERE org_id = ? AND slug = ?', [orgId, candidate])) {
    candidate = `${base}-${n++}`;
  }
  return candidate;
}

export function createBusiness(
  orgId: string,
  input: BusinessInput,
  source: SourceAttribution
): { business: Business; created: boolean; mergedInto?: string } {
  const domain = normalizeDomain(input.website);
  const email = normalizeEmail(input.email);
  const phone = normalizePhone(input.phone);

  // Deduplication must happen before creation (§11).
  const dupe = findDuplicate(orgId, {
    name: input.name,
    domain,
    email,
    phone,
    addressLine: input.addressLine ?? null,
    locality: input.locality ?? null,
    externalId: source.externalId ?? null,
    providerKey: source.providerKey,
    social: input.social ?? {},
  });

  if (dupe) {
    recordDuplicateEvent(orgId, dupe.id, null, input.name, dupe.method, dupe.score, dupe.evidence);
    addSourceAttribution(orgId, dupe.id, { ...source, field: '*', value: input.name });
    touchBusiness(orgId, dupe.id);
    const existing = getBusiness(orgId, dupe.id);
    if (existing) return { business: existing, created: false, mergedInto: dupe.id };
  }

  const now = nowIso();
  const businessId = id('biz');
  run(
    `INSERT INTO businesses (
       id, org_id, name, legal_name, slug, industry, category, subcategory, description, founded_year,
       address_line, locality, region, country, postal_code, timezone,
       website, website_domain, website_status, phone, email, social,
       rating, review_count, price_level, employee_estimate, is_new_business, hiring_signal,
       stage, priority, owner_id, consent_state, first_discovered_at, source_confidence, is_demo,
       created_at, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      businessId,
      orgId,
      input.name.trim(),
      input.legalName ?? null,
      uniqueSlug(orgId, input.name),
      input.industry ?? null,
      input.category ?? null,
      input.subcategory ?? null,
      input.description ?? null,
      input.foundedYear ?? null,
      input.addressLine ?? null,
      input.locality ?? null,
      input.region ?? null,
      input.country ?? null,
      input.postalCode ?? null,
      input.timezone ?? null,
      input.website ?? null,
      domain,
      domain ? 'unknown' : 'missing',
      input.phone ?? null,
      email,
      toJson(input.social ?? {}),
      input.rating ?? null,
      input.reviewCount ?? null,
      input.priceLevel ?? null,
      input.employeeEstimate ?? null,
      input.isNewBusiness ? 1 : 0,
      input.hiringSignal ? 1 : 0,
      input.stage ?? 'discovered',
      'low',
      input.ownerId ?? null,
      'unknown',
      now,
      source.confidence,
      input.isDemo ? 1 : 0,
      now,
      now,
    ]
  );

  addSourceAttribution(orgId, businessId, { ...source, field: '*', value: input.name });
  const business = getBusiness(orgId, businessId);
  return { business: business as Business, created: true };
}

export function updateBusiness(
  orgId: string,
  businessId: string,
  patch: Partial<Record<string, unknown>>
): Business | null {
  const allowed = new Set([
    'name', 'legal_name', 'industry', 'category', 'subcategory', 'description', 'founded_year',
    'address_line', 'locality', 'region', 'country', 'postal_code', 'timezone',
    'website', 'website_domain', 'website_status', 'website_checked_at', 'phone', 'email', 'social',
    'rating', 'review_count', 'price_level', 'employee_estimate', 'is_new_business', 'hiring_signal',
    'stage', 'priority', 'opportunity_score', 'intent_score', 'engagement_score', 'close_probability',
    'revenue_potential', 'recommended_service', 'recommended_package_id', 'next_best_action',
    'next_best_action_reason', 'next_best_action_due', 'owner_id', 'consent_state', 'consent_source',
    'consent_at', 'last_verified_at', 'source_confidence', 'is_archived', 'archived_reason', 'is_demo',
  ]);
  const entries = Object.entries(patch).filter(([k]) => allowed.has(k));
  if (!entries.length) return getBusiness(orgId, businessId);

  const sets = entries.map(([k]) => `${k} = ?`).join(', ');
  const values = entries.map(([, v]) => (typeof v === 'object' && v !== null ? toJson(v) : v));
  run(`UPDATE businesses SET ${sets}, updated_at = ? WHERE id = ? AND org_id = ?`, [
    ...values,
    nowIso(),
    businessId,
    orgId,
  ]);
  return getBusiness(orgId, businessId);
}

export function touchBusiness(orgId: string, businessId: string): void {
  run('UPDATE businesses SET last_verified_at = ?, updated_at = ? WHERE id = ?', [nowIso(), nowIso(), businessId]);
}

export function archiveBusiness(orgId: string, businessId: string, reason: string): void {
  run('UPDATE businesses SET is_archived = 1, archived_reason = ?, updated_at = ? WHERE id = ?', [
    reason,
    nowIso(),
    businessId,
  ]);
}

// ── Provenance (§3) ──────────────────────────────────────────
export function addSourceAttribution(orgId: string, businessId: string, source: SourceAttribution): void {
  run(
    `INSERT INTO business_sources
       (id, org_id, business_id, source_id, provider_key, external_id, source_url, field, value, confidence, discovered_at, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id('bsrc'),
      orgId,
      businessId,
      source.sourceId ?? null,
      source.providerKey,
      source.externalId ?? null,
      source.sourceUrl ?? null,
      source.field ?? '*',
      source.value ?? null,
      source.confidence,
      nowIso(),
      nowIso(),
    ]
  );
}

export interface SourceRow {
  id: string;
  org_id: string;
  business_id: string;
  source_id: string | null;
  provider_key: string;
  external_id: string | null;
  source_url: string | null;
  field: string;
  value: string | null;
  confidence: number;
  discovered_at: string;
  last_verified_at: string | null;
  created_at: string;
}

export function listSources(orgId: string, businessId: string): SourceRow[] {
  return all<SourceRow>(
    `SELECT * FROM business_sources WHERE org_id = ? AND business_id = ? ORDER BY discovered_at DESC`,
    [orgId, businessId]
  );
}

// ── Deduplication (§11) ──────────────────────────────────────
export interface DuplicateCandidate {
  name?: string | null;
  domain?: string | null;
  email?: string | null;
  phone?: string | null;
  addressLine?: string | null;
  locality?: string | null;
  externalId?: string | null;
  providerKey?: string | null;
  social?: Record<string, string>;
}

export interface DuplicateMatch {
  id: string;
  name: string;
  method: string;
  score: number;
  evidence: Record<string, unknown>;
}

/**
 * Ranked duplicate detection. Domain/phone/email/source-id/social are exact and
 * high confidence; name+locality uses a fuzzy similarity and is only trusted
 * above a conservative threshold so distinct businesses are never merged.
 */
export function findDuplicate(orgId: string, c: DuplicateCandidate): DuplicateMatch | null {
  const matches = findDuplicates(orgId, c);
  return matches[0] ?? null;
}

export function findDuplicates(orgId: string, c: DuplicateCandidate): DuplicateMatch[] {
  const out: DuplicateMatch[] = [];
  const seen = new Set<string>();
  const push = (row: { id: string; name: string }, method: string, score: number, evidence: Record<string, unknown>) => {
    if (seen.has(row.id)) return;
    seen.add(row.id);
    out.push({ id: row.id, name: row.name, method, score, evidence });
  };

  if (c.domain) {
    for (const row of all<{ id: string; name: string }>(
      'SELECT id, name FROM businesses WHERE org_id = ? AND website_domain = ? AND is_archived = 0',
      [orgId, c.domain]
    ))
      push(row, 'domain', 0.99, { domain: c.domain });
  }
  if (c.email) {
    for (const row of all<{ id: string; name: string }>(
      'SELECT id, name FROM businesses WHERE org_id = ? AND email = ? AND is_archived = 0',
      [orgId, c.email]
    ))
      push(row, 'email', 0.95, { email: c.email });
    const dom = domainOfEmail(c.email);
    if (dom) {
      for (const row of all<{ id: string; name: string }>(
        'SELECT id, name FROM businesses WHERE org_id = ? AND website_domain = ? AND is_archived = 0',
        [orgId, dom]
      ))
        push(row, 'email_domain', 0.8, { domain: dom });
    }
  }
  if (c.phone) {
    const norm = normalizePhone(c.phone);
    for (const row of all<{ id: string; name: string; phone: string }>(
      'SELECT id, name, phone FROM businesses WHERE org_id = ? AND phone IS NOT NULL AND is_archived = 0',
      [orgId]
    )) {
      if (normalizePhone(row.phone) === norm) push(row, 'phone', 0.97, { phone: norm });
    }
  }
  if (c.externalId && c.providerKey) {
    for (const row of all<{ id: string; name: string }>(
      `SELECT b.id, b.name FROM business_sources s JOIN businesses b ON b.id = s.business_id
        WHERE s.org_id = ? AND s.provider_key = ? AND s.external_id = ? AND b.is_archived = 0`,
      [orgId, c.providerKey, c.externalId]
    ))
      push(row, 'source_id', 0.98, { provider: c.providerKey, externalId: c.externalId });
  }
  if (c.social) {
    for (const [platform, url] of Object.entries(c.social)) {
      if (!url) continue;
      for (const row of all<{ id: string; name: string; social: string }>(
        'SELECT id, name, social FROM businesses WHERE org_id = ? AND is_archived = 0',
        [orgId]
      )) {
        const existing = json<Record<string, string>>(row.social, {});
        if (existing[platform] && existing[platform] === url) {
          push(row, 'social', 0.9, { platform, url });
        }
      }
    }
  }

  // Fuzzy name + locality — only when nothing exact matched.
  if (c.name && out.length === 0) {
    const rows = all<{ id: string; name: string; locality: string | null }>(
      'SELECT id, name, locality FROM businesses WHERE org_id = ? AND is_archived = 0',
      [orgId]
    );
    for (const row of rows) {
      const sim = similarity(c.name, row.name);
      const sameLocality =
        !!c.locality && !!row.locality && row.locality.toLowerCase() === c.locality.toLowerCase();
      const score = sameLocality ? sim : sim * 0.7;
      if (score >= 0.93) {
        push(row, sameLocality ? 'name_locality' : 'fuzzy_name', Number(score.toFixed(3)), {
          candidate: c.name,
          existing: row.name,
          similarity: Number(sim.toFixed(3)),
          sameLocality,
        });
      }
    }
  }

  return out.sort((a, b) => b.score - a.score);
}

/** Dice coefficient over bigrams — cheap, stable, no external dependency. */
export function similarity(a: string, b: string): number {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, '')
      .replace(/\b(inc|llc|ltd|limited|co|company|the|and)\b/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const bigrams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) m.set(s.slice(i, i + 2), (m.get(s.slice(i, i + 2)) ?? 0) + 1);
    return m;
  };
  const ma = bigrams(x);
  const mb = bigrams(y);
  let overlap = 0;
  for (const [k, v] of ma) overlap += Math.min(v, mb.get(k) ?? 0);
  return (2 * overlap) / (x.length - 1 + (y.length - 1));
}

export function recordDuplicateEvent(
  orgId: string,
  keptId: string,
  droppedId: string | null,
  droppedName: string,
  method: string,
  score: number,
  evidence: Record<string, unknown>,
  resolution = 'merged'
): void {
  run(
    `INSERT INTO duplicate_events
       (id, org_id, kept_id, dropped_id, dropped_name, match_method, match_score, evidence, resolution, auto, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,1,?)`,
    [
      id('dup'),
      orgId,
      keptId,
      droppedId ?? keptId,
      droppedName,
      method,
      score,
      toJson(evidence),
      resolution,
      nowIso(),
    ]
  );
}

export function listDuplicateEvents(orgId: string, limit = 100) {
  return all<Record<string, unknown>>(
    `SELECT d.*, b.name AS kept_name FROM duplicate_events d
       LEFT JOIN businesses b ON b.id = d.kept_id
      WHERE d.org_id = ? ORDER BY d.created_at DESC LIMIT ?`,
    [orgId, limit]
  );
}

/**
 * Merge `fromId` into `toId`, repointing every child record, then archiving the
 * duplicate. Idempotent and transactional.
 */
export function mergeBusinesses(
  orgId: string,
  toId: string,
  fromId: string,
  method = 'manual',
  score = 1
): { ok: boolean; moved: Record<string, number>; reason?: string } {
  if (toId === fromId) return { ok: false, moved: {}, reason: 'same_record' };
  const target = getBusiness(orgId, toId);
  const source = getBusiness(orgId, fromId);
  if (!target || !source) return { ok: false, moved: {}, reason: 'not_found' };

  const moved: Record<string, number> = {};
  const repoint = (table: string, column: string) => {
    const { changes } = run(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`, [toId, fromId]);
    moved[table] = changes;
  };

  tx(() => {
    for (const t of [
      'contacts', 'business_sources', 'enrichment_records', 'digital_audits', 'social_audits',
      'competitors', 'opportunity_scores', 'research_docs', 'ai_memory', 'outreach_messages',
      'sequence_enrollments', 'follow_ups', 'mockups', 'calls', 'call_briefings', 'proposals',
      'projects', 'activities', 'cost_ledger', 'outcome_events', 'assets', 'websites', 'upsell_opportunities',
    ]) {
      try {
        repoint(t, 'business_id');
      } catch {
        /* table may not carry business_id */
      }
    }
    // Carry over facts the target is missing (never overwrite real data).
    const fill: Record<string, unknown> = {};
    const fillable = ['website', 'website_domain', 'phone', 'email', 'rating', 'review_count', 'description', 'industry', 'category', 'address_line', 'locality', 'region', 'country'] as const;
    for (const f of fillable) {
      const tv = (target as unknown as Record<string, unknown>)[f];
      const sv = (source as unknown as Record<string, unknown>)[f];
      if ((tv === null || tv === undefined || tv === '') && sv !== null && sv !== undefined && sv !== '') {
        fill[f] = sv;
      }
    }
    if (Object.keys(fill).length) updateBusiness(orgId, toId, fill);

    run('UPDATE businesses SET merged_into = ?, is_archived = 1, archived_reason = ?, updated_at = ? WHERE id = ?', [
      toId,
      `Merged into ${target.name}`,
      nowIso(),
      fromId,
    ]);
    recordDuplicateEvent(orgId, toId, fromId, source.name, method, score, { moved, filled: Object.keys(fill) });
  });

  return { ok: true, moved };
}

// ── Contacts (§10) ───────────────────────────────────────────
export interface Contact {
  id: string;
  org_id: string;
  business_id: string;
  full_name: string;
  first_name: string | null;
  last_name: string | null;
  job_title: string | null;
  seniority: string | null;
  is_decision_maker: number;
  email: string | null;
  email_status: string;
  phone: string | null;
  linkedin_url: string | null;
  preferred_channel: string | null;
  confidence: number;
  last_verified_at: string | null;
  consent_state: string;
  notes: string | null;
  is_demo: number;
  created_at: string;
}

export function listContacts(orgId: string, businessId: string): Contact[] {
  return all<Contact>('SELECT * FROM contacts WHERE org_id = ? AND business_id = ? ORDER BY is_decision_maker DESC, confidence DESC', [
    orgId,
    businessId,
  ]);
}

export function getContact(contactId: string): Contact | null {
  return get<Contact>('SELECT * FROM contacts WHERE id = ?', [contactId]);
}

export function primaryContact(orgId: string, businessId: string): Contact | null {
  return get<Contact>(
    `SELECT * FROM contacts WHERE org_id = ? AND business_id = ?
      ORDER BY is_decision_maker DESC, confidence DESC, created_at ASC LIMIT 1`,
    [orgId, businessId]
  );
}

export function upsertContact(
  orgId: string,
  businessId: string,
  data: Partial<Contact> & { full_name: string }
): Contact {
  const email = normalizeEmail(data.email ?? null);
  const phone = normalizePhone(data.phone ?? null);
  const existing = email
    ? get<Contact>('SELECT * FROM contacts WHERE org_id = ? AND business_id = ? AND email = ?', [
        orgId,
        businessId,
        email,
      ])
    : null;

  if (existing) {
    run(
      `UPDATE contacts SET job_title = COALESCE(?, job_title), seniority = COALESCE(?, seniority),
              is_decision_maker = MAX(is_decision_maker, ?), confidence = MAX(confidence, ?),
              linkedin_url = COALESCE(?, linkedin_url), last_verified_at = ?, updated_at = ? WHERE id = ?`,
      [
        data.job_title ?? null,
        data.seniority ?? null,
        data.is_decision_maker ?? 0,
        data.confidence ?? existing.confidence,
        data.linkedin_url ?? null,
        nowIso(),
        nowIso(),
        existing.id,
      ]
    );
    return getContact(existing.id) as Contact;
  }

  const contactId = id('con');
  const [first, ...rest] = data.full_name.split(/\s+/);
  run(
    `INSERT INTO contacts (id, org_id, business_id, full_name, first_name, last_name, job_title, seniority,
        is_decision_maker, email, email_status, phone, linkedin_url, preferred_channel, confidence,
        last_verified_at, consent_state, notes, is_demo, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      contactId,
      orgId,
      businessId,
      data.full_name,
      first ?? null,
      rest.join(' ') || null,
      data.job_title ?? null,
      data.seniority ?? null,
      data.is_decision_maker ? 1 : 0,
      email,
      data.email_status ?? (email ? 'unknown' : 'unknown'),
      data.phone ?? null,
      data.linkedin_url ?? null,
      data.preferred_channel ?? (email ? 'email' : null),
      data.confidence ?? 0.5,
      nowIso(),
      data.consent_state ?? 'unknown',
      data.notes ?? null,
      data.is_demo ? 1 : 0,
      nowIso(),
      nowIso(),
    ]
  );
  return getContact(contactId) as Contact;
}

// ── Querying (§51, §63) ──────────────────────────────────────
export interface BusinessFilters {
  q?: string;
  stage?: string | string[];
  stages?: string[];
  priority?: string | string[];
  minScore?: number;
  maxScore?: number;
  websiteStatus?: string | string[];
  industry?: string;
  category?: string;
  hasContact?: boolean;
  outreachStatus?: string;
  mockupStatus?: 'none' | 'generated' | 'shared' | 'viewed';
  callStatus?: string;
  proposalStatus?: string;
  clientStatus?: string;
  projectStatus?: string;
  discoveredAfter?: string;
  discoveredBefore?: string;
  lastActivityAfter?: string;
  minRevenuePotential?: number;
  excludeArchived?: boolean;
  demoOnly?: boolean;
  excludeDemo?: boolean;
  ownerId?: string;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

const SORT_COLUMNS: Record<string, string> = {
  score: 'b.opportunity_score',
  name: 'b.name',
  discovered: 'b.first_discovered_at',
  updated: 'b.updated_at',
  revenue: 'b.revenue_potential',
  intent: 'b.intent_score',
  rating: 'b.rating',
  reviews: 'b.review_count',
  priority: "CASE b.priority WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END",
};

function buildWhere(f: BusinessFilters, orgId: string) {
  const where: string[] = ['b.org_id = ?', 'b.merged_into IS NULL'];
  const params: unknown[] = [orgId];
  const inList = (column: string, value: string | string[]) => {
    const arr = Array.isArray(value) ? value : [value];
    where.push(`${column} IN (${arr.map(() => '?').join(',')})`);
    params.push(...arr);
  };

  if (f.excludeArchived !== false) where.push('b.is_archived = 0');
  if (f.demoOnly) where.push('b.is_demo = 1');
  if (f.excludeDemo) where.push('b.is_demo = 0');
  if (f.stage) inList('b.stage', f.stage);
  if (f.stages?.length) inList('b.stage', f.stages);
  if (f.priority) inList('b.priority', f.priority);
  if (f.websiteStatus) inList('b.website_status', f.websiteStatus);
  if (f.minScore !== undefined) {
    where.push('b.opportunity_score >= ?');
    params.push(f.minScore);
  }
  if (f.maxScore !== undefined) {
    where.push('b.opportunity_score <= ?');
    params.push(f.maxScore);
  }
  if (f.industry) {
    where.push('LOWER(COALESCE(b.industry,\'\')) = LOWER(?)');
    params.push(f.industry);
  }
  if (f.category) {
    where.push('LOWER(COALESCE(b.category,\'\')) = LOWER(?)');
    params.push(f.category);
  }
  if (f.hasContact === true) where.push('EXISTS (SELECT 1 FROM contacts c WHERE c.business_id = b.id)');
  if (f.hasContact === false) where.push('NOT EXISTS (SELECT 1 FROM contacts c WHERE c.business_id = b.id)');
  if (f.minRevenuePotential !== undefined) {
    where.push('b.revenue_potential >= ?');
    params.push(f.minRevenuePotential);
  }
  if (f.discoveredAfter) {
    where.push('b.first_discovered_at >= ?');
    params.push(f.discoveredAfter);
  }
  if (f.discoveredBefore) {
    where.push('b.first_discovered_at <= ?');
    params.push(f.discoveredBefore);
  }
  if (f.lastActivityAfter) {
    where.push('b.updated_at >= ?');
    params.push(f.lastActivityAfter);
  }
  if (f.ownerId) {
    where.push('b.owner_id = ?');
    params.push(f.ownerId);
  }
  if (f.outreachStatus === 'none') {
    where.push('NOT EXISTS (SELECT 1 FROM outreach_messages o WHERE o.business_id = b.id)');
  } else if (f.outreachStatus === 'sent') {
    where.push("EXISTS (SELECT 1 FROM outreach_messages o WHERE o.business_id = b.id AND o.status IN ('sent','delivered','opened','clicked'))");
  } else if (f.outreachStatus === 'replied') {
    where.push("EXISTS (SELECT 1 FROM outreach_messages o WHERE o.business_id = b.id AND o.status = 'replied')");
  } else if (f.outreachStatus === 'draft') {
    where.push("EXISTS (SELECT 1 FROM outreach_messages o WHERE o.business_id = b.id AND o.status IN ('draft','queued','approved'))");
  }
  if (f.mockupStatus === 'none') {
    where.push('NOT EXISTS (SELECT 1 FROM mockups m WHERE m.business_id = b.id)');
  } else if (f.mockupStatus) {
    where.push('EXISTS (SELECT 1 FROM mockups m WHERE m.business_id = b.id AND m.status = ?)');
    params.push(f.mockupStatus);
  }
  if (f.callStatus) {
    where.push("EXISTS (SELECT 1 FROM calls cl WHERE cl.business_id = b.id AND cl.status = ?)");
    params.push(f.callStatus);
  }
  if (f.proposalStatus) {
    where.push('EXISTS (SELECT 1 FROM proposals p WHERE p.business_id = b.id AND p.status = ?)');
    params.push(f.proposalStatus);
  }
  if (f.clientStatus) {
    where.push('EXISTS (SELECT 1 FROM clients c2 WHERE c2.business_id = b.id AND c2.status = ?)');
    params.push(f.clientStatus);
  }
  if (f.projectStatus) {
    where.push('EXISTS (SELECT 1 FROM projects pr WHERE pr.business_id = b.id AND pr.status = ?)');
    params.push(f.projectStatus);
  }
  if (f.q) {
    const term = f.q.trim();
    where.push(`(b.name LIKE ? OR COALESCE(b.industry,'') LIKE ? OR COALESCE(b.category,'') LIKE ?
                 OR COALESCE(b.locality,'') LIKE ? OR COALESCE(b.description,'') LIKE ?
                 OR EXISTS (SELECT 1 FROM businesses_fts f WHERE f.rowid = b.rowid AND businesses_fts MATCH ?))`);
    const like = `%${term}%`;
    let fts: string | null = `"${term.replace(/"/g, '')}"*`;
    try {
      // Validate the FTS expression; fall back to LIKE-only matching if invalid.
      const probe = scalar<number>('SELECT COUNT(*) FROM businesses_fts WHERE businesses_fts MATCH ?', [fts]);
      if (probe === null) fts = null;
    } catch {
      fts = null;
    }
    params.push(like, like, like, like, like, fts ?? '__never_match__');
  }
  return { where: where.join(' AND '), params };
}

export interface BusinessListResult {
  rows: (Business & { contact_count?: number; mockup_status?: string | null })[];
  total: number;
}

export function listBusinesses(orgId: string, filters: BusinessFilters = {}): BusinessListResult {
  const { where, params } = buildWhere(filters, orgId);
  const total = scalar<number>(`SELECT COUNT(*) FROM businesses b WHERE ${where}`, params) ?? 0;
  const sortCol = SORT_COLUMNS[filters.sortBy ?? 'score'] ?? 'b.opportunity_score';
  const dir = filters.sortDir === 'asc' ? 'ASC' : 'DESC';
  const rows = all<Record<string, unknown>>(
    `SELECT b.*,
            (SELECT COUNT(*) FROM contacts c WHERE c.business_id = b.id) AS contact_count,
            (SELECT m.status FROM mockups m WHERE m.business_id = b.id ORDER BY m.created_at DESC LIMIT 1) AS mockup_status
       FROM businesses b
      WHERE ${where}
      ORDER BY ${sortCol} ${dir}, b.created_at DESC
      LIMIT ? OFFSET ?`,
    [...params, filters.limit ?? 50, filters.offset ?? 0]
  );
  return { rows: rows.map((r) => hydrateBusiness(r) as Business & Record<string, unknown>), total };
}

export function countBusinesses(orgId: string, filters: BusinessFilters = {}): number {
  const { where, params } = buildWhere(filters, orgId);
  return scalar<number>(`SELECT COUNT(*) FROM businesses b WHERE ${where}`, params) ?? 0;
}

export function stageCounts(orgId: string): Record<string, number> {
  const rows = all<{ stage: string; c: number }>(
    `SELECT stage, COUNT(*) c FROM businesses WHERE org_id = ? AND merged_into IS NULL AND is_archived = 0 GROUP BY stage`,
    [orgId]
  );
  return Object.fromEntries(rows.map((r) => [r.stage, r.c]));
}

export function priorityCounts(orgId: string): Record<string, number> {
  const rows = all<{ priority: string; c: number }>(
    `SELECT priority, COUNT(*) c FROM businesses WHERE org_id = ? AND merged_into IS NULL AND is_archived = 0 GROUP BY priority`,
    [orgId]
  );
  return Object.fromEntries(rows.map((r) => [r.priority, r.c]));
}

export function industryBreakdown(orgId: string, limit = 12) {
  return all<{ industry: string; c: number; avg_score: number }>(
    `SELECT COALESCE(industry, 'Uncategorised') industry, COUNT(*) c, ROUND(AVG(opportunity_score),1) avg_score
       FROM businesses WHERE org_id = ? AND merged_into IS NULL AND is_archived = 0
      GROUP BY industry ORDER BY c DESC LIMIT ?`,
    [orgId, limit]
  );
}

export function distinctValues(orgId: string, column: 'industry' | 'category' | 'locality'): string[] {
  if (!['industry', 'category', 'locality'].includes(column)) return [];
  return all<{ v: string }>(
    `SELECT DISTINCT ${column} v FROM businesses WHERE org_id = ? AND ${column} IS NOT NULL AND ${column} <> '' ORDER BY v`,
    [orgId]
  ).map((r) => r.v);
}

export function setPriorityFromScore(orgId: string, businessId: string, score: number, thresholds?: Record<Priority, number>): void {
  const priority = priorityFromScore(score, thresholds);
  run('UPDATE businesses SET priority = ?, opportunity_score = ?, updated_at = ? WHERE id = ?', [
    priority,
    score,
    nowIso(),
    businessId,
  ]);
}

/** Deterministic pseudo-random helper for demo data generation (§73). */
export function demoRandom(seed: string): () => number {
  return seededRandom(seed);
}

export { JSON_COLS };
