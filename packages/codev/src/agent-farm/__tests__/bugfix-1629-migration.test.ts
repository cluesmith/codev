/**
 * Issue #1629 — tower_owner table migration (v19), driven through the REAL
 * production runner (runGlobalMigrations). A pre-v19 database (markers 1..18)
 * gains the tower_owner table, and an upgraded database converges on the same
 * shape as a fresh GLOBAL_SCHEMA install.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { GLOBAL_SCHEMA } from '../db/schema.js';
import { GLOBAL_CURRENT_VERSION, runGlobalMigrations } from '../db/migrations.js';

describe('Issue #1629 — tower_owner migration (v19)', () => {
  let db: Database.Database;
  const logs: string[] = [];

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    logs.length = 0;
  });

  afterEach(() => db.close());

  const migrate = () => runGlobalMigrations(db, { log: (m) => logs.push(m) });
  const tableExists = (name: string) =>
    !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name);
  const columns = (table: string) =>
    (db.prepare('SELECT name FROM pragma_table_info(?)').all(table) as Array<{ name: string }>)
      .map((c) => c.name)
      .sort();

  /** A pre-v19 database: markers through v18, no tower_owner table. */
  function buildPreV19Db(): void {
    db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );`);
    for (let v = 1; v <= 18; v++) {
      db.prepare('INSERT OR IGNORE INTO _migrations (version) VALUES (?)').run(v);
    }
  }

  it('creates the tower_owner table on a pre-v19 database and records v19', () => {
    buildPreV19Db();
    expect(tableExists('tower_owner')).toBe(false);

    migrate();

    expect(tableExists('tower_owner')).toBe(true);
    expect(db.prepare('SELECT version FROM _migrations WHERE version = 19').get()).toBeTruthy();
    expect(GLOBAL_CURRENT_VERSION).toBe(19);
  });

  it('enforces the singleton CHECK and round-trips an owner row', () => {
    buildPreV19Db();
    migrate();

    db.prepare(
      `INSERT INTO tower_owner (id, pid, port, hostname, started_at, db_dir)
       VALUES (1, 4242, 4100, 'h', 1000, '/d')`,
    ).run();
    expect((db.prepare('SELECT pid FROM tower_owner WHERE id = 1').get() as { pid: number }).pid).toBe(4242);

    // The CHECK (id = 1) rejects any second row — it is a singleton by construction.
    expect(() =>
      db.prepare(
        `INSERT INTO tower_owner (id, pid, port, hostname, started_at, db_dir)
         VALUES (2, 1, 1, 'h', 1, '/d')`,
      ).run(),
    ).toThrow();
  });

  it('is idempotent: re-running does not throw or duplicate the marker', () => {
    buildPreV19Db();
    migrate();
    expect(() => migrate()).not.toThrow();
    const count = db.prepare('SELECT COUNT(*) AS n FROM _migrations WHERE version = 19').get() as {
      n: number;
    };
    expect(count.n).toBe(1);
  });

  it('a fresh GLOBAL_SCHEMA install has tower_owner, matching the migrated shape', () => {
    buildPreV19Db();
    migrate();
    const migratedCols = columns('tower_owner');

    const fresh = new Database(':memory:');
    try {
      fresh.exec(GLOBAL_SCHEMA);
      const freshCols = (
        fresh.prepare("SELECT name FROM pragma_table_info('tower_owner')").all() as Array<{ name: string }>
      )
        .map((c) => c.name)
        .sort();
      expect(freshCols).toContain('db_dir');
      expect(freshCols).toEqual(migratedCols);
    } finally {
      fresh.close();
    }
  });
});
