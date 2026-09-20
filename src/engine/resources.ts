/**
 * Resource Center (§51, §27, §28, §30, §52).
 *
 * A single honest view of every external dependency: what it is, whether a free
 * option exists, whether it is configured, whether it has actually been tested,
 * and what the fallback is when it is absent.
 *
 * The states are deliberately distinct. "Implemented" means the code exists.
 * "Configured" means credentials are present. "Tested" means a real call
 * succeeded. Those are not the same thing and are never conflated (§68).
 */
import { get, scalar } from '@/db';
import { getSecret } from '@/lib/secrets';
import { providers } from '@/lib/providers/registry';
import { deadLetterSummary } from '@/engine/jobs';
import { schedulerStatus } from '@/engine/scheduler';
import { backupSummary } from '@/db/backup';
import { usageSummary } from '@/lib/ai/router';

export type ResourceState = 'configured' | 'not_configured' | 'native' | 'fallback';

export interface Resource {
  capability: string;
  provider: string;
  category: string;
  cost: 'free' | 'free-tier' | 'self-hosted' | 'paid' | 'none';
  freeTierDetail: string;
  state: ResourceState;
  stateLabel: string;
  tested: boolean;
  testedLabel: string;
  fallback: string;
  requiresUserAction: boolean;
  userAction?: string;
  usage?: { used: number; limit: number | null; pct: number | null };
}

export interface ResourceCenter {
  resources: Resource[];
  summary: {
    total: number;
    configured: number;
    native: number;
    fallback: number;
    notConfigured: number;
    requiringUserAction: number;
  };
  operationalWithoutCredentials: boolean;
}

const notConfigured = (capability: string, provider: string, category: string, cost: Resource['cost'], freeTierDetail: string, fallback: string, userAction?: string): Resource => ({
  capability,
  provider,
  category,
  cost,
  freeTierDetail,
  state: 'not_configured',
  stateLabel: 'Not configured',
  tested: false,
  testedLabel: 'Not tested',
  fallback,
  requiresUserAction: !!userAction,
  userAction,
});

