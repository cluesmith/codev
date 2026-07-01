/**
 * Tests for database layer
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { LOCAL_SCHEMA, GLOBAL_SCHEMA } from '../db/schema.js';

describe('Database Schema', () => {
  const testDir = resolve(process.cwd(), '.test-db');
  let db: Database.Database;

  beforeEach(() => {
    // Clean up before each test
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
    mkdirSync(testDir, { recursive: true });

    // Create test database
    db = new Database(resolve(testDir, 'test.db'));
    db.pragma('journal_mode = WAL');
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
  });

  describe('LOCAL_SCHEMA', () => {
    beforeEach(() => {
      db.exec(LOCAL_SCHEMA);
    });

    it('should create all required tables', () => {
      const tables = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'
      `).all() as Array<{ name: string }>;

      const tableNames = tables.map(t => t.name).sort();
      expect(tableNames).toContain('_migrations');
      expect(tableNames).toContain('architect');
      expect(tableNames).toContain('builders');
      expect(tableNames).toContain('utils');
      expect(tableNames).toContain('annotations');
    });

    it('should allow multiple named architects (Spec 755 — singleton lifted; Bugfix #826 — workspace-scoped)', () => {
      // Bugfix #826: composite PK (workspace_path, id) — same name allowed in
      // different workspaces, name still unique within a workspace.
      db.prepare(`
        INSERT INTO architect (workspace_path, id, pid, port, cmd, started_at)
        VALUES ('/workspace/A', 'main', 1234, 4201, 'claude', datetime('now'))
      `).run();

      // A second named architect in the same workspace must succeed.
      db.prepare(`
        INSERT INTO architect (workspace_path, id, pid, port, cmd, started_at)
        VALUES ('/workspace/A', 'sibling', 5678, 4201, 'claude', datetime('now'))
      `).run();

      // A 'main' architect in a DIFFERENT workspace must also succeed (composite PK).
      db.prepare(`
        INSERT INTO architect (workspace_path, id, pid, port, cmd, started_at)
        VALUES ('/workspace/B', 'main', 9999, 4201, 'claude', datetime('now'))
      `).run();

      const count = db.prepare('SELECT COUNT(*) as count FROM architect').get() as { count: number };
      expect(count.count).toBe(3);

      // (workspace_path, id) is unique — same workspace + same name conflicts.
      expect(() => {
        db.prepare(`
          INSERT INTO architect (workspace_path, id, pid, port, cmd, started_at)
          VALUES ('/workspace/A', 'main', 1111, 4201, 'claude', datetime('now'))
        `).run();
      }).toThrow();
    });

    it('should enforce builder status CHECK constraint', () => {
      // Valid status should work
      db.prepare(`
        INSERT INTO builders (id, name, port, pid, status, phase, worktree, branch, type)
        VALUES ('B001', 'test', 4210, 1234, 'implementing', 'init', '/tmp', 'test', 'spec')
      `).run();

      // Invalid status should fail
      expect(() => {
        db.prepare(`
          INSERT INTO builders (id, name, port, pid, status, phase, worktree, branch, type)
          VALUES ('B002', 'test2', 4211, 5678, 'invalid_status', 'init', '/tmp', 'test', 'spec')
        `).run();
      }).toThrow();
    });

    it('should allow multiple builders with same port (port=0 for PTY-backed)', () => {
      db.prepare(`
        INSERT INTO builders (id, name, port, pid, status, phase, worktree, branch, type)
        VALUES ('B001', 'test1', 0, 0, 'implementing', 'init', '/tmp', 'test1', 'task')
      `).run();

      // Same port (0) should succeed — PTY-backed builders all use port=0
      db.prepare(`
        INSERT INTO builders (id, name, port, pid, status, phase, worktree, branch, type)
        VALUES ('B002', 'test2', 0, 0, 'implementing', 'init', '/tmp', 'test2', 'bugfix')
      `).run();

      const count = db.prepare('SELECT COUNT(*) as count FROM builders').get() as { count: number };
      expect(count.count).toBe(2);
    });

    it('should create indexes', () => {
      const indexes = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'
      `).all() as Array<{ name: string }>;

      const indexNames = indexes.map(i => i.name);
      expect(indexNames).toContain('idx_builders_status');
      expect(indexNames).toContain('idx_builders_port');
    });
  });

  describe('GLOBAL_SCHEMA', () => {
    beforeEach(() => {
      db.exec(GLOBAL_SCHEMA);
    });

    it('should create all required tables', () => {
      const tables = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'
      `).all() as Array<{ name: string }>;

      const tableNames = tables.map(t => t.name);
      expect(tableNames).toContain('terminal_sessions');
      expect(tableNames).toContain('file_tabs');
      expect(tableNames).toContain('known_workspaces');
      expect(tableNames).toContain('cron_tasks');
    });

    it('should create cron_tasks with correct columns and constraints', () => {
      // Insert a valid cron task
      db.prepare(`
        INSERT INTO cron_tasks (id, workspace_path, task_name, enabled)
        VALUES ('test-id', '/tmp/ws', 'CI Health Check', 1)
      `).run();

      const row = db.prepare('SELECT * FROM cron_tasks WHERE id = ?').get('test-id') as Record<string, unknown>;
      expect(row.workspace_path).toBe('/tmp/ws');
      expect(row.task_name).toBe('CI Health Check');
      expect(row.enabled).toBe(1);
      expect(row.last_run).toBeNull();
      expect(row.last_result).toBeNull();
      expect(row.last_output).toBeNull();
    });

    it('should enforce unique constraint on workspace_path + task_name', () => {
      db.prepare(`
        INSERT INTO cron_tasks (id, workspace_path, task_name, enabled)
        VALUES ('id-1', '/tmp/ws', 'task-a', 1)
      `).run();

      expect(() => {
        db.prepare(`
          INSERT INTO cron_tasks (id, workspace_path, task_name, enabled)
          VALUES ('id-2', '/tmp/ws', 'task-a', 1)
        `).run();
      }).toThrow();
    });

    it('should create terminal_sessions indexes', () => {
      const indexes = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'
      `).all() as Array<{ name: string }>;

      const indexNames = indexes.map(i => i.name);
      expect(indexNames).toContain('idx_terminal_sessions_workspace');
      expect(indexNames).toContain('idx_terminal_sessions_type');
    });
  });
});

// Issue #1118 (codex review): `afx db consolidate` must be idempotent on
// repeat-runs. Both guards return before opening global.db, so no DB is touched.
describe('dbConsolidate idempotency (Issue #1118)', () => {
  const idemDir = resolve(process.cwd(), '.test-db-idem');

  beforeEach(() => {
    if (existsSync(idemDir)) rmSync(idemDir, { recursive: true });
    mkdirSync(idemDir, { recursive: true });
  });
  afterEach(() => {
    if (existsSync(idemDir)) rmSync(idemDir, { recursive: true });
  });

  it('is a friendly no-op on a missing source (re-run after the source was renamed)', async () => {
    const { dbConsolidate } = await import('../commands/db.js');
    expect(() => dbConsolidate(resolve(idemDir, 'already-migrated-state.db'))).not.toThrow();
  });

  it('skips an already-archived *.pre-merge-* file instead of re-migrating it', async () => {
    const { writeFileSync } = await import('node:fs');
    const { dbConsolidate } = await import('../commands/db.js');
    const archived = resolve(idemDir, 'state.db.pre-merge-2026-01-01T00-00-00-000Z');
    writeFileSync(archived, 'x'); // exists + matches pattern → early skip
    expect(() => dbConsolidate(archived)).not.toThrow();
  });
});
