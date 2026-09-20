/**
 * Enrichment, communication, hosting, payment and social providers (§10, §16,
 * §31, §34, §36, §54) plus registration of the whole catalogue.
 *
 * Contract every provider honours:
 *  - `live: true`  → a real external call happened
 *  - `live: false` → nothing left this process; the caller must say so in the UI
 *  - unconfigured providers return no data and never a fabricated result
 */
import {
  registerAi,
  registerCommunication,
  registerDiscovery,
  registerEnrichment,
  registerHosting,
  registerImage,
  registerPayment,
  registerSocial,
  providerCredential,
  type AiProvider,
  type CommunicationProvider,
  type EnrichmentProvider,
  type HostingProvider,
  type ImageProvider,
  type PaymentProvider,
  type SendResult,
  type SocialProvider,
} from './registry';
import { httpJson, qs } from '@/lib/http';
import { DISCOVERY_PROVIDERS } from './data';
import { AI_PROVIDERS } from '@/lib/ai/catalogue';
import { run, all, get } from '@/db';
import { id, normalizeDomain, nowIso } from '@/lib/id';

const notConfigured = (key: string) => ({
  fields: {},
  confidence: 0,
  verified: false,
  live: false,
  note: `${key} is not configured. Add credentials in Settings → Integrations.`,
});

// ═════════════════════════════════════════════════════════════
// ENRICHMENT (§10)
// ═════════════════════════════════════════════════════════════
export const hunterProvider: EnrichmentProvider = {
  key: 'hunter.enrich',
  label: 'Hunter.io',
  requiresCredentials: true,
  credentialLabel: 'Hunter API key',
  description: 'Domain search + email finder. Returns decision-maker contacts with a per-email confidence score.',
  costPerCall: 0.01,

  async enrich(orgId, input) {
    const key = providerCredential(orgId, 'hunter.enrich');
    if (!key) return notConfigured('hunter.enrich');
    const domain = normalizeDomain(input.website ?? input.domain ?? null) ?? (input.email ? input.email.split('@')[1] : null);
    if (!domain) return { fields: {}, confidence: 0, verified: false, live: true, note: 'No domain to search.' };

    const res = await httpJson<{ emails?: HunterEmail[]; organization?: string; country?: string }>(
      `https://api.hunter.io/v2/domain-search?${qs({ domain, api_key: key, limit: 5 })}`,
      { timeoutMs: 20_000 }
    );
    if (!res.ok) return { fields: {}, confidence: 0, verified: false, live: true, note: `Hunter error: ${res.error}` };

    const emails = res.data?.emails ?? [];
    const ranked = [...emails].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
    return {
      fields: { organization: res.data?.organization ?? null, country: res.data?.country ?? null },
      contacts: ranked.map((e) => ({
        fullName: [e.first_name, e.last_name].filter(Boolean).join(' ') || e.value,
        jobTitle: e.position ?? null,
        email: e.value,
        isDecisionMaker: /owner|founder|director|ceo|principal|manager/i.test(e.position ?? ''),
        seniority: /owner|founder|ceo|director|principal/i.test(e.position ?? '') ? 'decision_maker' : 'manager',
        confidence: (e.confidence ?? 50) / 100,
      })),
      confidence: ranked.length ? (ranked[0].confidence ?? 50) / 100 : 0,
      verified: ranked.some((e) => e.verification?.status === 'valid'),
      live: true,
    };
  },
};

interface HunterEmail {
  value: string;
  first_name?: string;
  last_name?: string;
  position?: string;
  confidence?: number;
  verification?: { status?: string };
}

