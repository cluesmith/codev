/**
 * Tests for JSON to SQLite migration
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LOCAL_SCHEMA } from '../db/schema.js';
import { migrateLocalFromJson } from '../db/migrate.js';

describe('Migration', () => {
  const testDir = resolve(process.cwd(), '.test-migrate');
  let db: Database.Database;

  beforeEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (db) {
      db.close();
    }
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
  });

  describe('migrateLocalFromJson', () => {
    beforeEach(() => {
      db = new Database(resolve(testDir, 'state.db'));
      db.pragma('journal_mode = WAL');
      db.exec(LOCAL_SCHEMA);
    });

    it('should migrate architect state', () => {
      const jsonState = {
        architect: {
          pid: 1234,
          port: 4201,
          cmd: 'claude --dangerously-skip-permissions',
          startedAt: '2024-01-01T00:00:00.000Z',
          tmuxSession: 'architect-session',
        },
        builders: [],
        utils: [],
        annotations: [],
      };

      const jsonPath = resolve(testDir, 'state.json');
      writeFileSync(jsonPath, JSON.stringify(jsonState));

      migrateLocalFromJson(db, jsonPath);

      const architect = db.prepare('SELECT * FROM architect WHERE id = 1').get() as any;
      expect(architect.pid).toBe(1234);
      expect(architect.port).toBe(4201);
      expect(architect.cmd).toBe('claude --dangerously-skip-permissions');
      expect(architect.tmux_session).toBe('architect-session');
    });

    it('should migrate builders', () => {
      const jsonState = {
        architect: null,
        builders: [
          {
            id: 'B001',
            name: 'test-builder',
            port: 4210,
            pid: 5678,
            status: 'implementing',
            phase: 'init',
            worktree: '/tmp/worktree',
            branch: 'feature-branch',
            tmuxSession: 'builder-session',
            type: 'spec',
            taskText: 'Fix the bug',
            protocolName: null,
          },
        ],
        utils: [],
        annotations: [],
      };

      const jsonPath = resolve(testDir, 'state.json');
      writeFileSync(jsonPath, JSON.stringify(jsonState));

      migrateLocalFromJson(db, jsonPath);

      const builders = db.prepare('SELECT * FROM builders').all() as any[];
      expect(builders).toHaveLength(1);
      expect(builders[0].id).toBe('B001');
      expect(builders[0].status).toBe('implementing');
      expect(builders[0].task_text).toBe('Fix the bug');
    });

    it('should migrate utils', () => {
      const jsonState = {
        architect: null,
        builders: [],
        utils: [
          {
            id: 'U001',
            name: 'test-util',
            port: 4230,
            pid: 9012,
            tmuxSession: 'util-session',
          },
        ],
        annotations: [],
      };

      const jsonPath = resolve(testDir, 'state.json');
      writeFileSync(jsonPath, JSON.stringify(jsonState));

      migrateLocalFromJson(db, jsonPath);

      const utils = db.prepare('SELECT * FROM utils').all() as any[];
      expect(utils).toHaveLength(1);
      expect(utils[0].id).toBe('U001');
    });

    it('should migrate annotations', () => {
      const jsonState = {
        architect: null,
        builders: [],
        utils: [],
        annotations: [
          {
            id: 'A001',
            file: '/path/to/file.ts',
            port: 4250,
            pid: 3456,
            parent: {
              type: 'builder',
              id: 'B001',
            },
          },
        ],
      };

      const jsonPath = resolve(testDir, 'state.json');
      writeFileSync(jsonPath, JSON.stringify(jsonState));

      migrateLocalFromJson(db, jsonPath);

      const annotations = db.prepare('SELECT * FROM annotations').all() as any[];
      expect(annotations).toHaveLength(1);
      expect(annotations[0].file).toBe('/path/to/file.ts');
      expect(annotations[0].parent_type).toBe('builder');
      expect(annotations[0].parent_id).toBe('B001');
    });

    it('should handle empty state', () => {
      const jsonState = {
        architect: null,
        builders: [],
        utils: [],
        annotations: [],
      };

      const jsonPath = resolve(testDir, 'state.json');
      writeFileSync(jsonPath, JSON.stringify(jsonState));

      // Should not throw
      migrateLocalFromJson(db, jsonPath);

      const architect = db.prepare('SELECT * FROM architect').all();
      expect(architect).toHaveLength(0);
    });

    it('should rollback on error', () => {
      const jsonState = {
        architect: null,
        builders: [
          {
            id: 'B001',
            name: 'valid-builder',
            port: 4210,
            pid: 1234,
            status: 'implementing',
            phase: 'init',
            worktree: '/tmp/1',
            branch: 'test1',
            type: 'spec',
          },
          {
            id: 'B001',  // Same ID - will cause PRIMARY KEY constraint violation
            name: 'duplicate-builder',
            port: 4211,
            pid: 5678,
            status: 'implementing',
            phase: 'init',
            worktree: '/tmp/2',
            branch: 'test2',
            type: 'spec',
          },
        ],
        utils: [],
        annotations: [],
      };

      const jsonPath = resolve(testDir, 'state.json');
      writeFileSync(jsonPath, JSON.stringify(jsonState));

      // Should throw and rollback
      expect(() => migrateLocalFromJson(db, jsonPath)).toThrow();

      // No builders should be inserted due to rollback
      const builders = db.prepare('SELECT * FROM builders').all();
      expect(builders).toHaveLength(0);
    });
  });

});
