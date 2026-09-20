/**
 * Provider abstraction (§3, §54).
 *
 * Every external capability — discovery, enrichment, communication, hosting,
 * payments, social publishing, AI — is expressed as an interface and resolved
 * at runtime from a registry. Adding a new data source means implementing one
 * interface and registering it; no application code changes.
 *
 * HONESTY RULE: a provider that needs credentials and has none is reported as
 * `configured: false` and never returns invented data. Callers must surface
 * that state rather than paper over it.
 */
import { all, get, run, scalar } from '@/db';
import { id, nowIso } from '@/lib/id';
import { getSecret, hasSecret } from '@/lib/secrets';

// ── Discovery (§3) ───────────────────────────────────────────
export interface DiscoveredRecord {
  name: string;
  website?: string | null;
  phone?: string | null;
  email?: string | null;
  industry?: string | null;
  category?: string | null;
  subcategory?: string | null;
  description?: string | null;
  addressLine?: string | null;
  locality?: string | null;
  region?: string | null;
  country?: string | null;
  postalCode?: string | null;
  social?: Record<string, string>;
  rating?: number | null;
  reviewCount?: number | null;
  priceLevel?: string | null;
  employeeEstimate?: string | null;
  foundedYear?: number | null;
  isNewBusiness?: boolean;
  hiringSignal?: boolean;
  /** Provenance is mandatory on every record. */
  sourceUrl?: string | null;
  externalId?: string | null;
  confidence: number;
}

export interface DiscoveryQuery {
  /** Opportunity-oriented intent, e.g. 'no_website', 'weak_digital_presence'. Never geo-first. */
  opportunity?: string;
  industries?: string[];
  categories?: string[];
  services?: string[];
  limit?: number;
  /** Optional narrowing only — discovery must work with none of these (§2). */
  locality?: string;
  region?: string;
  country?: string;
  cursor?: string;
}

export interface DiscoveryResult {
  records: DiscoveredRecord[];
  nextCursor?: string;
  total?: number;
  /** True when the provider actually reached an external system. */
  live: boolean;
  note?: string;
}

export interface DiscoveryProvider {
  key: string;
  label: string;
  category:
    | 'directory'
    | 'public_listing'
    | 'search'
    | 'maps'
    | 'social'
    | 'reviews'
    | 'database'
    | 'industry'
    | 'import'
    | 'connected';
  requiresCredentials: boolean;
  credentialLabel?: string;
  description: string;
  costPerCall?: number;
  rateLimitPerMin?: number;
  discover(orgId: string, query: DiscoveryQuery): Promise<DiscoveryResult>;
  health?(orgId: string): Promise<{ ok: boolean; message: string }>;
}

// ── Enrichment (§10) ─────────────────────────────────────────
export interface EnrichmentInput {
  name?: string | null;
  website?: string | null;
  domain?: string | null;
  email?: string | null;
  phone?: string | null;
  locality?: string | null;
  country?: string | null;
}

export interface EnrichmentOutput {
  fields: Record<string, unknown>;
  contacts?: {
    fullName: string;
    jobTitle?: string | null;
    seniority?: string | null;
    email?: string | null;
    phone?: string | null;
    linkedinUrl?: string | null;
    isDecisionMaker?: boolean;
    confidence: number;
  }[];
  confidence: number;
  verified: boolean;
  live: boolean;
  note?: string;
  cost?: number;
}

export interface EnrichmentProvider {
  key: string;
  label: string;
  requiresCredentials: boolean;
  credentialLabel?: string;
  description: string;
  costPerCall?: number;
  enrich(orgId: string, input: EnrichmentInput): Promise<EnrichmentOutput>;
}

// ── Communication (§16, §19) ─────────────────────────────────
export interface SendInput {
  to: string;
  toName?: string | null;
  from?: string | null;
  subject?: string | null;
  body: string;
  html?: string | null;
  trackingId?: string;
  openTrackingUrl?: string;
  unsubscribeUrl?: string;
}

export interface SendResult {
  ok: boolean;
  providerMessageId?: string;
  status?: string;
  error?: string;
  /** True when a real external send happened. False = simulated/logged only. */
  live: boolean;
}

export interface CommunicationProvider {
  key: string;
  label: string;
  channel: 'email' | 'sms' | 'whatsapp' | 'calendar';
  requiresCredentials: boolean;
  credentialLabel?: string;
  description: string;
  supportsOpenTracking?: boolean;
  supportsClickTracking?: boolean;
  supportsReplyDetection?: boolean;
  costPerMessage?: number;
  send(orgId: string, input: SendInput): Promise<SendResult>;
}