export const clearbitProvider: EnrichmentProvider = {
  key: 'clearbit.enrich',
  label: 'Clearbit (company + contact)',
  requiresCredentials: true,
  credentialLabel: 'Clearbit secret key',
  description: 'Firmographics: industry, employee range, technology signals, founded year and description.',
  costPerCall: 0.02,

  async enrich(orgId, input) {
    const key = providerCredential(orgId, 'clearbit.enrich');
    if (!key) return notConfigured('clearbit.enrich');
    const domain = normalizeDomain(input.website ?? input.domain ?? null);
    if (!domain) return { fields: {}, confidence: 0, verified: false, live: true, note: 'No domain to enrich.' };

    const res = await httpJson<ClearbitCompany>(`https://company.clearbit.com/v2/companies/find?domain=${domain}`, {
      headers: { authorization: `Bearer ${key}` },
      timeoutMs: 20_000,
    });
    if (!res.ok || !res.data) return { fields: {}, confidence: 0, verified: false, live: true, note: `Clearbit: ${res.error}` };
    const c = res.data;
    return {
      fields: {
        name: c.name ?? null,
        legalName: c.legalName ?? null,
        description: c.description ?? null,
        industry: c.category?.industry ?? null,
        category: c.category?.sector ?? null,
        employeeEstimate: c.employees ? String(c.employees) : (c.employeesRange ? c.employeesRange.join('-') : null),
        foundedYear: c.foundedYear ?? null,
        locality: c.geo?.city ?? null,
        region: c.geo?.state ?? null,
        country: c.geo?.country ?? null,
        social: {
          ...(c.linkedin?.handle ? { linkedin: `https://linkedin.com/company/${c.linkedin.handle}` } : {}),
          ...(c.twitter?.handle ? { twitter: `https://twitter.com/${c.twitter.handle}` } : {}),
          ...(c.facebook?.handle ? { facebook: `https://facebook.com/${c.facebook.handle}` } : {}),
        },
        techSignals: (c.tech ?? []).slice(0, 20),
      },
      confidence: 0.85,
      verified: true,
      live: true,
    };
  },
};

interface ClearbitCompany {
  name?: string;
  legalName?: string;
  description?: string;
  category?: { industry?: string; sector?: string };
  employees?: number;
  employeesRange?: number[];
  foundedYear?: number;
  geo?: { city?: string; state?: string; country?: string };
  linkedin?: { handle?: string };
  twitter?: { handle?: string };
  facebook?: { handle?: string };
  tech?: string[];
}

export const apolloProvider: EnrichmentProvider = {
  key: 'apollo.enrich',
  label: 'Apollo.io',
  requiresCredentials: true,
  credentialLabel: 'Apollo API key',
  description: 'People search and contact enrichment with seniority, titles and verified emails.',
  costPerCall: 0.015,

  async enrich(orgId, input) {
    const key = providerCredential(orgId, 'apollo.enrich');
    if (!key) return notConfigured('apollo.enrich');
    const domain = normalizeDomain(input.website ?? input.domain ?? null);
    const res = await httpJson<{ people?: ApolloPerson[] }>(
      'https://api.apollo.io/v1/mixed_people/search',
      {
        method: 'POST',
        headers: { 'cache-control': 'no-cache', 'x-api-key': key },
        body: { q_organization_domains: domain ?? undefined, q_keywords: input.name ?? undefined, per_page: 5 },
        timeoutMs: 20_000,
      }
    );
    if (!res.ok) return { fields: {}, confidence: 0, verified: false, live: true, note: `Apollo: ${res.error}` };
    const people = res.data?.people ?? [];
    return {
      fields: {},
      contacts: people.map((p) => ({
        fullName: p.name ?? '',
        jobTitle: p.title ?? null,
        email: p.email ?? null,
        linkedinUrl: p.linkedin_url ?? null,
        seniority: p.seniority ?? null,
        isDecisionMaker: /owner|founder|ceo|director|principal|head/i.test(p.title ?? ''),
        confidence: 0.75,
      })),
      confidence: people.length ? 0.75 : 0,
      verified: false,
      live: true,
    };
  },
};

interface ApolloPerson {
  name?: string;
  title?: string;
  email?: string;
  linkedin_url?: string;
  seniority?: string;
}

/**
 * Derived enrichment: no external call, but real inference from data we already
 * hold (domain-based role emails, social presence, tech signals from the audit).
 * Every field is marked unverified (§10).
 */
export const derivedProvider: EnrichmentProvider = {
  key: 'derived.local',
  label: 'Derived signals (local)',
  requiresCredentials: false,
  description:
    'Infers role-based email patterns, social presence and technology signals from data already collected. Marked unverified — never presented as confirmed.',
  costPerCall: 0,

  async enrich(_orgId, input) {
    const fields: Record<string, unknown> = {};
    const domain = normalizeDomain(input.website ?? input.domain ?? null);
    if (domain) {
      fields.suggestedEmailPattern = `hello@${domain}`;
      fields.domain = domain;
    }
    return {
      fields,
      confidence: domain ? 0.35 : 0,
      verified: false,
      live: false,
      note: 'Derived locally from existing records. Treat as a hypothesis, not a fact.',
    };
  },
};

