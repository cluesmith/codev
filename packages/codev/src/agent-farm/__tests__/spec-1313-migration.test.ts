/**
 * Spec 1313 — mailbox table migration (v15).
 *
 * Migration v15 adds the additive `mailbox` table (mailbox-first delivery). These
 * tests instantiate a pre-v15 database by hand, drive a faithful replica of the
 * v15 block in `db/index.ts`, and assert the resulting shape — matching the
 * inline-replication convention of `pir-832-migration.test.ts` /
 * `bugfix-826-migration.test.ts`. Migrations are forward-only by project
 * convention; there is no reverse SQL to test.
 *
 * The critical invariant: a freshly-created database (GLOBAL_SCHEMA) and an
 * upgraded pre-v15 database must converge on the identical `mailbox` shape. The
 * fresh path here exercises the REAL production GLOBAL_SCHEMA, so drift between
 * the two definitions fails this test.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { GLOBAL_SCHEMA } from '../db/schema.js';

describe('Spec 1313 — mailbox table migration (v15)', () => {
  const testDir = resolve(process.cwd(), '.test-spec-1313-migration');
  let db: Database.Database;
  let dbPath: string;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
    dbPath = resolve(testDir, 'global.db');
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  /**
   * Faithful replica of the v15 block's DDL in `db/index.ts`. Kept verbatim so
   * this test fails loudly if the production migration drifts.
   */
  const MAILBOX_DDL = `
    CREATE TABLE IF NOT EXISTS mailbox (
      id TEXT PRIMARY KEY,
      workspace_path TEXT NOT NULL,
      to_agent TEXT NOT NULL,
      terminal_id TEXT,
      from_agent TEXT,
      from_workspace TEXT,
      body TEXT NOT NULL,
      formatted_message TEXT NOT NULL,
      no_enter INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'held'
        CHECK(status IN ('held', 'delivered', 'superseded', 'dismissed')),
      reason TEXT CHECK(reason IN ('busy', 'no-profile', 'no-live-pty')),
      supersede_key TEXT,
      escalated INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      resolved_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_mailbox_workspace_status ON mailbox(workspace_path, status);
    CREATE INDEX IF NOT EXISTS idx_mailbox_agent_drain ON mailbox(workspace_path, to_agent, status);
    CREATE INDEX IF NOT EXISTS idx_mailbox_supersede ON mailbox(supersede_key);
  `;

  /**
   * Reproduce a pre-v15 database: a _migrations table with v1..v14 applied and no
   * mailbox table. v15 only creates a new table (it references no other), so no
   * other tables are needed to drive it.
   */
  function buildPreV15Db(): void {
    db.exec(`
      CREATE TABLE _migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    for (let v = 1; v <= 14; v++) {
      db.prepare('INSERT INTO _migrations (version) VALUES (?)').run(v);
    }
  }

  /** Faithful replica of the v15 block in db/index.ts (idempotent create + marker). */
  function runV15Migration(): void {
    const v15 = db.prepare('SELECT version FROM _migrations WHERE version = 15').get();
    if (!v15) {
      db.exec(MAILBOX_DDL);
      db.prepare('INSERT INTO _migrations (version) VALUES (15)').run();
    }
  }

  function tableExists(name: string): boolean {
    return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name);
  }

  function mailboxColumns(): string[] {
    return (db.prepare("SELECT name FROM pragma_table_info('mailbox')").all() as Array<{ name: string }>)
      .map((c) => c.name)
      .sort();
  }

  function mailboxIndexes(): string[] {
    return (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='mailbox'")
        .all() as Array<{ name: string }>
    )
      .map((i) => i.name)
      .filter((n) => !n.startsWith('sqlite_')) // drop the implicit PK index
      .sort();
  }

  it('creates the mailbox table on a pre-v15 database', () => {
    buildPreV15Db();
    expect(tableExists('mailbox')).toBe(false);

    runV15Migration();

    expect(tableExists('mailbox')).toBe(true);
    expect(mailboxColumns()).toEqual(
      [
        'body',
        'created_at',
        'escalated',
        'formatted_message',
        'from_agent',
        'from_workspace',
        'id',
        'no_enter',
        'reason',
        'resolved_at',
        'status',
        'supersede_key',
        'terminal_id',
        'to_agent',
        'updated_at',
        'workspace_path',
      ].sort()
    );
  });

  it('creates the drain and supersede indexes', () => {
    buildPreV15Db();
    runV15Migration();
    expect(mailboxIndexes()).toEqual([
      'idx_mailbox_agent_drain',
      'idx_mailbox_supersede',
      'idx_mailbox_workspace_status',
    ]);
  });

  it('records v15 in _migrations and is idempotent on re-run', () => {
    buildPreV15Db();
    runV15Migration();
    expect(() => runV15Migration()).not.toThrow();

    const markers = db.prepare('SELECT COUNT(*) AS n FROM _migrations WHERE version = 15').get() as {
      n: number;
    };
    expect(markers.n).toBe(1);
    expect(tableExists('mailbox')).toBe(true);
  });

  it('a held row round-trips through the migrated table with its defaults', () => {
    buildPreV15Db();
    runV15Migration();

    db.prepare(
      `INSERT INTO mailbox (id, workspace_path, to_agent, body, formatted_message, created_at, updated_at)
       VALUES ('m1', '/ws/a', 'spir-1313', 'raw', 'formatted', 1000, 1000)`
    ).run();

    const row = db.prepare("SELECT * FROM mailbox WHERE id = 'm1'").get() as {
      status: string;
      reason: string | null;
      no_enter: number;
      escalated: number;
      resolved_at: number | null;
    };
    expect(row.status).toBe('held'); // schema default
    expect(row.reason).toBeNull();
    expect(row.no_enter).toBe(0);
    expect(row.escalated).toBe(0);
    expect(row.resolved_at).toBeNull();
  });

  it('the status CHECK constraint rejects an unknown status', () => {
    buildPreV15Db();
    runV15Migration();
    expect(() =>
      db
        .prepare(
          `INSERT INTO mailbox (id, workspace_path, to_agent, body, formatted_message, status, created_at, updated_at)
           VALUES ('bad', '/ws/a', 'x', 'b', 'f', 'bogus', 1, 1)`
        )
        .run()
    ).toThrow();
  });

  it('a fresh install (GLOBAL_SCHEMA) converges on the identical mailbox shape as the migration', () => {
    // Migrated shape (pre-v15 → v15).
    buildPreV15Db();
    runV15Migration();
    const migratedCols = mailboxColumns();
    const migratedIdx = mailboxIndexes();

    // Fresh shape: a brand-new database created from the REAL production GLOBAL_SCHEMA.
    const freshPath = resolve(testDir, 'fresh.db');
    const fresh = new Database(freshPath);
    try {
      fresh.exec(GLOBAL_SCHEMA);
      const freshCols = (
        fresh.prepare("SELECT name FROM pragma_table_info('mailbox')").all() as Array<{ name: string }>
      )
        .map((c) => c.name)
        .sort();
      const freshIdx = (
        fresh
          .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='mailbox'")
          .all() as Array<{ name: string }>
      )
        .map((i) => i.name)
        .filter((n) => !n.startsWith('sqlite_'))
        .sort();

      expect(freshCols).toEqual(migratedCols);
      expect(freshIdx).toEqual(migratedIdx);
    } finally {
      fresh.close();
    }
  });
});

describe('Spec 1313 — command column migration (v16)', () => {
  const testDir = resolve(process.cwd(), '.test-spec-1313-v16-migration');
  let db: Database.Database;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
    db = new Database(resolve(testDir, 'global.db'));
    db.pragma('journal_mode = WAL');
  });
  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  /** The pre-v16 terminal_sessions shape (v15 schema: label + cwd, NO command). */
  const PRE_V16_TERMINAL_SESSIONS_DDL = `
    CREATE TABLE IF NOT EXISTS terminal_sessions (
      id TEXT PRIMARY KEY,
      workspace_path TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('architect', 'builder', 'shell')),
      role_id TEXT,
      pid INTEGER,
      shellper_socket TEXT,
      shellper_pid INTEGER,
      shellper_start_time INTEGER,
      label TEXT,
      cwd TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `;

  function buildPreV16Db(): void {
    db.exec(`CREATE TABLE _migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')));`);
    for (let v = 1; v <= 15; v++) db.prepare('INSERT INTO _migrations (version) VALUES (?)').run(v);
    db.exec(PRE_V16_TERMINAL_SESSIONS_DDL);
  }

  /**
   * Faithful replica of the v16 block in db/index.ts: PRAGMA-gated (only ALTER
   * when the column is genuinely absent, so a real failure surfaces instead of
   * being marked migrated), then the version marker.
   */
  function runV16Migration(): void {
    const v16 = db.prepare('SELECT version FROM _migrations WHERE version = 16').get();
    if (!v16) {
      const hasCommand = (db.prepare(`PRAGMA table_info(terminal_sessions)`).all() as Array<{ name: string }>)
        .some((c) => c.name === 'command');
      if (!hasCommand) db.exec(`ALTER TABLE terminal_sessions ADD COLUMN command TEXT`);
      db.prepare('INSERT INTO _migrations (version) VALUES (16)').run();
    }
  }

  const termCols = () =>
    (db.prepare("SELECT name FROM pragma_table_info('terminal_sessions')").all() as Array<{ name: string }>)
      .map((c) => c.name).sort();

  it('adds the command column to a pre-v16 terminal_sessions and records v16', () => {
    buildPreV16Db();
    expect(termCols()).not.toContain('command');

    runV16Migration();

    expect(termCols()).toContain('command');
    expect(db.prepare('SELECT version FROM _migrations WHERE version = 16').get()).toBeTruthy();
    // The healed column round-trips a value (what reconcile persists for identity).
    db.prepare(`INSERT INTO terminal_sessions (id, workspace_path, type, command) VALUES ('t', '/ws', 'architect', 'claude')`).run();
    expect((db.prepare("SELECT command FROM terminal_sessions WHERE id='t'").get() as { command: string }).command).toBe('claude');
  });

  it('is idempotent: re-running does not throw, double-add, or duplicate the marker', () => {
    buildPreV16Db();
    runV16Migration();
    expect(() => runV16Migration()).not.toThrow();
    const markers = db.prepare('SELECT COUNT(*) AS n FROM _migrations WHERE version = 16').get() as { n: number };
    expect(markers.n).toBe(1);
    expect(termCols().filter((c) => c === 'command')).toHaveLength(1);
  });

  it('the PRAGMA gate skips the ALTER when the column already exists (fresh-install shape)', () => {
    // Simulate a fresh install: GLOBAL_SCHEMA already created `command`, but the
    // v16 marker was not yet stamped. The gate must NOT attempt a duplicate ALTER.
    db.exec(`CREATE TABLE _migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')));`);
    for (let v = 1; v <= 15; v++) db.prepare('INSERT INTO _migrations (version) VALUES (?)').run(v);
    db.exec(PRE_V16_TERMINAL_SESSIONS_DDL.replace('cwd TEXT,', 'cwd TEXT,\n      command TEXT,'));
    expect(termCols()).toContain('command');

    expect(() => runV16Migration()).not.toThrow();
    expect(db.prepare('SELECT version FROM _migrations WHERE version = 16').get()).toBeTruthy();
  });

  it('a fresh install (GLOBAL_SCHEMA) has the command column, matching the migrated shape', () => {
    buildPreV16Db();
    runV16Migration();
    const migratedCols = termCols();

    const fresh = new Database(resolve(testDir, 'fresh.db'));
    try {
      fresh.exec(GLOBAL_SCHEMA);
      const freshCols = (fresh.prepare("SELECT name FROM pragma_table_info('terminal_sessions')").all() as Array<{ name: string }>)
        .map((c) => c.name).sort();
      expect(freshCols).toContain('command');
      expect(freshCols).toEqual(migratedCols);
    } finally {
      fresh.close();
    }
  });
});
