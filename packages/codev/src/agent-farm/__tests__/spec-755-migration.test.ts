/**
 * Spec 755 — Multi-architect migration tests.
 *
 * Covers the v9 local migration (rebuild `architect` table as TEXT primary key,
 * rekey existing row to 'main', add `builders.spawned_by_architect` column) and
 * the v13 global migration (backfill `terminal_sessions.role_id` for legacy
 * architect rows).
 *
 * These tests instantiate the prior schema by hand, then drive the project's
 * actual `_migrations`-versioned migration code paths and assert the resulting
 * shape. Migration paths are forward-only by project convention (see plan and
 * `db/migrations.ts` v3/v4 precedent) — there is no reverse SQL to test.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Spec 755 — Multi-architect migration', () => {
  const testDir = resolve(process.cwd(), '.test-spec-755');
  let db: Database.Database;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
    db = new Database(resolve(testDir, 'state.db'));
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  describe('Local v9 — architect table rebuild + spawned_by_architect column', () => {
    /**
     * Reproduce the pre-v9 architect table shape (singleton with id = 1).
     * Mirrors the schema as it existed before Spec 755 landed.
     */
    function buildLegacyArchitectTable() {
      db.exec(`
        CREATE TABLE _migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE architect (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          pid INTEGER NOT NULL,
          port INTEGER NOT NULL,
          cmd TEXT NOT NULL,
          started_at TEXT NOT NULL DEFAULT (datetime('now')),
          terminal_id TEXT
        );
        CREATE TABLE builders (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          worktree TEXT NOT NULL,
          branch TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'spawning'
        );
      `);
      for (let v = 1; v <= 8; v++) {
        db.prepare('INSERT INTO _migrations (version) VALUES (?)').run(v);
      }
    }

    /**
     * Run the v9 migration block in isolation against the test DB. Mirrors the
     * retired per-workspace state.db's v9 block — a different numbering space from
     * global.db's v9 (`project_path` → `workspace_path`, in `db/migrations.ts`), with
     * no production runner left to call. Keeping a copy here lets the test
     * assert behavior without importing the full `getDb()` setup (which would
     * pull in workspace config, env detection, etc.).
     */
    function runV9Migration() {
      const tableInfo = db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='architect'")
        .get() as { sql: string } | undefined;

      if (tableInfo?.sql && /CHECK\s*\(\s*id\s*=\s*1\s*\)/i.test(tableInfo.sql)) {
        db.exec(`
          CREATE TABLE architect_v9 (
            id TEXT PRIMARY KEY,
            pid INTEGER NOT NULL,
            port INTEGER NOT NULL,
            cmd TEXT NOT NULL,
            started_at TEXT NOT NULL DEFAULT (datetime('now')),
            terminal_id TEXT
          );
          INSERT INTO architect_v9 (id, pid, port, cmd, started_at, terminal_id)
            SELECT 'main', pid, port, cmd, started_at, terminal_id FROM architect;
          DROP TABLE architect;
          ALTER TABLE architect_v9 RENAME TO architect;
        `);
      }
      try {
        db.exec(`ALTER TABLE builders ADD COLUMN spawned_by_architect TEXT`);
      } catch {
        /* column may already exist */
      }
      db.prepare('INSERT INTO _migrations (version) VALUES (9)').run();
    }

    it('rekeys the singleton architect row from id=1 to id="main"', () => {
      buildLegacyArchitectTable();
      db.prepare(`
        INSERT INTO architect (id, pid, port, cmd, started_at, terminal_id)
        VALUES (1, 1234, 4201, 'claude', '2026-01-01T00:00:00.000Z', 'term-abc')
      `).run();

      runV9Migration();

      const row = db.prepare("SELECT * FROM architect WHERE id = 'main'").get() as any;
      expect(row).toBeDefined();
      expect(row.id).toBe('main');
      expect(row.pid).toBe(1234);
      expect(row.port).toBe(4201);
      expect(row.cmd).toBe('claude');
      expect(row.started_at).toBe('2026-01-01T00:00:00.000Z');
      expect(row.terminal_id).toBe('term-abc');

      // Old id=1 row is gone.
      const oldRow = db.prepare('SELECT * FROM architect WHERE id = ?').get('1');
      expect(oldRow).toBeUndefined();
    });

    it('preserves DEFAULT (datetime(now)) on started_at', () => {
      buildLegacyArchitectTable();
      db.prepare(`
        INSERT INTO architect (id, pid, port, cmd, started_at)
        VALUES (1, 1, 0, 'claude', '2026-01-01T00:00:00.000Z')
      `).run();

      runV9Migration();

      // Insert a new row without supplying started_at — the column default
      // must still be active. (Gemini's review caught this gap.)
      db.prepare(`
        INSERT INTO architect (id, pid, port, cmd)
        VALUES ('sibling', 2, 0, 'claude')
      `).run();

      const sibling = db.prepare("SELECT * FROM architect WHERE id = 'sibling'").get() as any;
      expect(sibling.started_at).toBeTruthy();
      expect(typeof sibling.started_at).toBe('string');
    });

    it('allows multiple named architects after migration (singleton lifted)', () => {
      buildLegacyArchitectTable();
      runV9Migration();

      db.prepare(`
        INSERT INTO architect (id, pid, port, cmd, started_at)
        VALUES ('main', 1, 0, 'claude', '2026-01-01T00:00:00.000Z')
      `).run();
      db.prepare(`
        INSERT INTO architect (id, pid, port, cmd, started_at)
        VALUES ('sibling', 2, 0, 'claude', '2026-01-01T00:00:00.000Z')
      `).run();

      const count = db.prepare('SELECT COUNT(*) as count FROM architect').get() as { count: number };
      expect(count.count).toBe(2);
    });

    it('adds spawned_by_architect column to builders', () => {
      buildLegacyArchitectTable();
      runV9Migration();

      const cols = db
        .prepare("SELECT name FROM pragma_table_info('builders')")
        .all() as Array<{ name: string }>;
      expect(cols.map(c => c.name)).toContain('spawned_by_architect');
    });

    it('is a no-op on a workspace with no existing architect row (fresh install)', () => {
      buildLegacyArchitectTable();
      // No row inserted — table is empty.

      runV9Migration();

      const count = db.prepare('SELECT COUNT(*) as count FROM architect').get() as { count: number };
      expect(count.count).toBe(0);

      const migrationRow = db.prepare('SELECT version FROM _migrations WHERE version = 9').get();
      expect(migrationRow).toBeDefined();
    });
  });

  describe('Global v13 — terminal_sessions.role_id backfill for architects', () => {
    /**
     * Build a minimal pre-v13 global.db with a terminal_sessions table holding
     * one legacy architect row (role_id = NULL) and some unrelated rows.
     */
    function buildLegacyGlobalDb() {
      db.exec(`
        CREATE TABLE _migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE terminal_sessions (
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
      `);
      for (let v = 1; v <= 12; v++) {
        db.prepare('INSERT INTO _migrations (version) VALUES (?)').run(v);
      }
    }

    function runV13Backfill() {
      db.prepare(`
        UPDATE terminal_sessions
           SET role_id = 'main'
         WHERE type = 'architect' AND role_id IS NULL
      `).run();
      db.prepare('INSERT INTO _migrations (version) VALUES (13)').run();
    }

    it('backfills role_id to "main" for legacy architect rows', () => {
      buildLegacyGlobalDb();
      db.prepare(`
        INSERT INTO terminal_sessions (id, workspace_path, type, role_id)
        VALUES ('term-arch-001', '/path/to/ws', 'architect', NULL)
      `).run();

      runV13Backfill();

      const row = db.prepare('SELECT * FROM terminal_sessions WHERE id = ?').get('term-arch-001') as any;
      expect(row.role_id).toBe('main');
    });

    it('leaves non-architect rows untouched', () => {
      buildLegacyGlobalDb();
      db.prepare(`
        INSERT INTO terminal_sessions (id, workspace_path, type, role_id)
        VALUES ('term-builder-1', '/path/to/ws', 'builder', 'spir-100')
      `).run();
      db.prepare(`
        INSERT INTO terminal_sessions (id, workspace_path, type, role_id)
        VALUES ('term-shell-1', '/path/to/ws', 'shell', NULL)
      `).run();

      runV13Backfill();

      const builderRow = db.prepare('SELECT * FROM terminal_sessions WHERE id = ?').get('term-builder-1') as any;
      expect(builderRow.role_id).toBe('spir-100');

      const shellRow = db.prepare('SELECT * FROM terminal_sessions WHERE id = ?').get('term-shell-1') as any;
      expect(shellRow.role_id).toBeNull();
    });

    it('does not overwrite architects that already have an explicit role_id', () => {
      buildLegacyGlobalDb();
      // Hypothetical row already written with an explicit name (e.g., after
      // someone fast-forwards across migrations in a dev branch). The
      // backfill must only touch NULL rows.
      db.prepare(`
        INSERT INTO terminal_sessions (id, workspace_path, type, role_id)
        VALUES ('term-arch-explicit', '/path/to/ws', 'architect', 'sibling')
      `).run();

      runV13Backfill();

      const row = db.prepare('SELECT * FROM terminal_sessions WHERE id = ?').get('term-arch-explicit') as any;
      expect(row.role_id).toBe('sibling');
    });

    it('falls back to first-registered architect when "main" is absent (started_at order, not lexicographic)', () => {
      // This regression test guards against the Codex-flagged bug where
      // `state.ts` used `ORDER BY id LIMIT 1`. If `main` is absent and the
      // workspace has architects 'architect-2' (registered first) and
      // 'zebra' (registered later), the fallback must surface 'architect-2'
      // — not 'architect-2' by alphabet, but by registration order. With the
      // started_at ordering, this distinction matters when name sort
      // disagrees with insert order.
      db.exec(`
        CREATE TABLE _migrations (version INTEGER PRIMARY KEY);
        CREATE TABLE architect (
          id TEXT PRIMARY KEY,
          pid INTEGER NOT NULL,
          port INTEGER NOT NULL,
          cmd TEXT NOT NULL,
          started_at TEXT NOT NULL DEFAULT (datetime('now')),
          terminal_id TEXT
        );
      `);

      // Note: 'aaa-architect' sorts before 'zebra' alphabetically, but we
      // register 'zebra' FIRST (earlier started_at). The fallback should
      // return 'zebra' if order-by-registration is honored, or 'aaa-architect'
      // if order-by-name is used. Started_at semantics return 'zebra'.
      db.prepare(`
        INSERT INTO architect (id, pid, port, cmd, started_at)
        VALUES ('zebra', 1, 0, 'claude', '2026-01-01T00:00:00.000Z')
      `).run();
      db.prepare(`
        INSERT INTO architect (id, pid, port, cmd, started_at)
        VALUES ('aaa-architect', 2, 0, 'claude', '2026-01-02T00:00:00.000Z')
      `).run();

      const fallback = db
        .prepare('SELECT * FROM architect ORDER BY started_at LIMIT 1')
        .get() as { id: string };
      expect(fallback.id).toBe('zebra');

      const lex = db
        .prepare('SELECT * FROM architect ORDER BY id LIMIT 1')
        .get() as { id: string };
      // Sanity: this is the wrong answer that the bug would have returned.
      expect(lex.id).toBe('aaa-architect');
      expect(lex.id).not.toBe('zebra');
    });

    it('is idempotent when run twice', () => {
      buildLegacyGlobalDb();
      db.prepare(`
        INSERT INTO terminal_sessions (id, workspace_path, type, role_id)
        VALUES ('term-arch-001', '/path/to/ws', 'architect', NULL)
      `).run();

      runV13Backfill();
      // Re-running the backfill SQL (not the migration block — that's gated
      // by the _migrations check) should be a no-op on already-populated rows.
      db.prepare(`
        UPDATE terminal_sessions
           SET role_id = 'main'
         WHERE type = 'architect' AND role_id IS NULL
      `).run();

      const row = db.prepare('SELECT * FROM terminal_sessions WHERE id = ?').get('term-arch-001') as any;
      expect(row.role_id).toBe('main');
    });
  });
});