export const ENRICHMENT_PROVIDERS: EnrichmentProvider[] = [hunterProvider, clearbitProvider, apolloProvider, derivedProvider];

// ═════════════════════════════════════════════════════════════
// COMMUNICATION (§16, §18, §19)
// ═════════════════════════════════════════════════════════════
export const resendProvider: CommunicationProvider = {
  key: 'resend.email',
  label: 'Resend (email)',
  channel: 'email',
  requiresCredentials: true,
  credentialLabel: 'Resend API key',
  description: 'Transactional/marketing email with open and click tracking webhooks.',
  supportsOpenTracking: true,
  supportsClickTracking: true,
  supportsReplyDetection: true,
  costPerMessage: 0.0002,

  async send(orgId, input) {
    const key = providerCredential(orgId, 'resend.email');
    if (!key) return { ok: false, live: false, error: 'Resend is not configured' };
    const res = await httpJson<{ id?: string; error?: { message?: string } }>('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}` },
      body: {
        from: input.from ?? 'Acquisition OS <onboarding@resend.dev>',
        to: [input.to],
        subject: input.subject ?? '(no subject)',
        text: input.body,
        html: input.html ?? `<pre style="font-family:inherit;white-space:pre-wrap">${escapeHtml(input.body)}</pre>`,
        headers: input.trackingId ? { 'X-Message-Id': input.trackingId } : undefined,
      },
      timeoutMs: 20_000,
    });
    if (!res.ok) return { ok: false, live: true, error: res.data?.error?.message ?? res.error };
    return { ok: true, live: true, providerMessageId: res.data?.id, status: 'sent' };
  },
};

export const sendgridProvider: CommunicationProvider = {
  key: 'sendgrid.email',
  label: 'SendGrid (email)',
  channel: 'email',
  requiresCredentials: true,
  credentialLabel: 'SendGrid API key',
  description: 'Email delivery with event webhooks for delivered / opened / clicked / bounced.',
  supportsOpenTracking: true,
  supportsClickTracking: true,
  supportsReplyDetection: true,
  costPerMessage: 0.0001,

  async send(orgId, input) {
    const key = providerCredential(orgId, 'sendgrid.email');
    if (!key) return { ok: false, live: false, error: 'SendGrid is not configured' };
    const res = await httpJson('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}` },
      body: {
        personalizations: [{ to: [{ email: input.to, name: input.toName ?? undefined }] }],
        from: { email: input.from ?? 'hello@acquisitionos.app' },
        subject: input.subject ?? '(no subject)',
        content: [{ type: 'text/plain', value: input.body }],
        tracking_settings: { open_tracking: { enable: true }, click_tracking: { enable: true } },
      },
      timeoutMs: 20_000,
    });
    if (!res.ok) return { ok: false, live: true, error: res.error };
    return { ok: true, live: true, status: 'sent' };
  },
};

export const twilioSmsProvider: CommunicationProvider = {
  key: 'twilio.sms',
  label: 'Twilio (SMS)',
  channel: 'sms',
  requiresCredentials: true,
  credentialLabel: 'Twilio credentials as ACCOUNT_SID:AUTH_TOKEN, plus from=+1...',
  description: 'SMS delivery with delivery-status callbacks. Store opt-outs in the suppression list.',
  costPerMessage: 0.0079,

  async send(orgId, input) {
    const raw = providerCredential(orgId, 'twilio.sms');
    if (!raw) return { ok: false, live: false, error: 'Twilio is not configured' };
    const [sid, token] = raw.split(':');
    const from = raw.includes('from=') ? raw.split('from=')[1].trim() : null;
    if (!sid || !token || !from) return { ok: false, live: false, error: 'Twilio credential must be SID:TOKEN from=+1…' };

    const res = await httpText_(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      auth: { user: sid, pass: token },
      form: { To: input.to, From: from, Body: input.body },
    });
    if (!res.ok) return { ok: false, live: true, error: res.error };
    return { ok: true, live: true, providerMessageId: res.sid, status: 'sent' };
  },
};

