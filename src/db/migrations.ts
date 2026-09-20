/**
 * Migration runner.
 *
 * Applies numbered SQL files from src/db/migrations in order, tracked in a
 * `schema_migrations` ledger so each runs exactly once. Idempotent and safe to
 * re-run: `ALTER TABLE … ADD COLUMN` statements are skipped when the column
 * already exists, and every `CREATE … IF NOT EXISTS` is naturally safe.
 *
 * Takes a backup before applying (§44) unless explicitly disabled.
 */
import fs from 'node:fs';
import path from 'node:path';
import { all, db, get, run, scalar } from './index';
import { nowIso } from '@/lib/id';

const MIGRATIONS_DIR = path.join(process.cwd(), 'src/db/migrations');

export interface MigrationRecord {
  id: string;
  applied_at: string;
  statements: number;
  checksum: string;
}

function ensureLedger(): void {
  db().exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id          TEXT PRIMARY KEY,
      applied_at  TEXT NOT NULL,
      statements  INTEGER NOT NULL DEFAULT 0,
      checksum    TEXT
    );
  `);
}

export function appliedMigrations(): string[] {
  ensureLedger();
  return all<{ id: string }>('SELECT id FROM schema_migrations ORDER BY id').map((r) => r.id);
}

/** Columns already present on a table — used to make ALTER TABLE idempotent. */
function columnsOf(table: string): Set<string> {
  try {
    return new Set(all<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name));
  } catch {
    return new Set();
  }
}

/**
 * Splits a SQL file into statements on top-level semicolons, ignoring
 * semicolons inside string literals and `--` comments.
 */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inSingle = false;
  let inDouble = false;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    // Line comment
    if (!inSingle && !inDouble && ch === '-' && next === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? sql.length : nl + 1;
      cur += '\n';
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      cur += ch;
      i++;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      cur += ch;
      i++;
      continue;
    }
    if (ch === ';' && !inSingle && !inDouble) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
  statementsRun: number;
  errors: string[];
}

/**
 * Applies all pending migrations. Returns what happened. Never throws for an
 * already-applied migration; collects errors for genuinely broken statements.
 */
export function migrateUp(opts: { backup?: boolean } = {}): MigrationResult {
  const result: MigrationResult = { applied: [], skipped: [], statementsRun: 0, errors: [] };
  if (!fs.existsSync(MIGRATIONS_DIR)) return result;

  ensureLedger();
  const already = new Set(appliedMigrations());
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();

  const pending = files.filter((f) => !already.has(f.replace(/\.sql$/, '')));
  if (pending.length === 0) {
    result.skipped = files.map((f) => f.replace(/\.sql$/, ''));
    return result;
  }

  if (opts.backup !== false) {
    try {
      // Lazy import avoids a cycle at module load.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { createBackup } = require('./backup') as typeof import('./backup');
      createBackup({ trigger: 'pre_migration' });
    } catch {
      // A backup failure must not block migration, but it is recorded.
      result.errors.push('pre-migration backup skipped (backup module unavailable)');
    }
  }

  for (const file of pending) {
    const name = file.replace(/\.sql$/, '');
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const statements = splitStatements(sql);
    let count = 0;

    db().exec('BEGIN');
    try {
      for (const stmt of statements) {
        const alter = stmt.match(/^ALTER TABLE\s+(\w+)\s+ADD COLUMN\s+(\w+)/i);
        if (alter) {
          const [, table, column] = alter;
          if (columnsOf(table).has(column)) continue; // already applied — skip safely
        }
        db().exec(stmt);
        count++;
      }
      db().exec('COMMIT');
      run('INSERT INTO schema_migrations (id, applied_at, statements, checksum) VALUES (?,?,?,?)', [
        name,
        nowIso(),
        count,
        checksum(sql),
      ]);
      result.applied.push(name);
      result.statementsRun += count;
    } catch (err) {
      try {
        db().exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push(`${name}: ${message}`);
      throw new Error(`Migration ${name} failed: ${message}`);
    }
  }

  result.skipped = files.map((f) => f.replace(/\.sql$/, '')).filter((n) => !result.applied.includes(n));
  return result;
}

function checksum(sql: string): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const crypto = require('node:crypto') as typeof import('node:crypto');
  return crypto.createHash('sha256').update(sql).digest('hex').slice(0, 16);
}

export function migrationStatus(): {
  applied: MigrationRecord[];
  pending: string[];
} {
  ensureLedger();
  const applied = all<MigrationRecord>('SELECT * FROM schema_migrations ORDER BY id');
  const names = new Set(applied.map((a) => a.id));
  const files = fs.existsSync(MIGRATIONS_DIR)
    ? fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
    : [];
  return {
    applied,
    pending: files.map((f) => f.replace(/\.sql$/, '')).filter((n) => !names.has(n)),
  };
}

/** Verifies constraints and indexes the schema depends on (§39, §51). */
export function verifySchema(): { ok: boolean; problems: string[]; indexCount: number; tableCount: number } {
  const problems: string[] = [];

  const fk = scalar<number>('PRAGMA foreign_key_check') === null ? 0 : 1;
  if (fk) problems.push('foreign_key_check reported violations');

  const integrity = scalar<string>('PRAGMA integrity_check');
  if (integrity !== 'ok') problems.push(`integrity_check: ${integrity}`);

  const tables = scalar<number>(
    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  ) ?? 0;
  const indexes = scalar<number>(
    "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'"
  ) ?? 0;

  // Constraints the application relies on.
  const uniqueClient = all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='clients' AND sql LIKE '%UNIQUE%'"
  );
  const clientIndexes = all<{ sql: string | null }>("PRAGMA index_list(clients)" as never) as { sql: string | null }[];
  const hasUniqueBusiness =
    /UNIQUE/i.test(
      all<{ sql: string }>(
        "SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='clients'"
      )
        .map((r) => r.sql ?? '')
        .join(' ')
    ) || clientIndexes.some((i) => /unique/i.test(String(i.sql ?? '')));
  if (!hasUniqueBusiness && uniqueClient.length === 0) {
    // Fall back to a behavioural check: the UNIQUE constraint is declared inline.
    const ddl = scalar<string>("SELECT sql FROM sqlite_master WHERE type='table' AND name='clients'") ?? '';
    if (!/business_id\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(ddl)) {
      problems.push('clients.business_id is not UNIQUE — duplicate clients would be possible');
    }
  }

  return { ok: problems.length === 0, problems, indexCount: indexes, tableCount: tables };
}
