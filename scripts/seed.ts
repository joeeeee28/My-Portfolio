/**
 * Seeds demo data so every screen is immediately understandable (§73).
 * Every record is flagged `is_demo = 1` and labelled in the UI.
 */
import { initDb } from './db-init';
import { seedDemoData, DEMO_BUSINESSES } from '../src/data/seed';
import { scoreBusiness, rescoreAll } from '../src/engine/scoring';
import { computeNba, persistSalesIntelligence } from '../src/engine/nba';
import { buildActionQueue } from '../src/engine/queues';
import { closeDb, all } from '../src/db';

const { orgId } = initDb();
const res = seedDemoData(orgId);

// Score and rank everything so the queues and pipeline are populated.
const businesses = all<{ id: string }>(`SELECT id FROM businesses WHERE org_id = ? AND merged_into IS NULL`, [orgId]);
for (const b of businesses) {
  scoreBusiness(orgId, b.id, { actor: 'seed', log: false });
  computeNba(orgId, b.id);
  persistSalesIntelligence(orgId, b.id);
}

const queue = buildActionQueue(orgId, { limit: 500 });

// eslint-disable-next-line no-console
console.log(`✓ demo data — ${res.businesses} businesses, ${res.contacts} contacts, ${res.clients} clients, ${res.projects} projects, ${res.proposals} proposals`);
// eslint-disable-next-line no-console
console.log(`✓ scored ${businesses.length} prospect(s) · Action Queue has ${queue.length} item(s)`);
// eslint-disable-next-line no-console
console.log(`  catalogue contains ${DEMO_BUSINESSES.length} businesses across ${new Set(DEMO_BUSINESSES.map((b) => b.industry)).size} industries`);
// eslint-disable-next-line no-console
console.log('  all demo records are flagged is_demo = 1 and labelled in the UI');

closeDb();