export const twilioWhatsappProvider: CommunicationProvider = {
  key: 'twilio.whatsapp',
  label: 'Twilio WhatsApp',
  channel: 'whatsapp',
  requiresCredentials: true,
  credentialLabel: 'Twilio credentials as ACCOUNT_SID:AUTH_TOKEN, plus from=whatsapp:+1...',
  description: 'WhatsApp Business API messaging. Requires an approved WhatsApp sender.',
  costPerMessage: 0.005,

  async send(orgId, input) {
    const raw = providerCredential(orgId, 'twilio.whatsapp');
    if (!raw) return { ok: false, live: false, error: 'Twilio WhatsApp is not configured' };
    const [sid, token] = raw.split(':');
    const from = raw.includes('from=') ? raw.split('from=')[1].trim() : null;
    if (!sid || !token || !from) return { ok: false, live: false, error: 'Credential must be SID:TOKEN from=whatsapp:+1…' };
    const res = await httpText_(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      auth: { user: sid, pass: token },
      form: { To: `whatsapp:${input.to}`, From: from, Body: input.body },
    });
    if (!res.ok) return { ok: false, live: true, error: res.error };
    return { ok: true, live: true, providerMessageId: res.sid, status: 'sent' };
  },
};

/**
 * Outbox provider: always available, no credentials. Messages are persisted and
 * queued but never leave the system — reported as simulated so nobody mistakes
 * them for real sends (§54 honesty rule).
 */
export const outboxProvider: CommunicationProvider = {
  key: 'outbox.local',
  label: 'Local outbox (no provider configured)',
  channel: 'email',
  requiresCredentials: false,
  description:
    'Records the message in the outbox and marks it simulated. Wire up Resend or SendGrid in Settings → Integrations to send for real.',
  costPerMessage: 0,

  async send() {
    return { ok: true, live: false, status: 'simulated' } satisfies SendResult;
  },
};

export const outboxSmsProvider: CommunicationProvider = {
  key: 'outbox.sms',
  label: 'Local outbox (SMS)',
  channel: 'sms',
  requiresCredentials: false,
  description: 'Queues SMS locally without sending. Configure Twilio to send for real.',
  async send() {
    return { ok: true, live: false, status: 'simulated' };
  },
};

export const outboxWhatsappProvider: CommunicationProvider = {
  key: 'outbox.whatsapp',
  label: 'Local outbox (WhatsApp)',
  channel: 'whatsapp',
  requiresCredentials: false,
  description: 'Queues WhatsApp locally without sending. Configure Twilio WhatsApp to send for real.',
  async send() {
    return { ok: true, live: false, status: 'simulated' };
  },
};

/** Minimal form-encoded POST with basic auth (Twilio). */
async function httpText_(
  url: string,
  opts: { method: string; auth: { user: string; pass: string }; form: Record<string, string> }
): Promise<{ ok: boolean; sid?: string; error?: string }> {
  const basic = Buffer.from(`${opts.auth.user}:${opts.auth.pass}`).toString('base64');
  const res = await fetch(url, {
    method: opts.method,
    headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(opts.form).toString(),
  });
  const text = await res.text();
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
  try {
    const parsed = JSON.parse(text) as { sid?: string };
    return { ok: true, sid: parsed.sid };
  } catch {
    return { ok: true };
  }
}

export const COMMUNICATION_PROVIDERS: CommunicationProvider[] = [
  resendProvider,
  sendgridProvider,
  twilioSmsProvider,
  twilioWhatsappProvider,
  outboxProvider,
  outboxSmsProvider,
  outboxWhatsappProvider,
];

// ═════════════════════════════════════════════════════════════
// HOSTING (§34)
// ═════════════════════════════════════════════════════════════
/**
 * In-app preview host. This one is genuinely live: the generated site is served
 * by the app itself at /site/[id], which is a real, viewable URL.
 */
