/**
 * Backup CLI (§44).
 *
 *   npm run db:backup             create a verified backup
 *   npm run db:backup -- --list   list existing backups
 */
import { migrate } from '../src/db/migrate';
import { createBackup, listBackups, backupSummary, verifyBackupFile, enforceRetention } from '../src/db/backup';
import { closeDb } from '../src/db';

const args = process.argv.slice(2);

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(2)} MB`;
}

if (args.includes('--list')) {
  const backups = listBackups(30);
  const summary = backupSummary();
  console.log(`\n══ Backups ══\n`);
  if (!backups.length) {
    console.log('  No backups yet.');
  } else {
    for (const b of backups) {
      console.log(
        `  ${b.status === 'ok' ? '✓' : '✗'} ${b.created_at}  ${fmtBytes(b.size_bytes).padStart(9)}  ${b.trigger.padEnd(14)} ${b.status}${b.verified ? ' verified' : ''}`
      );
    }
    console.log(`\n  ${summary.total} total · ${summary.ok} ok · ${summary.failed} failed · ${fmtBytes(summary.totalBytes)}`);
    console.log(`  directory: ${summary.backupDir}`);
  }
  closeDb();
  process.exit(0);
}

migrate();
const backup = createBackup({ trigger: args.includes('--pre-deploy') ? 'pre_deploy' : 'manual' });

if (!backup || backup.status !== 'ok') {
  console.error(`✗ Backup failed: ${backup?.error ?? 'unknown error'}`);
  closeDb();
  process.exit(1);
}

const verified = verifyBackupFile(backup.path);
const pruned = enforceRetention();

console.log(`\n══ Backup ══\n`);
console.log(`  ✓ created   ${backup.path}`);
console.log(`    size      ${fmtBytes(backup.size_bytes)}`);
console.log(`    checksum  ${backup.checksum?.slice(0, 32)}…`);
console.log(`    verified  ${verified.ok ? `yes — ${verified.tables} tables restorable` : `NO — ${verified.error}`}`);
if (pruned) console.log(`    pruned    ${pruned} backup(s) beyond the retention window`);

closeDb();
process.exit(verified.ok ? 0 : 1);
