/**
 * Import / export (§53) and safe bulk actions (§52).
 *
 * Imports are validated and deduplicated before anything is written — the same
 * duplicate engine the discovery pipeline uses, so an imported list cannot
 * create shadow records of businesses we already know.
 *
 * Bulk actions that have an external consequence (sending outreach) are never
 * executed by this module; they are queued for approval.
 */
import { all, get, json, run, scalar, toJson } from '@/db';
import { id, normalizeDomain, normalizeEmail, normalizePhone, nowIso, slugify } from '@/lib/id';
import { logActivity } from '@/lib/activity';
import { audit, logAutomation } from '@/lib/logging';
import { createBusiness, findDuplicates, listBusinesses, mergeBusinesses, recordDuplicateEvent, updateBusiness, type BusinessFilters } from '@/repo/business';
import { stageImport } from '@/lib/providers/data';
import { canContact } from './compliance';
import { getSettings } from '@/lib/settings';

export interface ImportRow {
  name: string;
  website?: string;
  phone?: string;
  email?: string;
  industry?: string;
  category?: string;
  description?: string;
  addressLine?: string;
  locality?: string;
  region?: string;
  country?: string;
  rating?: number;
  reviewCount?: number;
}

export interface ImportResult {
  batchId: string;
  rowsTotal: number;
  imported: number;
  deduplicated: number;
  invalid: number;
  errors: { row: number; field: string; message: string }[];
}

const REQUIRED = ['name'] as const;

/** Validates rows, deduplicates against the existing hub, then inserts. */
export function importRows(orgId: string, rows: ImportRow[], opts: { filename?: string; source?: string; actor?: string } = {}): ImportResult {
  const batchId = id('imp');
  const now = nowIso();
  const errors: { row: number; field: string; message: string }[] = [];
  let imported = 0;
  let deduplicated = 0;
  let invalid = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNo = i + 2; // 1-indexed plus header

    if (!row.name?.trim()) {
      invalid++;
      errors.push({ row: rowNo, field: 'name', message: 'Business name is required.' });
      continue;
    }
    const email = normalizeEmail(row.email ?? null);
    if (row.email && !email) {
      errors.push({ row: rowNo, field: 'email', message: `"${row.email}" is not a valid email — stored without it.` });
    }
    const phone = normalizePhone(row.phone ?? null);
    if (row.phone && !phone) {
      errors.push({ row: rowNo, field: 'phone', message: `"${row.phone}" does not look like a phone number — stored as-is for review.` });
    }
    if (row.rating !== undefined && (row.rating < 0 || row.rating > 5)) {
      errors.push({ row: rowNo, field: 'rating', message: `Rating ${row.rating} is outside 0–5 — ignored.` });
      row.rating = undefined;
    }

    // Deduplicate before creating (§11, §53).
    const domain = normalizeDomain(row.website ?? null);
    const matches = findDuplicates(orgId, {
      name: row.name,
      domain,
      email,
      phone,
      addressLine: row.addressLine ?? null,
      locality: row.locality ?? null,
      social: {},
    });

    if (matches.length && matches[0].score >= 0.93) {
      const match = matches[0];
      recordDuplicateEvent(orgId, match.id, null, row.name, match.method, match.score, { ...match.evidence, importBatch: batchId }, 'skipped');
      deduplicated++;
      continue;
    }

    const { created } = createBusiness(
      orgId,
      {
        name: row.name.trim(),
        website: row.website ?? null,
        phone: row.phone ?? null,
        email,
        industry: row.industry ?? null,
        category: row.category ?? null,
        description: row.description ?? null,
        addressLine: row.addressLine ?? null,
        locality: row.locality ?? null,
        region: row.region ?? null,
        country: row.country ?? null,
        rating: row.rating ?? null,
        reviewCount: row.reviewCount ?? null,
      },
      {
        providerKey: opts.source ?? 'import.csv',
        sourceUrl: null,
        externalId: `import:${batchId}:${rowNo}`,
        // Imported data is asserted by the user, not verified by us.
        confidence: 0.6,
      }
    );
    if (created) imported++;
    else deduplicated++;
  }

  run(
    `INSERT INTO import_batches (id, org_id, filename, format, rows_total, rows_imported, rows_deduped, rows_invalid, errors, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,'complete',?)`,
    [batchId, orgId, opts.filename ?? null, 'csv', rows.length, imported, deduplicated, invalid, toJson(errors), now]
  );

  logActivity(orgId, 'discovery', `Import complete — ${imported} added, ${deduplicated} duplicates skipped`, {
    actor: opts.actor ?? 'user',
    detail: `${rows.length} row(s) from ${opts.filename ?? 'import'}${invalid ? ` · ${invalid} invalid` : ''}`,
    entityType: 'import_batch',
    entityId: batchId,
  });
  audit(orgId, 'import.completed', {
    actor: opts.actor ?? 'user',
    entityType: 'import_batch',
    entityId: batchId,
    detail: { rows: rows.length, imported, deduplicated, invalid },
  });

  return { batchId, rowsTotal: rows.length, imported, deduplicated, invalid, errors };
}

