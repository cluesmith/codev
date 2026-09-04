/**
 * global.db migrations — driven through the REAL production runner.
 *
 * Issue #1476: these tests used to drive hand-maintained *replicas* of the
 * migration blocks in `db/index.ts`, kept honest by source guards. The blocks now
 * live in `db/migrations.ts` as `runGlobalMigrations(db)`, which is what
 * `ensureGlobalDatabase()` calls — so every case below exercises the SQL that
 * actually ships. Each fixture builds a database at a historical version, calls
 * the runner, and asserts the resulting shape.
 *
 * Because the runner applies *every* outstanding step, a pre-v15 fixture walks
 * v15 → v16 → v17 in one call — exactly as a real upgrading install does. The
 * critical invariant remains: an upgraded database and a freshly-created one
 * (GLOBAL_SCHEMA) must converge on an identical shape. Migrations are
 * forward-only by project convention; there is no reverse SQL to test.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { GLOBAL_SCHEMA } from '../db/schema.js';
import { GLOBAL_CURRENT_VERSION, runGlobalMigrations } from '../db/migrations.js';

/**
 * Test harness: a scratch directory holding the database under migration, plus a
 * `runDir` standing in for `~/.codev/run` so migration v8's socket rename can
 * never touch a developer's live sockets.
 */
