/**
 * One-time boot for the server process.
 * Applies the schema, registers every provider, and ensures workspace defaults.
 * Safe to call repeatedly — every step is idempotent and guarded.
 */
import { migrate } from '@/db/migrate';
import { migrateUp } from '@/db/migrations';
import { bootstrapOrg } from '@/lib/settings';
import { registerAllProviders } from '@/lib/providers';
import { syncSourceRows } from '@/lib/providers/registry';
import { registerModelCatalogue } from '@/lib/ai/router';
import {
  ensureAiTaskRoutes,
  ensureAutomationJobs,
  ensureDefaultSequences,
  ensureExperiments,
  ensureIcpProfile,
  ensurePackages,
  ensureScoringProfile,
} from '@/engine/bootstrap';

let booted = false;

export function boot(): string {
  if (booted) return cachedOrgId;
  migrate();
  // V2 additions are additive and tracked in a ledger, so this is safe to run
  // on every boot and never re-applies an already-applied migration.
  try {
    migrateUp({ backup: false });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[boot] migration failed:', err instanceof Error ? err.message : err);
  }
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
  booted = true;
  cachedOrgId = org.id;
  return org.id;
}

let cachedOrgId = '';