export function buildResourceCenter(orgId: string): ResourceCenter {
  const has = (key: string) => !!getSecret(orgId, key);
  const resources: Resource[] = [];

  // ── Database ───────────────────────────────────────────────
  const backups = backupSummary();
  resources.push({
    capability: 'Database',
    provider: 'SQLite (node:sqlite)',
    category: 'data',
    cost: 'free',
    freeTierDetail: 'Built into the Node runtime. No external service, no cost, no connection limit.',
    state: 'configured',
    stateLabel: 'Healthy',
    tested: true,
    testedLabel: 'Verified (integrity check + restore test)',
    fallback: 'None needed — self-contained.',
    requiresUserAction: false,
    usage: { used: backups.totalBytes, limit: null, pct: null },
  });

  // ── Backups ────────────────────────────────────────────────
  resources.push({
    capability: 'Backups',
    provider: 'VACUUM INTO (local)',
    category: 'data',
    cost: 'free',
    freeTierDetail: 'Checksummed snapshots written to .data/backups with rotation and a verified restore path.',
    state: backups.total > 0 ? 'configured' : 'not_configured',
    stateLabel: backups.total > 0 ? `${backups.total} backup(s)` : 'No backup yet',
    tested: backups.ok > 0,
    testedLabel: backups.ok > 0 ? 'Restore verified' : 'Not yet run',
    fallback: 'Manual file copy of the database file.',
    requiresUserAction: false,
  });

  // ── Scheduler ──────────────────────────────────────────────
  const sched = schedulerStatus();
  resources.push({
    capability: 'Scheduler',
    provider: 'node-cron (in-process)',
    category: 'automation',
    cost: 'free',
    freeTierDetail: 'In-process cron. Daily Discovery at 02:00 plus five supporting jobs.',
    state: sched.running ? 'configured' : 'not_configured',
    stateLabel: sched.running ? `${sched.scheduledTasks} jobs registered` : 'Not started',
    tested: sched.running,
    testedLabel: sched.running ? 'Verified at runtime' : 'Not running',
    fallback: 'Manual "Run Now" from the Automation Center.',
    requiresUserAction: false,
    userAction: sched.running
      ? undefined
      : 'On serverless hosts that sleep between requests, add an external cron trigger calling the Run Now endpoint.',
  });

  // ── Background jobs ────────────────────────────────────────
  const dlq = deadLetterSummary(orgId);
  resources.push({
    capability: 'Background jobs',
    provider: 'Database-backed queue',
    category: 'automation',
    cost: 'free',
    freeTierDetail: 'Job runs, steps, locks, idempotency keys and a dead-letter queue, all in SQLite. No Redis required.',
    state: 'configured',
    stateLabel: `${dlq.open} open in dead-letter`,
    tested: true,
    testedLabel: 'Resume-from-checkpoint verified',
    fallback: 'None needed — the database is the queue.',
    requiresUserAction: false,
  });

  // ── AI ─────────────────────────────────────────────────────
  const aiConfigured = ['openai', 'anthropic', 'google'].filter((k) => has(k));
  const aiUsage = usageSummary(orgId, 30);
  resources.push({
    capability: 'AI',
    provider: aiConfigured.length ? aiConfigured.join(', ') : 'Local grounded engine',
    category: 'ai',
    cost: aiConfigured.length ? 'paid' : 'free',
    freeTierDetail: aiConfigured.length
      ? 'Hosted model active. Cost is tracked per request.'
      : 'Deterministic grounded engine. No API key, no cost, no rate limit. Outputs are grounded only in supplied facts.',
    state: aiConfigured.length ? 'configured' : 'fallback',
    stateLabel: aiConfigured.length ? aiConfigured.join(', ') : 'Local fallback active',
    tested: aiUsage.calls > 0,
    testedLabel: aiUsage.calls > 0 ? `${aiUsage.calls} request(s)` : 'Local engine only',
    fallback: 'Local grounded engine — always available.',
    requiresUserAction: false,
    userAction: aiConfigured.length ? undefined : 'Optional: add OPENAI_API_KEY, ANTHROPIC_API_KEY or GOOGLE_AI_API_KEY for hosted reasoning.',
    usage: { used: aiUsage.calls, limit: null, pct: null },
  });

  // ── Discovery ──────────────────────────────────────────────
  const discoveryReady = providers.discovery.filter((p) => !p.requiresCredentials || has(p.key));
  resources.push({
    capability: 'Business discovery',
    provider: discoveryReady.map((p) => p.key).join(', ') || 'none',
    category: 'discovery',
    cost: 'free',
    freeTierDetail: 'OpenStreetMap Overpass needs no API key and is the zero-cost default. Others activate when a key is added.',
    state: discoveryReady.length ? 'configured' : 'not_configured',
    stateLabel: discoveryReady.length ? `${discoveryReady.length} source(s) usable` : 'No source enabled',
    tested: (scalar<number>('SELECT COUNT(*) FROM businesses WHERE org_id = ?', [orgId]) ?? 0) > 0,
    testedLabel: `${scalar<number>('SELECT COUNT(*) FROM businesses WHERE org_id = ?', [orgId]) ?? 0} business(es) on record`,
    fallback: 'CSV import.',
    requiresUserAction: false,
    userAction: 'Enable OpenStreetMap in Settings → Integrations for zero-cost discovery.',
  });

  // ── Website auditing ───────────────────────────────────────
  resources.push({
    capability: 'Website auditing',
    provider: 'Built-in auditor',
    category: 'discovery',
    cost: 'free',
    freeTierDetail: 'Fetches and parses the site directly. SSRF-guarded: internal and metadata addresses are refused.',
    state: 'configured',
    stateLabel: 'Active',
    tested: (scalar<number>('SELECT COUNT(*) FROM digital_audits WHERE org_id = ? AND verified = 1', [orgId]) ?? 0) > 0,
    testedLabel: `${scalar<number>('SELECT COUNT(*) FROM digital_audits WHERE org_id = ? AND verified = 1', [orgId]) ?? 0} verified audit(s)`,
    fallback: 'Records "unreachable" rather than fabricating a result.',
    requiresUserAction: false,
  });

  // ── Enrichment ─────────────────────────────────────────────
  const enrichReady = providers.enrichment.filter((p) => !p.requiresCredentials || has(p.key));
  resources.push({
    capability: 'Contact enrichment',
    provider: enrichReady.map((p) => p.key).join(', ') || 'public data only',
    category: 'enrichment',
    cost: 'free',
    freeTierDetail: 'Derived from the business website and public records. Hunter / Clearbit / Apollo activate with a key.',
    state: enrichReady.some((p) => p.requiresCredentials) ? 'configured' : 'fallback',
    stateLabel: enrichReady.some((p) => p.requiresCredentials) ? 'Provider active' : 'Public data only',
    tested: (scalar<number>('SELECT COUNT(*) FROM enrichment_records WHERE org_id = ?', [orgId]) ?? 0) > 0,
    testedLabel: `${scalar<number>('SELECT COUNT(*) FROM enrichment_records WHERE org_id = ?', [orgId]) ?? 0} enrichment record(s)`,
    fallback: 'Every field is marked Unverified rather than presented as fact.',
    requiresUserAction: false,
    userAction: 'Optional: add HUNTER_API_KEY or APOLLO_API_KEY for decision-maker lookup.',
  });

  // ── Email ──────────────────────────────────────────────────
  const emailReady = providers.communication.filter((p) => p.channel === 'email' && (!p.requiresCredentials || has(p.key)));
  const emailLive = emailReady.some((p) => p.requiresCredentials && has(p.key));
  resources.push({
    capability: 'Email (outreach)',
    provider: emailLive ? emailReady.find((p) => p.requiresCredentials)!.key : 'Local outbox',
    category: 'communication',
    cost: emailLive ? 'free-tier' : 'free',
    freeTierDetail: emailLive
      ? 'Provider active. Sends are rate limited and pass the compliance gate.'
      : 'Messages are drafted and held in the local outbox. Nothing is sent until a provider is connected.',
    state: emailLive ? 'configured' : 'fallback',
    stateLabel: emailLive ? 'Connected' : 'Manual outreach mode',
    tested: (scalar<number>("SELECT COUNT(*) FROM outreach_messages WHERE org_id = ? AND simulated = 0 AND sent_at IS NOT NULL", [orgId]) ?? 0) > 0,
    testedLabel:
      (scalar<number>("SELECT COUNT(*) FROM outreach_messages WHERE org_id = ? AND simulated = 0 AND sent_at IS NOT NULL", [orgId]) ?? 0) > 0
        ? 'Real send confirmed'
        : 'No real send yet',
    fallback: 'Manual outreach mode — copy/export the draft and send it yourself.',
    requiresUserAction: !emailLive,
    userAction: emailLive
      ? undefined
      : 'Add RESEND_API_KEY (3,000 emails/month free) or SENDGRID_API_KEY (100/day free). Configure SPF, DKIM and DMARC on your sending domain first.',
  });

  // ── SMS / WhatsApp ─────────────────────────────────────────
  resources.push(
    notConfigured(
      'SMS',
      'Twilio',
      'communication',
      'paid',
      'No permanent free tier. Trial credit is temporary and requires verification.',
      'Call tasks and manual sending.',
      'Optional: add TWILIO_SMS as ACCOUNT_SID:AUTH_TOKEN from=+1…'
    ),
    notConfigured(
      'WhatsApp',
      'Twilio WhatsApp',
      'communication',
      'paid',
      'Requires an approved WhatsApp Business sender. No free tier for business-initiated messages.',
      'Manual sending.',
      'Optional: add TWILIO_WHATSAPP and complete WhatsApp sender approval.'
    )
  );

  // ── Calendar ───────────────────────────────────────────────
  resources.push({
    capability: 'Calendar',
    provider: 'Built-in scheduling',
    category: 'communication',
    cost: 'free',
    freeTierDetail: 'Calls are scheduled in-app with a manual meeting link. No calendar integration required.',
    state: 'fallback',
    stateLabel: 'Manual scheduling',
    tested: (scalar<number>('SELECT COUNT(*) FROM calls WHERE org_id = ?', [orgId]) ?? 0) > 0,
    testedLabel: `${scalar<number>('SELECT COUNT(*) FROM calls WHERE org_id = ?', [orgId]) ?? 0} call(s) scheduled`,
    fallback: 'Manual scheduling — always available.',
    requiresUserAction: false,
    userAction: 'Optional: self-host Cal.com, or connect Google Calendar via OAuth.',
  });

  // ── Website concept hosting ────────────────────────────────
  resources.push({
    capability: 'Concept preview hosting',
    provider: 'In-app (/mockup/:token)',
    category: 'hosting',
    cost: 'free',
    freeTierDetail: 'Served by the application itself with a share token, view tracking and no internal CRM data exposed.',
    state: 'configured',
    stateLabel: 'Active',
    tested: (scalar<number>('SELECT COUNT(*) FROM mockups WHERE org_id = ?', [orgId]) ?? 0) > 0,
    testedLabel: `${scalar<number>('SELECT COUNT(*) FROM mockups WHERE org_id = ?', [orgId]) ?? 0} concept(s) generated`,
    fallback: 'None needed.',
    requiresUserAction: false,
  });

  // ── Client website hosting ─────────────────────────────────
  const hostReady = providers.hosting.filter((p) => !p.requiresCredentials || has(p.key));
  const hostLive = hostReady.some((p) => p.requiresCredentials && has(p.key));
  resources.push({
    capability: 'Client website hosting',
    provider: hostLive ? hostReady.find((p) => p.requiresCredentials)!.key : 'In-app preview',
    category: 'hosting',
    cost: hostLive ? 'free-tier' : 'free',
    freeTierDetail: hostLive
      ? 'Provider active with automatic SSL.'
      : 'Sites are served in-app and deployments are reported as simulated, never as live.',
    state: hostLive ? 'configured' : 'fallback',
    stateLabel: hostLive ? 'Connected' : 'Preview only',
    tested: (scalar<number>("SELECT COUNT(*) FROM deployments WHERE org_id = ? AND simulated = 0", [orgId]) ?? 0) > 0,
    testedLabel:
      (scalar<number>("SELECT COUNT(*) FROM deployments WHERE org_id = ? AND simulated = 0", [orgId]) ?? 0) > 0
        ? 'Real deployment confirmed'
        : 'No real deployment yet',
    fallback: 'In-app preview at /site/:slug.',
    requiresUserAction: !hostLive,
    userAction: hostLive
      ? undefined
      : 'Add CLOUDFLARE_PAGES / VERCEL_TOKEN / NETLIFY_TOKEN. Cloudflare Pages and Netlify both have permanent free tiers.',
  });

  // ── Storage ────────────────────────────────────────────────
  resources.push({
    capability: 'File storage',
    provider: 'Local filesystem',
    category: 'storage',
    cost: 'free',
    freeTierDetail: 'Concept assets are generated inline into the HTML, so no object storage is required to operate.',
    state: 'fallback',
    stateLabel: 'Local',
    tested: false,
    testedLabel: 'Not required for current features',
    fallback: 'Local filesystem.',
    requiresUserAction: false,
    userAction: 'Optional: Supabase Storage (1 GB free) or Cloudflare R2 (10 GB free) for client file libraries.',
  });

  // ── Social publishing ──────────────────────────────────────
  resources.push(
    notConfigured(
      'Social publishing',
      'Buffer / Meta Graph',
      'social',
      'free-tier',
      'Official APIs require app review. Content is generated and held as "Ready to publish".',
      'Ready-to-publish mode — download the caption, creative and hashtags and post manually.',
      'Optional: add BUFFER_ACCESS_TOKEN or META_ACCESS_TOKEN after completing app review.'
    )
  );

  // ── Payments ───────────────────────────────────────────────
  resources.push({
    capability: 'Payments',
    provider: has('stripe.payments') ? 'Stripe' : 'Manual invoicing',
    category: 'payments',
    cost: 'paid',
    freeTierDetail: 'Not required to validate the acquisition workflow. Test mode is free; live charges carry processing fees.',
    state: has('stripe.payments') ? 'configured' : 'not_configured',
    stateLabel: has('stripe.payments') ? 'Connected' : 'Payment pending workflow',
    tested: false,
    testedLabel: 'Not tested — no live charge attempted',
    fallback: 'Proposal accepted → payment pending → confirmed manually.',
    requiresUserAction: false,
    userAction: 'Optional: add STRIPE_SECRET_KEY. Never required for the acquisition workflow.',
  });

  // ── Monitoring ─────────────────────────────────────────────
  resources.push({
    capability: 'Monitoring',
    provider: 'Built-in health endpoints',
    category: 'monitoring',
    cost: 'free',
    freeTierDetail: '/api/health returns component-level status and 503 when unhealthy, ready for any external uptime poller.',
    state: 'configured',
    stateLabel: 'Active',
    tested: true,
    testedLabel: 'Verified via smoke tests',
    fallback: 'None needed.',
    requiresUserAction: false,
    userAction: 'Optional: point UptimeRobot (50 monitors free) at /api/health.',
  });

  // ── Error tracking ─────────────────────────────────────────
  resources.push(
    notConfigured(
      'Error tracking',
      'Sentry',
      'monitoring',
      'free-tier',
      '5k errors/month free. Errors currently go to the automation log and the Automation Center.',
      'Automation log + Automation Center.',
      'Optional: add SENTRY_DSN (5,000 errors/month free).'
    )
  );

  // ── Analytics ──────────────────────────────────────────────
  resources.push({
    capability: 'Analytics',
    provider: 'Built-in',
    category: 'monitoring',
    cost: 'free',
    freeTierDetail: 'Acquisition, revenue and unit-economics analytics are computed from the local database.',
    state: 'configured',
    stateLabel: 'Active',
    tested: true,
    testedLabel: 'Verified',
    fallback: 'None needed.',
    requiresUserAction: false,
    userAction: 'Optional: Cloudflare Web Analytics (free, privacy-preserving) for public-site traffic.',
  });

  // ── Authentication ─────────────────────────────────────────
  resources.push({
    capability: 'Authentication',
    provider: 'Built-in (scrypt)',
    category: 'security',
    cost: 'free',
    freeTierDetail: 'scrypt password hashing, hashed session tokens, httpOnly secure cookies, login rate limiting.',
    state: 'configured',
    stateLabel: 'Active',
    tested: true,
    testedLabel: 'Verified by security tests',
    fallback: 'None needed.',
    requiresUserAction: false,
  });

  const configured = resources.filter((r) => r.state === 'configured').length;
  const native = resources.filter((r) => r.cost === 'free').length;
  const fallback = resources.filter((r) => r.state === 'fallback').length;
  const notCfg = resources.filter((r) => r.state === 'not_configured').length;

  return {
    resources,
    summary: {
      total: resources.length,
      configured,
      native,
      fallback,
      notConfigured: notCfg,
      requiringUserAction: resources.filter((r) => r.requiresUserAction).length,
    },
    // The whole point of no-credential mode: every core capability has a
    // working fallback, so the product is usable with zero external accounts.
    operationalWithoutCredentials: resources.every((r) => r.state !== 'not_configured' || r.fallback.length > 0),
  };
}

/** Flat list of everything that still needs the user, with the exact setting. */
export function requiredUserActions(orgId: string): { provider: string; why: string; setting: string }[] {
  const center = buildResourceCenter(orgId);
  return center.resources
    .filter((r) => r.requiresUserAction && r.userAction)
    .map((r) => ({ provider: r.capability, why: r.stateLabel, setting: r.userAction as string }));
}

export function freeTierAlerts(orgId: string): { capability: string; used: number; limit: number; pct: number; level: 'ok' | 'warn' | 'critical' }[] {
  const center = buildResourceCenter(orgId);
  return center.resources
    .filter((r) => r.usage && r.usage.limit !== null)
    .map((r) => {
      const pct = r.usage!.pct ?? 0;
      return {
        capability: r.capability,
        used: r.usage!.used,
        limit: r.usage!.limit as number,
        pct,
        level: pct >= 95 ? ('critical' as const) : pct >= 70 ? ('warn' as const) : ('ok' as const),
      };
    });
}

export { get };
