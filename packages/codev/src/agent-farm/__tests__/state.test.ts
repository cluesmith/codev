/**
 * Tests for state management with SQLite
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { GLOBAL_SCHEMA } from '../db/schema.js';

// Test directory
const testDir = resolve(process.cwd(), '.test-state');
let testGlobalDb: Database.Database;

// Mock the db module to use a test database. Issue #1118: getDb() and
// getGlobalDb() both return the single global.db, so the mock returns one shared
// db built from GLOBAL_SCHEMA (which now holds architect/builders/utils/
// annotations — builders reshaped with workspace_path + composite PK).
vi.mock('../db/index.js', () => {
  const ensure = () => {
    if (!testGlobalDb) {
      testGlobalDb = new Database(resolve(testDir, 'global.db'));
      testGlobalDb.pragma('journal_mode = WAL');
      testGlobalDb.pragma('busy_timeout = 5000');
      testGlobalDb.exec(GLOBAL_SCHEMA);
    }
    return testGlobalDb;
  };
  const close = () => {
    if (testGlobalDb) {
      testGlobalDb.close();
      testGlobalDb = null as any;
    }
  };
  return {
    getDb: ensure,
    getGlobalDb: ensure,
    closeDb: close,
    closeGlobalDb: close,
  };
});

// Import after mocking
const state = await import('../state.js');

// Bugfix #826: architect rows are scoped by workspace_path. Tests use this
// single workspace unless explicitly testing cross-workspace isolation.
const WS = '/workspace/test';

describe('State Management', () => {
  beforeEach(() => {
    // Clean up before each test
    if (testGlobalDb) {
      testGlobalDb.close();
      testGlobalDb = null as any;
    }
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (testGlobalDb) {
      testGlobalDb.close();
      testGlobalDb = null as any;
    }
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
  });

  describe('loadState', () => {
    it('should return default state when database is empty', () => {
      const result = state.loadState(WS);

      // Spec 786 Phase 5: loadState now returns `architects: []` alongside the
      // scalar `architect` shim (empty array when no rows in state.db.architect).
      expect(result).toEqual({
        architect: null,
        architects: [],
        builders: [],
        utils: [],
        annotations: [],
      });
    });

    // Spec 786 Phase 5: loadState populates `architects` with `main` first.
    it('returns architects collection with main first then siblings by started_at', () => {
      // Insert in a deliberately scrambled order: a sibling first, then main,
      // then another sibling. loadState must sort main to position 0.
      state.setArchitectByName(WS, 'ob-refine', {
        name: 'ob-refine',
        cmd: 'claude',
        startedAt: '2026-05-22T10:00:00Z',
        terminalId: 'term-ob',
      });
      state.setArchitect(WS, {
        cmd: 'claude',
        startedAt: '2026-05-22T11:00:00Z',
        terminalId: 'term-main',
      });
      state.setArchitectByName(WS, 'architect-3', {
        name: 'architect-3',
        cmd: 'claude',
        startedAt: '2026-05-22T12:00:00Z',
        terminalId: 'term-a3',
      });

      const result = state.loadState(WS);
      expect(result.architects).toHaveLength(3);
      expect(result.architects[0].name).toBe('main');
      // Siblings in started_at order (ob-refine before architect-3).
      expect(result.architects[1].name).toBe('ob-refine');
      expect(result.architects[2].name).toBe('architect-3');
    });

    it('scalar `architect` shim points at architects[0] for backward-compat', () => {
      // With only a sibling registered (no main row), the scalar shim points
      // at the sibling (architects[0]) — preserving the Spec 755 fallback.
      state.setArchitectByName(WS, 'ob-refine', {
        name: 'ob-refine',
        cmd: 'claude',
        startedAt: '2026-05-22T10:00:00Z',
      });

      const result = state.loadState(WS);
      expect(result.architects).toHaveLength(1);
      expect(result.architects[0].name).toBe('ob-refine');
      expect(result.architect?.name).toBe('ob-refine');
    });
  });

  describe('setArchitect', () => {
    it('should set architect state', () => {
      const architect = {
        cmd: 'claude',
        startedAt: new Date().toISOString(),
      };

      state.setArchitect(WS, architect);

      const result = state.loadState(WS);
      expect(result.architect?.cmd).toBe('claude');
    });

    it('should clear architect when set to null', () => {
      // Set architect first
      state.setArchitect(WS, {
        cmd: 'claude',
        startedAt: new Date().toISOString(),
      });

      // Then clear it
      state.setArchitect(WS, null);

      const result = state.loadState(WS);
      expect(result.architect).toBeNull();
    });

    it('should replace existing architect (singleton)', () => {
      state.setArchitect(WS, {
        cmd: 'claude',
        startedAt: new Date().toISOString(),
      });

      state.setArchitect(WS, {
        cmd: 'claude --dangerously-skip-permissions',
        startedAt: new Date().toISOString(),
      });

      const result = state.loadState(WS);
      expect(result.architect?.cmd).toBe('claude --dangerously-skip-permissions');
    });
  });

  describe('session id persistence (Issue #832)', () => {
    it('round-trips sessionId for main via setArchitect / getArchitectByName', () => {
      state.setArchitect(WS, {
        name: 'main',
        cmd: 'claude',
        startedAt: new Date().toISOString(),
        sessionId: 'sess-main-1',
      });
      expect(state.getArchitectByName(WS, 'main')?.sessionId).toBe('sess-main-1');
      expect(state.loadState(WS).architect?.sessionId).toBe('sess-main-1');
    });

    it('round-trips sessionId for a named sibling', () => {
      state.setArchitectByName(WS, 'reviewer', {
        name: 'reviewer',
        cmd: 'claude',
        startedAt: new Date().toISOString(),
        sessionId: 'sess-rev-1',
      });
      expect(state.getArchitectByName(WS, 'reviewer')?.sessionId).toBe('sess-rev-1');
    });

    it('reads back undefined when no sessionId was stored (legacy row)', () => {
      state.setArchitectByName(WS, 'legacy', {
        name: 'legacy',
        cmd: 'claude',
        startedAt: new Date().toISOString(),
      });
      expect(state.getArchitectByName(WS, 'legacy')?.sessionId).toBeUndefined();
    });

    it('clears the stored sessionId when the row is removed (removal-clears-id)', () => {
      state.setArchitectByName(WS, 'reviewer', {
        name: 'reviewer',
        cmd: 'claude',
        startedAt: new Date().toISOString(),
        sessionId: 'sess-rev-1',
      });
      state.setArchitectByName(WS, 'reviewer', null);
      expect(state.getArchitectByName(WS, 'reviewer')).toBeNull();
    });

    it('keeps sibling session ids distinct (no cross-attachment)', () => {
      state.setArchitectByName(WS, 'reviewer', {
        name: 'reviewer', cmd: 'claude', startedAt: new Date().toISOString(), sessionId: 'rev',
      });
      state.setArchitectByName(WS, 'casa', {
        name: 'casa', cmd: 'claude', startedAt: new Date().toISOString(), sessionId: 'casa',
      });
      expect(state.getArchitectByName(WS, 'reviewer')?.sessionId).toBe('rev');
      expect(state.getArchitectByName(WS, 'casa')?.sessionId).toBe('casa');
    });
  });

  describe('upsertBuilder', () => {
    it('should add new builder', () => {
      const builder = {
        id: 'B001',
        name: 'test-builder',
        status: 'implementing' as const,
        phase: 'init',
        worktree: '/workspace/test/.builders/wt',
        branch: 'feature-branch',
        type: 'spec' as const,
      };

      state.upsertBuilder(builder);

      const result = state.loadState(WS);
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
        worktree: '/workspace/test/.builders/wt',
        branch: 'feature-branch',
        type: 'spec' as const,
      };

      state.upsertBuilder(builder);

      // Update status
      state.upsertBuilder({ ...builder, status: 'blocked' });

      const result = state.loadState(WS);
      expect(result.builders).toHaveLength(1);
      expect(result.builders[0].status).toBe('blocked');
    });

    // Spec 755 Phase 2: spawnedByArchitect persistence.
    it('persists spawnedByArchitect when supplied', () => {
      state.upsertBuilder({
        id: 'B-spec755',
        name: 'test-builder',
        status: 'implementing' as const,
        phase: 'init',
        worktree: '/workspace/test/.builders/wt',
        branch: 'feature-branch',
        type: 'spec' as const,
        spawnedByArchitect: 'sibling',
      });

      const row = state.getBuilder('B-spec755');
      expect(row?.spawnedByArchitect).toBe('sibling');
    });

    it('preserves spawnedByArchitect across re-upserts (COALESCE)', () => {
      // First insert with an explicit architect name.
      state.upsertBuilder({
        id: 'B-spec755',
        name: 'test-builder',
        status: 'implementing' as const,
        phase: 'init',
        worktree: '/workspace/test/.builders/wt',
        branch: 'feature-branch',
        type: 'spec' as const,
        spawnedByArchitect: 'sibling',
      });

      // Subsequent status update without spawnedByArchitect must NOT clobber
      // the persisted name. The SQL uses COALESCE to preserve it.
      state.upsertBuilder({
        id: 'B-spec755',
        name: 'test-builder',
        status: 'blocked' as const,
        phase: 'review',
        worktree: '/workspace/test/.builders/wt',
        branch: 'feature-branch',
        type: 'spec' as const,
        // spawnedByArchitect intentionally omitted.
      });

      const row = state.getBuilder('B-spec755');
      expect(row?.status).toBe('blocked');
      expect(row?.spawnedByArchitect).toBe('sibling');
    });

    it('leaves spawnedByArchitect null for legacy upserts that never supplied it', () => {
      state.upsertBuilder({
        id: 'B-spec755-legacy',
        name: 'test-builder',
        status: 'implementing' as const,
        phase: 'init',
        worktree: '/workspace/test/.builders/wt',
        branch: 'feature-branch',
        type: 'spec' as const,
      });

      const row = state.getBuilder('B-spec755-legacy');
      expect(row?.spawnedByArchitect).toBeUndefined();
    });
  });

  describe('removeBuilder', () => {
    it('should remove builder by id', () => {
      state.upsertBuilder({
        id: 'B001',
        name: 'test-builder',
        status: 'implementing' as const,
        phase: 'init',
        worktree: '/workspace/test/.builders/wt',
        branch: 'feature-branch',
        type: 'spec' as const,
      });

      state.removeBuilder('B001');

      const result = state.loadState(WS);
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
        worktree: '/workspace/test/.builders/wt',
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

      let result = state.loadState(WS);
      expect(result.utils).toHaveLength(1);
      expect(result.utils[0].id).toBe('U001');

      state.removeUtil('U001');

      result = state.loadState(WS);
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

      let result = state.loadState(WS);
      expect(result.annotations).toHaveLength(1);
      expect(result.annotations[0].file).toBe('/path/to/file.ts');

      state.removeAnnotation('A001');

      result = state.loadState(WS);
      expect(result.annotations).toHaveLength(0);
    });
  });

  describe('clearState', () => {
    it('should reset all state', () => {
      // Add some state
      state.setArchitect(WS, {
        cmd: 'claude',
        startedAt: new Date().toISOString(),
      });

      state.upsertBuilder({
        id: 'B001',
        name: 'test-builder',
        status: 'implementing' as const,
        phase: 'init',
        worktree: '/workspace/test/.builders/wt',
        branch: 'feature-branch',
        type: 'spec' as const,
      });

      // Clear it
      state.clearState();

      const result = state.loadState(WS);
      // Spec 786 Phase 5: loadState now returns `architects: []` alongside the
      // scalar `architect` shim (empty array when no rows in state.db.architect).
      expect(result).toEqual({
        architect: null,
        architects: [],
        builders: [],
        utils: [],
        annotations: [],
      });
    });
  });

  // Spec 786 Phase 1: removeArchitect helper and clearRuntime variant.
  // Bugfix #826: scoped by workspace_path.
  describe('removeArchitect (Spec 786 + Bugfix #826)', () => {
    it('removes a named architect row from state.db', () => {
      state.setArchitectByName(WS, 'ob-refine', {
        name: 'ob-refine',
        cmd: 'claude',
        startedAt: new Date().toISOString(),
        terminalId: 'term-1',
      });
      // Confirm it was inserted
      let architects = state.getArchitects(WS);
      expect(architects.some(a => a.name === 'ob-refine')).toBe(true);

      state.removeArchitect(WS, 'ob-refine');

      architects = state.getArchitects(WS);
      expect(architects.some(a => a.name === 'ob-refine')).toBe(false);
    });

    it('is idempotent — removing a non-existent name is a no-op', () => {
      expect(() => state.removeArchitect(WS, 'nonexistent')).not.toThrow();
    });

    it('does not affect other architects in the same workspace', () => {
      state.setArchitect(WS, {
        cmd: 'claude',
        startedAt: new Date().toISOString(),
        terminalId: 'main-term',
      });
      state.setArchitectByName(WS, 'ob-refine', {
        name: 'ob-refine',
        cmd: 'claude',
        startedAt: new Date().toISOString(),
        terminalId: 'sibling-term',
      });

      state.removeArchitect(WS, 'ob-refine');

      const architects = state.getArchitects(WS);
      expect(architects.some(a => a.name === 'main')).toBe(true);
      expect(architects.some(a => a.name === 'ob-refine')).toBe(false);
    });

    it('does not affect architects in OTHER workspaces (Bugfix #826)', () => {
      const WS2 = '/workspace/other';
      // Same architect name in two workspaces — composite PK allows this.
      state.setArchitectByName(WS, 'ob-refine', {
        name: 'ob-refine',
        cmd: 'claude',
        startedAt: new Date().toISOString(),
      });
      state.setArchitectByName(WS2, 'ob-refine', {
        name: 'ob-refine',
        cmd: 'claude --dangerously-skip-permissions',
        startedAt: new Date().toISOString(),
      });

      // Remove in WS only.
      state.removeArchitect(WS, 'ob-refine');

      // WS no longer has it; WS2 still does.
      expect(state.getArchitects(WS).map(a => a.name)).toEqual([]);
      expect(state.getArchitects(WS2).map(a => a.name)).toEqual(['ob-refine']);
    });
  });

  describe('clearRuntime (Spec 786)', () => {
    it('preserves all architect rows while wiping runtime tables', () => {
      // Set up: main + a sibling + a builder + a util + an annotation
      state.setArchitect(WS, {
        cmd: 'claude',
        startedAt: new Date().toISOString(),
        terminalId: 'main-term',
      });
      state.setArchitectByName(WS, 'ob-refine', {
        name: 'ob-refine',
        cmd: 'claude',
        startedAt: new Date().toISOString(),
        terminalId: 'sibling-term',
      });
      state.upsertBuilder({
        id: 'B001',
        name: 'test-builder',
        status: 'implementing' as const,
        phase: 'init',
        worktree: '/workspace/test/.builders/wt',
        branch: 'feature-branch',
        type: 'spec' as const,
      });

      state.clearRuntime(WS);

      // Architects survive
      const architects = state.getArchitects(WS);
      expect(architects).toHaveLength(2);
      expect(architects.some(a => a.name === 'main')).toBe(true);
      expect(architects.some(a => a.name === 'ob-refine')).toBe(true);

      // Builders are gone
      const result = state.loadState(WS);
      expect(result.builders).toEqual([]);
      expect(result.utils).toEqual([]);
      expect(result.annotations).toEqual([]);
    });

    it('Issue #1118: is workspace-scoped — clearRuntime(A) does not wipe B\'s builders', () => {
      // Two workspaces' builders coexist in the shared global.db.
      state.upsertBuilder({
        id: 'A-1', name: 'a', status: 'implementing' as const, phase: 'init',
        worktree: '/workspace/aaa/.builders/A-1', branch: 'm', type: 'spec' as const,
      });
      state.upsertBuilder({
        id: 'B-1', name: 'b', status: 'implementing' as const, phase: 'init',
        worktree: '/workspace/bbb/.builders/B-1', branch: 'm', type: 'spec' as const,
      });

      // Stopping workspace A must not touch workspace B.
      state.clearRuntime('/workspace/aaa');

      expect(state.getBuilders('/workspace/aaa')).toHaveLength(0);
      expect(state.getBuilders('/workspace/bbb').map(b => b.id)).toEqual(['B-1']);
    });

    it('differs from clearState which wipes architects too', () => {
      // Confirm the differential behaviour: clearState removes architects;
      // clearRuntime preserves them.
      state.setArchitect(WS, {
        cmd: 'claude',
        startedAt: new Date().toISOString(),
      });
      state.setArchitectByName(WS, 'ob-refine', {
        name: 'ob-refine',
        cmd: 'claude',
        startedAt: new Date().toISOString(),
      });

      state.clearState();

      const architectsAfterClear = state.getArchitects(WS);
      expect(architectsAfterClear).toHaveLength(0);
    });
  });

  // ===========================================================================
  // Bugfix #826 — Workspace-scoped architect schema (Option A)
  // ===========================================================================
  //
  // Migration v11 added `workspace_path` to the architect table as part of a
  // composite primary key. Architects are isolated by construction: a query
  // scoped to workspace A cannot see architects registered in workspace B,
  // regardless of which workspaces this Tower process is serving from a
  // single state.db file. The cross-workspace leak that #826 reported is
  // eliminated at the schema level rather than via per-call-site guards.

  describe('workspace-scoped architect schema (Bugfix #826)', () => {
    const WS_A = '/workspace/shannon';
    const WS_B = '/workspace/manazil';

    it('isolates architects between workspaces', () => {
      // Same architect names registered in two workspaces. Composite PK
      // (workspace_path, id) allows this; each workspace gets its own rows.
      state.setArchitect(WS_A, { cmd: 'claude-A', startedAt: '2026-05-23T10:00:00Z' });
      state.setArchitectByName(WS_A, 'ob-refine', {
        name: 'ob-refine',
        cmd: 'claude-A',
        startedAt: '2026-05-23T10:05:00Z',
      });
      state.setArchitect(WS_B, { cmd: 'claude-B', startedAt: '2026-05-23T11:00:00Z' });

      // Each workspace sees only its own architects.
      expect(state.getArchitects(WS_A).map(a => a.name).sort()).toEqual(['main', 'ob-refine']);
      expect(state.getArchitects(WS_B).map(a => a.name).sort()).toEqual(['main']);
      // The cmd field discriminates which workspace's main row was returned.
      expect(state.getArchitect(WS_A)?.cmd).toBe('claude-A');
      expect(state.getArchitect(WS_B)?.cmd).toBe('claude-B');
    });

    it('regression: #826 leak — siblings in workspace A do NOT appear in workspace B', () => {
      // The bug scenario: shannon registered ob-refine. Then user opens manazil.
      // launchInstance(MANAZIL)'s reconcile loop calls getArchitects(MANAZIL).
      // Pre-fix (no workspace_path column), that query returned ob-refine and
      // re-spawned it into manazil. Post-fix, the workspace filter excludes it.
      state.setArchitectByName(WS_A, 'ob-refine', {
        name: 'ob-refine',
        cmd: 'claude',
        startedAt: '2026-05-23T10:00:00Z',
      });
      state.setArchitectByName(WS_A, 'bug-backlog', {
        name: 'bug-backlog',
        cmd: 'claude',
        startedAt: '2026-05-23T10:05:00Z',
      });

      // Manazil sees nothing — schema-level isolation.
      expect(state.getArchitects(WS_B)).toEqual([]);
      expect(state.getArchitect(WS_B)).toBeNull();
      expect(state.getArchitectByName(WS_B, 'ob-refine')).toBeNull();

      // Shannon still sees both of its siblings.
      expect(state.getArchitects(WS_A).map(a => a.name).sort()).toEqual(['bug-backlog', 'ob-refine']);
    });

    it('Spec 786 stop+start: clearRuntime + scoped re-read preserves siblings', () => {
      // Set up shannon's main + sibling. clearRuntime is called by
      // `afx workspace stop`'s legacy path — wipes runtime tables but
      // preserves architects. Verify the workspace_path scope ensures shannon
      // still sees its sibling on the next launchInstance.
      state.setArchitect(WS_A, {
        cmd: 'claude',
        startedAt: '2026-05-23T10:00:00Z',
        terminalId: 'arch-main-v1',
      });
      state.setArchitectByName(WS_A, 'ob-refine', {
        name: 'ob-refine',
        cmd: 'claude',
        startedAt: '2026-05-23T10:05:00Z',
        terminalId: 'arch-sibling-v1',
      });
      state.upsertBuilder({
        id: 'B001',
        name: 'test-builder',
        status: 'implementing' as const,
        phase: 'init',
        worktree: '/workspace/test/.builders/wt',
        branch: 'feature-branch',
        type: 'spec' as const,
      });

      // Simulate `afx workspace stop` (legacy path):
      state.clearRuntime(WS_A);

      // Architects survive in the workspace's scope.
      expect(state.getArchitects(WS_A).map(a => a.name).sort()).toEqual(['main', 'ob-refine']);

      // Simulate next launchInstance(WS_A): re-upserts main with a new
      // terminal_id. The composite-PK INSERT OR REPLACE keys on
      // (workspace_path, id), so the same row gets updated — no stale row
      // accumulation, no leak into other workspaces.
      state.setArchitect(WS_A, {
        cmd: 'claude',
        startedAt: '2026-05-23T11:00:00Z',
        terminalId: 'arch-main-v2',
      });

      // Still exactly two architects in shannon's scope (main updated, sibling preserved).
      const after = state.getArchitects(WS_A);
      expect(after).toHaveLength(2);
      expect(after.find(a => a.name === 'main')?.terminalId).toBe('arch-main-v2');
      expect(after.find(a => a.name === 'ob-refine')?.terminalId).toBe('arch-sibling-v1');
    });

    it('getArchitectByName is scoped — same name in two workspaces is two different rows', () => {
      state.setArchitectByName(WS_A, 'ob-refine', {
        name: 'ob-refine',
        cmd: 'claude-from-shannon',
        startedAt: '2026-05-23T10:00:00Z',
        terminalId: 'shannon-term',
      });
      state.setArchitectByName(WS_B, 'ob-refine', {
        name: 'ob-refine',
        cmd: 'claude-from-manazil',
        startedAt: '2026-05-23T11:00:00Z',
        terminalId: 'manazil-term',
      });

      const shannonRow = state.getArchitectByName(WS_A, 'ob-refine');
      const manazilRow = state.getArchitectByName(WS_B, 'ob-refine');

      expect(shannonRow?.cmd).toBe('claude-from-shannon');
      expect(shannonRow?.terminalId).toBe('shannon-term');
      expect(manazilRow?.cmd).toBe('claude-from-manazil');
      expect(manazilRow?.terminalId).toBe('manazil-term');
    });

    it('loadState scoped — architect collection reflects only the requested workspace', () => {
      state.setArchitect(WS_A, { cmd: 'A-cmd', startedAt: '2026-05-23T10:00:00Z' });
      state.setArchitectByName(WS_A, 'sibling-A', {
        name: 'sibling-A',
        cmd: 'A-cmd',
        startedAt: '2026-05-23T10:05:00Z',
      });
      state.setArchitect(WS_B, { cmd: 'B-cmd', startedAt: '2026-05-23T11:00:00Z' });

      const stateA = state.loadState(WS_A);
      const stateB = state.loadState(WS_B);

      // WS_A: main + sibling, sorted main-first.
      expect(stateA.architects).toHaveLength(2);
      expect(stateA.architects[0].name).toBe('main');
      expect(stateA.architects[1].name).toBe('sibling-A');
      expect(stateA.architect?.cmd).toBe('A-cmd');

      // WS_B: only main.
      expect(stateB.architects).toHaveLength(1);
      expect(stateB.architects[0].name).toBe('main');
      expect(stateB.architect?.cmd).toBe('B-cmd');
    });

    it('setArchitect upsert is scoped — updating WS_A does not affect WS_B', () => {
      state.setArchitect(WS_A, {
        cmd: 'claude',
        startedAt: '2026-05-23T10:00:00Z',
        terminalId: 'main-A',
      });
      state.setArchitect(WS_B, {
        cmd: 'claude',
        startedAt: '2026-05-23T11:00:00Z',
        terminalId: 'main-B',
      });

      // Update WS_A's main only.
      state.setArchitect(WS_A, {
        cmd: 'claude --dangerously-skip-permissions',
        startedAt: '2026-05-23T12:00:00Z',
        terminalId: 'main-A-v2',
      });

      expect(state.getArchitect(WS_A)?.cmd).toBe('claude --dangerously-skip-permissions');
      expect(state.getArchitect(WS_A)?.terminalId).toBe('main-A-v2');
      expect(state.getArchitect(WS_B)?.cmd).toBe('claude'); // unchanged
      expect(state.getArchitect(WS_B)?.terminalId).toBe('main-B'); // unchanged
    });
  });

  // ===========================================================================
  // Bugfix #826 iter-6 — Path normalization (symlink/realpath canonicalization)
  // ===========================================================================
  //
  // Tower writes canonical realpaths; CLI callers may pass raw symlinked paths.
  // Without normalization at the state.ts boundary, the same workspace
  // accessed via two different paths would create two distinct rows and
  // lookups would silently fail. Each architect accessor now canonicalizes
  // its `workspacePath` argument via `realpathSync` (falling back to
  // `path.resolve` if the path doesn't exist).

  describe('path normalization (Bugfix #826 iter-6)', () => {
    // Use vi.fn-backed mocking? No — the simplest correctness check is a real
    // symlink on disk. The mock DB doesn't care which absolute path is stored.
    const { realpathSync, symlinkSync, mkdirSync: mkSync, rmSync: rmDir } = require('node:fs') as typeof import('node:fs');
    const { join: pathJoin } = require('node:path') as typeof import('node:path');

    let realDir: string;
    let symlinkDir: string;
    let canonicalRealDir: string;

    beforeEach(() => {
      // Create a real workspace directory and a symlink to it.
      realDir = pathJoin(testDir, 'workspace-real');
      mkSync(realDir, { recursive: true });
      symlinkDir = pathJoin(testDir, 'workspace-symlinked');
      try { rmDir(symlinkDir, { recursive: true, force: true }); } catch { /* ignore */ }
      symlinkSync(realDir, symlinkDir, 'dir');
      // The canonical form is what realpath returns (handles /private/var
      // prefixing on macOS, /tmp → /private/tmp, etc).
      canonicalRealDir = realpathSync(realDir);
    });

    it('write via symlink + read via canonical resolves to the same row', () => {
      // Write via the SYMLINKED path.
      state.setArchitectByName(symlinkDir, 'ob-refine', {
        name: 'ob-refine',
        cmd: 'claude',
        startedAt: '2026-05-23T10:00:00Z',
        terminalId: 't-sibling',
      });

      // Read via the CANONICAL realpath — must find the row.
      const arr = state.getArchitects(canonicalRealDir);
      expect(arr.map(a => a.name)).toEqual(['ob-refine']);

      // The persisted workspace_path is the canonical form (verifiable via
      // a direct DB query — single row, canonical workspace_path).
      const allRows = testGlobalDb!.prepare('SELECT workspace_path, id FROM architect').all() as Array<{ workspace_path: string; id: string }>;
      expect(allRows).toEqual([{ workspace_path: canonicalRealDir, id: 'ob-refine' }]);
    });

    it('write via canonical + read via symlink resolves to the same row', () => {
      state.setArchitectByName(canonicalRealDir, 'ob-refine', {
        name: 'ob-refine',
        cmd: 'claude',
        startedAt: '2026-05-23T10:00:00Z',
      });

      // Read via the symlinked path — should find the row.
      expect(state.getArchitectByName(symlinkDir, 'ob-refine')?.name).toBe('ob-refine');
    });

    it('removeArchitect via symlink removes the canonical row', () => {
      state.setArchitectByName(canonicalRealDir, 'ob-refine', {
        name: 'ob-refine',
        cmd: 'claude',
        startedAt: '2026-05-23T10:00:00Z',
      });
      expect(state.getArchitects(canonicalRealDir)).toHaveLength(1);

      // Remove via symlinked path.
      state.removeArchitect(symlinkDir, 'ob-refine');

      expect(state.getArchitects(canonicalRealDir)).toHaveLength(0);
    });

    it('loadState via symlink returns the canonical row', () => {
      state.setArchitect(canonicalRealDir, {
        cmd: 'claude',
        startedAt: '2026-05-23T10:00:00Z',
      });

      const loaded = state.loadState(symlinkDir);
      expect(loaded.architect?.cmd).toBe('claude');
    });

    it('does NOT collapse two distinct workspaces that happen to share a name', () => {
      // Sanity guard: normalization must NOT make two genuinely-different
      // workspaces look identical. Different realpaths → different rows.
      const otherReal = pathJoin(testDir, 'workspace-other');
      mkSync(otherReal, { recursive: true });
      const otherCanonical = realpathSync(otherReal);

      state.setArchitectByName(canonicalRealDir, 'main', {
        name: 'main',
        cmd: 'claude-1',
        startedAt: '2026-05-23T10:00:00Z',
      });
      state.setArchitectByName(otherCanonical, 'main', {
        name: 'main',
        cmd: 'claude-2',
        startedAt: '2026-05-23T11:00:00Z',
      });

      expect(state.getArchitectByName(canonicalRealDir, 'main')?.cmd).toBe('claude-1');
      expect(state.getArchitectByName(otherCanonical, 'main')?.cmd).toBe('claude-2');
    });

    it('falls back to path.resolve for non-existent paths (no realpath available)', () => {
      // Write to a path that doesn't exist on disk — canonicalize() falls
      // back to path.resolve(). Reads via the same input must still match.
      const ghostPath = '/this/path/does/not/exist/workspace';
      state.setArchitectByName(ghostPath, 'main', {
        name: 'main',
        cmd: 'claude',
        startedAt: '2026-05-23T10:00:00Z',
      });
      expect(state.getArchitectByName(ghostPath, 'main')?.cmd).toBe('claude');
    });
  });
});