// ── Hosting (§34) ────────────────────────────────────────────
export interface DeployInput {
  siteName: string;
  html: string;
  domain?: string | null;
  version: number;
}

export interface DeployResult {
  ok: boolean;
  url?: string;
  status: 'deployed' | 'failed' | 'simulated';
  logs?: string;
  error?: string;
  live: boolean;
}

export interface HostingProvider {
  key: string;
  label: string;
  requiresCredentials: boolean;
  credentialLabel?: string;
  description: string;
  supportsCustomDomains?: boolean;
  supportsSsl?: boolean;
  deploy(orgId: string, input: DeployInput): Promise<DeployResult>;
  rollback?(orgId: string, deploymentId: string): Promise<DeployResult>;
}

// ── Payments (§31, §35) ──────────────────────────────────────
export interface PaymentInput {
  amount: number;
  currency: string;
  description: string;
  customerId?: string;
  metadata?: Record<string, unknown>;
}

export interface PaymentResult {
  ok: boolean;
  providerPaymentId?: string;
  status: 'paid' | 'pending' | 'failed' | 'not_configured';
  error?: string;
  live: boolean;
}

export interface PaymentProvider {
  key: string;
  label: string;
  requiresCredentials: boolean;
  credentialLabel?: string;
  description: string;
  createCharge(orgId: string, input: PaymentInput): Promise<PaymentResult>;
  createSubscription?(orgId: string, input: PaymentInput & { interval: 'month' | 'year' }): Promise<PaymentResult>;
}

// ── Social publishing (§36) ──────────────────────────────────
export interface SocialPublishInput {
  platform: string;
  accountId: string;
  caption: string;
  media?: string[];
  scheduledFor?: string;
}

export interface SocialPublishResult {
  ok: boolean;
  postId?: string;
  status: 'published' | 'scheduled' | 'failed' | 'not_configured';
  error?: string;
  live: boolean;
}

export interface SocialProvider {
  key: string;
  label: string;
  requiresCredentials: boolean;
  credentialLabel?: string;
  description: string;
  platforms: string[];
  publish(orgId: string, input: SocialPublishInput): Promise<SocialPublishResult>;
}

// ── AI (§43) ─────────────────────────────────────────────────
export interface AiRequest {
  task: string;
  system?: string;
  prompt: string;
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
  contextLimit?: number;
}

export interface AiResponse {
  text: string;
  json?: unknown;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  latencyMs: number;
  model: string;
  live: boolean;
  error?: string;
}

export interface AiProvider {
  key: string;
  label: string;
  requiresCredentials: boolean;
  credentialLabel?: string;
  description: string;
  models: {
    modelId: string;
    label: string;
    tier: 'nano' | 'standard' | 'strong' | 'vision' | 'image';
    capabilities: string[];
    quality: number;
    speedMs: number;
    costPer1kIn: number;
    costPer1kOut: number;
    contextWindow: number;
  }[];
  complete(orgId: string, modelId: string, req: AiRequest): Promise<AiResponse>;
}

export interface ImageProvider {
  key: string;
  label: string;
  requiresCredentials: boolean;
  credentialLabel?: string;
  description: string;
  costPerImage?: number;
  generate(orgId: string, prompt: string, opts?: { width?: number; height?: number }): Promise<{
    ok: boolean;
    url?: string;
    error?: string;
    live: boolean;
  }>;
}

// ── Registry ─────────────────────────────────────────────────
interface Catalogue {
  discovery: DiscoveryProvider[];
  enrichment: EnrichmentProvider[];
  communication: CommunicationProvider[];
  hosting: HostingProvider[];
  payment: PaymentProvider[];
  social: SocialProvider[];
  ai: AiProvider[];
  image: ImageProvider[];
}

const registry: Catalogue = {
  discovery: [],
  enrichment: [],
  communication: [],
  hosting: [],
  payment: [],
  social: [],
  ai: [],
  image: [],
};

export function registerDiscovery(p: DiscoveryProvider): void {
  if (!registry.discovery.some((x) => x.key === p.key)) registry.discovery.push(p);
}
export function registerEnrichment(p: EnrichmentProvider): void {
  if (!registry.enrichment.some((x) => x.key === p.key)) registry.enrichment.push(p);
}
export function registerCommunication(p: CommunicationProvider): void {
  if (!registry.communication.some((x) => x.key === p.key)) registry.communication.push(p);
}
export function registerHosting(p: HostingProvider): void {
  if (!registry.hosting.some((x) => x.key === p.key)) registry.hosting.push(p);
}
export function registerPayment(p: PaymentProvider): void {
  if (!registry.payment.some((x) => x.key === p.key)) registry.payment.push(p);
}
export function registerSocial(p: SocialProvider): void {
  if (!registry.social.some((x) => x.key === p.key)) registry.social.push(p);
}
export function registerAi(p: AiProvider): void {
  if (!registry.ai.some((x) => x.key === p.key)) registry.ai.push(p);
}
export function registerImage(p: ImageProvider): void {
  if (!registry.image.some((x) => x.key === p.key)) registry.image.push(p);
}

