/**
 * Settings store + organization bootstrap.
 * Settings are stored as a JSON document per org (table-free) alongside typed
 * columns where querying matters.
 */
import { all, get, run } from '@/db';
import { id, initials, nowIso } from './id';
import type { ApprovalMode, Priority } from './domain';
import { DEFAULT_WEIGHTS } from './domain';

export interface Settings {
  // Discovery (§4)
  discovery: {
    schedule: 'daily' | 'weekly' | 'manual' | 'custom';
    cron: string;
    timezone: string;
    enabled: boolean;
    maxBusinessesPerRun: number;
    autoQualify: boolean;
    autoEnrichment: boolean;
    autoAudit: boolean;
    autoMockup: boolean;
    autoOutreachDrafts: boolean;
    minScoreToQualify: number;
    minScoreToMockup: number;
    reverifyIntervalDays: number;
    cacheTtlHours: number;
  };
  // Outreach (§18)
  outreach: {
    approvalMode: ApprovalMode;
    dailySendLimit: number;
    domainDailyLimit: number;
    approvalThresholdScore: number;
    quietHoursStart: string;
    quietHoursEnd: string;
    timezone: string;
    duplicateProtection: boolean;
    requireConsent: boolean;
    respectSuppression: boolean;
  };
  // Scoring (§13)
  scoring: {
    weights: Record<string, number>;
    thresholds: Record<Priority, number>;
  };
  // AI (§43, §65)
  ai: {
    defaultPriority: 'quality' | 'balanced' | 'cost' | 'speed';
    monthlyBudgetUsd: number;
    costAlertPct: number;
    autoDowngradeOnBudget: boolean;
  };
  // Branding (§68)
  branding: {
    agencyName: string;
    contactName: string;
    email: string;
    website: string;
    currency: string;
  };
  // Compliance (§56)
  compliance: {
    includeUnsubscribe: boolean;
    honourDoNotContact: boolean;
    retentionDays: number;
    logAllCommunications: boolean;
  };
}

export const DEFAULT_SETTINGS: Settings = {
  discovery: {
    schedule: 'daily',
    cron: '0 2 * * *',
    timezone: 'UTC',
    enabled: true,
    maxBusinessesPerRun: 250,
    autoQualify: true,
    autoEnrichment: true,
    autoAudit: true,
    autoMockup: true,
    autoOutreachDrafts: true,
    minScoreToQualify: 55,
    minScoreToMockup: 82,
    reverifyIntervalDays: 14,
    cacheTtlHours: 72,
  },
  outreach: {
    approvalMode: 'assisted',
    dailySendLimit: 50,
    domainDailyLimit: 30,
    approvalThresholdScore: 70,
    quietHoursStart: '20:00',
    quietHoursEnd: '08:00',
    timezone: 'UTC',
    duplicateProtection: true,
    requireConsent: false,
    respectSuppression: true,
  },
  scoring: {
    weights: { ...DEFAULT_WEIGHTS },
    thresholds: { low: 0, medium: 45, high: 70, critical: 88 },
  },
  ai: {
    defaultPriority: 'balanced',
    monthlyBudgetUsd: 250,
    costAlertPct: 80,
    autoDowngradeOnBudget: true,
  },
  branding: {
    agencyName: 'Acquisition OS',
    contactName: 'Alex Mercer',
    email: 'hello@acquisitionos.app',
    website: 'https://acquisitionos.app',
    currency: 'USD',
  },
  compliance: {
    includeUnsubscribe: true,
    honourDoNotContact: true,
    retentionDays: 730,
    logAllCommunications: true,
  },
};

const SETTINGS_KEY = '__settings__';

function deepMerge<T>(base: T, override: unknown): T {
  if (override === null || override === undefined) return base;
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return (override as T) ?? base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
    out[k] = k in out ? deepMerge((base as Record<string, unknown>)[k], v) : v;
  }
  return out as T;
}

export interface Org {
  id: string;
  name: string;
  agency_mode: number;
  brand_name: string | null;
  brand_primary: string | null;
  created_at: string;
}

export function getSettings(orgId: string): Settings {
  const row = get<{ value: string }>(
    `SELECT value FROM settings WHERE org_id = ? AND key = ?`,
    [orgId, SETTINGS_KEY]
  );
  if (!row) return structuredClone(DEFAULT_SETTINGS);
  try {
    return deepMerge(structuredClone(DEFAULT_SETTINGS), JSON.parse(row.value));
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export function saveSettings(orgId: string, patch: Partial<Settings>): Settings {
  const next = deepMerge(getSettings(orgId), patch);
  const now = nowIso();
  const existing = get<{ id: string }>(`SELECT id FROM settings WHERE org_id = ? AND key = ?`, [
    orgId,
    SETTINGS_KEY,
  ]);
  if (existing) {
    run('UPDATE settings SET value = ?, updated_at = ? WHERE id = ?', [JSON.stringify(next), now, existing.id]);
  } else {
    run(`INSERT INTO settings (id, org_id, key, value, created_at, updated_at) VALUES (?,?,?,?,?,?)`, [
      id('set'),
      orgId,
      SETTINGS_KEY,
      JSON.stringify(next),
      now,
      now,
    ]);
  }
  return next;
}

export interface UserRow {
  id: string;
  org_id: string;
  email: string;
  name: string;
  password_hash: string | null;
  role: string;
  is_active: number;
  avatar_initials: string | null;
  last_login_at: string | null;
  created_at: string;
}

/** Single-workspace bootstrap: creates the org, owner and default rows on first use. */
export function bootstrapOrg(name = 'Acquisition OS'): { org: Org; user: UserRow } {
  const existing = get<Org>('SELECT * FROM organizations ORDER BY created_at ASC LIMIT 1');
  if (existing) {
    const user =
      get<UserRow>('SELECT * FROM users WHERE org_id = ? ORDER BY created_at ASC LIMIT 1', [existing.id]) ??
      createUser(existing.id, 'owner@acquisitionos.app', 'Owner', 'owner');
    return { org: existing, user };
  }
  const now = nowIso();
  const orgId = id('org');
  run(
    `INSERT INTO organizations (id, name, agency_mode, created_at, updated_at) VALUES (?,?,0,?,?)`,
    [orgId, name, now, now]
  );
  const user = createUser(orgId, 'owner@acquisitionos.app', 'Owner', 'owner');
  return { org: { id: orgId, name, agency_mode: 0, brand_name: null, brand_primary: null, created_at: now }, user };
}

export function createUser(orgId: string, email: string, name: string, role: string): UserRow {
  const now = nowIso();
  const userId = id('usr');
  run(
    `INSERT INTO users (id, org_id, email, name, role, permissions, is_active, avatar_initials, created_at, updated_at)
     VALUES (?,?,?,?,?,'[]',1,?,?,?)`,
    [userId, orgId, email.toLowerCase(), name, role, initials(name), now, now]
  );
  return get<UserRow>('SELECT * FROM users WHERE id = ?', [userId]) as UserRow;
}

export function currentOrg(): Org {
  return bootstrapOrg().org;
}

export function currentUserId(orgId?: string): string | null {
  const oid = orgId ?? currentOrg().id;
  const u = get<UserRow>('SELECT * FROM users WHERE org_id = ? ORDER BY created_at ASC LIMIT 1', [oid]);
  return u?.id ?? null;
}

export function listUsers(orgId: string): UserRow[] {
  return all<UserRow>('SELECT * FROM users WHERE org_id = ? ORDER BY created_at ASC', [orgId]);
}