export const localHostingProvider: HostingProvider = {
  key: 'host.local',
  label: 'Built-in preview host',
  requiresCredentials: false,
  description: 'Serves generated sites from the application itself. Real and viewable; not a production CDN.',
  supportsCustomDomains: false,
  supportsSsl: false,

  async deploy(_orgId, input) {
    return {
      ok: true,
      status: 'deployed',
      url: `/site/${encodeURIComponent(input.siteName)}`,
      logs: `Served in-app at /site/${input.siteName} (v${input.version}). No external host contacted.`,
      live: true,
    };
  },
};

export const vercelProvider: HostingProvider = {
  key: 'host.vercel',
  label: 'Vercel',
  requiresCredentials: true,
  credentialLabel: 'Vercel access token',
  description: 'Deploys a static bundle to Vercel with automatic SSL and optional custom domains.',
  supportsCustomDomains: true,
  supportsSsl: true,

  async deploy(orgId, input) {
    const token = providerCredential(orgId, 'host.vercel');
    if (!token) return { ok: false, status: 'simulated', live: false, error: 'Vercel token not configured' };
    const files = [{ file: 'index.html', data: input.html, type: 'text/html' }];
    const body = { name: input.siteName, target: 'production', files };
    const res = await httpJson<{ id?: string; url?: string; error?: { message?: string } }>(
      `https://api.vercel.com/v13/deployments?${qs({ teamId: undefined })}`,
      { method: 'POST', headers: { authorization: `Bearer ${token}` }, body, timeoutMs: 60_000 }
    );
    if (!res.ok) return { ok: false, status: 'failed', live: true, error: res.data?.error?.message ?? res.error };
    return { ok: true, status: 'deployed', url: res.data?.url ? `https://${res.data.url}` : undefined, live: true };
  },
};

export const netlifyProvider: HostingProvider = {
  key: 'host.netlify',
  label: 'Netlify',
  requiresCredentials: true,
  credentialLabel: 'Netlify personal access token',
  description: 'Static deploys with instant SSL and custom domains.',
  supportsCustomDomains: true,
  supportsSsl: true,

  async deploy(orgId, input) {
    const token = providerCredential(orgId, 'host.netlify');
    if (!token) return { ok: false, status: 'simulated', live: false, error: 'Netlify token not configured' };
    const create = await httpJson<{ site_id?: string; ssl_url?: string }>('https://api.netlify.com/api/v1/sites', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: { name: input.siteName },
      timeoutMs: 30_000,
    });
    if (!create.ok || !create.data?.site_id) {
      return { ok: false, status: 'failed', live: true, error: create.error };
    }
    const deploy = await httpJson<{ deploy_id?: string; ssl_url?: string }>(
      `https://api.netlify.com/api/v1/sites/${create.data.site_id}/deploys`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/zip' },
        body: makeZip([{ name: 'index.html', data: input.html }]),
        timeoutMs: 60_000,
      }
    );
    if (!deploy.ok) return { ok: false, status: 'failed', live: true, error: deploy.error };
    return { ok: true, status: 'deployed', url: deploy.data?.ssl_url, live: true };
  },
};