export const providers = registry;

export function getDiscoveryProvider(key: string): DiscoveryProvider | undefined {
  return registry.discovery.find((p) => p.key === key);
}
export function getEnrichmentProvider(key: string): EnrichmentProvider | undefined {
  return registry.enrichment.find((p) => p.key === key);
}
export function getCommunicationProvider(channel: string, preferredKey?: string): CommunicationProvider | undefined {
  const forChannel = registry.communication.filter((p) => p.channel === channel);
  if (preferredKey) {
    const exact = forChannel.find((p) => p.key === preferredKey);
    if (exact) return exact;
  }
  // Prefer a provider whose credentials are actually present, else the first.
  return forChannel.find((p) => !p.requiresCredentials) ?? forChannel[0];
}
export function getHostingProvider(key?: string): HostingProvider | undefined {
  if (key) return registry.hosting.find((p) => p.key === key);
  return registry.hosting[0];
}
export function getPaymentProvider(key?: string): PaymentProvider | undefined {
  if (key) return registry.payment.find((p) => p.key === key);
  return registry.payment[0];
}
export function getSocialProvider(orgId?: string, key?: string): SocialProvider | undefined {
  if (key) return registry.social.find((p) => p.key === key);
  // Prefer a provider whose credentials are actually present; fall back to the
  // local outbox, which reports itself as simulated rather than pretending.
  if (orgId) {
    const ready = registry.social.find((p) => p.requiresCredentials && providerReady(orgId, p));
    if (ready) return ready;
  }
  return registry.social.find((p) => !p.requiresCredentials) ?? registry.social[0];
}
export function getAiProvider(key: string): AiProvider | undefined {
  return registry.ai.find((p) => p.key === key);
}
export function getImageProvider(key?: string): ImageProvider | undefined {
  if (key) return registry.image.find((p) => p.key === key);
  return registry.image[0];
}

/** True when the credentials a provider needs are present in the vault. */
export function providerReady(orgId: string, p: { key: string; requiresCredentials: boolean }): boolean {
  if (!p.requiresCredentials) return true;
  return hasSecret(orgId, p.key);
}

export function providerCredential(orgId: string, key: string): string | null {
  return getSecret(orgId, key);
}

// ── Enabled-source bookkeeping ───────────────────────────────
export interface SourceRow {
  id: string;
  org_id: string;
  provider_key: string;
  category: string;
  label: string;
  enabled: number;
  requires_credentials: number;
  credentials_ready: number;
  config: string;
  rate_limit_per_min: number | null;
  cost_per_call: number;
  last_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
  records_total: number;
}

/**
 * Syncs the registry into `discovery_sources` so the configuration UI reflects
 * exactly what the running process can do — and what it cannot.
 */
export function syncSourceRows(orgId: string): void {
  for (const p of registry.discovery) {
    const existing = get<{ id: string }>('SELECT id FROM discovery_sources WHERE org_id = ? AND provider_key = ?', [
      orgId,
      p.key,
    ]);
    const ready = providerReady(orgId, p) ? 1 : 0;
    if (existing) {
      run(
        `UPDATE discovery_sources SET category = ?, label = ?, requires_credentials = ?, credentials_ready = ?,
                rate_limit_per_min = ?, cost_per_call = ?, updated_at = ? WHERE id = ?`,
        [p.category, p.label, p.requiresCredentials ? 1 : 0, ready, p.rateLimitPerMin ?? null, p.costPerCall ?? 0, nowIso(), existing.id]
      );
    } else {
      run(
        `INSERT INTO discovery_sources
           (id, org_id, provider_key, category, label, enabled, requires_credentials, credentials_ready,
            config, rate_limit_per_min, cost_per_call, records_total, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?)`,
        [
          id('src'), orgId, p.key, p.category, p.label, 0, p.requiresCredentials ? 1 : 0, ready,
          '{}', p.rateLimitPerMin ?? null, p.costPerCall ?? 0, nowIso(), nowIso(),
        ]
      );
    }
  }
}