function harness(name: string) {
  const testDir = resolve(process.cwd(), name);
  const state = {
    testDir,
    runDir: resolve(testDir, 'run'),
    db: null as unknown as Database.Database,
    logs: [] as string[],
  };

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(state.runDir, { recursive: true });
    state.db = new Database(resolve(testDir, 'global.db'));
    // Match production's configurePragmas(): v7–v9 rebuild tables with DROP + RENAME,
    // which is exactly the SQL whose behavior depends on `foreign_keys`.
    state.db.pragma('journal_mode = WAL');
    state.db.pragma('synchronous = FULL');
    state.db.pragma('busy_timeout = 5000');
    state.db.pragma('foreign_keys = ON');
    state.logs = [];
  });

  afterEach(() => {
    state.db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  /** Drive the real production runner against the fixture database. */
  const migrate = () =>
    runGlobalMigrations(state.db, {
      log: (m) => state.logs.push(m),
      runDir: state.runDir,
    });

  const markers = () =>
    (state.db.prepare('SELECT version FROM _migrations ORDER BY version').all() as Array<{
      version: number;
    }>).map((r) => r.version);

  const columns = (table: string) =>
    (state.db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as Array<{ name: string }>)
      .map((c) => c.name)
      .sort();

  const indexes = (table: string) =>
    (
      state.db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name = ?")
        .all(table) as Array<{ name: string }>
    )
      .map((i) => i.name)
      .filter((n) => !n.startsWith('sqlite_')) // drop implicit PK/UNIQUE indexes
      .sort();

  const tableExists = (name: string) =>
    !!state.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name);

  const seedMarkers = (through: number) => {
    state.db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );`);
    for (let v = 1; v <= through; v++) {
      state.db.prepare('INSERT OR IGNORE INTO _migrations (version) VALUES (?)').run(v);
    }
  };

  return { state, migrate, markers, columns, indexes, tableExists, seedMarkers };
}

/** The post-v14 terminal_sessions shape: label + cwd, no `command` (that is v16). */
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

/** The post-v15 mailbox shape: no `not_before` (that is v17). */
const PRE_V17_MAILBOX_DDL = `
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
`;

describe('Spec 1313 — mailbox table migration (v15) via runGlobalMigrations', () => {
  const h = harness('.test-spec-1313-migration');

  /** A pre-v15 database: markers through v14 and the post-v14 terminal_sessions. */
  function buildPreV15Db(): void {
    h.seedMarkers(14);
    h.state.db.exec(PRE_V16_TERMINAL_SESSIONS_DDL);
  }

  it('creates the mailbox table on a pre-v15 database', () => {
    buildPreV15Db();
    expect(h.tableExists('mailbox')).toBe(false);

    h.migrate();

    expect(h.tableExists('mailbox')).toBe(true);
    // v15 creates the table; the same call then walks v16/v17, so `not_before`
    // (v17) is present too — precisely the shape a real upgrade lands on.
    expect(h.columns('mailbox')).toEqual(
      [
        'body',
        'created_at',
        'escalated',
        'formatted_message',
        'from_agent',
        'from_workspace',
        'id',
        'no_enter',
        'not_before',
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
    h.migrate();
    expect(h.indexes('mailbox')).toEqual([
      'idx_mailbox_agent_drain',
      'idx_mailbox_supersede',
      'idx_mailbox_workspace_status',
    ]);
  });

  it('records v15 in _migrations and is idempotent on re-run', () => {
    buildPreV15Db();
    h.migrate();
    const afterFirstRun = h.state.logs.length;
    expect(() => h.migrate()).not.toThrow();

    const count = h.state.db.prepare('SELECT COUNT(*) AS n FROM _migrations WHERE version = 15').get() as {
      n: number;
    };
    expect(count.n).toBe(1);
    expect(h.tableExists('mailbox')).toBe(true);
    // The second run applies nothing — every marker is already stamped, so it logs nothing.
    expect(h.state.logs.length).toBe(afterFirstRun);
  });

  it('a held row round-trips through the migrated table with its defaults', () => {
    buildPreV15Db();
    h.migrate();

    h.state.db
      .prepare(
        `INSERT INTO mailbox (id, workspace_path, to_agent, body, formatted_message, created_at, updated_at)
         VALUES ('m1', '/ws/a', 'spir-1313', 'raw', 'formatted', 1000, 1000)`
      )
      .run();

    const row = h.state.db.prepare("SELECT * FROM mailbox WHERE id = 'm1'").get() as {
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
    h.migrate();
    expect(() =>
      h.state.db
        .prepare(
          `INSERT INTO mailbox (id, workspace_path, to_agent, body, formatted_message, status, created_at, updated_at)
           VALUES ('bad', '/ws/a', 'x', 'b', 'f', 'bogus', 1, 1)`
        )
        .run()
    ).toThrow();
  });

  it('a fresh install (GLOBAL_SCHEMA) converges on the identical mailbox shape as the migration', () => {
    buildPreV15Db();
    h.migrate();
    const migratedCols = h.columns('mailbox');
    const migratedIdx = h.indexes('mailbox');

    // Fresh shape: a brand-new database created from the REAL production GLOBAL_SCHEMA.
    const fresh = new Database(resolve(h.state.testDir, 'fresh.db'));
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

describe('Spec 1313 — command column migration (v16) via runGlobalMigrations', () => {
  const h = harness('.test-spec-1313-v16-migration');

  function buildPreV16Db(): void {
    h.seedMarkers(15);
    h.state.db.exec(PRE_V16_TERMINAL_SESSIONS_DDL);
    h.state.db.exec(PRE_V17_MAILBOX_DDL); // v15 already applied on this fixture
  }

  it('adds the command column to a pre-v16 terminal_sessions and records v16', () => {
    buildPreV16Db();
    expect(h.columns('terminal_sessions')).not.toContain('command');

    h.migrate();

    expect(h.columns('terminal_sessions')).toContain('command');
    expect(h.state.db.prepare('SELECT version FROM _migrations WHERE version = 16').get()).toBeTruthy();
    // The healed column round-trips a value (what reconcile persists for identity).
    h.state.db
      .prepare(
        `INSERT INTO terminal_sessions (id, workspace_path, type, command) VALUES ('t', '/ws', 'architect', 'claude')`
      )
      .run();
    expect(
      (h.state.db.prepare("SELECT command FROM terminal_sessions WHERE id='t'").get() as { command: string })
        .command
    ).toBe('claude');
  });

  it('is idempotent: re-running does not throw, double-add, or duplicate the marker', () => {
    buildPreV16Db();
    h.migrate();
    expect(() => h.migrate()).not.toThrow();
    const count = h.state.db.prepare('SELECT COUNT(*) AS n FROM _migrations WHERE version = 16').get() as {
      n: number;
    };
    expect(count.n).toBe(1);
    expect(h.columns('terminal_sessions').filter((c) => c === 'command')).toHaveLength(1);
  });

  it('the PRAGMA gate skips the ALTER when the column already exists (fresh-install shape)', () => {
    // Simulate a fresh install: GLOBAL_SCHEMA already created `command`, but the
    // v16 marker was not yet stamped. The gate must NOT attempt a duplicate ALTER.
    h.seedMarkers(15);
    h.state.db.exec(PRE_V16_TERMINAL_SESSIONS_DDL.replace('cwd TEXT,', 'cwd TEXT,\n    command TEXT,'));
    h.state.db.exec(PRE_V17_MAILBOX_DDL);
    expect(h.columns('terminal_sessions')).toContain('command');

    expect(() => h.migrate()).not.toThrow();
    expect(h.state.db.prepare('SELECT version FROM _migrations WHERE version = 16').get()).toBeTruthy();
  });

  it('a fresh install (GLOBAL_SCHEMA) has the command column, matching the migrated shape', () => {
    buildPreV16Db();
    h.migrate();
    const migratedCols = h.columns('terminal_sessions');

    const fresh = new Database(resolve(h.state.testDir, 'fresh.db'));
    try {
      fresh.exec(GLOBAL_SCHEMA);
      const freshCols = (
        fresh.prepare("SELECT name FROM pragma_table_info('terminal_sessions')").all() as Array<{
          name: string;
        }>
      )
        .map((c) => c.name)
        .sort();
      expect(freshCols).toContain('command');
      expect(freshCols).toEqual(migratedCols);
    } finally {
      fresh.close();
    }
  });
});

describe('Spec 1313 round 3 — mailbox not_before column migration (v17) via runGlobalMigrations', () => {
  const h = harness('.test-spec-1313-v17-migration');

  function buildPreV17Db(): void {
    h.seedMarkers(16);
    h.state.db.exec(PRE_V17_MAILBOX_DDL);
  }

  it('adds the not_before column to a pre-v17 mailbox and records v17', () => {
    buildPreV17Db();
    expect(h.columns('mailbox')).not.toContain('not_before');

    h.migrate();

    expect(h.columns('mailbox')).toContain('not_before');
    expect(h.state.db.prepare('SELECT version FROM _migrations WHERE version = 17').get()).toBeTruthy();
    // The healed column round-trips a due time (what a `--delay` row persists) and defaults null.
    h.state.db
      .prepare(
        `INSERT INTO mailbox (id, workspace_path, to_agent, body, formatted_message, not_before, created_at, updated_at)
         VALUES ('d', '/ws', 'spir-1313', 'b', 'f', 5000, 1000, 1000)`
      )
      .run();
    expect(
      (h.state.db.prepare("SELECT not_before FROM mailbox WHERE id='d'").get() as { not_before: number })
        .not_before
    ).toBe(5000);
    h.state.db
      .prepare(
        `INSERT INTO mailbox (id, workspace_path, to_agent, body, formatted_message, created_at, updated_at)
         VALUES ('n', '/ws', 'spir-1313', 'b', 'f', 1000, 1000)`
      )
      .run();
    expect(
      (h.state.db.prepare("SELECT not_before FROM mailbox WHERE id='n'").get() as {
        not_before: number | null;
      }).not_before
    ).toBeNull();
  });

  it('is idempotent: re-running does not throw, double-add, or duplicate the marker', () => {
    buildPreV17Db();
    h.migrate();
    expect(() => h.migrate()).not.toThrow();
    const count = h.state.db.prepare('SELECT COUNT(*) AS n FROM _migrations WHERE version = 17').get() as {
      n: number;
    };
    expect(count.n).toBe(1);
    expect(h.columns('mailbox').filter((c) => c === 'not_before')).toHaveLength(1);
  });

  it('the PRAGMA gate skips the ALTER when not_before already exists (fresh-install shape)', () => {
    // Fresh install: GLOBAL_SCHEMA already created `not_before`, but the v17 marker was not
    // yet stamped. The gate must NOT attempt a duplicate ALTER (which SQLite would reject).
    h.seedMarkers(16);
    h.state.db.exec(
      PRE_V17_MAILBOX_DDL.replace(
        'escalated INTEGER NOT NULL DEFAULT 0,',
        'escalated INTEGER NOT NULL DEFAULT 0,\n    not_before INTEGER,'
      )
    );
    expect(h.columns('mailbox')).toContain('not_before');

    expect(() => h.migrate()).not.toThrow();
    expect(h.state.db.prepare('SELECT version FROM _migrations WHERE version = 17').get()).toBeTruthy();
  });

  it('a fresh install (GLOBAL_SCHEMA) has not_before, matching the migrated shape', () => {
    buildPreV17Db();
    h.migrate();
    const migratedCols = h.columns('mailbox');

    const fresh = new Database(resolve(h.state.testDir, 'fresh.db'));
    try {
      fresh.exec(GLOBAL_SCHEMA);
      const freshCols = (
        fresh.prepare("SELECT name FROM pragma_table_info('mailbox')").all() as Array<{ name: string }>
      )
        .map((c) => c.name)
        .sort();
      expect(freshCols).toContain('not_before');
      expect(freshCols).toEqual(migratedCols);
    } finally {
      fresh.close();
    }
  });
});

/**
 * Whole-chain coverage — only possible now that the runner is callable (Issue #1476).
 * A replica test could assert one block at a time; driving the real function walks a
 * v1-era database through every step, including the table rebuilds (v7/v8/v9) that no
 * replica reproduced.
 */
describe('Issue #1476 — the full v1 → v17 chain through the real runner', () => {
  const h = harness('.test-issue-1476-full-chain');

  /** A v1-era database: the marker table with v1 applied and no content tables. */
  function buildLegacyV1Db(): void {
    h.seedMarkers(1);
  }

  const tables = (db: Database.Database) =>
    (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string }>
    )
      .map((t) => t.name)
      .sort();

  it('walks a v1 database to the current version, stamping every marker', () => {
    buildLegacyV1Db();

    h.migrate();

    const expected = Array.from({ length: GLOBAL_CURRENT_VERSION }, (_, i) => i + 1);
    expect(h.markers()).toEqual(expected);
    expect(h.state.logs.length).toBeGreaterThan(0);
  });

  const triggers = (db: Database.Database) =>
    (db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all() as Array<{ name: string }>)
      .map((t) => t.name)
      .sort();

  it('converges on the same tables, columns, indexes and triggers as a fresh GLOBAL_SCHEMA install', () => {
    buildLegacyV1Db();
    h.migrate();

    const fresh = new Database(resolve(h.state.testDir, 'fresh.db'));
    try {
      fresh.exec(GLOBAL_SCHEMA);

      expect(tables(h.state.db)).toEqual(tables(fresh));
      // The builders_updated_at trigger is defined in both v14 and GLOBAL_SCHEMA.
      expect(triggers(h.state.db)).toEqual(triggers(fresh));

      for (const table of tables(fresh)) {
        const freshCols = (
          fresh.prepare('SELECT name FROM pragma_table_info(?)').all(table) as Array<{ name: string }>
        )
          .map((c) => c.name)
          .sort();
        const freshIdx = (
          fresh
            .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name = ?")
            .all(table) as Array<{ name: string }>
        )
          .map((i) => i.name)
          .filter((n) => !n.startsWith('sqlite_'))
          .sort();

        expect({ table, cols: h.columns(table) }).toEqual({ table, cols: freshCols });
        expect({ table, idx: h.indexes(table) }).toEqual({ table, idx: freshIdx });
      }
    } finally {
      fresh.close();
    }
  });

  it('migration v9 carries legacy project_path rows over to workspace_path', () => {
    // A post-v8 database: project_path-era tables carrying real rows.
    h.seedMarkers(8);
    h.state.db.exec(`
      CREATE TABLE terminal_sessions (
        id TEXT PRIMARY KEY,
        project_path TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('architect', 'builder', 'shell')),
        role_id TEXT,
        pid INTEGER,
        shellper_socket TEXT,
        shellper_pid INTEGER,
        shellper_start_time INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE file_tabs (
        id TEXT PRIMARY KEY,
        project_path TEXT NOT NULL,
        file_path TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE known_projects (
        project_path TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        last_launched_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO terminal_sessions (id, project_path, type, role_id) VALUES ('t1', '/ws/legacy', 'architect', NULL);
      INSERT INTO file_tabs (id, project_path, file_path, created_at) VALUES ('f1', '/ws/legacy', 'a.md', 1);
      INSERT INTO known_projects (project_path, name) VALUES ('/ws/legacy', 'legacy');
    `);

    h.migrate();

    expect(h.columns('terminal_sessions')).toContain('workspace_path');
    const session = h.state.db.prepare("SELECT workspace_path, role_id FROM terminal_sessions WHERE id='t1'").get() as {
      workspace_path: string;
      role_id: string;
    };
    expect(session.workspace_path).toBe('/ws/legacy');
    expect(session.role_id).toBe('main'); // v13 backfill of legacy architect rows
    expect(
      (h.state.db.prepare("SELECT workspace_path FROM file_tabs WHERE id='f1'").get() as {
        workspace_path: string;
      }).workspace_path
    ).toBe('/ws/legacy');
    expect(
      (h.state.db.prepare("SELECT name FROM known_workspaces WHERE workspace_path='/ws/legacy'").get() as {
        name: string;
      }).name
    ).toBe('legacy');
    expect(h.tableExists('known_projects')).toBe(false);
  });

  it('migration v8 renames shellper sockets in the injected run directory only', () => {
    buildLegacyV1Db();
    writeFileSync(resolve(h.state.runDir, 'shepherd-abc.sock'), '');
    writeFileSync(resolve(h.state.runDir, 'unrelated.txt'), '');

    h.migrate();

    expect(readdirSync(h.state.runDir).sort()).toEqual(['shellper-abc.sock', 'unrelated.txt']);
  });

  it('refuses a marker-less fresh GLOBAL_SCHEMA database with a named error', () => {
    // The runner is now callable from anywhere, so the one shape it cannot handle must
    // fail diagnosably rather than dying at v5 on `no such column: project_path`.
    h.state.db.exec(GLOBAL_SCHEMA);
    h.state.db.prepare('DELETE FROM _migrations').run();

    expect(() => h.migrate()).toThrow(/no v9 migration marker/);
    // Nothing was applied — the guard fires before any step runs.
    expect(h.markers()).toEqual([]);
  });

  it('accepts a fresh GLOBAL_SCHEMA database once its markers are stamped (the production path)', () => {
    h.state.db.exec(GLOBAL_SCHEMA);
    for (let v = 1; v <= GLOBAL_CURRENT_VERSION; v++) {
      h.state.db.prepare('INSERT OR IGNORE INTO _migrations (version) VALUES (?)').run(v);
    }

    expect(() => h.migrate()).not.toThrow();
    expect(h.state.logs).toEqual([]); // every step already marked; nothing re-runs
  });

  it('a missing run directory does not fail the chain', () => {
    buildLegacyV1Db();
    rmSync(h.state.runDir, { recursive: true });

    expect(() => h.migrate()).not.toThrow();
    expect(h.markers()).toContain(8);
  });
});
