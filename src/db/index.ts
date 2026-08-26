/**
 * SQLite access layer over Node 22's built-in `node:sqlite` (DatabaseSync).
 *
 * Chosen deliberately over a native driver: no compilation step, no external
 * binary, full relational engine (FKs, transactions, JSON1, FTS5, window fns).
 *
 * All rows are returned as plain objects (node:sqlite yields null-prototype
 * objects which do not survive Next.js RSC serialization cleanly).
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const DB_DIR = path.join(process.cwd(), '.data');

/**
 * Resolved lazily rather than at module load: ES import hoisting would otherwise
 * evaluate OS_DATABASE before a test harness or script has a chance to set it.
 */
function dbFile(): string {
  return process.env.OS_DATABASE ?? path.join(DB_DIR, 'acquisition.db');
}

let _db: DatabaseSync | null = null;
let _dbFile: string | null = null;

export function db(): DatabaseSync {
  if (_db) return _db;
  _dbFile = dbFile();
  fs.mkdirSync(path.dirname(_dbFile), { recursive: true });
  const conn = new DatabaseSync(_dbFile);
  conn.exec('PRAGMA journal_mode = WAL');
  conn.exec('PRAGMA foreign_keys = ON');
  conn.exec('PRAGMA busy_timeout = 5000');
  conn.exec('PRAGMA synchronous = NORMAL');
  _db = conn;
  return conn;
}

export function dbPath(): string {
  return _dbFile ?? dbFile();
}

/** Run SQL with no result set. */
export function exec(sql: string): void {
  db().exec(sql);
}

/** All rows as plain objects. */
export function all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
  return db().prepare(sql).all(...(params as never[])).map((r) => ({ ...(r as object) })) as T[];
}

/** First row, or null. */
export function get<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T | null {
  const row = db().prepare(sql).get(...(params as never[]));
  return row ? ({ ...(row as object) } as T) : null;
}

/** One scalar column of the first row. */
export function scalar<T = number | string | null>(sql: string, params: unknown[] = []): T | null {
  const row = db().prepare(sql).get(...(params as never[])) as Record<string, unknown> | undefined;
  if (!row) return null;
  return (Object.values(row)[0] as T) ?? null;
}

/** Insert / update / delete. Returns { changes, lastInsertRowid }. */
export function run(sql: string, params: unknown[] = []): { changes: number; lastInsertRowid: number | bigint } {
  const r = db().prepare(sql).run(...(params as never[]));
  return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
}

/** Execute a unit of work inside a transaction (nested calls use savepoints). */
let depth = 0;
export function tx<T>(fn: () => T): T {
  const conn = db();
  if (depth > 0) {
    const name = `sp_${depth}`;
    conn.exec(`SAVEPOINT ${name}`);
    depth++;
    try {
      const out = fn();
      conn.exec(`RELEASE ${name}`);
      return out;
    } catch (err) {
      try {
        conn.exec(`ROLLBACK TO ${name}`);
        conn.exec(`RELEASE ${name}`);
      } catch {
        /* ignore */
      }
      throw err;
    }
  }
  conn.exec('BEGIN');
  depth++;
  try {
    const out = fn();
    conn.exec('COMMIT');
    return out;
  } catch (err) {
    try {
      conn.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    depth--;
  }
}

// ── JSON helpers ─────────────────────────────────────────────
export function json<T>(value: string | null | undefined, fallback: T): T {
  if (value == null || value === '') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/** Recursively hydrate known JSON columns of a row set. */
export function hydrate<T extends Record<string, unknown>>(
  row: T | null,
  keys: readonly string[]
): T | null {
  if (!row) return null;
  const out: Record<string, unknown> = { ...row };
  for (const k of keys) {
    if (k in out) out[k] = json(out[k] as string | null, null);
  }
  return out as T;
}

export function hydrateMany<T extends Record<string, unknown>>(
  rows: T[],
  keys: readonly string[]
): T[] {
  return rows.map((r) => hydrate(r, keys) as T);
}

export function closeDb(): void {
  if (_db) {
    try {
      _db.close();
    } catch {
      /* ignore */
    }
    _db = null;
  }
}
