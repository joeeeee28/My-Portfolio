import fs from 'node:fs';
import path from 'node:path';
import { db, exec } from './index';

/**
 * Idempotent migration: applies schema.sql (all CREATE ... IF NOT EXISTS) plus
 * the FTS sync triggers that keep businesses_fts aligned with businesses.
 */
export function migrate(): void {
  const sql = fs.readFileSync(path.join(process.cwd(), 'src/db/schema.sql'), 'utf8');
  exec(sql);

  // Rebuild the FTS index from its content table on every boot.
  //
  // FTS5 external-content tables corrupt if rows were written before the sync
  // triggers existed: a later UPDATE issues an FTS 'delete' for a rowid that
  // was never indexed, which corrupts the blob. Rebuilding is cheap, idempotent
  // and makes migration self-healing rather than requiring manual repair.
  try {
    db().exec("INSERT INTO businesses_fts(businesses_fts) VALUES('rebuild')");
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[migrate] FTS rebuild failed:', err instanceof Error ? err.message : err);
  }

  // Keep the FTS index in sync with the businesses table.
  exec(`
    CREATE TRIGGER IF NOT EXISTS businesses_ai AFTER INSERT ON businesses BEGIN
      INSERT INTO businesses_fts(rowid, name, industry, category, description, locality, region, country)
      VALUES (new.rowid, new.name, new.industry, new.category, new.description, new.locality, new.region, new.country);
    END;
  `);
  exec(`
    CREATE TRIGGER IF NOT EXISTS businesses_ad AFTER DELETE ON businesses BEGIN
      INSERT INTO businesses_fts(businesses_fts, rowid, name, industry, category, description, locality, region, country)
      VALUES ('delete', old.rowid, old.name, old.industry, old.category, old.description, old.locality, old.region, old.country);
    END;
  `);
  exec(`
    CREATE TRIGGER IF NOT EXISTS businesses_au AFTER UPDATE ON businesses BEGIN
      INSERT INTO businesses_fts(businesses_fts, rowid, name, industry, category, description, locality, region, country)
      VALUES ('delete', old.rowid, old.name, old.industry, old.category, old.description, old.locality, old.region, old.country);
      INSERT INTO businesses_fts(rowid, name, industry, category, description, locality, region, country)
      VALUES (new.rowid, new.name, new.industry, new.category, new.description, new.locality, new.region, new.country);
    END;
  `);
}

export function tableNames(): string[] {
  const rows = db()
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}