export function listSources(orgId: string): (SourceRow & { live: boolean; ready: boolean; usable: boolean })[] {
  syncSourceRows(orgId);
  return all<SourceRow>('SELECT * FROM discovery_sources WHERE org_id = ? ORDER BY category, label', [orgId]).map(
    (r) => {
      const p = getDiscoveryProvider(r.provider_key);
      const ready = p ? providerReady(orgId, p) : false;
      return {
        ...r,
        live: !!p,
        ready,
        usable: !!r.enabled && ready,
      };
    }
  );
}

export function enabledDiscoveryProviders(orgId: string): DiscoveryProvider[] {
  syncSourceRows(orgId);
  const rows = all<{ provider_key: string; enabled: number; credentials_ready: number }>(
    'SELECT provider_key, enabled, credentials_ready FROM discovery_sources WHERE org_id = ?',
    [orgId]
  );
  const enabledKeys = new Set(rows.filter((r) => r.enabled === 1 && r.credentials_ready === 1).map((r) => r.provider_key));
  return registry.discovery.filter((p) => enabledKeys.has(p.key));
}

export function setSourceEnabled(orgId: string, providerKey: string, enabled: boolean): void {
  syncSourceRows(orgId);
  run('UPDATE discovery_sources SET enabled = ?, updated_at = ? WHERE org_id = ? AND provider_key = ?', [
    enabled ? 1 : 0,
    nowIso(),
    orgId,
    providerKey,
  ]);
}

export function setSourceConfig(orgId: string, providerKey: string, config: Record<string, unknown>): void {
  syncSourceRows(orgId);
  run('UPDATE discovery_sources SET config = ?, updated_at = ? WHERE org_id = ? AND provider_key = ?', [
    JSON.stringify(config),
    nowIso(),
    orgId,
    providerKey,
  ]);
}

export function recordSourceRun(orgId: string, providerKey: string, ok: boolean, count: number, error?: string): void {
  run(
    `UPDATE discovery_sources
        SET last_run_at = ?, last_status = ?, last_error = ?,
            records_total = records_total + ?, updated_at = ?
      WHERE org_id = ? AND provider_key = ?`,
    [nowIso(), ok ? 'ok' : 'error', error ?? null, ok ? count : 0, nowIso(), orgId, providerKey]
  );
}

/** Full integration inventory for the Settings → Integrations screen (§54). */
export function integrationInventory(orgId: string) {
  const shape = <T extends { key: string; label: string; requiresCredentials: boolean; description: string }>(
    list: T[],
    kind: string
  ) =>
    list.map((p) => ({
      kind,
      key: p.key,
      label: p.label,
      requiresCredentials: p.requiresCredentials,
      description: p.description,
      configured: providerReady(orgId, p),
    }));

  return [
    ...shape(registry.discovery, 'data'),
    ...shape(registry.enrichment, 'enrichment'),
    ...shape(registry.communication, 'communication'),
    ...shape(registry.hosting, 'hosting'),
    ...shape(registry.payment, 'payments'),
    ...shape(registry.social, 'social'),
    ...shape(registry.ai, 'ai'),
    ...shape(registry.image, 'ai_image'),
  ];
}

export function providerHealthSnapshot(orgId: string) {
  return {
    discovery: registry.discovery.map((p) => ({ key: p.key, label: p.label, ready: providerReady(orgId, p) })),
    enrichment: registry.enrichment.map((p) => ({ key: p.key, label: p.label, ready: providerReady(orgId, p) })),
    communication: registry.communication.map((p) => ({
      key: p.key,
      label: p.label,
      channel: p.channel,
      ready: providerReady(orgId, p),
    })),
    hosting: registry.hosting.map((p) => ({ key: p.key, label: p.label, ready: providerReady(orgId, p) })),
    payments: registry.payment.map((p) => ({ key: p.key, label: p.label, ready: providerReady(orgId, p) })),
    social: registry.social.map((p) => ({ key: p.key, label: p.label, ready: providerReady(orgId, p) })),
    ai: registry.ai.map((p) => ({ key: p.key, label: p.label, ready: providerReady(orgId, p) })),
  };
}

export function countReadyProviders(orgId: string): { ready: number; total: number } {
  const inv = integrationInventory(orgId);
  return { ready: inv.filter((i) => i.configured || !i.requiresCredentials).length, total: inv.length };
}

export function anyDiscoverySourceEnabled(orgId: string): boolean {
  return (scalar<number>('SELECT COUNT(*) FROM discovery_sources WHERE org_id = ? AND enabled = 1', [orgId]) ?? 0) > 0;
}
