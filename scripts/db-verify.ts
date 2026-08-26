/**
 * Database verification (§39, §51).
 *
 * Confirms the schema is sound before a deploy: integrity check, foreign-key
 * check, migration ledger, index coverage on high-volume queries, and the
 * constraints the application depends on.
 */
import { migrate } from '../src/db/migrate';
import { migrateUp, migrationStatus, verifySchema } from '../src/db/migrations';
import { all, scalar, closeDb, dbPath } from '../src/db';
import { createBackup, backupSummary, verifyBackupFile } from '../src/db/backup';

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

console.log('\n══ ClientForge AI — database verification ══\n');
console.log(`Database: ${dbPath()}\n`);

migrate();
const migration = migrateUp({ backup: false });
console.log('Migrations');
const status = migrationStatus();
check('all migrations applied', status.pending.length === 0,
  migration.applied.length ? `applied now: ${migration.applied.join(', ')}` : 'nothing pending');
check('migration ledger is populated', status.applied.length > 0, `${status.applied.length} recorded`);

console.log('\nIntegrity');
const integrity = scalar<string>('PRAGMA integrity_check');
check('PRAGMA integrity_check', integrity === 'ok', String(integrity));
const fkViolations = all<Record<string, unknown>>('PRAGMA foreign_key_check');
check('PRAGMA foreign_key_check', fkViolations.length === 0, `${fkViolations.length} violation(s)`);
const fkEnabled = scalar<number>('PRAGMA foreign_keys');
check('foreign keys are enforced', fkEnabled === 1, `PRAGMA foreign_keys = ${fkEnabled}`);

console.log('\nSchema');
const schema = verifySchema();
check('schema verification', schema.ok, schema.problems.join('; ') || `${schema.tableCount} tables, ${schema.indexCount} indexes`);
check('table count is plausible', schema.tableCount >= 80, `${schema.tableCount} tables`);
check('index count is plausible', schema.indexCount >= 100, `${schema.indexCount} indexes`);

console.log('\nConstraints the application depends on');
const clientsDdl = scalar<string>("SELECT sql FROM sqlite_master WHERE type='table' AND name='clients'") ?? '';
check('clients.business_id is UNIQUE', /business_id\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(clientsDdl),
  'prevents a duplicate client on conversion');
// An inline UNIQUE constraint creates a sqlite_autoindex_* entry, which does
// NOT appear in sqlite_master — so assert on the table DDL instead.
const mockupsDdl = scalar<string>("SELECT sql FROM sqlite_master WHERE type='table' AND name='mockups'") ?? '';
check('mockups.share_token is UNIQUE', /share_token\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(mockupsDdl),
  'prevents colliding share links');
check('mockups.slug is UNIQUE', /slug\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(mockupsDdl),
  'prevents colliding preview paths');
const enrollUnique = all<{ name: string }>(
  "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='sequence_enrollments' AND sql LIKE '%UNIQUE%'"
);
check('active enrolment is unique per sequence', enrollUnique.length > 0, 'prevents double enrolment');

console.log('\nIndex coverage on high-volume queries');
const requiredIndexes: [string, string][] = [
  ['businesses', 'stage'],
  ['businesses', 'opportunity_score'],
  ['businesses', 'website_status'],
  ['outreach_messages', 'business_id'],
  ['outreach_messages', 'created_at'],
  ['follow_ups', 'due_at'],
  ['mockups', 'status'],
  ['mockup_views', 'viewed_at'],
  ['calls', 'scheduled_at'],
  ['proposals', 'status'],
  ['tasks', 'due_at'],
  ['projects', 'status'],
  ['cost_ledger', 'category'],
  ['ai_model_usage', 'created_at'],
  ['suppression_list', 'value'],
];
for (const [table, column] of requiredIndexes) {
  const indexes = all<{ sql: string }>(
    "SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name = ?",
    [table]
  );
  const covered = indexes.some((i) => (i.sql ?? '').includes(column));
  check(`${table} indexed on ${column}`, covered);
}

console.log('\nBackups');
const backup = createBackup({ trigger: 'manual' });
check('a backup can be created', backup?.status === 'ok', backup?.error ?? `${backup?.size_bytes} bytes`);
if (backup?.path) {
  const verified = verifyBackupFile(backup.path);
  check('the backup passes verification', verified.ok, verified.error ?? `${verified.tables} tables restorable`);
}
const summary = backupSummary();
check('backup history is recorded', summary.total > 0, `${summary.total} backup(s), ${summary.totalBytes} bytes`);

console.log('\nTenant isolation');
const tables = all<{ name: string; sql: string }>(
  "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
);
const exempt = new Set([
  'organizations', 'sessions', 'mockup_versions', 'website_versions', 'sequence_steps',
  'proposal_items', 'call_notes', 'experiment_variants', 'duplicate_events', 'job_steps',
  'rate_limits', 'api_requests', 'health_checks', 'backups', 'login_attempts',
  'schema_migrations', 'data_confidence', 'discovery_run_items', 'mockup_views',
  'businesses_fts', 'businesses_fts_data', 'businesses_fts_idx',
  'businesses_fts_content', 'businesses_fts_docsize', 'businesses_fts_config',
]);
const unscoped = tables.filter((t) => !exempt.has(t.name) && !/\borg_id\b/.test(t.sql ?? ''));
check('every tenant table carries org_id', unscoped.length === 0, unscoped.map((t) => t.name).join(', ') || 'all scoped');

console.log('\n' + '═'.repeat(48));
console.log(failures === 0 ? '  ✓ Database verification passed' : `  ✗ ${failures} check(s) failed`);
console.log('═'.repeat(48) + '\n');

closeDb();
process.exit(failures ? 1 : 0);
