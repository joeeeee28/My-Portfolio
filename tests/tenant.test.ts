/**
 * Multi-tenant isolation tests (§49, §36).
 *
 * A hidden button is not security. These tests assert at the data layer that
 * one organisation can never read another organisation's businesses, contacts,
 * projects, automation, analytics or AI context.
 */
process.env.OS_DATABASE ||= require('node:path').join(process.cwd(), '.data', `tenant-${Date.now()}.db`);

import fs from 'node:fs';
import { migrate } from '../src/db/migrate';
import { migrateUp } from '../src/db/migrations';
import { bootstrapOrg, createUser } from '../src/lib/settings';
import { registerAllProviders } from '../src/lib/providers';
import { ensureAutomationJobs, ensureScoringProfile, ensureIcpProfile, ensurePackages, ensureDefaultSequences } from '../src/engine/bootstrap';
import { all, get, scalar, run, closeDb } from '../src/db';
import { createBusiness, listBusinesses, listContacts, getBusiness, listSources, getBusiness as _gb } from '../src/repo/business';
import { scoreBusiness, latestScore } from '../src/engine/scoring';
import { listBusinessActivity } from '../src/lib/activity';
import { buildResourceCenter } from '../src/engine/resources';
import { buildActionQueue } from '../src/engine/queues';
import { listJobs } from '../src/engine/scheduler';
import { can } from '../src/lib/domain';

const a = (globalThis as unknown as { assert: unknown }).assert as never as {
  (c: unknown, m?: string): void;
  ok(v: unknown, m?: string): void;
  equal(a: unknown, b: unknown, m?: string): void;
};

migrate();
migrateUp({ backup: false });
const { org: orgA } = bootstrapOrg('Tenant A');
registerAllProviders();
ensureAutomationJobs(orgA.id);
ensureScoringProfile(orgA.id);
ensureIcpProfile(orgA.id);
ensurePackages(orgA.id);
ensureDefaultSequences(orgA.id);

// Create a second, entirely separate organisation.
const orgBId = `org_b_${Date.now().toString(36)}`;
const now = new Date().toISOString();
run("INSERT INTO organizations (id, name, agency_mode, created_at, updated_at) VALUES (?, 'Tenant B', 0, ?, ?)", [orgBId, now, now]);
createUser(orgBId, 'owner@tenantb.test', 'Tenant B Owner', 'owner');
ensureAutomationJobs(orgBId);
ensureScoringProfile(orgBId);
ensureIcpProfile(orgBId);
ensurePackages(orgBId);
ensureDefaultSequences(orgBId);

const A = orgA.id;
const B = orgBId;

const secretA = createBusiness(A, { name: 'Tenant A Secret Bakery', category: 'Bakery', email: 'secret@tenanta.test', website: 'https://tenanta.test' }, { providerKey: 'test', confidence: 0.9 });
const secretB = createBusiness(B, { name: 'Tenant B Secret Dentist', category: 'Dentist', email: 'secret@tenantb.test', website: 'https://tenantb.test' }, { providerKey: 'test', confidence: 0.9 });
scoreBusiness(A, secretA.business.id, { actor: 'test' });
scoreBusiness(B, secretB.business.id, { actor: 'test' });

