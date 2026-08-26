/**
 * Initialises the database: applies the schema, registers every provider,
 * bootstraps the workspace and seeds default configuration.
 * Safe to re-run — every step is idempotent.
 */
import { migrate, tableNames } from '../src/db/migrate';
import { dbPath, closeDb } from '../src/db';
import { bootstrapOrg } from '../src/lib/settings';
import { registerAllProviders } from '../src/lib/providers';
import { syncSourceRows } from '../src/lib/providers/registry';
import { registerModelCatalogue } from '../src/lib/ai/router';
import {
  ensureScoringProfile,
  ensureIcpProfile,
  ensureDefaultSequences,
  ensurePackages,
  ensureAutomationJobs,
  ensureAiTaskRoutes,
  ensureExperiments,
} from '../src/engine/bootstrap';

export function initDb(): { orgId: string; tables: number; path: string } {
  migrate();
  const { org } = bootstrapOrg();
  registerAllProviders();
  syncSourceRows(org.id);
  registerModelCatalogue(org.id);
  ensureScoringProfile(org.id);
  ensureIcpProfile(org.id);
  ensurePackages(org.id);
  ensureDefaultSequences(org.id);
  ensureAutomationJobs(org.id);
  ensureAiTaskRoutes(org.id);
  ensureExperiments(org.id);
  return { orgId: org.id, tables: tableNames().length, path: dbPath() };
}

if (require.main === module) {
  const res = initDb();
  // eslint-disable-next-line no-console
  console.log(`✓ schema applied — ${res.tables} tables/relations at ${res.path}`);
  // eslint-disable-next-line no-console
  console.log(`✓ workspace ready — org ${res.orgId}`);
  closeDb();
}
