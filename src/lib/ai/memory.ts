/**
 * Business-level AI memory (§44).
 *
 * Every prompt about a business is assembled through `businessContext()`, which
 * merges hard record data with remembered facts, objections and preferences.
 * Because the context is built from stored evidence, generated copy cannot
 * contradict what we already know — and unknown facts are simply absent rather
 * than invented.
 */
import { all, get, json, run, toJson } from '@/db';
import { id, nowIso } from '@/lib/id';
import type { Business, Contact } from '@/repo/business';

export type MemoryKind = 'fact' | 'preference' | 'objection' | 'commitment' | 'history';

export interface MemoryEntry {
  id: string;
  business_id: string;
  kind: MemoryKind;
  key: string;
  value: string;
  confidence: number;
  source: string | null;
  pinned: number;
  created_at: string;
}

export function remember(
  orgId: string,
  businessId: string,
  kind: MemoryKind,
  key: string,
  value: string,
  opts: { confidence?: number; source?: string; pinned?: boolean } = {}
): string {
  const existing = get<{ id: string }>('SELECT id FROM ai_memory WHERE business_id = ? AND kind = ? AND key = ?', [
    businessId,
    kind,
    key,
  ]);
  if (existing) {
    run('UPDATE ai_memory SET value = ?, confidence = ?, source = ?, updated_at = ? WHERE id = ?', [
      value,
      opts.confidence ?? 0.85,
      opts.source ?? null,
      nowIso(),
      existing.id,
    ]);
    return existing.id;
  }
  const memoryId = id('mem');
  run(
    `INSERT INTO ai_memory (id, org_id, business_id, kind, key, value, confidence, source, pinned, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [
      memoryId, orgId, businessId, kind, key, value, opts.confidence ?? 0.85,
      opts.source ?? null, opts.pinned ? 1 : 0, nowIso(), nowIso(),
    ]
  );
  return memoryId;
}

export function recall(orgId: string, businessId: string, kinds?: MemoryKind[]): MemoryEntry[] {
  if (kinds?.length) {
    return all<MemoryEntry>(
      `SELECT * FROM ai_memory WHERE org_id = ? AND business_id = ? AND superseded_by IS NULL
         AND kind IN (${kinds.map(() => '?').join(',')}) ORDER BY pinned DESC, updated_at DESC`,
      [orgId, businessId, ...kinds]
    );
  }
  return all<MemoryEntry>(
    `SELECT * FROM ai_memory WHERE org_id = ? AND business_id = ? AND superseded_by IS NULL
      ORDER BY pinned DESC, updated_at DESC`,
    [orgId, businessId]
  );
}

export function forget(orgId: string, businessId: string, kind: MemoryKind, key: string): void {
  run('UPDATE ai_memory SET superseded_by = id, updated_at = ? WHERE org_id = ? AND business_id = ? AND kind = ? AND key = ?', [
    nowIso(),
    orgId,
    businessId,
    kind,
    key,
  ]);
}

export interface BusinessContext {
  business: Business;
  contact: Contact | null;
  audit: Record<string, unknown> | null;
  socialAudit: Record<string, unknown> | null;
  competitors: Record<string, unknown>[];
  research: Record<string, unknown> | null;
  memories: MemoryEntry[];
  outreachHistory: { channel: string; subject: string | null; status: string; sent_at: string | null; body: string; direction: string }[];
  replies: string[];
  objections: string[];
  calls: { title: string; scheduled_at: string | null; summary: string | null }[];
  mockups: { title: string; version: number; status: string; view_count: number }[];
  proposals: { number: string; status: string; total: number }[];
  project: Record<string, unknown> | null;
  signals: string[];
  /** Facts that are unknown — generators must omit rather than invent these. */
  unknowns: string[];
}

/**
 * Assembles the full grounded context for a business. This is the single source
 * of truth every AI task is prompted from.
 */
export function businessContext(orgId: string, businessId: string): BusinessContext | null {
  const business = get<Record<string, unknown>>('SELECT * FROM businesses WHERE id = ? AND org_id = ?', [
    businessId,
    orgId,
  ]);
  if (!business) return null;
  const biz = { ...business, social: json<Record<string, string>>(business.social as string, {}) } as unknown as Business;

  const contact = get<Contact>(
    `SELECT * FROM contacts WHERE org_id = ? AND business_id = ? ORDER BY is_decision_maker DESC, confidence DESC LIMIT 1`,
    [orgId, businessId]
  );
  const audit = get<Record<string, unknown>>(
    'SELECT * FROM digital_audits WHERE business_id = ? ORDER BY created_at DESC LIMIT 1',
    [businessId]
  );
  const socialAudit = get<Record<string, unknown>>(
    'SELECT * FROM social_audits WHERE business_id = ? ORDER BY created_at DESC LIMIT 1',
    [businessId]
  );
  const competitors = all<Record<string, unknown>>(
    'SELECT * FROM competitors WHERE business_id = ? ORDER BY gap_score DESC LIMIT 5',
    [businessId]
  );
  const research = get<Record<string, unknown>>(
    'SELECT * FROM research_docs WHERE business_id = ? ORDER BY generated_at DESC LIMIT 1',
    [businessId]
  );
  const memories = recall(orgId, businessId);
  const outreachHistory = all<{ channel: string; subject: string | null; status: string; sent_at: string | null; body: string; direction: string }>(
    `SELECT channel, subject, status, sent_at, body, direction FROM outreach_messages
      WHERE business_id = ? ORDER BY created_at DESC LIMIT 10`,
    [businessId]
  );
  const replies = all<{ body: string }>(
    `SELECT body FROM outreach_messages WHERE business_id = ? AND direction = 'inbound' ORDER BY created_at DESC LIMIT 10`,
    [businessId]
  ).map((r) => r.body);
  const calls = all<{ title: string; scheduled_at: string | null; ai_summary: string | null }>(
    'SELECT title, scheduled_at, ai_summary FROM calls WHERE business_id = ? ORDER BY created_at DESC LIMIT 5',
    [businessId]
  ).map((c) => ({ title: c.title, scheduled_at: c.scheduled_at, summary: c.ai_summary }));
  const mockups = all<{ title: string; current_version: number; status: string; view_count: number }>(
    'SELECT title, current_version, status, view_count FROM mockups WHERE business_id = ? ORDER BY created_at DESC LIMIT 5',
    [businessId]
  ).map((m) => ({ title: m.title, version: m.current_version, status: m.status, view_count: m.view_count }));
  const proposals = all<{ number: string; status: string; total: number }>(
    'SELECT number, status, total FROM proposals WHERE business_id = ? ORDER BY created_at DESC LIMIT 5',
    [businessId]
  );
  const project = get<Record<string, unknown>>(
    'SELECT * FROM projects WHERE business_id = ? ORDER BY created_at DESC LIMIT 1',
    [businessId]
  );

  const signals = audit ? json<string[]>(audit.signals as string, []) : [];
  const objections = memories.filter((m) => m.kind === 'objection').map((m) => m.value);

  const unknowns: string[] = [];
  if (!biz.website) unknowns.push('website');
  if (!biz.rating) unknowns.push('public rating');
  if (!contact) unknowns.push('named contact');
  if (!biz.industry) unknowns.push('industry');
  if (!biz.description) unknowns.push('business description');

  return {
    business: biz,
    contact,
    audit,
    socialAudit,
    competitors,
    research,
    memories,
    outreachHistory,
    replies,
    objections,
    calls,
    mockups,
    proposals,
    project,
    signals: signals.map((s) => (typeof s === 'string' ? s : String((s as { label?: string })?.label ?? s))),
    unknowns,
  };
}

/**
 * Renders context as a compact, labelled prompt block. Anything absent is
 * explicitly listed as unknown so the model omits it instead of guessing.
 */
export function contextPrompt(ctx: BusinessContext): string {
  const b = ctx.business;
  const a = ctx.audit;
  const social = ctx.socialAudit;
  const lines: string[] = ['## Verified business record'];
  lines.push(`Name: ${b.name}`);
  if (b.category) lines.push(`Category: ${b.category}`);
  if (b.industry) lines.push(`Industry: ${b.industry}`);
  if (b.description) lines.push(`Description: ${b.description}`);
  if (b.locality || b.region) lines.push(`Location: ${[b.locality, b.region, b.country].filter(Boolean).join(', ')}`);
  lines.push(`Website: ${b.website ?? 'none on record'}`);
  lines.push(`Website status: ${b.website_status}`);
  if (b.rating) lines.push(`Public rating: ${b.rating}${b.review_count ? ` from ${b.review_count} reviews` : ''}`);
  if (b.phone) lines.push(`Phone: ${b.phone}`);
  const socials = Object.entries(b.social ?? {});
  lines.push(`Social profiles: ${socials.length ? socials.map(([k, v]) => `${k} (${v})`).join(', ') : 'none on record'}`);

  if (ctx.contact) {
    lines.push('', '## Best contact');
    lines.push(`${ctx.contact.full_name}${ctx.contact.job_title ? ` — ${ctx.contact.job_title}` : ''}`);
    lines.push(`Email: ${ctx.contact.email ?? 'unknown'} (status: ${ctx.contact.email_status})`);
  }

  if (a) {
    lines.push('', '## Website audit (measured)');
    lines.push(`Website score: ${a.website_score ?? 'n/a'}`);
    const sigs = json<{ key: string; label: string; evidence?: string }[]>(a.signals as string, []);
    for (const s of sigs.slice(0, 12)) lines.push(`- ${s.label}${s.evidence ? ` (${s.evidence})` : ''}`);
    if (a.title) lines.push(`Page title: ${a.title}`);
    if (a.meta_description) lines.push(`Meta description: ${String(a.meta_description).slice(0, 140)}`);
  }

  if (social) {
    lines.push('', '## Social audit');
    lines.push(`Social score: ${social.social_score ?? 'n/a'}`);
    const platforms = json<{ platform: string; last_activity_days?: number | null }[]>(social.platforms as string, []);
    for (const p of platforms.slice(0, 6)) {
      lines.push(`- ${p.platform}${p.last_activity_days != null ? `, last activity ${p.last_activity_days}d ago` : ''}`);
    }
  }

  if (ctx.competitors.length) {
    lines.push('', '## Competitors identified');
    for (const c of ctx.competitors.slice(0, 3)) {
      lines.push(`- ${c.name}${c.website ? ` (${c.website})` : ''}${c.gap_summary ? ` — ${c.gap_summary}` : ''}`);
    }
  }

  if (ctx.memories.length) {
    lines.push('', '## Remembered context');
    for (const m of ctx.memories.slice(0, 15)) lines.push(`- [${m.kind}] ${m.key}: ${m.value}`);
  }

  if (ctx.outreachHistory.length) {
    lines.push('', '## Outreach already sent');
    for (const o of ctx.outreachHistory.slice(0, 5)) {
      lines.push(`- ${o.channel}${o.subject ? ` "${o.subject}"` : ''} — ${o.status}${o.sent_at ? ` on ${o.sent_at.slice(0, 10)}` : ''}`);
    }
  }

  if (ctx.replies.length) {
    lines.push('', '## Their replies');
    for (const r of ctx.replies.slice(0, 3)) lines.push(`- ${r.slice(0, 220)}`);
  }

  if (ctx.objections.length) {
    lines.push('', '## Objections raised');
    for (const o of ctx.objections.slice(0, 5)) lines.push(`- ${o}`);
  }

  lines.push('', '## Not known (do not invent)');
  lines.push(ctx.unknowns.length ? ctx.unknowns.join(', ') : 'nothing material');

  return lines.join('\n');
}

/** Persists the durable parts of a context into memory after an interaction. */
export function learnFromInteraction(
  orgId: string,
  businessId: string,
  kind: MemoryKind,
  facts: Record<string, string>,
  source = 'interaction'
): void {
  for (const [key, value] of Object.entries(facts)) {
    if (value) remember(orgId, businessId, kind, key, value, { source });
  }
}

export function memoryStats(orgId: string) {
  return get<{ total: number; businesses: number }>(
    'SELECT COUNT(*) total, COUNT(DISTINCT business_id) businesses FROM ai_memory WHERE org_id = ? AND superseded_by IS NULL',
    [orgId]
  ) ?? { total: 0, businesses: 0 };
}

export { toJson };
