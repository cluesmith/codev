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
  deleteWorkspaceTerminalSessions,
  saveFileTab,
  deleteFileTab,
  loadFileTabsForWorkspace,
  processExists,
  getTerminalSessionsForWorkspace,
  type TerminalDeps,
} from '../servers/tower-terminals.js';

// ============================================================================
// Mocks
// ============================================================================

const {
  mockDbPrepare, mockDbRun, mockDbAll,
  mockGetGateStatusForProject,
  mockSaveFileTabToDb, mockDeleteFileTabFromDb, mockLoadFileTabsFromDb,
} = vi.hoisted(() => ({
  mockDbPrepare: vi.fn(),
  mockDbRun: vi.fn(),
  mockDbAll: vi.fn(),
  mockGetGateStatusForProject: vi.fn(),
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

vi.mock('../utils/gate-status.js', () => ({
  getGateStatusForProject: (...args: unknown[]) => mockGetGateStatusForProject(...args),
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
  // reconcileTerminalSessions (startup guard)
  // =========================================================================

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
  });
});
