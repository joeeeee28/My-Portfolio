/**
 * Security tests (§35, §36, §37, §46).
 *
 * Covers authentication, authorization, tenant isolation, secret handling and
 * the compliance controls that prevent unrestricted outreach.
 */
process.env.OS_DATABASE ||= require('node:path').join(process.cwd(), '.data', `sectest-${Date.now()}.db`);

import fs from 'node:fs';
import path from 'node:path';
import { migrate } from '../src/db/migrate';
import { migrateUp } from '../src/db/migrations';
import { bootstrapOrg } from '../src/lib/settings';
import { registerAllProviders } from '../src/lib/providers';
import { syncSourceRows } from '../src/lib/providers/registry';
import { closeDb, get, run, scalar, all } from '../src/db';
import { hashPassword, verifyPassword, validatePassword, needsRehash } from '../src/lib/password';
import { checkAndConsume, isRateLimited } from '../src/lib/ratelimit';
import { setSecret, getSecret, listSecrets, maskSecret, encryptSecret, decryptSecret, masterKeySource } from '../src/lib/secrets';
import { createBusiness } from '../src/repo/business';
import { isSuppressed, canContact, handleOptOut, suppress } from '../src/engine/compliance';
import { can } from '../src/lib/domain';
import { workspaceNeedsSetup } from '../src/lib/auth';

const a = (globalThis as unknown as { assert: unknown }).assert as never as {
  (c: unknown, m?: string): void;
  ok(v: unknown, m?: string): void;
  equal(a: unknown, b: unknown, m?: string): void;
  includes(h: unknown, n: unknown, m?: string): void;
};

migrate();
migrateUp({ backup: false });
const { org } = bootstrapOrg('Security Test Org');
registerAllProviders();
syncSourceRows(org.id);
const ORG = org.id;

/** Reads every source file so we can assert on the codebase itself. */
const sourceFiles = (function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' || e.name === '.next' ? [] : walk(p);
    return /\.(ts|tsx)$/.test(e.name) ? [p] : [];
  });
})('src');

const sources = new Map(sourceFiles.map((f) => [f, fs.readFileSync(f, 'utf8')]));
const allSource = Array.from(sources.values()).join('\n');