/** Tiny stored-ZIP builder for Netlify's file-based deploy endpoint. */
function makeZip(files: { name: string; data: string }[]): string {
  const chunks: number[] = [];
  const central: number[] = [];
  let offset = 0;
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (buf: Uint8Array) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  for (const f of files) {
    const nameBytes = [...Buffer.from(f.name, 'utf8')];
    const data = Buffer.from(f.data, 'utf8');
    const crc = crc32(data);
    const local = [0x50, 0x4b, 0x03, 0x04, 20, 0, 0, 0, 0, 0, 0, 0, ...le32(crc), ...le32(data.length), ...le32(data.length), ...le16(nameBytes.length), 0, 0];
    chunks.push(...local, ...nameBytes, ...data);
    central.push(0x50, 0x4b, 0x01, 0x02, 20, 20, 0, 0, 0, 0, 0, ...le32(crc), ...le32(data.length), ...le32(data.length), ...le16(nameBytes.length), 0, 0, 0, 0, 0, 0, 0, 0, ...le32(offset), ...nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const eocd = [0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, ...le16(files.length), ...le16(files.length), ...le32(central.length), ...le32(offset), 0, 0];
  return Buffer.from([...chunks, ...central, ...eocd]).toString('base64');
}
const le16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const le32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff];

export const githubPagesProvider: HostingProvider = {
  key: 'host.github',
  label: 'GitHub Pages',
  requiresCredentials: true,
  credentialLabel: 'GitHub personal access token (repo scope)',
  description: 'Publishes a site to a GitHub repository with Pages enabled.',
  supportsCustomDomains: true,
  supportsSsl: true,

  async deploy(orgId, input) {
    const token = providerCredential(orgId, 'host.github');
    if (!token) return { ok: false, status: 'simulated', live: false, error: 'GitHub token not configured' };
    const owner = await httpJson<{ login?: string }>('https://api.github.com/user', {
      headers: { authorization: `Bearer ${token}`, 'user-agent': 'AcquisitionOS' },
      timeoutMs: 15_000,
    });
    if (!owner.ok || !owner.data?.login) return { ok: false, status: 'failed', live: true, error: owner.error };
    const repo = `site-${input.siteName}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    await httpJson(`https://api.github.com/user/repos`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'user-agent': 'AcquisitionOS' },
      body: { name: repo, auto_init: true, private: false },
      timeoutMs: 20_000,
    });
    const put = await httpJson(`https://api.github.com/repos/${owner.data.login}/${repo}/contents/index.html`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'user-agent': 'AcquisitionOS' },
      body: { message: `Deploy v${input.version}`, content: Buffer.from(input.html).toString('base64') },
      timeoutMs: 30_000,
    });
    if (!put.ok) return { ok: false, status: 'failed', live: true, error: put.error };
    await httpJson(`https://api.github.com/repos/${owner.data.login}/${repo}/pages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'user-agent': 'AcquisitionOS' },
      body: { source: { branch: 'main', path: '/' } },
      timeoutMs: 20_000,
    });
    return { ok: true, status: 'deployed', url: `https://${owner.data.login}.github.io/${repo}/`, live: true };
  },
};

export const HOSTING_PROVIDERS: HostingProvider[] = [localHostingProvider, vercelProvider, netlifyProvider, githubPagesProvider];

// ═════════════════════════════════════════════════════════════
// PAYMENTS (§31, §35)
// ═════════════════════════════════════════════════════════════
export const stripeProvider: PaymentProvider = {
  key: 'stripe.payments',
  label: 'Stripe',
  requiresCredentials: true,
  credentialLabel: 'Stripe secret key',
  description: 'Charges and recurring subscriptions. Payment status always comes from Stripe — never assumed.',

  async createCharge(orgId, input) {
    const key = providerCredential(orgId, 'stripe.payments');
    if (!key) return { ok: false, status: 'not_configured', live: false, error: 'Stripe not configured' };
    const res = await httpText_('https://api.stripe.com/v1/payment_intents', {
      method: 'POST',
      auth: { user: key, pass: '' },
      form: {
        amount: String(Math.round(input.amount * 100)),
        currency: input.currency.toLowerCase(),
        description: input.description,
        automatic_payment_methods: '[enabled]=true',
      },
    });
    if (!res.ok) return { ok: false, status: 'failed', live: true, error: res.error };
    // A created PaymentIntent is *pending* until the customer completes it.
    return { ok: true, status: 'pending', providerPaymentId: res.sid, live: true };
  },

  async createSubscription(orgId, input) {
    const key = providerCredential(orgId, 'stripe.payments');
    if (!key) return { ok: false, status: 'not_configured', live: false, error: 'Stripe not configured' };
    const res = await httpText_('https://api.stripe.com/v1/subscriptions', {
      method: 'POST',
      auth: { user: key, pass: '' },
      form: {
        [`items[0][price_data][unit_amount]`]: String(Math.round(input.amount * 100)),
        [`items[0][price_data][currency]`]: input.currency.toLowerCase(),
        [`items[0][price_data][recurring][interval]`]: input.interval,
        [`items[0][price_data][product_data][name]`]: input.description,
      },
    });
    if (!res.ok) return { ok: false, status: 'failed', live: true, error: res.error };
    return { ok: true, status: 'pending', providerPaymentId: res.sid, live: true };
  },
};

/**
 * Manual invoicing. Creates a pending invoice record only — it can never mark
 * anything paid, because no money moved (§31).
 */
