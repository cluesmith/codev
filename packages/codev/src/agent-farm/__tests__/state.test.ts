/**
 * Tests for state management with SQLite
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LOCAL_SCHEMA } from '../db/schema.js';

// Test directory
const testDir = resolve(process.cwd(), '.test-state');
let testDb: Database.Database;

// Mock the db module to use test database
vi.mock('../db/index.js', () => {
  return {
    getDb: () => {
      if (!testDb) {
        testDb = new Database(resolve(testDir, 'state.db'));
        testDb.pragma('journal_mode = WAL');
        testDb.pragma('busy_timeout = 5000');
        testDb.exec(LOCAL_SCHEMA);
        testDb.prepare('INSERT OR IGNORE INTO _migrations (version) VALUES (1)').run();
      }
      return testDb;
    },
    closeDb: () => {
      if (testDb) {
        testDb.close();
        testDb = null as any;
      }
    },
  };
});

// Import after mocking
const state = await import('../state.js');

describe('State Management', () => {
  beforeEach(() => {
    // Clean up before each test
    if (testDb) {
      testDb.close();
      testDb = null as any;
    }
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (testDb) {
      testDb.close();
      testDb = null as any;
    }
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
  });

  describe('loadState', () => {
    it('should return default state when database is empty', () => {
      const result = state.loadState();

      expect(result).toEqual({
        architect: null,
        builders: [],
        utils: [],
        annotations: [],
      });
    });
  });

  describe('setArchitect', () => {
    it('should set architect state', () => {
      const architect = {
        cmd: 'claude',
        startedAt: new Date().toISOString(),
      };

      state.setArchitect(architect);

      const result = state.loadState();
      expect(result.architect?.cmd).toBe('claude');
    });

    it('should clear architect when set to null', () => {
      // Set architect first
      state.setArchitect({
        cmd: 'claude',
        startedAt: new Date().toISOString(),
      });

      // Then clear it
      state.setArchitect(null);

      const result = state.loadState();
      expect(result.architect).toBeNull();
    });

    it('should replace existing architect (singleton)', () => {
      state.setArchitect({
        cmd: 'claude',
        startedAt: new Date().toISOString(),
      });

      state.setArchitect({
        cmd: 'claude --dangerously-skip-permissions',
        startedAt: new Date().toISOString(),
      });

      const result = state.loadState();
      expect(result.architect?.cmd).toBe('claude --dangerously-skip-permissions');
    });
  });

  describe('upsertBuilder', () => {
    it('should add new builder', () => {
      const builder = {
        id: 'B001',
        name: 'test-builder',
        status: 'implementing' as const,
        phase: 'init',
        worktree: '/tmp/worktree',
        branch: 'feature-branch',
        type: 'spec' as const,
      };

      state.upsertBuilder(builder);

      const result = state.loadState();
      expect(result.builders).toHaveLength(1);
      expect(result.builders[0].id).toBe('B001');
      expect(result.builders[0].status).toBe('implementing');
    });

    it('should update existing builder', () => {
      const builder = {
        id: 'B001',
        name: 'test-builder',
        status: 'implementing' as const,
        phase: 'init',
        worktree: '/tmp/worktree',
        branch: 'feature-branch',
        type: 'spec' as const,
      };

      state.upsertBuilder(builder);

      // Update status
      state.upsertBuilder({ ...builder, status: 'blocked' });

      const result = state.loadState();
      expect(result.builders).toHaveLength(1);
      expect(result.builders[0].status).toBe('blocked');
    });
  });

  describe('removeBuilder', () => {
    it('should remove builder by id', () => {
      state.upsertBuilder({
        id: 'B001',
        name: 'test-builder',
        status: 'implementing' as const,
        phase: 'init',
        worktree: '/tmp/worktree',
        branch: 'feature-branch',
        type: 'spec' as const,
      });

      state.removeBuilder('B001');

      const result = state.loadState();
      expect(result.builders).toHaveLength(0);
    });
  });

  describe('getBuilder', () => {
    it('should return builder by id', () => {
      state.upsertBuilder({
        id: 'B001',
        name: 'test-builder',
        status: 'implementing' as const,
        phase: 'init',
        worktree: '/tmp/worktree',
        branch: 'feature-branch',
        type: 'spec' as const,
      });

      const builder = state.getBuilder('B001');
      expect(builder?.id).toBe('B001');
    });

    it('should return null for non-existent builder', () => {
      const builder = state.getBuilder('B999');
      expect(builder).toBeNull();
    });
  });

  describe('addUtil / removeUtil', () => {
    it('should add and remove utility terminals', () => {
      const util = {
        id: 'U001',
        name: 'test-util',
      };

      state.addUtil(util);

      let result = state.loadState();
      expect(result.utils).toHaveLength(1);
      expect(result.utils[0].id).toBe('U001');

      state.removeUtil('U001');

      result = state.loadState();
      expect(result.utils).toHaveLength(0);
    });
  });

  describe('addAnnotation / removeAnnotation', () => {
    it('should add and remove annotations', () => {
      const annotation = {
        id: 'A001',
        file: '/path/to/file.ts',
        parent: {
          type: 'architect' as const,
        },
      };

      state.addAnnotation(annotation);

      let result = state.loadState();
      expect(result.annotations).toHaveLength(1);
      expect(result.annotations[0].file).toBe('/path/to/file.ts');

      state.removeAnnotation('A001');

      result = state.loadState();
      expect(result.annotations).toHaveLength(0);
    });
  });

  describe('clearState', () => {
    it('should reset all state', () => {
      // Add some state
      state.setArchitect({
        cmd: 'claude',
        startedAt: new Date().toISOString(),
      });

      state.upsertBuilder({
        id: 'B001',
        name: 'test-builder',
        status: 'implementing' as const,
        phase: 'init',
        worktree: '/tmp/worktree',
        branch: 'feature-branch',
        type: 'spec' as const,
      });

      // Clear it
      state.clearState();

      const result = state.loadState();
      expect(result).toEqual({
        architect: null,
        builders: [],
        utils: [],
        annotations: [],
      });
    });
  });
});