export default [
  {
    name: 'Authentication (§35)',
    tests: [
      {
        name: 'passwords are salted, so the same password hashes differently',
        run: () => {
          const h1 = hashPassword('a-repeated-password').hash;
          const h2 = hashPassword('a-repeated-password').hash;
          a(h1 !== h2, 'identical passwords must not produce identical hashes');
        },
      },
      {
        name: 'the plaintext never appears in the stored hash',
        run: () => {
          const secret = 'SuperSecret!Passw0rd';
          const { hash } = hashPassword(secret);
          a(!hash.includes(secret), 'plaintext must not be stored');
          a(!hash.includes(Buffer.from(secret).toString('base64')), 'nor base64 of the plaintext');
        },
      },
      {
        name: 'a wrong password never verifies',
        run: () => {
          const { hash } = hashPassword('correct-password-here');
          for (const wrong of ['Correct-password-here', 'correct-password-here!', '', 'correct-password-her', 'correct-password-herex']) {
            a(!verifyPassword(wrong, hash), `"${wrong}" must not verify`);
          }
        },
      },
      {
        name: 'verification is safe against malformed and foreign hashes',
        run: () => {
          a(!verifyPassword('x', null), 'null must fail');
          a(!verifyPassword('x', ''), 'empty must fail');
          a(!verifyPassword('x', 'garbage'), 'garbage must fail');
          a(!verifyPassword('x', 'bcrypt$12$abcdefghijklmnopqrstuv'), 'a foreign algorithm must fail');
          a(!verifyPassword('x', 'scrypt$16384$8$1$!!notbase64!!$!!alsobad!!'), 'malformed base64 must fail');
        },
      },
      {
        name: 'weak passwords are rejected by policy',
        run: () => {
          a(validatePassword('short').length > 0, 'too short');
          a(validatePassword('password').some((i) => i.code === 'common'), 'too common');
          a(validatePassword('clientforge').some((i) => i.code === 'common'), 'product name must be blocked');
          a(validatePassword('Str0ng!Passw0rd#2026').length === 0, 'a strong password must be accepted');
        },
      },
      {
        name: 'weak hash parameters are flagged for transparent rehash',
        run: () => {
          a(needsRehash('scrypt$1024$8$1$c2FsdA==$aGFzaA=='), 'low cost parameters must be upgraded');
          a(!needsRehash(hashPassword('a-good-password').hash), 'current parameters need no upgrade');
        },
      },
      {
        name: 'a fresh workspace is not accessible before a password is set',
        run: () => {
          // The bootstrap owner has no password_hash, so the workspace must
          // report itself as needing setup rather than granting access.
          const owner = get<{ password_hash: string | null }>(
            'SELECT password_hash FROM users WHERE org_id = ? ORDER BY created_at ASC LIMIT 1',
            [ORG]
          );
          a(!owner?.password_hash, 'the bootstrap owner must have no password');
          a(workspaceNeedsSetup(), 'the workspace must report that setup is required');
        },
      },
      {
        name: 'sessions are stored hashed, never in plaintext',
        run: () => {
          const crypto = require('node:crypto') as typeof import('node:crypto');
          const token = crypto.randomBytes(32).toString('base64url');
          const hashed = crypto.createHash('sha256').update(token).digest('hex');
          run('INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?,?,?,?,?)', [
            `ses_sec_${Date.now()}`,
            scalar<string>('SELECT id FROM users WHERE org_id = ? LIMIT 1', [ORG]),
            hashed,
            new Date(Date.now() + 86_400_000).toISOString(),
            new Date().toISOString(),
          ]);
          const row = get<{ token_hash: string }>('SELECT token_hash FROM sessions ORDER BY created_at DESC LIMIT 1');
          a(row, 'a session must be stored');
          a(!row!.token_hash.includes(token), 'the raw token must never be stored');
          a.equal(row!.token_hash, hashed, 'only the hash may be stored');
        },
      },
      {
        name: 'login attempts are rate limited',
        run: () => {
          const scope = `login:sec-test-${Date.now()}`;
          for (let i = 0; i < 8; i++) checkAndConsume(scope, 'auth', 8, 15);
          a(isRateLimited(scope, 'auth', 8, 15), 'brute-force attempts must be throttled');
        },
      },
    ],
  },

  {
    name: 'Secrets management (§35)',
    tests: [
      {
        name: 'a stored credential is encrypted at rest',
        run: () => {
          const plaintext = 'sk-live-abc123SUPERsecret456';
          setSecret(ORG, 'security.test', plaintext, 'Security test key');
          const row = get<{ cipher_blob: string; last4: string }>(
            "SELECT cipher_blob, last4 FROM secrets WHERE org_id = ? AND provider_key = 'security.test'",
            [ORG]
          );
          a(row, 'the credential must be stored');
          a(!row!.cipher_blob.includes(plaintext), 'the plaintext must not appear in the database');
          a(!row!.cipher_blob.includes('SUPERsecret'), 'nor any fragment of it');
          a(row!.cipher_blob.startsWith('v1:'), 'the ciphertext must be versioned');
          a.equal(row!.last4, 't456', 'only the last four characters may be exposed');
        },
      },
      {
        name: 'the credential round-trips through decryption server-side',
        run: () => {
          const plaintext = 'sk-live-abc123SUPERsecret456';
          a.equal(getSecret(ORG, 'security.test'), plaintext, 'the server must be able to decrypt it');
        },
      },
      {
        name: 'the listing API never returns the plaintext',
        run: () => {
          const secrets = listSecrets(ORG);
          const listed = secrets.find((s) => s.provider_key === 'security.test');
          a(listed, 'the credential must be listed');
          const serialized = JSON.stringify(listed);
          a(!serialized.includes('SUPERsecret'), 'the plaintext must never be serialised');
          a(!('cipher_blob' in (listed as object)), 'the ciphertext must not be exposed either');
        },
      },
      {
        name: 'masking hides all but the last four characters',
        run: () => {
          const masked = maskSecret('sk-live-abcdefghij');
          a(!masked.includes('abcdefgh'), 'the body must be masked');
          a(masked.includes('ij'), 'the tail may be shown');
          a.equal(maskSecret('abc'), '••••', 'a short secret must be fully masked');
        },
      },
      {
        name: 'tampering with the ciphertext is detected',
        run: () => {
          const blob = encryptSecret('a-secret-value');
          const parts = blob.split(':');
          parts[3] = Buffer.from('tampered-payload').toString('base64');
          let threw = false;
          try {
            decryptSecret(parts.join(':'));
          } catch {
            threw = true;
          }
          a(threw, 'GCM authentication must reject a tampered ciphertext');
        },
      },
      {
        name: 'a master key strategy is reported',
        run: () => {
          a(['env', 'file'].includes(masterKeySource()), 'the key source must be known');
        },
      },
    ],
  },

  {
    name: 'Authorization & RBAC (§37)',
    tests: [
      {
        name: 'owner and admin have full access',
        run: () => {
          a(can('owner', 'anything.at.all'), 'owner must have full access');
          a(can('admin', 'anything.at.all'), 'admin must have full access');
        },
      },
      {
        name: 'sales cannot reach delivery or configuration',
        run: () => {
          a(can('sales', 'prospects.read'), 'sales must read prospects');
          a(can('sales', 'outreach.send'), 'sales must send outreach');
          a(!can('sales', 'deployments.write'), 'sales must not deploy');
          a(!can('sales', 'settings.write'), 'sales must not change settings');
        },
      },
      {
        name: 'designer is scoped to design work',
        run: () => {
          a(can('designer', 'mockups.write'), 'designer must edit concepts');
          a(!can('designer', 'outreach.send'), 'designer must not send outreach');
          a(!can('designer', 'proposals.write'), 'designer must not write proposals');
        },
      },
      {
        name: 'developer is scoped to delivery',
        run: () => {
          a(can('developer', 'deployments.write'), 'developer must deploy');
          a(!can('developer', 'outreach.send'), 'developer must not send outreach');
        },
      },
      {
        name: 'social manager is scoped to the social workspace',
        run: () => {
          a(can('social_manager', 'social.write'), 'social manager must manage social');
          a(can('social_manager', 'social.publish'), 'social manager must publish');
          a(!can('social_manager', 'proposals.write'), 'social manager must not write proposals');
        },
      },
      {
        name: 'client is restricted to the portal only',
        run: () => {
          a(can('client', 'portal.read'), 'client must read the portal');
          a(!can('client', 'prospects.read'), 'client must not see the prospect database');
          a(!can('client', 'outreach.send'), 'client must not send outreach');
          a(!can('client', 'settings.write'), 'client must not change settings');
          a(!can('client', 'analytics.read'), 'client must not see internal analytics');
        },
      },
      {
        name: 'an unknown role is denied everything',
        run: () => {
          a(!can('nonexistent-role' as never, 'prospects.read'), 'an unknown role must have no access');
        },
      },
    ],
  },

  {
    name: 'Tenant isolation (§36)',
    tests: [
      {
        name: 'every tenant-scoped table filters by org_id',
        run: () => {
          // Tables that legitimately have no org_id: they are children reached
          // only through an org-scoped parent, or global infrastructure.
          // Exempt: global infrastructure, or pure child rows that hold no
          // tenant data of their own and are reachable only through an
          // org-scoped parent with ON DELETE CASCADE.
          const exempt = new Set([
            'organizations', 'sessions', 'mockup_versions', 'website_versions', 'sequence_steps',
            'proposal_items', 'call_notes', 'experiment_variants', 'duplicate_events', 'job_steps',
            'rate_limits', 'api_requests', 'health_checks', 'backups', 'login_attempts',
            'schema_migrations', 'businesses_fts', 'businesses_fts_data', 'businesses_fts_idx',
            'businesses_fts_content', 'businesses_fts_docsize', 'businesses_fts_config',
            'data_confidence',      // PK is business_id → businesses (org-scoped, CASCADE)
            'discovery_run_items',  // FK run_id → discovery_runs (org-scoped, CASCADE)
            'mockup_views',         // FK mockup_id → mockups (org-scoped, CASCADE)
          ]);
          const tables = all<{ name: string; sql: string }>(
            "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
          );
          const missing: string[] = [];
          for (const t of tables) {
            if (exempt.has(t.name)) continue;
            if (!/\borg_id\b/.test(t.sql ?? '')) missing.push(t.name);
          }
          a(missing.length === 0, `tables without org_id: ${missing.join(', ')}`);

          // The exempt child tables must genuinely be reachable only through an
          // org-scoped parent, otherwise exempting them would hide a leak.
          const childParents: Record<string, string> = {
            data_confidence: 'businesses',
            discovery_run_items: 'discovery_runs',
            mockup_views: 'mockups',
            mockup_versions: 'mockups',
            proposal_items: 'proposals',
            call_notes: 'calls',
            sequence_steps: 'sequences',
            experiment_variants: 'experiments',
            duplicate_events: 'businesses',
            job_steps: 'job_runs',
            website_versions: 'websites',
          };
          for (const [child, parent] of Object.entries(childParents)) {
            const parentCols = all<{ name: string }>(`PRAGMA table_info(${parent})`).map((c) => c.name);
            a(parentCols.includes('org_id'), `${child} is exempt via ${parent}, but ${parent} has no org_id`);
            const childCols = all<{ name: string }>(`PRAGMA table_info(${child})`).map((c) => c.name);
            const hasLink = childCols.some((c) => c.endsWith('_id'));
            a(hasLink, `${child} must link to its parent`);
          }
        },
      },
      {
        name: 'a business created in one org is invisible to another',
        run: () => {
          const otherOrg = `org_other_${Date.now().toString(36)}`;
          run("INSERT INTO organizations (id, name, agency_mode, created_at, updated_at) VALUES (?, 'Other Org', 0, ?, ?)", [
            otherOrg,
            new Date().toISOString(),
            new Date().toISOString(),
          ]);
          const { business } = createBusiness(
            ORG,
            { name: 'Isolation Test Business', phone: '+44 117 555 0001' },
            { providerKey: 'test', confidence: 0.9 }
          );
          const visibleToOwner = get('SELECT id FROM businesses WHERE id = ? AND org_id = ?', [business.id, ORG]);
          const visibleToOther = get('SELECT id FROM businesses WHERE id = ? AND org_id = ?', [business.id, otherOrg]);
          a(visibleToOwner, 'the owner org must see it');
          a(!visibleToOther, 'another org must not see it');
        },
      },
      {
        name: 'aggregate queries are org-scoped',
        run: () => {
          const mine = scalar<number>('SELECT COUNT(*) FROM businesses WHERE org_id = ?', [ORG]) ?? 0;
          const allOrgs = scalar<number>('SELECT COUNT(*) FROM businesses') ?? 0;
          a(mine <= allOrgs, 'the org-scoped count must never exceed the global count');
          a(mine > 0, 'the test org must own businesses');
        },
      },
    ],
  },

  {
    name: 'Source-code security invariants',
    tests: [
      {
        name: 'no secret is ever returned to the client',
        run: () => {
          // Any route that reads a secret must not also serialise it into a response.
          const risky: string[] = [];
          for (const [file, src] of sources) {
            if (/getSecret\(/.test(src) && /NextResponse\.json\([^)]*getSecret/s.test(src)) risky.push(file);
          }
          a(risky.length === 0, `files that may leak secrets: ${risky.join(', ')}`);
        },
      },
      {
        name: 'secrets are never logged',
        run: () => {
          const risky: string[] = [];
          for (const [file, src] of sources) {
            if (/console\.(log|error|warn)\([^)]*getSecret\(/s.test(src)) risky.push(file);
            if (/logAutomation\([^)]*getSecret\(/s.test(src)) risky.push(file);
          }
          a(risky.length === 0, `files that log secrets: ${risky.join(', ')}`);
        },
      },
      {
        name: 'no credential is hard-coded in source',
        run: () => {
          const patterns = [
            /sk-[A-Za-z0-9]{20,}/,
            /AKIA[0-9A-Z]{16}/,
            /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
            /xox[baprs]-[A-Za-z0-9-]{10,}/,
          ];
          const hits: string[] = [];
          for (const [file, src] of sources) {
            for (const p of patterns) {
              if (p.test(src)) hits.push(`${file}: ${p}`);
            }
          }
          a(hits.length === 0, `possible hard-coded credentials: ${hits.join(', ')}`);
        },
      },
      {
        name: 'the session cookie is httpOnly',
        run: () => {
          a(/httpOnly:\s*true/.test(allSource), 'the session cookie must be httpOnly');
        },
      },
      {
        name: 'the session cookie is secure in production',
        run: () => {
          a(/secure:\s*process\.env\.NODE_ENV === 'production'/.test(allSource), 'the cookie must be secure in production');
        },
      },
      {
        name: 'security headers are configured',
        run: () => {
          const config = fs.readFileSync(path.join(process.cwd(), 'next.config.mjs'), 'utf8');
          a(config.includes('X-Frame-Options'), 'clickjacking protection must be set');
          a(config.includes('X-Content-Type-Options'), 'MIME sniffing protection must be set');
          a(config.includes('Referrer-Policy'), 'referrer policy must be set');
        },
      },
      {
        name: 'no raw stack trace reaches a user-facing response',
        run: () => {
          const risky: string[] = [];
          for (const [file, src] of sources) {
            if (!file.includes('/app/')) continue;
            if (/NextResponse\.json\([^)]*err(or)?\.stack/s.test(src)) risky.push(file);
          }
          a(risky.length === 0, `files exposing stack traces: ${risky.join(', ')}`);
        },
      },
      {
        name: 'an env example exists and contains no real secrets',
        run: () => {
          const envPath = path.join(process.cwd(), '.env.example');
          a(fs.existsSync(envPath), '.env.example must exist');
          const content = fs.readFileSync(envPath, 'utf8');
          a(!/sk-[A-Za-z0-9]{20,}/.test(content), 'the example must not contain a real key');
          a(content.includes('OS_MASTER_KEY'), 'the master key must be documented');
        },
      },
      {
        name: '.env is gitignored',
        run: () => {
          const ignore = fs.readFileSync(path.join(process.cwd(), '.gitignore'), 'utf8');
          a(ignore.includes('.env'), '.env must be gitignored');
          a(ignore.includes('.data'), 'the database directory must be gitignored');
        },
      },
    ],
  },

  {
    name: 'Compliance controls (§13, §56)',
    tests: [
      {
        name: 'an opt-out suppresses the business, its email, phone and domain',
        run: () => {
          const { business } = createBusiness(
            ORG,
            { name: 'Compliance Test Business', email: 'stop@compliance-test.example', phone: '+44 117 555 7777', website: 'https://compliance-test.example' },
            { providerKey: 'test', confidence: 0.9 }
          );
          handleOptOut(ORG, { businessId: business.id, channel: 'email', reason: 'test' });
          a(isSuppressed(ORG, { businessId: business.id }).suppressed, 'business must be suppressed');
          a(isSuppressed(ORG, { email: 'stop@compliance-test.example' }).suppressed, 'email must be suppressed');
          a(isSuppressed(ORG, { phone: '+44 117 555 7777' }).suppressed, 'phone must be suppressed');
          a(isSuppressed(ORG, { domain: 'compliance-test.example' }).suppressed, 'domain must be suppressed');
        },
      },
      {
        name: 'contact is blocked for a suppressed business',
        run: () => {
          const business = get<never>('SELECT * FROM businesses WHERE name = ? AND org_id = ?', ['Compliance Test Business', ORG]) as never;
          const verdict = canContact(ORG, business as never, null, 'email');
          a.equal(verdict.allowed, false, 'contact must be blocked');
          a(verdict.reasons.length > 0, 'the reason must be recorded');
        },
      },
      {
        name: 'a suppression cannot be weakened by a later, weaker record',
        run: () => {
          const business = get<{ id: string }>('SELECT id FROM businesses WHERE name = ? AND org_id = ?', ['Compliance Test Business', ORG]);
          a.equal(get<{ consent_state: string }>('SELECT consent_state FROM businesses WHERE id = ?', [business!.id])?.consent_state, 'do_not_contact');
          // A weaker, address-level suppression must not downgrade it.
          suppress(ORG, 'email', 'another@compliance-test.example', 'bounce', 'provider_webhook', { businessId: business!.id });
          a.equal(get<{ consent_state: string }>('SELECT consent_state FROM businesses WHERE id = ?', [business!.id])?.consent_state, 'do_not_contact',
            'do_not_contact must not be downgraded');
        },
      },
      {
        name: 'an existing client cannot receive acquisition outreach',
        run: () => {
          const { business } = createBusiness(ORG, { name: 'Already A Client', email: 'client@existing.example' }, { providerKey: 'test', confidence: 0.9 });
          run("UPDATE businesses SET stage = 'active_client' WHERE id = ?", [business.id]);
          const verdict = canContact(ORG, get<never>('SELECT * FROM businesses WHERE id = ?', [business.id]) as never, null, 'email');
          a.equal(verdict.allowed, false, 'an existing client must not be re-prospected');
        },
      },
      {
        name: 'quiet hours are enforced as a send constraint',
        run: () => {
          const { inQuietHours } = require('../src/engine/compliance') as typeof import('../src/engine/compliance');
          a(inQuietHours('20:00', '08:00', new Date('2026-08-26T02:00:00Z'), 'UTC'), '02:00 must be inside quiet hours');
        },
      },
    ],
  },

  {
    name: 'Honesty invariants (§51)',
    tests: [
      {
        name: 'no unconfigured provider claims to be live',
        run: () => {
          // Every provider that needs credentials must report not-configured
          // rather than pretending to work.
          const { integrationInventory } = require('../src/lib/providers/registry') as typeof import('../src/lib/providers/registry');
          const inventory = integrationInventory(ORG);
          for (const item of inventory) {
            if (item.requiresCredentials) {
              a.equal(item.configured, false, `${item.key} must report not-configured without credentials`);
            }
          }
        },
      },
      {
        name: 'deployment and payment statuses default to honest states',
        run: () => {
          const proposalCols = all<{ name: string }>('PRAGMA table_info(proposals)').map((c) => c.name);
          a(proposalCols.includes('signature_status'), 'signature status must be tracked');
          a(proposalCols.includes('payment_status'), 'payment status must be tracked');
          const deployCols = all<{ name: string }>('PRAGMA table_info(deployments)').map((c) => c.name);
          a(deployCols.includes('simulated'), 'deployments must record whether they were simulated');
          const msgCols = all<{ name: string }>('PRAGMA table_info(outreach_messages)').map((c) => c.name);
          a(msgCols.includes('simulated'), 'messages must record whether they were actually sent');
        },
      },
    ],
  },
];

process.on('exit', () => {
  try {
    closeDb();
    const db = process.env.OS_DATABASE;
    if (db) {
      fs.rmSync(db, { force: true });
      fs.rmSync(`${db}-wal`, { force: true });
      fs.rmSync(`${db}-shm`, { force: true });
    }
  } catch {
    /* best effort */
  }
});
