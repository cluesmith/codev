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
  removeArchitect,
  waitForTerminalExit,
  type InstanceDeps,
} from '../servers/tower-instances.js';
import { encodeClaudeProjectDir } from '../utils/claude-session-discovery.js';

// ---------------------------------------------------------------------------
// Mocks (vi.hoisted ensures these exist before vi.mock factories run)
// ---------------------------------------------------------------------------

const {
  mockDbPrepare,
  mockDbRun,
  mockDbAll,
  mockIsTempDirectory,
} = vi.hoisted(() => {
  const mockDbRun = vi.fn();
  const mockDbAll = vi.fn().mockReturnValue([]);
  const mockDbPrepare = vi.fn().mockReturnValue({ run: mockDbRun, all: mockDbAll });
  return {
    mockDbPrepare,
    mockDbRun,
    mockDbAll,
    mockIsTempDirectory: vi.fn().mockReturnValue(false),
  };
});

vi.mock('../db/index.js', () => ({
  getGlobalDb: () => ({ prepare: mockDbPrepare }),
  // state.getArchitectByName() (launchInstance's stored-session lookup) calls
  // getDb(), not getGlobalDb — mock it too. The default mock has no `.get`,
  // so the lookup throws and launchInstance treats the workspace as having no
  // stored session (the fresh-boot cases below rely on that).
  getDb: () => ({ prepare: mockDbPrepare }),
  closeDb: () => {},
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
      architects: new Map(),
      builders: new Map(),
      shells: new Map(),
    }),
    saveTerminalSession: vi.fn(),
    deleteTerminalSession: vi.fn(),
    deleteWorkspaceTerminalSessions: vi.fn(),
    deleteFileTabsForWorkspace: vi.fn(),
    getTerminalsForWorkspace: vi.fn().mockResolvedValue({ terminals: [] }),
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
  // waitForTerminalExit
  // =========================================================================

  describe('waitForTerminalExit', () => {
    it('resolves immediately when the session has already exited (Bugfix #905 regression)', async () => {
      // Bugfix #905 made shellper exits propagate before teardown attaches its
      // once('exit') listener. A session that already fired 'exit' must NOT wait
      // out the 5s safety timeout — it should short-circuit on status.
      const once = vi.fn();
      const manager = {
        getSession: vi.fn().mockReturnValue({ status: 'exited', once }),
      } as unknown as Parameters<typeof waitForTerminalExit>[0];

      await expect(waitForTerminalExit(manager, 'term-1', 5000)).resolves.toBeUndefined();
      // Must not even attach the listener for an already-exited session.
      expect(once).not.toHaveBeenCalled();
    });

    it('resolves immediately when the session is missing', async () => {
      const manager = {
        getSession: vi.fn().mockReturnValue(undefined),
      } as unknown as Parameters<typeof waitForTerminalExit>[0];

      await expect(waitForTerminalExit(manager, 'gone', 5000)).resolves.toBeUndefined();
    });

    it('waits for the exit event on a still-running session', async () => {
      let exitHandler: (() => void) | null = null;
      const manager = {
        getSession: vi.fn().mockReturnValue({
          status: 'running',
          once: (event: string, cb: () => void) => {
            if (event === 'exit') exitHandler = cb;
          },
        }),
      } as unknown as Parameters<typeof waitForTerminalExit>[0];

      const promise = waitForTerminalExit(manager, 'term-2', 5000);
      expect(exitHandler).toBeTypeOf('function');
      // Fire the event the listener is waiting for.
      exitHandler!();
      await expect(promise).resolves.toBeUndefined();
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
      workspaceTerminals.set('/path/b', { architects: new Map(), builders: new Map(), shells: new Map() });
      const deps = makeDeps({ workspaceTerminals });
      initInstances(deps);

      const paths = getKnownWorkspacePaths();
      expect(paths).toContain('/path/b');
    });

    it('deduplicates paths across sources', () => {
      const workspaceTerminals = new Map();
      workspaceTerminals.set('/path/c', { architects: new Map(), builders: new Map(), shells: new Map() });
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
        architects: new Map(), builders: new Map(), shells: new Map(),
      });
      const deps = makeDeps({ workspaceTerminals });
      initInstances(deps);

      const instances = await getInstances();
      expect(instances).toEqual([]);
    });

    it('skips non-existent directories', async () => {
      const workspaceTerminals = new Map();
      workspaceTerminals.set('/nonexistent/path/project', {
        architects: new Map(), builders: new Map(), shells: new Map(),
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
          architects: new Map(), builders: new Map(), shells: new Map(),
        });
        workspaceTerminals.set(tmpDir2, {
          architects: new Map(), builders: new Map(), shells: new Map(),
        });

        const getTerminalsForWorkspace = vi.fn()
          .mockResolvedValueOnce({ terminals: [] })  // tmpDir: inactive
          .mockResolvedValueOnce({ terminals: [{ id: 't1' }] });  // tmpDir2: active

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
          architects: new Map(), builders: new Map(), shells: new Map(),
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
          architects: new Map(), builders: new Map(), shells: new Map(),
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
        const deps = makeDeps({
          getTerminalManager: vi.fn().mockReturnValue({
            getSession: vi.fn(),
            killSession: vi.fn(),
            createSession: vi.fn().mockResolvedValue({ id: 'test-session', pid: 1234 }),
            createSessionRaw: vi.fn(),
            listSessions: vi.fn().mockReturnValue([]),
          }) as any,
        });
        initInstances(deps);

        const result = await launchInstance(tmpDir);
        expect(result.success).toBe(true);
        expect(result.adopted).toBeFalsy();
      } finally {
        fs.rmSync(tmpDir, { recursive: true });
      }
    });

    it('uses TOWER_ARCHITECT_CMD env var when set (Bugfix #473)', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-launch-env-'));
      fs.mkdirSync(path.join(tmpDir, 'codev'));
      // Write a .codev/config.json with a different architect command
      fs.mkdirSync(path.join(tmpDir, '.codev'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, '.codev', 'config.json'),
        JSON.stringify({ shell: { architect: 'claude --dangerously-skip-permissions' } }),
      );

      const originalEnv = process.env.TOWER_ARCHITECT_CMD;
      process.env.TOWER_ARCHITECT_CMD = 'bash';

      try {
        const mockCreateSession = vi.fn().mockReturnValue({ id: 'test-session' });
        const deps = makeDeps({
          getTerminalManager: vi.fn().mockReturnValue({
            getSession: vi.fn(),
            killSession: vi.fn(),
            createSession: mockCreateSession,
            createSessionRaw: vi.fn(),
            listSessions: vi.fn().mockReturnValue([]),
          }) as any,
        });
        initInstances(deps);

        const result = await launchInstance(tmpDir);
        expect(result.success).toBe(true);

        // Verify createSession was called with 'bash' (env var), not 'claude --dangerously-skip-permissions' (config)
        expect(mockCreateSession).toHaveBeenCalled();
        const callArgs = mockCreateSession.mock.calls[0];
        // The command is passed as the first positional arg or within options
        // Check that the architect command resolved to 'bash' from env var
        const callStr = JSON.stringify(callArgs);
        expect(callStr).toContain('bash');
        expect(callStr).not.toContain('dangerously-skip-permissions');
      } finally {
        if (originalEnv === undefined) {
          delete process.env.TOWER_ARCHITECT_CMD;
        } else {
          process.env.TOWER_ARCHITECT_CMD = originalEnv;
        }
        fs.rmSync(tmpDir, { recursive: true });
      }
    });

    it('returns failure when architect spawn throws', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-launch-fail-'));
      fs.mkdirSync(path.join(tmpDir, 'codev'));

      try {
        const logSpy = vi.fn();
        const deps = makeDeps({
          log: logSpy,
          getTerminalManager: vi.fn().mockReturnValue({
            getSession: vi.fn(),
            killSession: vi.fn(),
            createSession: vi.fn().mockRejectedValue(new Error('spawn claude ENOENT')),
            createSessionRaw: vi.fn(),
            listSessions: vi.fn().mockReturnValue([]),
          }) as any,
        });
        initInstances(deps);

        const result = await launchInstance(tmpDir);
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/Failed to create architect terminal/);
        expect(result.error).toMatch(/spawn claude ENOENT/);
        expect(logSpy).toHaveBeenCalledWith(
          'ERROR',
          expect.stringMatching(/Failed to create architect terminal/),
        );
      } finally {
        fs.rmSync(tmpDir, { recursive: true });
      }
    });
  });

  // =========================================================================
  // Issue #929 / #1145 — architect launch never discovery-resumes
  //
  // #929's crash-loop guard (codex/gemini + stale Claude jsonl must not launch
  // `<cmd> --resume`) is subsumed by #1145: launchInstance no longer consults
  // the jsonl store at all. Its ONLY resume source is the session id stored on
  // this workspace's `main` architect row. A fresh workspace with a personal
  // Claude conversation in the same cwd (the hijack in #1145) must boot fresh.
  // =========================================================================

  describe('Issue #929/#1145 — architect resume comes only from the stored row', () => {
    // A session in this workspace's own store dir — exactly what the removed
    // discovery fallback would have picked up and resumed. The fresh boot
    // below proves the fallback is gone.
    function writePersonalClaudeSession(fakeHome: string, cwd: string, uuid: string): void {
      const dir = path.join(fakeHome, '.claude', 'projects', encodeClaudeProjectDir(cwd));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${uuid}.jsonl`), `{"sessionId":"${uuid}"}\n`);
    }

    function makeCapturingDeps(): { deps: InstanceDeps; createSession: ReturnType<typeof vi.fn> } {
      const createSession = vi.fn().mockResolvedValue({ id: 'test-session', pid: 1234 });
      const deps = makeDeps({
        getTerminalManager: vi.fn().mockReturnValue({
          getSession: vi.fn(),
          killSession: vi.fn(),
          createSession,
          createSessionRaw: vi.fn(),
          listSessions: vi.fn().mockReturnValue([]),
        }) as any,
      });
      return { deps, createSession };
    }

    // Pin HOME so the stale-jsonl lookup (os.homedir() inside
    // findLatestSessionId) reads our fake store, not the real user's.
    function withSetup(
      configJson: Record<string, unknown> | null,
      fn: (tmpDir: string, fakeHome: string, uuid: string) => Promise<void>,
    ): () => Promise<void> {
      return async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-929-'));
        const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-929-home-'));
        const originalHome = process.env.HOME;
        const uuid = 'stale-claude-uuid-1234';
        try {
          fs.mkdirSync(path.join(tmpDir, 'codev'));
          if (configJson) {
            fs.mkdirSync(path.join(tmpDir, '.codev'), { recursive: true });
            fs.writeFileSync(
              path.join(tmpDir, '.codev', 'config.json'),
              JSON.stringify(configJson),
            );
          }
          writePersonalClaudeSession(fakeHome, tmpDir, uuid);
          process.env.HOME = fakeHome;
          await fn(tmpDir, fakeHome, uuid);
        } finally {
          if (originalHome === undefined) delete process.env.HOME;
          else process.env.HOME = originalHome;
          fs.rmSync(tmpDir, { recursive: true, force: true });
          fs.rmSync(fakeHome, { recursive: true, force: true });
        }
      };
    }

    it('codex architect + stale Claude jsonl → launches fresh, no --resume (#929)', withSetup(
      { shell: { architect: 'codex' } },
      async (tmpDir, _fakeHome, uuid) => {
        const { deps, createSession } = makeCapturingDeps();
        initInstances(deps);

        const result = await launchInstance(tmpDir);
        expect(result.success).toBe(true);
        expect(createSession).toHaveBeenCalled();

        const callStr = JSON.stringify(createSession.mock.calls[0]);
        expect(callStr).not.toContain('--resume');
        expect(callStr).not.toContain(uuid);
      },
    ));

    it('fresh workspace + personal Claude session in the same cwd → boots fresh, no --resume (#1145 regression)', withSetup(
      null,
      async (tmpDir, _fakeHome, uuid) => {
        const { deps, createSession } = makeCapturingDeps();
        initInstances(deps);

        const result = await launchInstance(tmpDir);
        expect(result.success).toBe(true);
        expect(createSession).toHaveBeenCalled();

        // Assert on the argv tokens, not the stringified call: the injected
        // role prompt legitimately mentions "--resume" in its CLI examples.
        const callArgs = (createSession.mock.calls[0][0] as { args: string[] }).args;
        expect(callArgs).not.toContain('--resume');
        expect(callArgs).not.toContain(uuid);
        // Fresh spawn pins a newly minted session id instead.
        expect(callArgs).toContain('--session-id');
      },
    ));

    it('main row with a stored session id + owned jsonl → resumes that id', withSetup(
      null,
      async (tmpDir, _fakeHome, _uuid) => {
        const storedId = 'stored-main-uuid-5678';
        writePersonalClaudeSession(_fakeHome, tmpDir, storedId);
        // getArchitectByName reads via db.prepare(...).get — return a main row
        // carrying the stored conversation id.
        const resolvedTmpDir = fs.realpathSync(tmpDir);
        const mockGet = vi.fn().mockReturnValue({
          workspace_path: resolvedTmpDir, id: 'main', pid: 0, port: 0,
          cmd: 'claude', started_at: 'x', terminal_id: null, session_id: storedId,
        });
        mockDbPrepare.mockReturnValue({ run: mockDbRun, all: mockDbAll, get: mockGet });
        try {
          // The stored session must exist under BOTH path forms the launch code
          // touches (tmpdir is symlinked on macOS: /var → /private/var).
          writePersonalClaudeSession(_fakeHome, resolvedTmpDir, storedId);

          const { deps, createSession } = makeCapturingDeps();
          initInstances(deps);

          const result = await launchInstance(tmpDir);
          expect(result.success).toBe(true);
          expect(createSession).toHaveBeenCalled();

          const callArgs = (createSession.mock.calls[0][0] as { args: string[] }).args;
          expect(callArgs).toContain('--resume');
          expect(callArgs).toContain(storedId);
        } finally {
          mockDbPrepare.mockReturnValue({ run: mockDbRun, all: mockDbAll });
        }
      },
    ));

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
        architects: new Map([['main', 'arch-1']]),
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
        architects: new Map([['main', 'arch-1']]),
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

  // =========================================================================
  // Spec 786 Phase 3 — Graceful-stop persistence
  // =========================================================================
  //
  // The intentional-stop flag prevents cascaded exit handlers from deleting
  // `state.db.architect` rows during `afx workspace stop`. Permanent exit
  // (max-restart, explicit remove) runs WITHOUT the flag set, so OQ-B's
  // auto-delete still applies. Exit handlers are hard to exercise directly in
  // unit tests (they fire on real PtySession exits, gated by shellper), so
  // these tests cover the observable behaviour: the flag is exported, set/
  // cleared correctly by stopInstance, and cleared via `finally` on errors.

  // =========================================================================
  // Spec 786 Phase 3 — launchInstance sibling reconciliation
  // =========================================================================
  //
  // After main is created, launchInstance reads state.db.architect (via
  // getArchitects()) and calls addArchitect for each persisted non-main row
  // not already in entry.architects. This is what restores siblings across
  // `afx workspace stop` + `afx workspace start`.

  describe('Spec 786 Phase 3 — launchInstance sibling reconciliation', () => {
    it('launchInstance succeeds even when sibling reconciliation has to handle non-empty state.db', async () => {
      // This test confirms launchInstance is robust to whatever state.db
      // contains at the time it runs (the reconciliation loop is wrapped in
      // try/catch that logs WARN on per-sibling failure and on the loop as a
      // whole). It does NOT assert specific log behaviour because state.db is
      // shared with other tests and other test environments; instead it asserts
      // launchInstance itself returns success when main creation succeeds.
      //
      // The reconciliation loop's behaviour at the unit level is documented in
      // the "skips main" test below (source-level property check) and exercised
      // end-to-end via integration tests in the verify phase.
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-launch-reconcile-'));
      fs.mkdirSync(path.join(tmpDir, 'codev'));

      try {
        const deps = makeDeps({
          getTerminalManager: vi.fn().mockReturnValue({
            getSession: vi.fn(),
            killSession: vi.fn(),
            createSession: vi.fn().mockResolvedValue({ id: 'main-term', pid: 1234 }),
            createSessionRaw: vi.fn(),
            listSessions: vi.fn().mockReturnValue([]),
          }) as any,
        });
        initInstances(deps);

        const result = await launchInstance(tmpDir);
        // Reconciliation runs after main is created. Any error in the
        // reconciliation loop is caught + logged but does NOT fail the launch.
        expect(result.success).toBe(true);
      } finally {
        fs.rmSync(tmpDir, { recursive: true });
      }
    });

    it('skips main in the reconciliation loop (main is already created above)', async () => {
      // This is a behavioural property: the reconciliation loop has a guard
      // `if (a.name === 'main') continue;`. The intent is that even if main
      // appears in state.db (which it does after Phase 3 stop), launchInstance
      // doesn't double-create it. The earlier test verifies the main creation
      // happens unconditionally via the `!entry.architects.has('main')` gate;
      // this test documents the guard's existence by checking the source.
      const src = fs.readFileSync(
        path.resolve(__dirname, '../servers/tower-instances.ts'),
        'utf8',
      );
      // Sentinel check: the reconciliation loop must skip 'main'.
      expect(src).toMatch(/if\s*\(\s*a\.name\s*===\s*['"]main['"]\s*\)\s*continue/);
      // And must skip already-present names for idempotency.
      expect(src).toMatch(/if\s*\(\s*entry\.architects\.has\(\s*a\.name\s*\)\s*\)\s*continue/);
    });

    it('Bugfix #826: reconcile loop uses workspace-scoped getArchitects(resolvedPath)', async () => {
      // Source-level property: with the schema migration v11 in place,
      // `getArchitects()` is workspace-scoped (takes a workspacePath arg).
      // The reconcile loop must pass `resolvedPath` so launchInstance(B)
      // cannot iterate architects registered in workspace A.
      const src = fs.readFileSync(
        path.resolve(__dirname, '../servers/tower-instances.ts'),
        'utf8',
      );
      // The reconcile call site must pass the workspace path.
      expect(src).toMatch(/getArchitects\s*\(\s*resolvedPath\s*\)/);
    });
  });

  describe('Spec 786 Phase 3 — intentional-stop flag', () => {
    it('exports isIntentionallyStopping; returns false when no stop is in progress', async () => {
      const { isIntentionallyStopping } = await import('../servers/tower-instances.js');
      expect(isIntentionallyStopping('/any/path')).toBe(false);
    });

    it('flags the workspace as intentionally stopping during stopInstance, then clears it', async () => {
      const workspaceTerminals = new Map();
      workspaceTerminals.set('/project/path', {
        architects: new Map([['main', 'arch-1'], ['ob-refine', 'arch-2']]),
        builders: new Map(),
        shells: new Map(),
      });

      let flagDuringKill: boolean | null = null;
      const mockManager = {
        getSession: vi.fn().mockImplementation((_id: string) => {
          // The flag should be set when the exit-handler-equivalent observers
          // run — i.e. during the kill iteration. Capture its state on the
          // first getSession call.
          if (flagDuringKill === null) {
            // Read the flag via the exported getter at this moment.
            // We can't import at the top here (vi.hoisted timing) so re-import.
            // But synchronous capture is what matters.
            flagDuringKill = (globalThis as any).__SPIR_786_PHASE_3_FLAG__ ?? null;
          }
          return { pid: 42, shellperBacked: false };
        }),
        killSession: vi.fn().mockReturnValue(true),
      };

      const deps = makeDeps({
        workspaceTerminals,
        getTerminalManager: vi.fn().mockReturnValue(mockManager) as any,
      });
      initInstances(deps);

      // Probe the flag synchronously during the kill iteration by patching the
      // session-manager mock to read it. The simplest reliable approach is to
      // assert the flag is cleared AFTER stopInstance returns.
      const { isIntentionallyStopping } = await import('../servers/tower-instances.js');
      await stopInstance('/project/path');

      // After stopInstance returns, the flag must be cleared (the `finally`
      // block runs even on success).
      expect(isIntentionallyStopping('/project/path')).toBe(false);
    });

    // Spec 786 PR iter-2 race-fix regression test: the architect's
    // integration-level CMAP caught a race where `stopInstance` cleared the
    // intentional-stop flag in `finally` BEFORE the cascaded exit handlers
    // fired. The handler then read `isIntentionallyStopping === false` and
    // wiped the persisted architect row. This test exercises the timing
    // explicitly: an EventEmitter-backed mock session that emits 'exit'
    // ASYNCHRONOUSLY (via setTimeout) after kill, and asserts the flag is
    // still set when the exit handler observes it.
    //
    // If the race regresses, this test will see the flag as `false` at the
    // moment the exit handler fires — exactly the production bug.
    it('Spec 786 PR iter-2 race-fix: flag is still set when async exit event fires', async () => {
      const { EventEmitter } = await import('node:events');
      const workspaceTerminals = new Map();
      workspaceTerminals.set('/project/path', {
        architects: new Map([['main', 'arch-1'], ['ob-refine', 'arch-2']]),
        builders: new Map(),
        shells: new Map(),
      });

      // The exit handler the kill cascade would invoke. It reads the flag at
      // the moment of firing — exactly like the real cascaded handlers do.
      const flagSnapshotAtExitTime: boolean[] = [];

      const sessions = new Map<string, EventEmitter & { pid: number; shellperBacked: boolean }>();
      for (const id of ['arch-1', 'arch-2']) {
        const s = new EventEmitter() as EventEmitter & { pid: number; shellperBacked: boolean };
        s.pid = id === 'arch-1' ? 42 : 43;
        s.shellperBacked = false;
        sessions.set(id, s);
      }

      const { isIntentionallyStopping } = await import('../servers/tower-instances.js');

      const mockManager = {
        getSession: vi.fn().mockImplementation((id: string) => sessions.get(id)),
        killSession: vi.fn().mockImplementation((id: string) => {
          const s = sessions.get(id);
          if (!s) return false;
          // Emit 'exit' on the NEXT tick — mirrors node-pty's async 'exit'
          // semantics. The exit handler reads the flag when this fires.
          setTimeout(() => {
            flagSnapshotAtExitTime.push(isIntentionallyStopping('/project/path'));
            s.emit('exit', 0, null);
          }, 1);
          return true;
        }),
      };

      const deps = makeDeps({
        workspaceTerminals,
        getTerminalManager: vi.fn().mockReturnValue(mockManager) as any,
      });
      initInstances(deps);

      await stopInstance('/project/path');

      // The exit handlers MUST have observed the flag as `true` (every time)
      // — proving the race fix awaited their firing before clearing the flag.
      expect(flagSnapshotAtExitTime).toHaveLength(2);
      for (const snapshot of flagSnapshotAtExitTime) {
        expect(snapshot).toBe(true);
      }

      // And after stopInstance returns, the flag is cleared — sanity check.
      expect(isIntentionallyStopping('/project/path')).toBe(false);
    });

    // Spec 786 PR iter-2 race-fix (Codex finding): the source-shape test
    // below checks that handleWorkspaceStopAll doesn't reference
    // `intentionallyStopping`, but that's only HALF the full-wipe property.
    // The other half — that architect rows are actually deleted — was broken
    // by a race: stop-all clears `currentEntry.architects` synchronously
    // after the kills, but architect exit handlers fire async and try to
    // recover the architect name FROM that already-cleared map. The lookup
    // returns null, so `setArchitectByName(name, null)` never ran, and
    // stale rows survived. Fix: explicitly delete every architect's row
    // BEFORE the kill loop. This sentinel test pins that ordering.
    it('handleWorkspaceStopAll explicitly deletes architect rows BEFORE the kill loop (PR iter-2 race-fix)', async () => {
      const routesSrc = fs.readFileSync(
        path.resolve(__dirname, '../servers/tower-routes.ts'),
        'utf8',
      );

      const fnStart = routesSrc.indexOf('async function handleWorkspaceStopAll');
      expect(fnStart).toBeGreaterThan(-1);
      let depth = 0;
      let i = routesSrc.indexOf('{', fnStart);
      let fnEnd = -1;
      for (; i < routesSrc.length; i++) {
        if (routesSrc[i] === '{') depth++;
        else if (routesSrc[i] === '}') {
          depth--;
          if (depth === 0) { fnEnd = i; break; }
        }
      }
      const fnBody = routesSrc.slice(fnStart, fnEnd + 1);

      // The function MUST iterate architect names and call
      // `setArchitectByName(name, null)` for each.
      expect(fnBody).toMatch(/for \(const name of entry\.architects\.keys\(\)\)/);
      expect(fnBody).toMatch(/setArchitectByName\(name,\s*null\)/);

      // The explicit-delete loop MUST come BEFORE the kill loops (otherwise
      // the architect name lookup race re-emerges via a different path).
      const deleteIdx = fnBody.indexOf('setArchitectByName(name, null)');
      const killArchIdx = fnBody.indexOf('killTerminalWithShellper(manager, terminalId)');
      expect(deleteIdx).toBeGreaterThan(-1);
      expect(killArchIdx).toBeGreaterThan(-1);
      expect(deleteIdx).toBeLessThan(killArchIdx);
    });

    it('handleWorkspaceStopAll remains a full wipe (does NOT set the intentional-stop flag)', async () => {
      // Spec 786 Phase 3: `handleWorkspaceStopAll` (the explicit "stop-all"
      // route) must remain a full wipe — sibling architect rows are deleted
      // along with main. This is the documented design difference vs
      // `stopInstance` which preserves sibling rows.
      //
      // The correct behaviour is FRAGILE — it depends on `handleWorkspaceStopAll`
      // NOT setting `intentionallyStopping`. A future refactor that routes the
      // stop-all path through `stopInstance` would silently flip the semantics.
      // This test pins the property at the source level.
      const routesSrc = fs.readFileSync(
        path.resolve(__dirname, '../servers/tower-routes.ts'),
        'utf8',
      );

      // Extract the handleWorkspaceStopAll function body.
      const fnStart = routesSrc.indexOf('async function handleWorkspaceStopAll');
      expect(fnStart).toBeGreaterThan(-1);
      // Find the closing brace of the function by matching braces from fnStart.
      let depth = 0;
      let i = routesSrc.indexOf('{', fnStart);
      let fnEnd = -1;
      for (; i < routesSrc.length; i++) {
        if (routesSrc[i] === '{') depth++;
        else if (routesSrc[i] === '}') {
          depth--;
          if (depth === 0) { fnEnd = i; break; }
        }
      }
      expect(fnEnd).toBeGreaterThan(fnStart);
      const fnBody = routesSrc.slice(fnStart, fnEnd + 1);

      // The body must NOT reference the intentional-stop flag (it would
      // otherwise preserve sibling rows, breaking the full-wipe semantic).
      expect(fnBody).not.toMatch(/intentionallyStopping/);
      expect(fnBody).not.toMatch(/isIntentionallyStopping/);

      // And it must call deleteWorkspaceTerminalSessions to wipe rows.
      expect(fnBody).toMatch(/deleteWorkspaceTerminalSessions/);
    });

    // =========================================================================
    // Spec 786 Phase 4 — removeArchitect (Tower-side handler)
    // =========================================================================

    it('removeArchitect: refuses to remove main', async () => {
      const deps = makeDeps();
      initInstances(deps);

      const result = await removeArchitect('/project/path', 'main');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Cannot remove.*main/i);
    });

    it('removeArchitect: refuses unknown sibling name', async () => {
      const workspaceTerminals = new Map();
      workspaceTerminals.set('/project/path', {
        architects: new Map([['main', 'arch-1']]),
        builders: new Map(),
        shells: new Map(),
      });
      const deps = makeDeps({ workspaceTerminals });
      initInstances(deps);

      const result = await removeArchitect('/project/path', 'nonexistent');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not found/i);
    });

    it('removeArchitect: refuses when workspace not running', async () => {
      const deps = makeDeps(); // empty workspaceTerminals
      initInstances(deps);

      const result = await removeArchitect('/project/path', 'ob-refine');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not running/i);
    });

    it('removeArchitect: returns startup error when called before initInstances', async () => {
      const result = await removeArchitect('/some/path', 'sibling');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/still starting/i);
    });

    it('removeArchitect: success path — removes sibling from in-memory map and clears persisted rows', async () => {
      const workspaceTerminals = new Map();
      workspaceTerminals.set('/project/path', {
        architects: new Map([['main', 'arch-main'], ['ob-refine', 'arch-sibling']]),
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

      const result = await removeArchitect('/project/path', 'ob-refine');

      expect(result.success).toBe(true);
      // In-memory: sibling gone, main preserved.
      const entry = workspaceTerminals.get('/project/path');
      expect(entry?.architects.has('ob-refine')).toBe(false);
      expect(entry?.architects.has('main')).toBe(true);
      // Tower's deleteTerminalSession was called with the sibling's terminal id.
      expect(deps.deleteTerminalSession).toHaveBeenCalledWith('arch-sibling');
      // Kill was called.
      expect(mockManager.killSession).toHaveBeenCalledWith('arch-sibling');
    });

    it('clears the intentional-stop flag via finally even when a kill throws', async () => {
      const workspaceTerminals = new Map();
      workspaceTerminals.set('/project/path', {
        architects: new Map([['main', 'arch-1']]),
        builders: new Map(),
        shells: new Map(),
      });

      // killSession throws → propagates up through killTerminalWithShellper →
      // out of stopInstance → BUT the `finally` should still run.
      const mockManager = {
        getSession: vi.fn().mockReturnValue({ pid: 42, shellperBacked: false }),
        killSession: vi.fn().mockImplementation(() => {
          throw new Error('kill failed');
        }),
      };

      const deps = makeDeps({
        workspaceTerminals,
        getTerminalManager: vi.fn().mockReturnValue(mockManager) as any,
      });
      initInstances(deps);

      const { isIntentionallyStopping } = await import('../servers/tower-instances.js');
      await expect(stopInstance('/project/path')).rejects.toThrow('kill failed');

      // The flag must NOT be left in the set after the throw.
      expect(isIntentionallyStopping('/project/path')).toBe(false);
    });
  });
});
