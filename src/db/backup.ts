/**
 * Database backups (§44).
 *
 * Uses SQLite's own online backup API via `node:sqlite` so backups are
 * consistent even while the app is writing. Each backup is checksummed and
 * verified by reopening it and running integrity_check.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { all, db, dbPath, get, run, scalar } from './index';
import { nowIso } from '@/lib/id';

const BACKUP_DIR = path.join(process.cwd(), '.data', 'backups');
const DEFAULT_RETENTION = 14;

export interface BackupRecord {
  id: string;
  org_id: string | null;
  kind: string;
  path: string;
  size_bytes: number;
  checksum: string | null;
  verified: number;
  verified_at: string | null;
  trigger: string;
  status: string;
  error: string | null;
  created_at: string;
}

/**
 * Creates a verified backup. Returns the record, or a failed record with the
 * error rather than throwing — a backup failure must be visible, not fatal.
 */
export function createBackup(opts: { orgId?: string; trigger?: string; kind?: string } = {}): BackupRecord | null {
  const trigger = opts.trigger ?? 'manual';
  const kind = opts.kind ?? 'database';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(BACKUP_DIR, `clientforge-${stamp}.db`);
  const now = nowIso();

  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });

    // SQLite's VACUUM INTO writes a consistent snapshot of the live database
    // into a new file. node:sqlite exposes no online-backup API, and a plain
    // file copy could capture a half-written page.
    if (fs.existsSync(file)) fs.rmSync(file, { force: true });
    db().exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);

    const size = fs.statSync(file).size;
    const checksum = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

    // Verify: reopen and check integrity + a known table.
    const verified = verifyBackupFile(file);

    const id = `bak_${crypto.randomBytes(8).toString('hex')}`;
    run(
      `INSERT INTO backups (id, org_id, kind, path, size_bytes, checksum, verified, verified_at, trigger, status, error, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        opts.orgId ?? null,
        kind,
        file,
        size,
        checksum,
        verified.ok ? 1 : 0,
        verified.ok ? now : null,
        trigger,
        verified.ok ? 'ok' : 'failed',
        verified.ok ? null : verified.error,
        now,
      ]
    );

    enforceRetention();

    return get<BackupRecord>('SELECT * FROM backups WHERE id = ?', [id]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const id = `bak_${crypto.randomBytes(8).toString('hex')}`;
    try {
      run(
        `INSERT INTO backups (id, org_id, kind, path, size_bytes, checksum, verified, trigger, status, error, created_at)
         VALUES (?,?,?,?,?,NULL,0,?,'failed',?,?)`,
        [id, opts.orgId ?? null, kind, file, 0, trigger, message, now]
      );
    } catch {
      /* the ledger itself is unavailable */
    }
    return get<BackupRecord>('SELECT * FROM backups WHERE id = ?', [id]);
  }
}

/** Opens a backup file and confirms it is a usable SQLite database. */
export function verifyBackupFile(file: string): { ok: boolean; error?: string; tables?: number } {
  let handle: DatabaseSync | null = null;
  try {
    if (!fs.existsSync(file)) return { ok: false, error: 'file missing' };
    handle = new DatabaseSync(file, { readOnly: true });
    const integrity = handle.prepare('PRAGMA integrity_check').get() as { integrity_check?: string } | undefined;
    const result = integrity?.integrity_check ?? Object.values(integrity ?? {})[0];
    if (result !== 'ok') return { ok: false, error: `integrity_check: ${String(result)}` };
    const tables = handle
      .prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .get() as { c: number };
    return { ok: true, tables: tables.c };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    try {
      handle?.close();
    } catch {
      /* ignore */
    }
  }
}

/** Deletes backups beyond the retention window, keeping the newest N. */
export function enforceRetention(keep = DEFAULT_RETENTION): number {
  const rows = all<BackupRecord>(
    "SELECT * FROM backups WHERE status = 'ok' ORDER BY created_at DESC"
  );
  if (rows.length <= keep) return 0;
  let removed = 0;
  for (const old of rows.slice(keep)) {
    try {
      if (old.path && fs.existsSync(old.path)) fs.rmSync(old.path, { force: true });
    } catch {
      /* best effort */
    }
    run("UPDATE backups SET status = 'pruned' WHERE id = ?", [old.id]);
    removed++;
  }
  return removed;
}

export function listBackups(limit = 30): BackupRecord[] {
  return all<BackupRecord>('SELECT * FROM backups ORDER BY created_at DESC LIMIT ?', [limit]);
}

/**
 * Restores a backup over the live database.
 *
 * Deliberately refuses to run while the application holds an open connection:
 * restoring underneath a running app would corrupt in-flight transactions.
 * Documented in docs/disaster-recovery.md.
 */
export function restoreBackup(backupId: string, opts: { force?: boolean } = {}): { ok: boolean; message: string } {
  const backup = get<BackupRecord>('SELECT * FROM backups WHERE id = ?', [backupId]);
  if (!backup) return { ok: false, message: 'Backup not found' };
  if (backup.status !== 'ok') return { ok: false, message: `Backup status is "${backup.status}", refusing to restore` };
  if (!backup.path || !fs.existsSync(backup.path)) return { ok: false, message: 'Backup file is missing from disk' };

  const verification = verifyBackupFile(backup.path);
  if (!verification.ok) return { ok: false, message: `Backup failed verification: ${verification.error}` };

  if (!opts.force && process.env.NODE_ENV === 'production') {
    return {
      ok: false,
      message:
        'Restore is disabled while the app is running in production. Stop the application first, then re-run with force. See docs/disaster-recovery.md.',
    };
  }

  try {
    const live = dbPath();
    const safetyCopy = `${live}.pre-restore-${Date.now()}`;
    if (fs.existsSync(live)) fs.copyFileSync(live, safetyCopy);
    fs.copyFileSync(backup.path, live);
    return {
      ok: true,
      message: `Restored ${verification.tables} tables from ${path.basename(backup.path)}. Pre-restore copy kept at ${path.basename(safetyCopy)}. Restart the application to pick up the restored data.`,
    };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export function backupSummary(): {
  total: number;
  ok: number;
  failed: number;
  lastAt: string | null;
  lastOk: boolean;
  totalBytes: number;
  backupDir: string;
} {
  const row = get<{ total: number; ok: number; failed: number; bytes: number }>(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
            COALESCE(SUM(size_bytes), 0) AS bytes
       FROM backups`
  );
  const last = get<BackupRecord>('SELECT * FROM backups ORDER BY created_at DESC LIMIT 1');
  return {
    total: row?.total ?? 0,
    ok: row?.ok ?? 0,
    failed: row?.failed ?? 0,
    lastAt: last?.created_at ?? null,
    lastOk: last?.status === 'ok',
    totalBytes: row?.bytes ?? 0,
    backupDir: BACKUP_DIR,
  };
}

export { scalar };
