/**
 * PIR #832 — architect `session_id` migration (v12).
 *
 * Migration v12 adds the per-architect conversation `session_id` column so Tower
 * can resume each architect's prior agent conversation after a restart. These tests
 * instantiate the prior (post-v11) architect schema by hand, then drive a faithful
 * replica of the retired state.db's v12 block and assert the resulting shape — matching the
 * inline-replication convention of `spec-755-migration.test.ts` / `bugfix-826-migration.test.ts`.
 * Migrations are forward-only by project convention; there is no reverse SQL to test.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

describe('PIR #832 — architect session_id migration (v12)', () => {
  const testDir = resolve(process.cwd(), '.test-pir-832');
  let db: Database.Database;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
    db = new Database(resolve(testDir, 'state.db'));
    db.pragma('journal_mode = WAL');
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  /**
   * Reproduce the post-v11 architect table shape: workspace-scoped, TEXT id,
   * NO session_id yet. Marks migrations through v11 as applied.
   */
  function buildPreV12ArchitectTable(opts: { withSessionId?: boolean } = {}): void {
    db.exec(`
      CREATE TABLE _migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE architect (
        workspace_path TEXT NOT NULL,
        id TEXT NOT NULL,
        pid INTEGER NOT NULL,
        port INTEGER NOT NULL,
        cmd TEXT NOT NULL,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        terminal_id TEXT${opts.withSessionId ? ',\n        session_id TEXT' : ''},
        PRIMARY KEY (workspace_path, id)
      );
    `);
    for (let v = 1; v <= 11; v++) {
      db.prepare('INSERT INTO _migrations (version) VALUES (?)').run(v);
    }
  }

  /**
   * Faithful replica of the retired per-workspace state.db's v12 block (idempotent
   * ALTER + marker). Issue #1476: this is NOT global.db's v12 (`terminal_sessions.cwd`,
   * in `db/migrations.ts`) — state.db numbers its migrations in its own space and has
   * no production runner left to call, so the replica stays.
   */
  function runV12Migration(): void {
    const v12 = db.prepare('SELECT version FROM _migrations WHERE version = 12').get();
    if (!v12) {
      try {
        db.exec('ALTER TABLE architect ADD COLUMN session_id TEXT');
      } catch {
        // Column already exists (fresh install ran the updated LOCAL_SCHEMA).
      }
      db.prepare('INSERT INTO _migrations (version) VALUES (12)').run();
    }
  }

  function architectColumns(): string[] {
    return (db.prepare("SELECT name FROM pragma_table_info('architect')").all() as Array<{ name: string }>)
      .map((c) => c.name);
  }

  it('adds the session_id column to the architect table', () => {
    buildPreV12ArchitectTable();
    expect(architectColumns()).not.toContain('session_id');

    runV12Migration();

    expect(architectColumns()).toContain('session_id');
    expect(db.prepare('SELECT version FROM _migrations WHERE version = 12').get()).toBeDefined();
  });

  it('a row written before v12 reads back session_id = null (legacy fallback)', () => {
    buildPreV12ArchitectTable();
    db.prepare(`
      INSERT INTO architect (workspace_path, id, pid, port, cmd, started_at, terminal_id)
      VALUES ('/ws/a', 'main', 1234, 0, 'claude', '2026-01-01T00:00:00.000Z', 'term-1')
    `).run();

    runV12Migration();

    const row = db.prepare("SELECT * FROM architect WHERE workspace_path = '/ws/a' AND id = 'main'").get() as {
      session_id: string | null;
      cmd: string;
    };
    expect(row.session_id).toBeNull();
    expect(row.cmd).toBe('claude'); // existing columns untouched
  });

  it('is idempotent — re-running does not throw and keeps a single v12 marker', () => {
    buildPreV12ArchitectTable();
    runV12Migration();
    expect(() => runV12Migration()).not.toThrow();

    expect(architectColumns()).toContain('session_id');
    const markers = db.prepare('SELECT COUNT(*) AS n FROM _migrations WHERE version = 12').get() as { n: number };
    expect(markers.n).toBe(1);
  });

  it('swallows the duplicate-column error when session_id already exists (fresh install)', () => {
    // A fresh install creates the column via LOCAL_SCHEMA before migrations run; the
    // ALTER then throws "duplicate column name" and must be swallowed, still marking v12.
    buildPreV12ArchitectTable({ withSessionId: true });
    expect(architectColumns()).toContain('session_id');

    expect(() => runV12Migration()).not.toThrow();
    expect(db.prepare('SELECT version FROM _migrations WHERE version = 12').get()).toBeDefined();
  });
});