/** Minimal RFC-4180-ish CSV parser — handles quoted fields and escaped quotes. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }

  const filtered = rows.filter((r) => r.some((c) => c.trim() !== ''));
  if (!filtered.length) return [];
  const headers = filtered[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  return filtered.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()])));
}

const FIELD_ALIASES: Record<string, keyof ImportRow> = {
  name: 'name',
  business_name: 'name',
  company: 'name',
  company_name: 'name',
  business: 'name',
  website: 'website',
  url: 'website',
  site: 'website',
  domain: 'website',
  phone: 'phone',
  telephone: 'phone',
  phone_number: 'phone',
  email: 'email',
  email_address: 'email',
  industry: 'industry',
  category: 'category',
  business_category: 'category',
  description: 'description',
  about: 'description',
  address: 'addressLine',
  address_line: 'addressLine',
  street: 'addressLine',
  city: 'locality',
  locality: 'locality',
  town: 'locality',
  state: 'region',
  region: 'region',
  country: 'country',
  rating: 'rating',
  stars: 'rating',
  review_count: 'reviewCount',
  reviews: 'reviewCount',
};

export function csvToImportRows(records: Record<string, string>[]): { rows: ImportRow[]; unmapped: string[] } {
  const unmapped = new Set<string>();
  const rows: ImportRow[] = [];
  for (const rec of records) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rec)) {
      const mapped = FIELD_ALIASES[key];
      if (!mapped) {
        unmapped.add(key);
        continue;
      }
      if ((mapped === 'rating' || mapped === 'reviewCount') && value) {
        const n = Number(value);
        if (Number.isFinite(n)) out[mapped] = n;
      } else if (value) {
        out[mapped] = value;
      }
    }
    if (out.name) rows.push(out as unknown as ImportRow);
  }
  return { rows, unmapped: Array.from(unmapped) };
}

/** Stages rows for the import discovery provider instead of writing directly. */
export function stageCsvImport(orgId: string, rows: ImportRow[]): number {
  stageImport(
    orgId,
    rows.map((r) => ({
      name: r.name,
      website: r.website ?? null,
      phone: r.phone ?? null,
      email: r.email ?? null,
      industry: r.industry ?? null,
      category: r.category ?? null,
      description: r.description ?? null,
      addressLine: r.addressLine ?? null,
      locality: r.locality ?? null,
      region: r.region ?? null,
      country: r.country ?? null,
      rating: r.rating ?? null,
      reviewCount: r.reviewCount ?? null,
      sourceUrl: null,
      externalId: `staged:${slugify(r.name)}`,
      confidence: 0.6,
    }))
  );
  return rows.length;
}

// ── Export (§53) ─────────────────────────────────────────────
export function exportBusinessesCsv(orgId: string, filters: BusinessFilters = {}): string {
  const { rows } = listBusinesses(orgId, { ...filters, limit: 10_000 });
  const headers = [
    'name', 'industry', 'category', 'locality', 'region', 'country', 'website', 'website_status', 'phone', 'email',
    'rating', 'review_count', 'opportunity_score', 'priority', 'stage', 'recommended_service', 'revenue_potential',
    'contact_count', 'mockup_status', 'first_discovered_at', 'is_demo',
  ];
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push(headers.map((h) => esc((r as unknown as Record<string, unknown>)[h])).join(','));
  }
  return lines.join('\n');
}