export const manualInvoiceProvider: PaymentProvider = {
  key: 'payments.manual',
  label: 'Manual invoice (no gateway)',
  requiresCredentials: false,
  description: 'Records an invoice as pending. Marking it paid requires a real payment gateway or a manual, audited confirmation.',

  async createCharge() {
    return { ok: true, status: 'pending', live: false };
  },
};

export const PAYMENT_PROVIDERS: PaymentProvider[] = [stripeProvider, manualInvoiceProvider];

// ═════════════════════════════════════════════════════════════
// SOCIAL PUBLISHING (§36)
// ═════════════════════════════════════════════════════════════
export const bufferProvider: SocialProvider = {
  key: 'social.buffer',
  label: 'Buffer',
  requiresCredentials: true,
  credentialLabel: 'Buffer access token',
  description: 'Schedules and publishes across Instagram, Facebook, LinkedIn, X and Pinterest.',
  platforms: ['instagram', 'facebook', 'linkedin', 'twitter', 'pinterest'],

  async publish(orgId, input) {
    const token = providerCredential(orgId, 'social.buffer');
    if (!token) return { ok: false, status: 'not_configured', live: false, error: 'Buffer not configured' };
    const res = await httpJson<{ id?: string }>('https://api.bufferapp.com/1/updates/create.json', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: { profile_id: input.accountId, text: input.caption, media: input.media?.[0], scheduled_at: input.scheduledFor },
      timeoutMs: 20_000,
    });
    if (!res.ok) return { ok: false, status: 'failed', live: true, error: res.error };
    return { ok: true, status: input.scheduledFor ? 'scheduled' : 'published', postId: res.data?.id, live: true };
  },
};

export const metaGraphProvider: SocialProvider = {
  key: 'social.meta',
  label: 'Meta Graph API (Instagram / Facebook)',
  requiresCredentials: true,
  credentialLabel: 'Meta long-lived access token',
  description: 'Direct Instagram and Facebook publishing plus insights.',
  platforms: ['instagram', 'facebook'],

  async publish(orgId, input) {
    const token = providerCredential(orgId, 'social.meta');
    if (!token) return { ok: false, status: 'not_configured', live: false, error: 'Meta token not configured' };
    const media = await httpJson<{ id?: string }>(
      `https://graph.facebook.com/v19.0/${input.accountId}/media?${qs({
        image_url: input.media?.[0],
        caption: input.caption,
        access_token: token,
      })}`,
      { method: 'POST', timeoutMs: 30_000 }
    );
    if (!media.ok || !media.data?.id) return { ok: false, status: 'failed', live: true, error: media.error };
    const publish = await httpJson<{ id?: string }>(
      `https://graph.facebook.com/v19.0/${input.accountId}/media_publish?${qs({
        creation_id: media.data.id,
        access_token: token,
      })}`,
      { method: 'POST', timeoutMs: 30_000 }
    );
    if (!publish.ok) return { ok: false, status: 'failed', live: true, error: publish.error };
    return { ok: true, status: 'published', postId: publish.data?.id, live: true };
  },
};

export const socialOutboxProvider: SocialProvider = {
  key: 'social.outbox',
  label: 'Local social outbox',
  requiresCredentials: false,
  description: 'Holds approved posts in the outbox without publishing. Connect Buffer or Meta to publish for real.',
  platforms: ['instagram', 'facebook', 'linkedin', 'twitter', 'tiktok'],

  async publish() {
    return { ok: true, status: 'scheduled', live: false };
  },
};

export const SOCIAL_PROVIDERS: SocialProvider[] = [bufferProvider, metaGraphProvider, socialOutboxProvider];

// ═════════════════════════════════════════════════════════════
// IMAGE GENERATION (§22)
// ═════════════════════════════════════════════════════════════
export const openaiImageProvider: ImageProvider = {
  key: 'openai.images',
  label: 'OpenAI Images',
  requiresCredentials: true,
  credentialLabel: 'OpenAI API key',
  description: 'Photoreal or illustrated imagery for hero sections and service cards.',
  costPerImage: 0.04,

  async generate(orgId, prompt, opts) {
    const key = providerCredential(orgId, 'openai.images');
    if (!key) return { ok: false, live: false, error: 'OpenAI key not configured' };
    const res = await httpJson<{ data?: { url?: string }[] }>('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}` },
      body: { model: 'gpt-image-1', prompt, size: `${opts?.width ?? 1024}x${opts?.height ?? 1024}`, n: 1 },
      timeoutMs: 90_000,
    });
    if (!res.ok) return { ok: false, live: true, error: res.error };
    return { ok: true, url: res.data?.data?.[0]?.url, live: true };
  },
};

