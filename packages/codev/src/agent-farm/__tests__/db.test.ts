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

    it('should enforce architect singleton constraint', () => {
      // Insert first architect
      db.prepare(`
        INSERT INTO architect (id, pid, port, cmd, started_at)
        VALUES (1, 1234, 4201, 'claude', datetime('now'))
      `).run();

      // Attempting to insert a second architect with different id should fail
      expect(() => {
        db.prepare(`
          INSERT INTO architect (id, pid, port, cmd, started_at)
          VALUES (2, 5678, 4201, 'claude', datetime('now'))
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