export function exportProspectsJson(orgId: string, filters: BusinessFilters = {}) {
  const { rows } = listBusinesses(orgId, { ...filters, limit: 10_000 });
  return rows.map((r) => ({
    name: r.name,
    industry: r.industry,
    category: r.category,
    locality: r.locality,
    website: r.website,
    websiteStatus: r.website_status,
    phone: r.phone,
    email: r.email,
    rating: r.rating,
    reviewCount: r.review_count,
    opportunityScore: r.opportunity_score,
    priority: r.priority,
    stage: r.stage,
    recommendedService: r.recommended_service,
    revenuePotential: r.revenue_potential,
    isDemo: r.is_demo === 1,
  }));
}

// ── Bulk actions (§52) ───────────────────────────────────────
export type BulkAction =
  | 'qualify'
  | 'enrich'
  | 'generate_outreach'
  | 'generate_mockups'
  | 'add_to_sequence'
  | 'assign_owner'
  | 'change_stage'
  | 'export'
  | 'archive';

/** Actions with an external consequence require an explicit confirmation token. */
export const EXTERNAL_ACTIONS: BulkAction[] = ['generate_outreach', 'add_to_sequence'];

export interface BulkPreview {
  action: BulkAction;
  affected: number;
  requiresConfirmation: boolean;
  warnings: string[];
  sample: { id: string; name: string }[];
}

export function previewBulkAction(orgId: string, action: BulkAction, businessIds: string[]): BulkPreview {
  const businesses = all<{ id: string; name: string; consent_state: string; stage: string; email: string | null; phone: string | null }>(
    `SELECT id, name, consent_state, stage, email, phone FROM businesses WHERE org_id = ? AND id IN (${businessIds.map(() => '?').join(',')})`,
    [orgId, ...businessIds]
  );
  const warnings: string[] = [];

  if (action === 'generate_outreach' || action === 'add_to_sequence') {
    const blocked = businesses.filter((b) => ['opted_out', 'do_not_contact'].includes(b.consent_state));
    if (blocked.length) warnings.push(`${blocked.length} business(es) are on the do-not-contact or opt-out list and will be skipped.`);
    const unreachable = businesses.filter((b) => !b.email && !b.phone);
    if (unreachable.length) warnings.push(`${unreachable.length} business(es) have no contact details and cannot receive outreach.`);
    const clients = businesses.filter((b) => ['won', 'onboarding', 'delivery', 'active_client', 'expansion'].includes(b.stage));
    if (clients.length) warnings.push(`${clients.length} are already clients — acquisition outreach is inappropriate and will be skipped.`);
    const settings = getSettings(orgId);
    if (businesses.length > settings.outreach.dailySendLimit) {
      warnings.push(`This exceeds the daily send limit of ${settings.outreach.dailySendLimit}. Sends will be spread across days.`);
    }
  }
  if (action === 'generate_mockups' && businesses.length > 25) {
    warnings.push(`${businesses.length} concepts is a large batch — generation is sequential and will take a while.`);
  }
  if (action === 'archive' && businesses.length > 50) {
    warnings.push(`Archiving ${businesses.length} records. This is reversible but hides them from every queue.`);
  }

  return {
    action,
    affected: businesses.length,
    requiresConfirmation: EXTERNAL_ACTIONS.includes(action) || action === 'archive',
    warnings,
    sample: businesses.slice(0, 8).map((b) => ({ id: b.id, name: b.name })),
  };
}

export interface BulkResult {
  action: BulkAction;
  processed: number;
  skipped: number;
  queued: number;
  errors: string[];
  requiresApproval: boolean;
  message: string;
}

/**
 * Executes a bulk action. External actions are queued, never sent inline, so a
 * bulk click cannot trigger uncontrolled outreach (§18, §52).
 */
