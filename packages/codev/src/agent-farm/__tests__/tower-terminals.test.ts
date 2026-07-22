/**
 * Unit tests for tower-terminals.ts (Spec 0105 Phase 4)
 *
 * Tests: session CRUD, file tab persistence, shell ID allocation,
 * terminal manager lifecycle, reconciliation,
 * getTerminalsForWorkspace, and initTerminals/shutdownTerminals lifecycle.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {
  initTerminals,
  shutdownTerminals,
  getWorkspaceTerminals,
  getTerminalManager,
  getWorkspaceTerminalsEntry,
  getNextShellId,
  saveTerminalSession,
  isSessionPersistent,
  deleteTerminalSession,
  removeTerminalFromRegistry,
  deleteWorkspaceTerminalSessions,
  saveFileTab,
  deleteFileTab,
  loadFileTabsForWorkspace,
  processExists,
  getTerminalSessionsForWorkspace,
  markStartupReconcileSettled,
  isStartupReconcileSettled,
  whenStartupReconcileSettled,
  getRehydratedTerminalsEntry,
  __resetStartupReconcileSettledForTest,
  type TerminalDeps,
} from '../servers/tower-terminals.js';

// ============================================================================
// Mocks
// ============================================================================

const {
  mockDbPrepare, mockDbRun, mockDbAll,
  mockSaveFileTabToDb, mockDeleteFileTabFromDb, mockLoadFileTabsFromDb,
} = vi.hoisted(() => ({
  mockDbPrepare: vi.fn(),
  mockDbRun: vi.fn(),
  mockDbAll: vi.fn(),
  mockSaveFileTabToDb: vi.fn(),
  mockDeleteFileTabFromDb: vi.fn(),
  mockLoadFileTabsFromDb: vi.fn(() => new Map()),
}));

vi.mock('../db/index.js', () => ({
  getGlobalDb: () => ({
    prepare: (...args: unknown[]) => {
      mockDbPrepare(...args);
      return { run: mockDbRun, all: mockDbAll };
    },
  }),
}));

vi.mock('../utils/file-tabs.js', () => ({
  saveFileTab: (...args: unknown[]) => mockSaveFileTabToDb(...args),
  deleteFileTab: (...args: unknown[]) => mockDeleteFileTabFromDb(...args),
  loadFileTabsForWorkspace: (...args: unknown[]) => mockLoadFileTabsFromDb(...args),
}));

// ============================================================================
// Helpers
// ============================================================================

function makeDeps(overrides: Partial<TerminalDeps> = {}): TerminalDeps {
  return {
    log: vi.fn(),
    shellperManager: null,
    registerKnownWorkspace: vi.fn(),
    getKnownWorkspacePaths: vi.fn(() => []),
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('tower-terminals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Ensure module is in clean state
    shutdownTerminals();
    getWorkspaceTerminals().clear();
    // #997: reset the startup-readiness barrier so each test starts pre-reconcile
    // (reconcileTerminalSessions in other tests settles it as a side effect).
    __resetStartupReconcileSettledForTest();
  });

  afterEach(() => {
    shutdownTerminals();
    getWorkspaceTerminals().clear();
  });

  // =========================================================================
  // Lifecycle
  // =========================================================================

  describe('initTerminals / shutdownTerminals', () => {
    it('initializes without error', () => {
      const deps = makeDeps();
      expect(() => initTerminals(deps)).not.toThrow();
    });

    it('shutdown is idempotent', () => {
      expect(() => shutdownTerminals()).not.toThrow();
      expect(() => shutdownTerminals()).not.toThrow();
    });

    it('safe re-init', () => {
      const deps1 = makeDeps();
      const deps2 = makeDeps();
      initTerminals(deps1);
      initTerminals(deps2);
      shutdownTerminals();
    });
  });

  // =========================================================================
  // getWorkspaceTerminals (accessor)
  // =========================================================================

  describe('getWorkspaceTerminals', () => {
    it('returns a Map', () => {
      expect(getWorkspaceTerminals()).toBeInstanceOf(Map);
    });

    it('entries persist across calls', () => {
      const map = getWorkspaceTerminals();
      map.set('/test', { builders: new Map(), shells: new Map(), fileTabs: new Map() });
      expect(getWorkspaceTerminals().has('/test')).toBe(true);
    });
  });

  // =========================================================================
  // getWorkspaceTerminalsEntry
  // =========================================================================

  describe('getWorkspaceTerminalsEntry', () => {
    it('creates new entry for unknown path', () => {
      const entry = getWorkspaceTerminalsEntry('/new/project');
      expect(entry).toBeDefined();
      expect(entry.builders).toBeInstanceOf(Map);
      expect(entry.shells).toBeInstanceOf(Map);
      expect(getWorkspaceTerminals().has('/new/project')).toBe(true);
    });

    it('returns existing entry', () => {
      const entry1 = getWorkspaceTerminalsEntry('/existing');
      entry1.architect = 'test-id';
      const entry2 = getWorkspaceTerminalsEntry('/existing');
      expect(entry2.architect).toBe('test-id');
    });

    it('ensures fileTabs exists for older entries', () => {
      // Simulate an older entry without fileTabs
      const map = getWorkspaceTerminals();
      map.set('/old', { builders: new Map(), shells: new Map() } as any);
      const entry = getWorkspaceTerminalsEntry('/old');
      expect(entry.fileTabs).toBeInstanceOf(Map);
    });
  });

  // =========================================================================
  // getNextShellId
  // =========================================================================

  describe('getNextShellId', () => {
    it('returns shell-1 for empty project', () => {
      expect(getNextShellId('/project')).toBe('shell-1');
    });

    it('increments based on existing shells', () => {
      const entry = getWorkspaceTerminalsEntry('/project');
      entry.shells.set('shell-1', 'term-1');
      entry.shells.set('shell-2', 'term-2');
      expect(getNextShellId('/project')).toBe('shell-3');
    });

    it('handles gaps in shell numbering', () => {
      const entry = getWorkspaceTerminalsEntry('/project');
      entry.shells.set('shell-1', 'term-1');
      entry.shells.set('shell-5', 'term-5');
      expect(getNextShellId('/project')).toBe('shell-6');
    });
  });

  // =========================================================================
  // saveTerminalSession
  // =========================================================================

  describe('saveTerminalSession', () => {
    it('saves to SQLite when project is active', () => {
      const deps = makeDeps();
      initTerminals(deps);
      getWorkspaceTerminals().set('/project', { builders: new Map(), shells: new Map(), fileTabs: new Map() });

      saveTerminalSession('term-1', '/project', 'architect', null, 1234);
      expect(mockDbPrepare).toHaveBeenCalledWith(expect.stringContaining('INSERT OR REPLACE'));
      expect(mockDbRun).toHaveBeenCalled();
    });

    it('skips save when project is not active', () => {
      const deps = makeDeps();
      initTerminals(deps);

      saveTerminalSession('term-1', '/inactive', 'architect', null, 1234);
      expect(mockDbRun).not.toHaveBeenCalled();
    });

    it('handles DB errors gracefully', () => {
      const deps = makeDeps();
      initTerminals(deps);
      getWorkspaceTerminals().set('/project', { builders: new Map(), shells: new Map(), fileTabs: new Map() });
      mockDbRun.mockImplementation(() => { throw new Error('DB error'); });

      expect(() => saveTerminalSession('term-1', '/project', 'architect', null, 1234)).not.toThrow();
    });
  });

  // =========================================================================
  // isSessionPersistent
  // =========================================================================

  describe('isSessionPersistent', () => {
    it('returns true for shellper-backed sessions', () => {
      const session = { shellperBacked: true } as any;
      expect(isSessionPersistent('term-1', session)).toBe(true);
    });

    it('returns false for non-shellper sessions', () => {
      const session = { shellperBacked: false } as any;
      expect(isSessionPersistent('term-1', session)).toBe(false);
    });
  });

  // =========================================================================
  // deleteTerminalSession
  // =========================================================================

  describe('deleteTerminalSession', () => {
    it('deletes from SQLite', () => {
      deleteTerminalSession('term-1');
      expect(mockDbPrepare).toHaveBeenCalledWith('DELETE FROM terminal_sessions WHERE id = ?');
      expect(mockDbRun).toHaveBeenCalledWith('term-1');
    });

    it('handles DB errors gracefully', () => {
      mockDbRun.mockImplementation(() => { throw new Error('DB error'); });
      expect(() => deleteTerminalSession('term-1')).not.toThrow();
    });
  });

  // =========================================================================
  // deleteWorkspaceTerminalSessions
  // =========================================================================

  describe('deleteWorkspaceTerminalSessions', () => {
    it('deletes by normalized path', () => {
      deleteWorkspaceTerminalSessions('/project');
      expect(mockDbPrepare).toHaveBeenCalledWith('DELETE FROM terminal_sessions WHERE workspace_path = ?');
    });

    it('handles DB errors gracefully', () => {
      mockDbRun.mockImplementation(() => { throw new Error('DB error'); });
      expect(() => deleteWorkspaceTerminalSessions('/project')).not.toThrow();
    });
  });

  // =========================================================================
  // File tab operations
  // =========================================================================

  describe('saveFileTab', () => {
    it('delegates to utils/file-tabs', () => {
      saveFileTab('tab-1', '/project', '/project/file.ts', Date.now());
      expect(mockSaveFileTabToDb).toHaveBeenCalled();
    });

    it('handles errors gracefully', () => {
      mockSaveFileTabToDb.mockImplementation(() => { throw new Error('err'); });
      const deps = makeDeps();
      initTerminals(deps);
      expect(() => saveFileTab('tab-1', '/project', '/file.ts', 0)).not.toThrow();
    });
  });

  describe('deleteFileTab', () => {
    it('delegates to utils/file-tabs', () => {
      deleteFileTab('tab-1');
      expect(mockDeleteFileTabFromDb).toHaveBeenCalled();
    });

    it('handles errors gracefully', () => {
      mockDeleteFileTabFromDb.mockImplementation(() => { throw new Error('err'); });
      const deps = makeDeps();
      initTerminals(deps);
      expect(() => deleteFileTab('tab-1')).not.toThrow();
    });
  });

  describe('loadFileTabsForWorkspace', () => {
    it('returns a Map', () => {
      const result = loadFileTabsForWorkspace('/project');
      expect(result).toBeInstanceOf(Map);
    });

    it('returns empty Map on error', () => {
      mockLoadFileTabsFromDb.mockImplementation(() => { throw new Error('err'); });
      const deps = makeDeps();
      initTerminals(deps);
      const result = loadFileTabsForWorkspace('/project');
      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(0);
    });
  });

  // =========================================================================
  // processExists
  // =========================================================================

  describe('processExists', () => {
    it('returns true for current process', () => {
      expect(processExists(process.pid)).toBe(true);
    });

    it('returns false for non-existent PID', () => {
      expect(processExists(999999999)).toBe(false);
    });
  });

  // =========================================================================
  // getTerminalSessionsForWorkspace
  // =========================================================================

  describe('getTerminalSessionsForWorkspace', () => {
    it('returns sessions from SQLite', () => {
      const mockSessions = [
        { id: 'term-1', workspace_path: '/project', type: 'architect' },
      ];
      mockDbAll.mockReturnValue(mockSessions);

      const result = getTerminalSessionsForWorkspace('/project');
      expect(result).toEqual(mockSessions);
    });

    it('returns empty array on DB error', () => {
      mockDbAll.mockImplementation(() => { throw new Error('DB error'); });
      const result = getTerminalSessionsForWorkspace('/project');
      expect(result).toEqual([]);
    });
  });

  // =========================================================================
  // getTerminalManager
  // =========================================================================

  describe('getTerminalManager', () => {
    it('returns a TerminalManager instance', () => {
      const manager = getTerminalManager();
      expect(manager).toBeDefined();
      expect(typeof manager.getSession).toBe('function');
    });

    it('returns same instance on multiple calls', () => {
      const manager1 = getTerminalManager();
      const manager2 = getTerminalManager();
      expect(manager1).toBe(manager2);
    });
  });

  // =========================================================================
  // removeTerminalFromRegistry (Bugfix #290)
  // =========================================================================

  describe('removeTerminalFromRegistry', () => {
    it('removes a builder terminal from the registry', () => {
      const entry = getWorkspaceTerminalsEntry('/project');
      entry.builders.set('builder-1', 'term-abc');
      entry.builders.set('builder-2', 'term-def');

      removeTerminalFromRegistry('term-abc');

      expect(entry.builders.has('builder-1')).toBe(false);
      expect(entry.builders.has('builder-2')).toBe(true);
    });

    it('removes a shell terminal from the registry', () => {
      const entry = getWorkspaceTerminalsEntry('/project');
      entry.shells.set('shell-1', 'term-shell');

      removeTerminalFromRegistry('term-shell');

      expect(entry.shells.has('shell-1')).toBe(false);
    });

    it('removes an architect terminal from the registry', () => {
      const entry = getWorkspaceTerminalsEntry('/project');
      entry.architects.set('main', 'term-arch');

      removeTerminalFromRegistry('term-arch');

      expect(entry.architects.has('main')).toBe(false);
    });

    it('is a no-op when terminal ID does not exist', () => {
      const entry = getWorkspaceTerminalsEntry('/project');
      entry.builders.set('builder-1', 'term-abc');

      removeTerminalFromRegistry('nonexistent');

      expect(entry.builders.has('builder-1')).toBe(true);
    });

    it('scans across multiple workspaces', () => {
      const entry1 = getWorkspaceTerminalsEntry('/project-a');
      entry1.builders.set('builder-1', 'term-a');
      const entry2 = getWorkspaceTerminalsEntry('/project-b');
      entry2.builders.set('builder-2', 'term-b');

      removeTerminalFromRegistry('term-b');

      expect(entry1.builders.has('builder-1')).toBe(true);
      expect(entry2.builders.has('builder-2')).toBe(false);
    });
  });

  // =========================================================================
  // reconcileTerminalSessions (startup guard)
  // =========================================================================

  // =========================================================================
  // Startup-readiness barrier (#997)
  // =========================================================================

  describe('startup-readiness barrier', () => {
    it('starts unsettled and flips on markStartupReconcileSettled', () => {
      expect(isStartupReconcileSettled()).toBe(false);
      markStartupReconcileSettled();
      expect(isStartupReconcileSettled()).toBe(true);
    });

    it('whenStartupReconcileSettled stays pending until settled, then resolves', async () => {
      let resolved = false;
      const wait = whenStartupReconcileSettled().then(() => { resolved = true; });

      // Not settled yet — must not resolve on the next microtask turn.
      await Promise.resolve();
      expect(resolved).toBe(false);

      markStartupReconcileSettled();
      await wait;
      expect(resolved).toBe(true);
    });

    it('resolves immediately once already settled', async () => {
      markStartupReconcileSettled();
      await expect(whenStartupReconcileSettled()).resolves.toBeUndefined();
    });

    it('honors the defensive timeout and resolves even if never settled', async () => {
      const log = vi.fn();
      initTerminals(makeDeps({ log }));
      // Tiny timeout: the barrier is never marked, so the timeout path fires.
      await expect(whenStartupReconcileSettled(5)).resolves.toBeUndefined();
      expect(isStartupReconcileSettled()).toBe(false);
      expect(log).toHaveBeenCalledWith('WARN', expect.stringContaining('not settled'));
    });

    it('reconcileTerminalSessions settles the barrier when uninitialized', async () => {
      // No initTerminals() → early !_deps return must still release waiters.
      const { reconcileTerminalSessions } = await import('../servers/tower-terminals.js');
      await reconcileTerminalSessions();
      expect(isStartupReconcileSettled()).toBe(true);
    });

    it('reconcileTerminalSessions settles the barrier after a normal run', async () => {
      initTerminals(makeDeps());
      mockDbAll.mockReturnValue([]);
      const { reconcileTerminalSessions } = await import('../servers/tower-terminals.js');
      await reconcileTerminalSessions();
      expect(isStartupReconcileSettled()).toBe(true);
    });

    it('getRehydratedTerminalsEntry blocks until the barrier settles', async () => {
      initTerminals(makeDeps());
      mockDbAll.mockReturnValue([]);

      let resolved = false;
      const pending = getRehydratedTerminalsEntry('/existing/project').then((e) => { resolved = true; return e; });

      // Barrier unsettled — the read must not complete yet.
      await Promise.resolve();
      expect(resolved).toBe(false);

      markStartupReconcileSettled();
      const entry = await pending;
      expect(resolved).toBe(true);
      expect(entry).toBeDefined();
    });

    // Restart-race regression (#997, plan Test Plan): with a real reconcile in
    // flight, a SINGLE getRehydratedTerminalsEntry read must block until reconcile
    // finishes and then reflect the fully-reconnected role→terminalId mapping —
    // never resolve early into the incomplete startup window.
    //
    // The assertion is an ordering one (deterministic, not timing-sensitive): the
    // read must resolve AFTER reconcile. Without the barrier gate the read runs
    // mid-reconcile (the `!_reconciling` guard skips on-the-fly reconnect, and
    // getTerminalsForWorkspace then *atomically overwrites* the cache with an
    // empty entry) and resolves BEFORE reconcile — flipping the recorded order,
    // which is exactly what this test pins.
    it('a single read after a restart reflects the completed reconcile (resolves after it)', async () => {
      mockDbRun.mockReset();
      mockDbAll.mockReset();
      mockDbPrepare.mockReturnValue({ run: mockDbRun, all: mockDbAll });

      // Hold reconnectSession open until the test releases it, so reconcile is
      // deterministically mid-flight when the read is issued (no timing races).
      let releaseReconnect!: () => void;
      const reconnectGate = new Promise<void>((r) => { releaseReconnect = r; });
      const makeClient = () => ({
        getReplayData: () => Buffer.alloc(0),
        waitForReplay: async () => Buffer.alloc(0),
        connected: true,
        connect: vi.fn(), disconnect: vi.fn(), write: vi.fn(), resize: vi.fn(),
        signal: vi.fn(), spawn: vi.fn(), ping: vi.fn(), setReplayData: vi.fn(),
        on: vi.fn(), emit: vi.fn(), removeAllListeners: vi.fn(), removeListener: vi.fn(),
        addListener: vi.fn(), once: vi.fn(), off: vi.fn(), listenerCount: vi.fn().mockReturnValue(0),
      });
      const mockReconnectSession = vi.fn(async () => { await reconnectGate; return makeClient(); });

      const deps = makeDeps({ shellperManager: { reconnectSession: mockReconnectSession } as any });
      initTerminals(deps);

      mockDbAll.mockReturnValue([{
        id: 'recon-builder', workspace_path: '/real/project', type: 'builder',
        role_id: 'builder-x', pid: 7000, shellper_socket: '/tmp/shellper-recon-builder.sock',
        shellper_pid: 8000, shellper_start_time: Date.now(), created_at: new Date().toISOString(),
      }]);
      vi.spyOn(fs, 'existsSync').mockImplementation((p: fs.PathLike) =>
        String(p) === '/real/project' ? true : false);

      const { reconcileTerminalSessions } = await import('../servers/tower-terminals.js');

      const events: string[] = [];
      // Reconcile parks inside reconnectSession (barrier unsettled, _reconciling=true).
      const reconcilePromise = reconcileTerminalSessions().then(() => { events.push('reconcile'); });
      const readPromise = getRehydratedTerminalsEntry('/real/project').then((e) => { events.push('read'); return e; });

      // Give the read a full macrotask to complete early IF it were ungated.
      await new Promise((r) => setImmediate(r));

      // Now let reconcile finish; the gated read unblocks only after it settles.
      releaseReconnect();
      await reconcilePromise;
      const entry = await readPromise;

      // The single read resolved strictly after reconcile completed.
      expect(events).toEqual(['reconcile', 'read']);
      // …and reflects the fully-reconnected mapping (complete on the first read).
      expect(entry.builders.size).toBe(1);
      expect(entry.builders.has('builder-x')).toBe(true);

      vi.restoreAllMocks();
    });
  });

  describe('reconcileTerminalSessions', () => {
    // Full reconciliation tests would require complex shellper mocking.
    // Here we test the startup guard and basic paths.

    it('returns silently when not initialized', async () => {
      const { reconcileTerminalSessions } = await import('../servers/tower-terminals.js');
      // Not initialized — should return without error
      // (already shutdown in beforeEach)
      await expect(reconcileTerminalSessions()).resolves.toBeUndefined();
    });

    it('handles empty terminal_sessions table', async () => {
      const deps = makeDeps();
      initTerminals(deps);
      mockDbAll.mockReturnValue([]);

      const { reconcileTerminalSessions } = await import('../servers/tower-terminals.js');
      await expect(reconcileTerminalSessions()).resolves.toBeUndefined();
    });

    it('handles DB read error gracefully', async () => {
      const deps = makeDeps();
      initTerminals(deps);
      mockDbAll.mockImplementation(() => { throw new Error('DB read error'); });

      const { reconcileTerminalSessions } = await import('../servers/tower-terminals.js');
      await expect(reconcileTerminalSessions()).resolves.toBeUndefined();
    });

    it('probes shellper sockets with bounded concurrency', async () => {
      // Reset mocks that may have been set to throw by prior tests
      mockDbRun.mockReset();
      mockDbAll.mockReset();
      mockDbPrepare.mockReturnValue({ run: mockDbRun, all: mockDbAll });

      // Track concurrent probe count to verify bounded concurrency
      let activeConcurrency = 0;
      let maxConcurrency = 0;
      const probeOrder: string[] = [];

      const mockReconnectSession = vi.fn(async (sessionId: string) => {
        activeConcurrency++;
        maxConcurrency = Math.max(maxConcurrency, activeConcurrency);
        probeOrder.push(sessionId);
        // Simulate network delay
        await new Promise(r => setTimeout(r, 10));
        activeConcurrency--;
        return null; // All sessions are stale
      });

      const mockShellperManager = {
        reconnectSession: mockReconnectSession,
      };

      const deps = makeDeps({ shellperManager: mockShellperManager as any });
      initTerminals(deps);

      // Create 8 shellper sessions in DB (more than concurrency limit of 5)
      const sessions = Array.from({ length: 8 }, (_, i) => ({
        id: `session-${i}`,
        workspace_path: '/existing/project', // must exist for fs.existsSync
        type: 'builder' as const,
        role_id: `builder-${i}`,
        pid: 1000 + i,
        shellper_socket: `/tmp/shellper-${i}.sock`,
        shellper_pid: 2000 + i,
        shellper_start_time: Date.now(),
        created_at: new Date().toISOString(),
      }));

      mockDbAll.mockReturnValue(sessions);

      // Mock fs.existsSync for workspace paths
      const origExistsSync = fs.existsSync;
      vi.spyOn(fs, 'existsSync').mockImplementation((p: fs.PathLike) => {
        if (String(p) === '/existing/project') return true;
        if (String(p).endsWith('.codev/config.json')) return false;
        return origExistsSync(p);
      });

      const { reconcileTerminalSessions } = await import('../servers/tower-terminals.js');
      await reconcileTerminalSessions();

      // All 8 sessions should have been probed
      expect(mockReconnectSession).toHaveBeenCalledTimes(8);

      // Concurrency should not exceed 5 (the limit)
      expect(maxConcurrency).toBeLessThanOrEqual(5);
      expect(maxConcurrency).toBeGreaterThan(1); // Should actually run in parallel

      // All sessions probed
      expect(probeOrder).toHaveLength(8);

      vi.restoreAllMocks();
    });

    it('processes probe results sequentially after parallel probing', async () => {
      // Reset mocks that may have been set to throw by prior tests
      mockDbRun.mockReset();
      mockDbAll.mockReset();
      mockDbPrepare.mockReturnValue({ run: mockDbRun, all: mockDbAll });

      // Mock a shellper client that returns successfully
      const makeClient = () => ({
        getReplayData: () => Buffer.alloc(0),
        waitForReplay: async () => Buffer.alloc(0),
        connected: true,
        connect: vi.fn(),
        disconnect: vi.fn(),
        write: vi.fn(),
        resize: vi.fn(),
        signal: vi.fn(),
        spawn: vi.fn(),
        ping: vi.fn(),
        setReplayData: vi.fn(),
        on: vi.fn(),
        emit: vi.fn(),
        removeAllListeners: vi.fn(),
        removeListener: vi.fn(),
        addListener: vi.fn(),
        once: vi.fn(),
        off: vi.fn(),
        listenerCount: vi.fn().mockReturnValue(0),
      });

      const mockReconnectSession = vi.fn(async () => {
        await new Promise(r => setTimeout(r, 5));
        return makeClient();
      });

      const mockShellperManager = {
        reconnectSession: mockReconnectSession,
      };

      const deps = makeDeps({ shellperManager: mockShellperManager as any });
      initTerminals(deps);

      // 3 sessions — small enough to stay within concurrency limit
      const sessions = Array.from({ length: 3 }, (_, i) => ({
        id: `recon-${i}`,
        workspace_path: '/real/project',
        type: 'builder' as const,
        role_id: `builder-${i}`,
        pid: 3000 + i,
        shellper_socket: `/tmp/shellper-recon-${i}.sock`,
        shellper_pid: 4000 + i,
        shellper_start_time: Date.now(),
        created_at: new Date().toISOString(),
      }));

      mockDbAll.mockReturnValue(sessions);

      vi.spyOn(fs, 'existsSync').mockImplementation((p: fs.PathLike) => {
        if (String(p) === '/real/project') return true;
        if (String(p).endsWith('.codev/config.json')) return false;
        return false;
      });

      const { reconcileTerminalSessions } = await import('../servers/tower-terminals.js');
      await reconcileTerminalSessions();

      // All 3 should have been probed
      expect(mockReconnectSession).toHaveBeenCalledTimes(3);

      // Verify log messages show successful reconnection
      expect(deps.log).toHaveBeenCalledWith('INFO', expect.stringContaining('Reconnected shellper session'));

      vi.restoreAllMocks();
    });

    it('overlaps waitForReplay calls within a probe batch instead of serializing them (#1215)', async () => {
      // Reset mocks that may have been set to throw by prior tests
      mockDbRun.mockReset();
      mockDbAll.mockReset();
      mockDbPrepare.mockReturnValue({ run: mockDbRun, all: mockDbAll });

      // Before #1215, waitForReplay() ran in the strictly-sequential
      // "process probe results" loop, so only one could ever be in flight
      // at a time regardless of how parallel the connect phase was. Moving
      // it into the same bounded-concurrency batch as reconnectSession
      // means several waitForReplay calls now overlap.
      let activeReplayWaits = 0;
      let maxActiveReplayWaits = 0;

      const makeClient = () => ({
        getReplayData: () => Buffer.alloc(0),
        waitForReplay: vi.fn(async () => {
          activeReplayWaits++;
          maxActiveReplayWaits = Math.max(maxActiveReplayWaits, activeReplayWaits);
          await new Promise((r) => setTimeout(r, 20));
          activeReplayWaits--;
          return Buffer.alloc(0);
        }),
        connected: true,
        connect: vi.fn(),
        disconnect: vi.fn(),
        write: vi.fn(),
        resize: vi.fn(),
        signal: vi.fn(),
        spawn: vi.fn(),
        ping: vi.fn(),
        setReplayData: vi.fn(),
        on: vi.fn(),
        emit: vi.fn(),
        removeAllListeners: vi.fn(),
        removeListener: vi.fn(),
        addListener: vi.fn(),
        once: vi.fn(),
        off: vi.fn(),
        listenerCount: vi.fn().mockReturnValue(0),
      });

      const mockReconnectSession = vi.fn(async () => makeClient());
      const mockShellperManager = { reconnectSession: mockReconnectSession };
      const deps = makeDeps({ shellperManager: mockShellperManager as any });
      initTerminals(deps);

      // 6 sessions — exceeds the concurrency limit of 5, so the first batch
      // alone should show overlap.
      const sessions = Array.from({ length: 6 }, (_, i) => ({
        id: `overlap-${i}`,
        workspace_path: '/overlap/project',
        type: 'builder' as const,
        role_id: `builder-${i}`,
        pid: 5000 + i,
        shellper_socket: `/tmp/shellper-overlap-${i}.sock`,
        shellper_pid: 6000 + i,
        shellper_start_time: Date.now(),
        created_at: new Date().toISOString(),
      }));

      mockDbAll.mockReturnValue(sessions);

      vi.spyOn(fs, 'existsSync').mockImplementation((p: fs.PathLike) => {
        if (String(p) === '/overlap/project') return true;
        if (String(p).endsWith('.codev/config.json')) return false;
        return false;
      });

      const { reconcileTerminalSessions } = await import('../servers/tower-terminals.js');
      await reconcileTerminalSessions();

      expect(mockReconnectSession).toHaveBeenCalledTimes(6);
      expect(maxActiveReplayWaits).toBeGreaterThan(1);

      vi.restoreAllMocks();
    });

    // =========================================================================
    // Spec 786 Phase 2 — Identity preservation on shellper auto-restart
    // =========================================================================
    //
    // The reconciliation path builds `restartOptions.env` that shellper uses
    // when it auto-restarts a dead process. Prior to Spec 786, the env was
    // `{ ...process.env }` minus CLAUDECODE — without `CODEV_ARCHITECT_NAME`
    // re-injection. That meant a restarted sibling's claude process inherited
    // Tower's env (default 'main' or unset), and builders spawned afterward
    // lost affinity to the sibling. Phase 2 injects
    // `CODEV_ARCHITECT_NAME: dbSession.role_id || 'main'` into the restart env.

    describe('Spec 786 Phase 2 — CODEV_ARCHITECT_NAME re-injection', () => {
      beforeEach(() => {
        mockDbRun.mockReset();
        mockDbAll.mockReset();
        mockDbPrepare.mockReturnValue({ run: mockDbRun, all: mockDbAll });
      });

      afterEach(() => {
        vi.restoreAllMocks();
      });

      it('injects CODEV_ARCHITECT_NAME=<role_id> into restartOptions.env for a sibling architect', async () => {
        let capturedRestartOptions: any = null;
        const mockReconnectSession = vi.fn(async (_id, _socket, _pid, _start, restartOptions) => {
          capturedRestartOptions = restartOptions;
          return null; // stale — phase 2 cares only about restartOptions construction
        });

        const deps = makeDeps({ shellperManager: { reconnectSession: mockReconnectSession } as any });
        initTerminals(deps);

        mockDbAll.mockReturnValue([{
          id: 'arch-ob-refine',
          workspace_path: '/real/project',
          type: 'architect',
          role_id: 'ob-refine',
          pid: 5000,
          shellper_socket: '/tmp/shellper-ob-refine.sock',
          shellper_pid: 6000,
          shellper_start_time: Date.now(),
          created_at: new Date().toISOString(),
        }]);

        vi.spyOn(fs, 'existsSync').mockImplementation((p: fs.PathLike) => {
          if (String(p) === '/real/project') return true;
          // No .codev/config.json — buildArchitectArgs will see no role and
          // return empty harnessEnv (early return when loadRolePrompt is null).
          return false;
        });

        const { reconcileTerminalSessions } = await import('../servers/tower-terminals.js');
        await reconcileTerminalSessions();

        expect(capturedRestartOptions).not.toBeNull();
        expect(capturedRestartOptions.env.CODEV_ARCHITECT_NAME).toBe('ob-refine');
      });

      it('falls back to CODEV_ARCHITECT_NAME=main when role_id is null (legacy rows)', async () => {
        let capturedRestartOptions: any = null;
        const mockReconnectSession = vi.fn(async (_id, _socket, _pid, _start, restartOptions) => {
          capturedRestartOptions = restartOptions;
          return null;
        });

        const deps = makeDeps({ shellperManager: { reconnectSession: mockReconnectSession } as any });
        initTerminals(deps);

        mockDbAll.mockReturnValue([{
          id: 'arch-legacy',
          workspace_path: '/real/project',
          type: 'architect',
          role_id: null, // pre-v13 backfill — should fall back to 'main'
          pid: 5000,
          shellper_socket: '/tmp/shellper-legacy.sock',
          shellper_pid: 6000,
          shellper_start_time: Date.now(),
          created_at: new Date().toISOString(),
        }]);

        vi.spyOn(fs, 'existsSync').mockImplementation((p: fs.PathLike) => {
          if (String(p) === '/real/project') return true;
          return false;
        });

        const { reconcileTerminalSessions } = await import('../servers/tower-terminals.js');
        await reconcileTerminalSessions();

        expect(capturedRestartOptions).not.toBeNull();
        expect(capturedRestartOptions.env.CODEV_ARCHITECT_NAME).toBe('main');
      });

      it('keeps main`s restart env unchanged in behaviour (role_id=main → CODEV_ARCHITECT_NAME=main)', async () => {
        let capturedRestartOptions: any = null;
        const mockReconnectSession = vi.fn(async (_id, _socket, _pid, _start, restartOptions) => {
          capturedRestartOptions = restartOptions;
          return null;
        });

        const deps = makeDeps({ shellperManager: { reconnectSession: mockReconnectSession } as any });
        initTerminals(deps);

        mockDbAll.mockReturnValue([{
          id: 'arch-main',
          workspace_path: '/real/project',
          type: 'architect',
          role_id: 'main',
          pid: 5000,
          shellper_socket: '/tmp/shellper-main.sock',
          shellper_pid: 6000,
          shellper_start_time: Date.now(),
          created_at: new Date().toISOString(),
        }]);

        vi.spyOn(fs, 'existsSync').mockImplementation((p: fs.PathLike) => {
          if (String(p) === '/real/project') return true;
          return false;
        });

        const { reconcileTerminalSessions } = await import('../servers/tower-terminals.js');
        await reconcileTerminalSessions();

        expect(capturedRestartOptions).not.toBeNull();
        expect(capturedRestartOptions.env.CODEV_ARCHITECT_NAME).toBe('main');
      });

      it('injects CODEV_ARCHITECT_NAME on the on-the-fly reconnect path (getTerminalsForWorkspace)', async () => {
        // Site 2 (workspace-status reconnect at tower-terminals.ts:777-798)
        // is structurally identical to site 1 but lives in a different
        // function. The plan explicitly requires "Tests assert env contents
        // on each path", so this test exercises getTerminalsForWorkspace
        // directly rather than reconcileTerminalSessions.
        let capturedRestartOptions: any = null;
        const mockReconnectSession = vi.fn(async (_id, _socket, _pid, _start, restartOptions) => {
          capturedRestartOptions = restartOptions;
          return null; // stale — phase 2 cares only about restartOptions construction
        });

        const deps = makeDeps({ shellperManager: { reconnectSession: mockReconnectSession } as any });
        initTerminals(deps);

        // getTerminalSessionsForWorkspace queries via mockDbAll. Return a
        // sibling architect session whose runtime PTY is gone (so the on-the-
        // fly reconnect path is triggered).
        mockDbAll.mockReturnValue([{
          id: 'arch-sibling-onthefly',
          workspace_path: '/real/project',
          type: 'architect',
          role_id: 'team-a',
          pid: 7000,
          shellper_socket: '/tmp/shellper-team-a.sock',
          shellper_pid: 8000,
          shellper_start_time: Date.now(),
          created_at: new Date().toISOString(),
        }]);

        vi.spyOn(fs, 'existsSync').mockImplementation((p: fs.PathLike) => {
          if (String(p) === '/real/project') return true;
          return false;
        });

        const { getTerminalsForWorkspace } = await import('../servers/tower-terminals.js');
        await getTerminalsForWorkspace('/real/project', 'http://example.test');

        expect(mockReconnectSession).toHaveBeenCalledTimes(1);
        expect(capturedRestartOptions).not.toBeNull();
        expect(capturedRestartOptions.env.CODEV_ARCHITECT_NAME).toBe('team-a');
      });

      it('does not set CODEV_ARCHITECT_NAME for non-architect sessions (builders/shells)', async () => {
        let capturedRestartOptions: any = null;
        const mockReconnectSession = vi.fn(async (_id, _socket, _pid, _start, restartOptions) => {
          capturedRestartOptions = restartOptions;
          return null;
        });

        const deps = makeDeps({ shellperManager: { reconnectSession: mockReconnectSession } as any });
        initTerminals(deps);

        mockDbAll.mockReturnValue([{
          id: 'builder-1',
          workspace_path: '/real/project',
          type: 'builder',
          role_id: 'builder-1',
          pid: 5000,
          shellper_socket: '/tmp/shellper-b1.sock',
          shellper_pid: 6000,
          shellper_start_time: Date.now(),
          created_at: new Date().toISOString(),
        }]);

        vi.spyOn(fs, 'existsSync').mockImplementation((p: fs.PathLike) => {
          if (String(p) === '/real/project') return true;
          return false;
        });

        const { reconcileTerminalSessions } = await import('../servers/tower-terminals.js');
        await reconcileTerminalSessions();

        // Builders take the non-architect branch — restartOptions is undefined,
        // so this is a no-op for env-injection purposes. (Builders restart via
        // their own mechanism handled by spawn-worktree.)
        expect(capturedRestartOptions).toBeUndefined();
      });
    });
  });

  // =========================================================================
  // Spec 786 Phase 5 — Surface enumeration (v1 collapse removal)
  // =========================================================================
  //
  // Replaces the Spec 755 v1 single-entry emission with one terminal entry per
  // registered architect. Verifies tab id scheme (main → bare `'architect'`,
  // siblings → `'architect:<name>'`), main-first ordering, and the new
  // `architectName` / `pid` fields on each entry.

  describe('Spec 786 Phase 5 — per-architect emission', () => {
    let workspaceTerminals: ReturnType<typeof getWorkspaceTerminals>;

    beforeEach(() => {
      mockDbRun.mockReset();
      mockDbAll.mockReset();
      mockDbAll.mockReturnValue([]);
      mockDbPrepare.mockReturnValue({ run: mockDbRun, all: mockDbAll });
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    function setupWorkspaceWithArchitects(names: string[]) {
      const deps = makeDeps();
      initTerminals(deps);
      const wsPath = '/real/project';
      vi.spyOn(fs, 'existsSync').mockImplementation((p: fs.PathLike) => {
        if (String(p) === wsPath) return true;
        return false;
      });
      // Seed in-memory architects via the entry helper, then mock the manager
      // to return live PtySessions for each.
      const entry = getWorkspaceTerminalsEntry(wsPath);
      const manager = getTerminalManager();
      const sessions = new Map<string, { id: string; pid: number; label: string; status: string }>();
      for (const name of names) {
        const terminalId = `term-${name}`;
        entry.architects.set(name, terminalId);
        sessions.set(terminalId, { id: terminalId, pid: 1000 + sessions.size, label: name, status: 'running' });
      }
      vi.spyOn(manager, 'getSession').mockImplementation((id: string) => {
        return sessions.get(id) as any;
      });
      workspaceTerminals = getWorkspaceTerminals();
      return { wsPath };
    }

    it('emits ONE entry per registered architect (no v1 collapse)', async () => {
      const { wsPath } = setupWorkspaceWithArchitects(['main', 'ob-refine', 'architect-3']);
      const { getTerminalsForWorkspace } = await import('../servers/tower-terminals.js');
      const result = await getTerminalsForWorkspace(wsPath, 'http://example.test');

      const architectEntries = result.terminals.filter(t => t.type === 'architect');
      expect(architectEntries).toHaveLength(3);
    });

    it('uses bare "architect" id for main and "architect:<name>" for siblings', async () => {
      const { wsPath } = setupWorkspaceWithArchitects(['main', 'ob-refine']);
      const { getTerminalsForWorkspace } = await import('../servers/tower-terminals.js');
      const result = await getTerminalsForWorkspace(wsPath, 'http://example.test');

      const architectEntries = result.terminals.filter(t => t.type === 'architect');
      const ids = architectEntries.map(t => t.id);
      expect(ids).toContain('architect');
      expect(ids).toContain('architect:ob-refine');
    });

    it('sorts main first regardless of insertion order', async () => {
      // Insert sibling BEFORE main — main must still appear at index 0.
      const { wsPath } = setupWorkspaceWithArchitects(['ob-refine', 'main', 'architect-3']);
      const { getTerminalsForWorkspace } = await import('../servers/tower-terminals.js');
      const result = await getTerminalsForWorkspace(wsPath, 'http://example.test');

      const architectEntries = result.terminals.filter(t => t.type === 'architect');
      expect(architectEntries[0].architectName).toBe('main');
      expect(architectEntries[0].id).toBe('architect');
    });

    it('populates architectName, pid, label per entry', async () => {
      const { wsPath } = setupWorkspaceWithArchitects(['main', 'ob-refine']);
      const { getTerminalsForWorkspace } = await import('../servers/tower-terminals.js');
      const result = await getTerminalsForWorkspace(wsPath, 'http://example.test');

      const mainEntry = result.terminals.find(t => t.id === 'architect')!;
      expect(mainEntry.architectName).toBe('main');
      expect(mainEntry.label).toBe('main');
      expect(mainEntry.pid).toBeGreaterThan(0);

      const siblingEntry = result.terminals.find(t => t.id === 'architect:ob-refine')!;
      expect(siblingEntry.architectName).toBe('ob-refine');
      expect(siblingEntry.label).toBe('ob-refine');
      expect(siblingEntry.pid).toBeGreaterThan(0);
    });

    it('emits no architect entries when none are registered', async () => {
      const { wsPath } = setupWorkspaceWithArchitects([]);
      const { getTerminalsForWorkspace } = await import('../servers/tower-terminals.js');
      const result = await getTerminalsForWorkspace(wsPath, 'http://example.test');

      const architectEntries = result.terminals.filter(t => t.type === 'architect');
      expect(architectEntries).toHaveLength(0);
    });
  });
});
