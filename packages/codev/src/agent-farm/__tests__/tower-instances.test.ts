/**
 * Unit tests for tower-instances.ts (Spec 0105 Phase 3)
 *
 * Tests: registerKnownWorkspace, getKnownWorkspacePaths, getInstances,
 * getDirectorySuggestions, launchInstance, killTerminalWithShellper, stopInstance,
 * initInstances / shutdownInstances lifecycle.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {
  initInstances,
  shutdownInstances,
  registerKnownWorkspace,
  getKnownWorkspacePaths,
  getInstances,
  getDirectorySuggestions,
  launchInstance,
  killTerminalWithShellper,
  stopInstance,
  type InstanceDeps,
} from '../servers/tower-instances.js';

// ---------------------------------------------------------------------------
// Mocks (vi.hoisted ensures these exist before vi.mock factories run)
// ---------------------------------------------------------------------------

const {
  mockDbPrepare,
  mockDbRun,
  mockDbAll,
  mockGetGateStatusForProject,
  mockIsTempDirectory,
} = vi.hoisted(() => {
  const mockDbRun = vi.fn();
  const mockDbAll = vi.fn().mockReturnValue([]);
  const mockDbPrepare = vi.fn().mockReturnValue({ run: mockDbRun, all: mockDbAll });
  return {
    mockDbPrepare,
    mockDbRun,
    mockDbAll,
    mockGetGateStatusForProject: vi.fn().mockReturnValue(null),
    mockIsTempDirectory: vi.fn().mockReturnValue(false),
  };
});

vi.mock('../db/index.js', () => ({
  getGlobalDb: () => ({ prepare: mockDbPrepare }),
}));

vi.mock('../utils/gate-status.js', () => ({
  getGateStatusForProject: (...args: unknown[]) => mockGetGateStatusForProject(...args),
}));

vi.mock('../servers/tower-utils.js', async () => {
  const actual = await vi.importActual<typeof import('../servers/tower-utils.js')>('../servers/tower-utils.js');
  return {
    ...actual,
    isTempDirectory: (...args: unknown[]) => mockIsTempDirectory(...args),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeps(overrides: Partial<InstanceDeps> = {}): InstanceDeps {
  return {
    log: vi.fn(),
    workspaceTerminals: new Map(),
    getTerminalManager: vi.fn().mockReturnValue({
      getSession: vi.fn(),
      killSession: vi.fn(),
      createSession: vi.fn(),
      createSessionRaw: vi.fn(),
      listSessions: vi.fn().mockReturnValue([]),
    }),
    shellperManager: null,
    getWorkspaceTerminalsEntry: vi.fn().mockReturnValue({
      architect: undefined,
      builders: new Map(),
      shells: new Map(),
    }),
    saveTerminalSession: vi.fn(),
    deleteTerminalSession: vi.fn(),
    deleteWorkspaceTerminalSessions: vi.fn(),
    getTerminalsForWorkspace: vi.fn().mockResolvedValue({ terminals: [], gateStatus: null }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('tower-instances', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    shutdownInstances();
  });

  // =========================================================================
  // initInstances / shutdownInstances lifecycle
  // =========================================================================

  describe('initInstances / shutdownInstances', () => {
    it('shutdownInstances is safe to call without prior init', () => {
      expect(() => shutdownInstances()).not.toThrow();
    });

    it('initInstances sets up module state', () => {
      const deps = makeDeps();
      initInstances(deps);
      // Verify by calling a function that requires initialization
      expect(() => getKnownWorkspacePaths()).not.toThrow();
    });

    it('subsequent init replaces previous deps', () => {
      const deps1 = makeDeps();
      const deps2 = makeDeps();
      initInstances(deps1);
      initInstances(deps2);
      shutdownInstances();
      // No error means it worked
    });
  });

  // =========================================================================
  // registerKnownWorkspace
  // =========================================================================

  describe('registerKnownWorkspace', () => {
    it('inserts workspace into known_workspaces table', () => {
      registerKnownWorkspace('/home/user/my-project');

      expect(mockDbPrepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO known_workspaces'));
      expect(mockDbRun).toHaveBeenCalledWith('/home/user/my-project', 'my-project');
    });

    it('handles database errors gracefully', () => {
      mockDbPrepare.mockImplementationOnce(() => { throw new Error('DB error'); });

      // Should not throw
      expect(() => registerKnownWorkspace('/some/path')).not.toThrow();
    });
  });

  // =========================================================================
  // getKnownWorkspacePaths
  // =========================================================================

  describe('getKnownWorkspacePaths', () => {
    it('returns empty array when no workspaces exist', () => {
      const deps = makeDeps();
      initInstances(deps);

      const paths = getKnownWorkspacePaths();
      expect(paths).toEqual([]);
    });

    it('includes paths from known_workspaces table', () => {
      const deps = makeDeps();
      initInstances(deps);

      // First call returns known_workspaces, second returns terminal_sessions
      mockDbAll
        .mockReturnValueOnce([{ workspace_path: '/path/a' }])
        .mockReturnValueOnce([]);

      const paths = getKnownWorkspacePaths();
      expect(paths).toContain('/path/a');
    });

    it('includes paths from in-memory workspaceTerminals', () => {
      const workspaceTerminals = new Map();
      workspaceTerminals.set('/path/b', { architect: undefined, builders: new Map(), shells: new Map() });
      const deps = makeDeps({ workspaceTerminals });
      initInstances(deps);

      const paths = getKnownWorkspacePaths();
      expect(paths).toContain('/path/b');
    });

    it('deduplicates paths across sources', () => {
      const workspaceTerminals = new Map();
      workspaceTerminals.set('/path/c', { architect: undefined, builders: new Map(), shells: new Map() });
      const deps = makeDeps({ workspaceTerminals });
      initInstances(deps);

      // Both DB tables return the same path
      mockDbAll
        .mockReturnValueOnce([{ workspace_path: '/path/c' }])
        .mockReturnValueOnce([{ workspace_path: '/path/c' }]);

      const paths = getKnownWorkspacePaths();
      // Should appear only once
      expect(paths.filter(p => p === '/path/c')).toHaveLength(1);
    });

    it('handles database errors gracefully', () => {
      const deps = makeDeps();
      initInstances(deps);

      mockDbPrepare.mockImplementation(() => { throw new Error('DB error'); });

      // Should not throw, returns whatever is in memory
      expect(() => getKnownWorkspacePaths()).not.toThrow();
    });
  });

  // =========================================================================
  // getInstances
  // =========================================================================

  describe('getInstances', () => {
    it('returns empty array when called before initInstances (startup guard)', async () => {
      const instances = await getInstances();
      expect(instances).toEqual([]);
    });

    it('returns empty array when no workspaces known', async () => {
      const deps = makeDeps();
      initInstances(deps);

      const instances = await getInstances();
      expect(instances).toEqual([]);
    });

    it('skips builder worktrees', async () => {
      const workspaceTerminals = new Map();
      workspaceTerminals.set('/home/user/project/.builders/001', {
        architect: undefined, builders: new Map(), shells: new Map(),
      });
      const deps = makeDeps({ workspaceTerminals });
      initInstances(deps);

      const instances = await getInstances();
      expect(instances).toEqual([]);
    });

    it('skips non-existent directories', async () => {
      const workspaceTerminals = new Map();
      workspaceTerminals.set('/nonexistent/path/project', {
        architect: undefined, builders: new Map(), shells: new Map(),
      });
      const deps = makeDeps({ workspaceTerminals });
      initInstances(deps);

      const instances = await getInstances();
      expect(instances).toEqual([]);
    });

    it('returns instances sorted: running first, then by name', async () => {
      // Create a temp dir that actually exists so it passes the existsSync check
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-test-a-'));
      const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-test-b-'));

      try {
        const workspaceTerminals = new Map();
        workspaceTerminals.set(tmpDir, {
          architect: undefined, builders: new Map(), shells: new Map(),
        });
        workspaceTerminals.set(tmpDir2, {
          architect: undefined, builders: new Map(), shells: new Map(),
        });

        const getTerminalsForWorkspace = vi.fn()
          .mockResolvedValueOnce({ terminals: [], gateStatus: null })  // tmpDir: inactive
          .mockResolvedValueOnce({ terminals: [{ id: 't1' }], gateStatus: null });  // tmpDir2: active

        const deps = makeDeps({ workspaceTerminals, getTerminalsForWorkspace });
        initInstances(deps);

        const instances = await getInstances();
        expect(instances.length).toBe(2);
        // Active instance should come first
        expect(instances[0].running).toBe(true);
        expect(instances[1].running).toBe(false);
      } finally {
        fs.rmSync(tmpDir, { recursive: true });
        fs.rmSync(tmpDir2, { recursive: true });
      }
    });

    it('populates lastUsed from known_workspaces.last_launched_at', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-test-lastused-'));

      try {
        const workspaceTerminals = new Map();
        workspaceTerminals.set(tmpDir, {
          architect: undefined, builders: new Map(), shells: new Map(),
        });

        const deps = makeDeps({ workspaceTerminals });
        initInstances(deps);

        // Route mock results based on the SQL query
        mockDbPrepare.mockImplementation((sql: string) => ({
          run: mockDbRun,
          all: () => {
            if (sql.includes('last_launched_at') && sql.includes('known_workspaces')) {
              return [{ workspace_path: tmpDir, last_launched_at: '2026-02-14 10:30:00' }];
            }
            if (sql.includes('known_workspaces')) {
              return [{ workspace_path: tmpDir }];
            }
            return [];
          },
        }));

        const instances = await getInstances();
        expect(instances).toHaveLength(1);
        expect(instances[0].lastUsed).toBe('2026-02-14 10:30:00');
      } finally {
        fs.rmSync(tmpDir, { recursive: true });
      }
    });

    it('sets lastUsed to undefined when workspace not in known_workspaces', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-test-nolastused-'));

      try {
        const workspaceTerminals = new Map();
        workspaceTerminals.set(tmpDir, {
          architect: undefined, builders: new Map(), shells: new Map(),
        });

        const deps = makeDeps({ workspaceTerminals });
        initInstances(deps);

        const instances = await getInstances();
        expect(instances).toHaveLength(1);
        expect(instances[0].lastUsed).toBeUndefined();
      } finally {
        fs.rmSync(tmpDir, { recursive: true });
      }
    });
  });

  // =========================================================================
  // getDirectorySuggestions (pure — no module state needed)
  // =========================================================================

  describe('getDirectorySuggestions', () => {
    it('returns empty for relative paths', async () => {
      const suggestions = await getDirectorySuggestions('relative/path');
      expect(suggestions).toEqual([]);
    });

    it('returns empty for non-existent directory', async () => {
      const suggestions = await getDirectorySuggestions('/nonexistent/path/abc123xyz');
      expect(suggestions).toEqual([]);
    });

    it('expands ~ to home directory', async () => {
      // We can test that it doesn't crash; the home dir should exist
      const suggestions = await getDirectorySuggestions('~/');
      expect(Array.isArray(suggestions)).toBe(true);
    });

    it('defaults empty input to home directory', async () => {
      const suggestions = await getDirectorySuggestions('');
      expect(Array.isArray(suggestions)).toBe(true);
    });

    it('filters by prefix when path does not end with /', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-suggest-'));
      fs.mkdirSync(path.join(tmpDir, 'alpha'));
      fs.mkdirSync(path.join(tmpDir, 'beta'));

      try {
        const suggestions = await getDirectorySuggestions(path.join(tmpDir, 'al'));
        expect(suggestions).toHaveLength(1);
        expect(suggestions[0].path).toContain('alpha');
      } finally {
        fs.rmSync(tmpDir, { recursive: true });
      }
    });

    it('limits results to 20', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-limit-'));
      for (let i = 0; i < 25; i++) {
        fs.mkdirSync(path.join(tmpDir, `dir-${String(i).padStart(2, '0')}`));
      }

      try {
        const suggestions = await getDirectorySuggestions(tmpDir + '/');
        expect(suggestions.length).toBeLessThanOrEqual(20);
      } finally {
        fs.rmSync(tmpDir, { recursive: true });
      }
    });

    it('skips hidden directories', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-hidden-'));
      fs.mkdirSync(path.join(tmpDir, '.hidden'));
      fs.mkdirSync(path.join(tmpDir, 'visible'));

      try {
        const suggestions = await getDirectorySuggestions(tmpDir + '/');
        expect(suggestions).toHaveLength(1);
        expect(suggestions[0].path).toContain('visible');
      } finally {
        fs.rmSync(tmpDir, { recursive: true });
      }
    });
  });

  // =========================================================================
  // launchInstance
  // =========================================================================

  describe('launchInstance', () => {
    it('returns error when called before initInstances (startup guard)', async () => {
      const result = await launchInstance('/some/path');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/still starting/i);
    });

    it('returns error for non-existent path', async () => {
      const deps = makeDeps();
      initInstances(deps);

      const result = await launchInstance('/nonexistent/path/abc123');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/does not exist/);
    });

    it('returns error for file path (not directory)', async () => {
      const tmpFile = path.join(os.tmpdir(), `tower-test-file-${Date.now()}`);
      fs.writeFileSync(tmpFile, 'test');

      try {
        const deps = makeDeps();
        initInstances(deps);

        const result = await launchInstance(tmpFile);
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/Not a directory/);
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });

    it('returns success for valid directory with codev/', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-launch-'));
      fs.mkdirSync(path.join(tmpDir, 'codev'));

      try {
        const deps = makeDeps();
        initInstances(deps);

        const result = await launchInstance(tmpDir);
        expect(result.success).toBe(true);
        expect(result.adopted).toBeFalsy();
      } finally {
        fs.rmSync(tmpDir, { recursive: true });
      }
    });
  });

  // =========================================================================
  // killTerminalWithShellper
  // =========================================================================

  describe('killTerminalWithShellper', () => {
    it('returns false when module is not initialized', async () => {
      const manager = { getSession: vi.fn(), killSession: vi.fn() } as any;
      const result = await killTerminalWithShellper(manager, 'term-1');
      expect(result).toBe(false);
    });

    it('returns false when session does not exist', async () => {
      const deps = makeDeps();
      initInstances(deps);

      const manager = { getSession: vi.fn().mockReturnValue(null), killSession: vi.fn() } as any;
      const result = await killTerminalWithShellper(manager, 'term-1');
      expect(result).toBe(false);
    });

    it('kills session without shellper for non-shellper sessions', async () => {
      const deps = makeDeps();
      initInstances(deps);

      const manager = {
        getSession: vi.fn().mockReturnValue({ shellperBacked: false }),
        killSession: vi.fn().mockReturnValue(true),
      } as any;

      const result = await killTerminalWithShellper(manager, 'term-1');
      expect(result).toBe(true);
      expect(manager.killSession).toHaveBeenCalledWith('term-1');
    });

    it('calls shellperManager.killSession for shellper-backed sessions', async () => {
      const mockShellperKill = vi.fn();
      const deps = makeDeps({
        shellperManager: { killSession: mockShellperKill } as any,
      });
      initInstances(deps);

      const manager = {
        getSession: vi.fn().mockReturnValue({
          shellperBacked: true,
          shellperSessionId: 'shep-1',
        }),
        killSession: vi.fn().mockReturnValue(true),
      } as any;

      const result = await killTerminalWithShellper(manager, 'term-1');
      expect(result).toBe(true);
      expect(mockShellperKill).toHaveBeenCalledWith('shep-1');
      expect(manager.killSession).toHaveBeenCalledWith('term-1');
    });
  });

  // =========================================================================
  // stopInstance
  // =========================================================================

  describe('stopInstance', () => {
    it('returns error when called before initInstances (startup guard)', async () => {
      const result = await stopInstance('/some/path');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/still starting/i);
      expect(result.stopped).toEqual([]);
    });

    it('returns success with empty stopped when no terminals found', async () => {
      const deps = makeDeps();
      initInstances(deps);

      const result = await stopInstance('/some/path');
      expect(result.success).toBe(true);
      expect(result.stopped).toEqual([]);
      expect(result.error).toMatch(/No terminals found/);
    });

    it('kills all terminals for a workspace', async () => {
      const workspaceTerminals = new Map();
      workspaceTerminals.set('/project/path', {
        architect: 'arch-1',
        builders: new Map([['b1', 'build-1']]),
        shells: new Map([['s1', 'shell-1']]),
      });

      const mockManager = {
        getSession: vi.fn().mockReturnValue({ pid: 42, shellperBacked: false }),
        killSession: vi.fn().mockReturnValue(true),
      };

      const deps = makeDeps({
        workspaceTerminals,
        getTerminalManager: vi.fn().mockReturnValue(mockManager) as any,
      });
      initInstances(deps);

      const result = await stopInstance('/project/path');
      expect(result.success).toBe(true);
      expect(result.stopped).toHaveLength(3); // architect + builder + shell
      expect(mockManager.killSession).toHaveBeenCalledTimes(3);
      expect(deps.deleteWorkspaceTerminalSessions).toHaveBeenCalled();
    });

    it('clears workspace from registry after stop', async () => {
      const workspaceTerminals = new Map();
      workspaceTerminals.set('/project/path', {
        architect: 'arch-1',
        builders: new Map(),
        shells: new Map(),
      });

      const mockManager = {
        getSession: vi.fn().mockReturnValue({ pid: 42, shellperBacked: false }),
        killSession: vi.fn().mockReturnValue(true),
      };

      const deps = makeDeps({
        workspaceTerminals,
        getTerminalManager: vi.fn().mockReturnValue(mockManager) as any,
      });
      initInstances(deps);

      await stopInstance('/project/path');
      expect(workspaceTerminals.has('/project/path')).toBe(false);
    });
  });
});