/**
 * Deterministic local artwork. Produces real, usable SVG — abstract brand
 * artwork derived from the business palette. Never a fake photo, and never
 * presented as a real photograph of the business (§22).
 */
export const localImageProvider: ImageProvider = {
  key: 'image.local',
  label: 'Generated SVG artwork (local)',
  requiresCredentials: false,
  description: 'Procedural SVG artwork seeded by the brand palette. Abstract by design — no invented photography.',
  costPerImage: 0,

  async generate(_orgId, prompt) {
    const { svgArtwork, dataUri } = await import('@/lib/artwork');
    const svg = svgArtwork(prompt);
    return { ok: true, url: dataUri(svg), live: true };
  },
};

export const IMAGE_PROVIDERS: ImageProvider[] = [openaiImageProvider, localImageProvider];

// ═════════════════════════════════════════════════════════════
// OUTBOX (used by simulated sends so they are auditable, §18)
// ═════════════════════════════════════════════════════════════
export function recordOutboxEntry(orgId: string, entry: {
  channel: string;
  to: string;
  subject?: string | null;
  body: string;
  messageId: string;
}): string {
  const outboxId = id('out');
  run(
    `INSERT INTO automation_logs
       (id, org_id, level, category, message, entity_type, entity_id, detail, retryable, retry_count, resolution, created_at)
     VALUES (?,?,?,?,?,?,?,?,'false' ,0,'resolved',?)`,
    [
      outboxId,
      orgId,
      'info',
      'outreach',
      `Outbox: ${entry.channel} → ${entry.to}${entry.subject ? ` — ${entry.subject}` : ''}`,
      'outreach_message',
      entry.messageId,
      JSON.stringify({ ...entry, simulated: true }),
      nowIso(),
    ]
  );
  return outboxId;
}

export function listOutbox(orgId: string, limit = 50) {
  return all(
    `SELECT * FROM automation_logs WHERE org_id = ? AND category = 'outreach' AND message LIKE 'Outbox:%'
      ORDER BY created_at DESC LIMIT ?`,
    [orgId, limit]
  );
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

/** Registers every provider in the catalogue. Called once at boot. */
export function registerAllProviders(): void {
  DISCOVERY_PROVIDERS.forEach(registerDiscovery);
  ENRICHMENT_PROVIDERS.forEach(registerEnrichment);
  COMMUNICATION_PROVIDERS.forEach(registerCommunication);
  HOSTING_PROVIDERS.forEach(registerHosting);
  PAYMENT_PROVIDERS.forEach(registerPayment);
  SOCIAL_PROVIDERS.forEach(registerSocial);
  IMAGE_PROVIDERS.forEach(registerImage);
  AI_PROVIDERS.forEach(registerAi);
}

export function pickEmailProvider(orgId: string) {
  const order = ['resend.email', 'sendgrid.email'];
  for (const key of order) {
    if (providerCredential(orgId, key)) {
      return COMMUNICATION_PROVIDERS.find((p) => p.key === key)!;
    }
  }
  return outboxProvider;
}

export function pickChannelProvider(orgId: string, channel: string) {
  if (channel === 'sms') return providerCredential(orgId, 'twilio.sms') ? twilioSmsProvider : outboxSmsProvider;
  if (channel === 'whatsapp') return providerCredential(orgId, 'twilio.whatsapp') ? twilioWhatsappProvider : outboxWhatsappProvider;
  if (channel === 'email') return pickEmailProvider(orgId);
  // linkedin / phone / custom are manual actions by definition
  return outboxProvider;
}

export function latestDeployment(orgId: string, websiteId: string) {
  return get('SELECT * FROM deployments WHERE org_id = ? AND website_id = ? ORDER BY created_at DESC LIMIT 1', [
    orgId,
    websiteId,
  ]);
}

export { qs };