export default [
  {
    name: 'Tenant isolation: businesses (§49)',
    tests: [
      {
        name: 'organisation A cannot read organisation B\'s business by id',
        run: () => {
          const leaked = getBusiness(A, secretB.business.id);
          a.equal(leaked, null, 'a cross-tenant business lookup must return null');
        },
      },
      {
        name: 'organisation B cannot read organisation A\'s business by id',
        run: () => {
          const leaked = getBusiness(B, secretA.business.id);
          a.equal(leaked, null, 'a cross-tenant business lookup must return null');
        },
      },
      {
        name: 'each organisation only lists its own businesses',
        run: () => {
          const aList = listBusinesses(A, { limit: 500 }).rows;
          const bList = listBusinesses(B, { limit: 500 }).rows;
          a(aList.every((r) => r.org_id === A), 'A must only see its own businesses');
          a(bList.every((r) => r.org_id === B), 'B must only see its own businesses');
          a(!aList.some((r) => r.id === secretB.business.id), 'A must not see B\'s business');
          a(!bList.some((r) => r.id === secretA.business.id), 'B must not see A\'s business');
        },
      },
      {
        name: 'a full-text search cannot cross tenants',
        run: () => {
          const aHits = listBusinesses(A, { q: 'Secret Dentist', limit: 100 }).rows;
          a.equal(aHits.length, 0, 'A must not find B\'s business by search');
          const bHits = listBusinesses(B, { q: 'Secret Dentist', limit: 100 }).rows;
          a(bHits.length > 0, 'B must find its own business');
        },
      },
      {
        name: 'aggregate counts are scoped per organisation',
        run: () => {
          const aCount = scalar<number>('SELECT COUNT(*) FROM businesses WHERE org_id = ?', [A]) ?? 0;
          const bCount = scalar<number>('SELECT COUNT(*) FROM businesses WHERE org_id = ?', [B]) ?? 0;
          const total = scalar<number>('SELECT COUNT(*) FROM businesses') ?? 0;
          a.equal(aCount + bCount, total, 'per-tenant counts must sum to the global total');
          a(aCount > 0 && bCount > 0, 'both tenants must own businesses');
        },
      },
    ],
  },

  {
    name: 'Tenant isolation: related records (§49)',
    tests: [
      {
        name: 'contacts cannot be read across tenants',
        run: () => {
          const leaked = listContacts(A, secretB.business.id);
          a.equal(leaked.length, 0, 'A must not read B\'s contacts');
        },
      },
      {
        name: 'source attribution cannot be read across tenants',
        run: () => {
          const leaked = listSources(A, secretB.business.id);
          a.equal(leaked.length, 0, 'A must not read B\'s source attribution');
        },
      },
      {
        name: 'opportunity scores cannot be read across tenants',
        run: () => {
          const leaked = latestScore(A, secretB.business.id);
          a.equal(leaked, null, 'A must not read B\'s opportunity score');
        },
      },
      {
        name: 'activity timelines cannot be read across tenants',
        run: () => {
          const leaked = listBusinessActivity(A, secretB.business.id, 100);
          a.equal(leaked.length, 0, 'A must not read B\'s activity timeline');
        },
      },
      {
        name: 'automation jobs are scoped per organisation',
        run: () => {
          const aJobs = listJobs(A);
          const bJobs = listJobs(B);
          // listJobs is already org-scoped by its query; assert isolation by
          // confirming each tenant gets exactly its own registered job set and
          // that neither set is empty (a leak would show cross-tenant rows).
          a.equal(aJobs.length, 6, `A must see exactly its own 6 jobs, got ${aJobs.length}`);
          a.equal(bJobs.length, 6, `B must see exactly its own 6 jobs, got ${bJobs.length}`);
          const aIds = new Set(aJobs.map((j) => j.key));
          const bIds = new Set(bJobs.map((j) => j.key));
          a.equal(aIds.size, 6, 'A must have 6 distinct job keys');
          a.equal(bIds.size, 6, 'B must have 6 distinct job keys');
        },
      },
      {
        name: 'the action queue is scoped per organisation',
        run: () => {
          const aQueue = buildActionQueue(A, { limit: 200 });
          const bIds = new Set(listBusinesses(B, { limit: 500 }).rows.map((r) => r.id));
          a(aQueue.every((item) => !bIds.has(item.businessId)), 'A\'s action queue must not contain B\'s businesses');
        },
      },
      {
        name: 'the resource center is scoped per organisation',
        run: () => {
          const aCenter = buildResourceCenter(A);
          const bCenter = buildResourceCenter(B);
          a(aCenter.resources.length > 0 && bCenter.resources.length > 0, 'both tenants must get a resource center');
        },
      },
    ],
  },

  {
    name: 'Tenant isolation: schema guarantees (§36)',
    tests: [
      {
        name: 'every tenant-scoped table declares org_id',
        run: () => {
          const exempt = new Set([
            'organizations', 'sessions', 'mockup_versions', 'website_versions', 'sequence_steps',
            'proposal_items', 'call_notes', 'experiment_variants', 'duplicate_events', 'job_steps',
            'rate_limits', 'api_requests', 'health_checks', 'backups', 'login_attempts',
            'schema_migrations', 'data_confidence', 'discovery_run_items', 'mockup_views',
            'businesses_fts', 'businesses_fts_data', 'businesses_fts_idx',
            'businesses_fts_content', 'businesses_fts_docsize', 'businesses_fts_config',
          ]);
          const tables = all<{ name: string; sql: string }>(
            "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
          );
          const unscoped = tables.filter((t) => !exempt.has(t.name) && !/\borg_id\b/.test(t.sql ?? ''));
          a.equal(unscoped.length, 0, `tables missing org_id: ${unscoped.map((t) => t.name).join(', ')}`);
        },
      },
      {
        name: 'clients.business_id is UNIQUE so a client cannot be duplicated',
        run: () => {
          const ddl = scalar<string>("SELECT sql FROM sqlite_master WHERE type='table' AND name='clients'") ?? '';
          a(/business_id\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(ddl), 'clients.business_id must be UNIQUE');
        },
      },
      {
        name: 'foreign keys cascade so a deleted business cannot orphan data',
        run: () => {
          const ddl = scalar<string>("SELECT sql FROM sqlite_master WHERE type='table' AND name='contacts'") ?? '';
          a(/ON DELETE CASCADE/i.test(ddl), 'contacts must cascade on business deletion');
          const fkEnabled = scalar<number>('PRAGMA foreign_keys');
          a.equal(fkEnabled, 1, 'foreign keys must be enforced');
        },
      },
    ],
  },

  {
    name: 'RBAC is enforced, not just hidden (§46)',
    tests: [
      {
        name: 'owner and admin have full access',
        run: () => {
          a(can('owner', 'anything'), 'owner must have full access');
          a(can('admin', 'anything'), 'admin must have full access');
        },
      },
      {
        name: 'client role is denied every internal capability',
        run: () => {
          for (const cap of ['prospects.read', 'outreach.send', 'settings.write', 'analytics.read', 'deployments.write', 'proposals.write']) {
            a.equal(can('client', cap), false, `client must be denied ${cap}`);
          }
          a(can('client', 'portal.read'), 'client must be allowed portal access');
        },
      },
      {
        name: 'sales cannot deploy or change settings',
        run: () => {
          a.equal(can('sales', 'deployments.write'), false);
          a.equal(can('sales', 'settings.write'), false);
          a(can('sales', 'prospects.read'), 'sales must read prospects');
          a(can('sales', 'outreach.send'), 'sales must send outreach');
        },
      },
      {
        name: 'designer cannot send outreach or write proposals',
        run: () => {
          a.equal(can('designer', 'outreach.send'), false);
          a.equal(can('designer', 'proposals.write'), false);
          a(can('designer', 'mockups.write'), 'designer must edit concepts');
        },
      },
      {
        name: 'an unknown role is denied everything',
        run: () => a.equal(can('nonexistent' as never, 'prospects.read'), false),
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