export async function runBulkAction(
  orgId: string,
  action: BulkAction,
  businessIds: string[],
  opts: { confirmed?: boolean; sequenceId?: string; ownerId?: string; stage?: string; actor?: string } = {}
): Promise<BulkResult> {
  const preview = previewBulkAction(orgId, action, businessIds);
  if (preview.requiresConfirmation && !opts.confirmed) {
    return {
      action,
      processed: 0,
      skipped: 0,
      queued: 0,
      errors: [],
      requiresApproval: true,
      message: `This action needs confirmation. ${preview.affected} business(es) affected.${preview.warnings.length ? ` Warnings: ${preview.warnings.join(' ')}` : ''}`,
    };
  }

  const businesses = all<{ id: string; name: string; consent_state: string; stage: string }>(
    `SELECT id, name, consent_state, stage FROM businesses WHERE org_id = ? AND id IN (${businessIds.map(() => '?').join(',')})`,
    [orgId, ...businessIds]
  );

  let processed = 0;
  let skipped = 0;
  let queued = 0;
  const errors: string[] = [];
  const now = nowIso();

  for (const b of businesses) {
    try {
      switch (action) {
        case 'qualify': {
          if (b.stage !== 'discovered') {
            skipped++;
            continue;
          }
          run("UPDATE businesses SET stage = 'qualified', updated_at = ? WHERE id = ?", [now, b.id]);
          logActivity(orgId, 'stage_change', `${b.name} → qualified`, { businessId: b.id, actor: opts.actor ?? 'user', detail: 'Bulk qualification' });
          processed++;
          break;
        }
        case 'assign_owner': {
          run('UPDATE businesses SET owner_id = ?, updated_at = ? WHERE id = ?', [opts.ownerId ?? null, now, b.id]);
          processed++;
          break;
        }
        case 'change_stage': {
          if (!opts.stage) {
            errors.push('No target stage supplied.');
            break;
          }
          run('UPDATE businesses SET stage = ?, updated_at = ? WHERE id = ?', [opts.stage, now, b.id]);
          logActivity(orgId, 'stage_change', `${b.name} → ${opts.stage.replace(/_/g, ' ')}`, { businessId: b.id, actor: opts.actor ?? 'user', detail: 'Bulk stage change' });
          processed++;
          break;
        }
        case 'archive': {
          run('UPDATE businesses SET is_archived = 1, archived_reason = ?, updated_at = ? WHERE id = ?', ['Bulk archive', now, b.id]);
          processed++;
          break;
        }
        case 'generate_outreach': {
          if (['opted_out', 'do_not_contact'].includes(b.consent_state) || ['won', 'onboarding', 'delivery', 'active_client', 'expansion'].includes(b.stage)) {
            skipped++;
            continue;
          }
          const { generateOutreach } = await import('./outreach');
          const res = await generateOutreach(orgId, b.id, { channel: 'email', purpose: 'intro', actor: 'bulk' });
          if (res?.messageId && res.compliance.allowed) queued++;
          else skipped++;
          break;
        }
        case 'add_to_sequence': {
          if (!opts.sequenceId) {
            errors.push('No sequence supplied.');
            break;
          }
          if (['opted_out', 'do_not_contact'].includes(b.consent_state) || ['won', 'onboarding', 'delivery', 'active_client', 'expansion'].includes(b.stage)) {
            skipped++;
            continue;
          }
          const { enroll } = await import('./outreach');
          const res = enroll(orgId, opts.sequenceId, b.id, { actor: 'bulk' });
          if (res.ok) queued++;
          else skipped++;
          break;
        }
        case 'generate_mockups': {
          const existing = scalar<number>('SELECT COUNT(*) FROM mockups WHERE business_id = ?', [b.id]) ?? 0;
          if (existing > 0) {
            skipped++;
            continue;
          }
          const { generateMockup } = await import('./mockup');
          await generateMockup(orgId, b.id, { actor: 'bulk' });
          processed++;
          break;
        }
        case 'enrich': {
          const { recomputeDataConfidence } = await import('./discovery');
          recomputeDataConfidence(orgId, b.id);
          processed++;
          break;
        }
        case 'export': {
          processed++;
          break;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${b.name}: ${message}`);
      logAutomation(orgId, 'system', `Bulk ${action} failed for ${b.name}: ${message}`, {
        level: 'error',
        entityType: 'business',
        entityId: b.id,
        retryable: true,
      });
    }
  }

  audit(orgId, `bulk.${action}`, {
    actor: opts.actor ?? 'user',
    detail: { processed, skipped, queued, errors: errors.length },
    severity: EXTERNAL_ACTIONS.includes(action) ? 'warn' : 'info',
  });
  logActivity(orgId, 'discovery', `Bulk ${action.replace(/_/g, ' ')} — ${processed + queued} processed, ${skipped} skipped`, {
    actor: opts.actor ?? 'user',
    detail: errors.length ? `${errors.length} error(s)` : undefined,
  });

  const message =
    action === 'generate_outreach'
      ? `${queued} draft(s) queued for approval. Nothing was sent — approve them individually in Outreach.`
      : action === 'add_to_sequence'
        ? `${queued} prospect(s) enrolled. First touches are scheduled outside quiet hours.`
        : `${processed} processed, ${skipped} skipped${errors.length ? `, ${errors.length} error(s)` : ''}.`;

  return { action, processed, skipped, queued, errors, requiresApproval: false, message };
}

/** Merge a duplicate into its keeper from the UI (§11). */
export function mergeDuplicate(orgId: string, keepId: string, dropId: string, actor = 'user') {
  const result = mergeBusinesses(orgId, keepId, dropId, 'manual', 1);
  if (result.ok) {
    audit(orgId, 'business.merged', { actor, entityType: 'business', entityId: keepId, detail: { dropped: dropId, moved: result.moved } });
    logActivity(orgId, 'discovery', 'Duplicate merged', { businessId: keepId, actor, detail: `${dropId} merged into ${keepId}` });
  }
  return result;
}

export interface ImportBatchRow {
  id: string;
  org_id: string;
  filename: string | null;
  format: string;
  rows_total: number;
  rows_imported: number;
  rows_deduped: number;
  rows_invalid: number;
  status: string;
  created_at: string;
  errors: unknown[];
}

export function listImportBatches(orgId: string, limit = 50): ImportBatchRow[] {
  return all<Omit<ImportBatchRow, 'errors'> & { errors: string }>(
    'SELECT * FROM import_batches WHERE org_id = ? ORDER BY created_at DESC LIMIT ?',
    [orgId, limit]
  ).map((b) => ({ ...b, errors: json<unknown[]>(b.errors, []) }));
}

// ── Webhooks / API ingestion (§53) ───────────────────────────
/**
 * Accepts a webhook payload from an external CRM or data provider.
 * Payloads are normalised through the same validation path as CSV imports.
 */
export function ingestWebhook(orgId: string, payload: unknown, source = 'webhook'): ImportResult {
  const rows: ImportRow[] = [];
  const list = Array.isArray(payload) ? payload : [payload];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const name = (rec.name ?? rec.business_name ?? rec.company ?? rec.title) as string | undefined;
    if (!name) continue;
    rows.push({
      name: String(name),
      website: (rec.website ?? rec.url ?? rec.domain) as string | undefined,
      phone: (rec.phone ?? rec.telephone) as string | undefined,
      email: (rec.email ?? rec.email_address) as string | undefined,
      industry: rec.industry as string | undefined,
      category: (rec.category ?? rec.business_category) as string | undefined,
      description: rec.description as string | undefined,
      locality: (rec.city ?? rec.locality) as string | undefined,
      region: (rec.state ?? rec.region) as string | undefined,
      country: rec.country as string | undefined,
      rating: typeof rec.rating === 'number' ? rec.rating : undefined,
      reviewCount: typeof rec.review_count === 'number' ? rec.review_count : undefined,
    });
  }
  return importRows(orgId, rows, { source, filename: `webhook:${source}` });
}

export { normalizeDomain, normalizeEmail, normalizePhone };
