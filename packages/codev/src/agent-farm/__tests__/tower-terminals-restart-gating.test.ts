/**
 * Issue #1338 — retired-harness architect: restartOnExit gated on reconnect.
 *
 * BLOCKING review fix (upstream maintainer, PR #1342). Both reconnect paths in
 * tower-terminals.ts used to force `ptySession.restartOnExit = true` for EVERY
 * architect. A retired-harness architect resolves `restartOptions` to `undefined`
 * — no auto-restart is configured (SessionManager mirrors this with
 * `restartOnExit: hasRestart`) — so forcing the PTY flag true made the pane hold
 * WebSocket clients in a "restarting…" wait for a process that can never restart.
 *
 * These tests exercise the CONSUMER (tower-terminals reconnect) on BOTH paths —
 * startup `reconcileTerminalSessions` and on-the-fly `getTerminalsForWorkspace` —
 * and assert the PTY flag tracks `restartOptions`. `buildArchitectReconnectRestart-
 * Options` is mocked so its return (undefined = retired, an object = supported) is
 * the controlled input: this isolates the consumer's gating branch from the helper,
 * whose real undefined-return is separately unit-tested in tower-utils.test.ts.
 * (A real-config end-to-end version tripped a vitest module-duplication artifact —
 * the helper's `err instanceof RetiredHarnessError` check and config.ts's throw
 * bound different harness.js instances under this file's vi.mock graph — which does
 * not occur in production's single module graph.)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { EventEmitter } from 'node:events';

// --- Mocks (mirror tower-terminals.test.ts for db + file tabs) ---
const { mockDbPrepare, mockDbRun, mockDbAll, mockBuildRestartOptions } = vi.hoisted(() => ({
  mockDbPrepare: vi.fn(),
  mockDbRun: vi.fn(),
  mockDbAll: vi.fn(),
  mockBuildRestartOptions: vi.fn(),
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
  saveFileTab: vi.fn(),
  deleteFileTab: vi.fn(),
  loadFileTabsForWorkspace: vi.fn(() => new Map()),
}));

// The unit under test: keep every real export (notably normalizeWorkspacePath,
// which tower-terminals also imports) and override only the restart-options helper
// so the consumer's `restartOptions` input is controlled per-test.
vi.mock('../servers/tower-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../servers/tower-utils.js')>();
  return { ...actual, buildArchitectReconnectRestartOptions: mockBuildRestartOptions };
});

import {
  initTerminals,
  shutdownTerminals,
  getWorkspaceTerminals,
  getTerminalManager,
  reconcileTerminalSessions,
  getTerminalsForWorkspace,
  __resetStartupReconcileSettledForTest,
  type TerminalDeps,
} from '../servers/tower-terminals.js';

function makeDeps(overrides: Partial<TerminalDeps> = {}): TerminalDeps {
  return {
    log: vi.fn(),
    shellperManager: null,
    registerKnownWorkspace: vi.fn(),
    getKnownWorkspacePaths: vi.fn(() => []),
    ...overrides,
  };
}

// reconnectSession must return a non-null client to reach attachShellper + the
// restartOnExit assignment. Minimal surface the reconnect path touches:
// EventEmitter + lastDataAt/connected/write/resize + waitForReplay.
function makeReconnectClient(): unknown {
  const client = new EventEmitter() as EventEmitter & Record<string, unknown>;
  Object.defineProperty(client, 'lastDataAt', { get: () => 1 });
  Object.defineProperty(client, 'connected', { get: () => true });
  client.write = () => true;
  client.resize = () => true;
  client.waitForReplay = async () => Buffer.alloc(0);
  client.getReplayData = () => null;
  return client;
}

const WS = '/real/project';
const LIVE_RESTART_OPTIONS = { command: 'claude', args: [], cwd: WS, env: {} };

describe('Issue #1338 — restartOnExit gated on restartOptions (consumer path)', () => {
  const createdLogIds: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    shutdownTerminals();
    getWorkspaceTerminals().clear();
    __resetStartupReconcileSettledForTest();
    mockDbPrepare.mockReturnValue({ run: mockDbRun, all: mockDbAll });
    // Reconcile pre-filter: workspace must exist and not be under /tmp. Config
    // reads (loadConfig) resolve to defaults because the config path returns false.
    vi.spyOn(fs, 'existsSync').mockImplementation((p: fs.PathLike) => String(p) === WS);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    shutdownTerminals();
    getWorkspaceTerminals().clear();
    // createSessionRaw logs under AGENT_FARM_DIR (~/.agent-farm/logs); drop them.
    for (const id of createdLogIds.splice(0)) {
      fs.rmSync(path.join(os.homedir(), '.agent-farm', 'logs', `${id}.log`), { force: true });
    }
  });

  function architectRow(id: string) {
    createdLogIds.push(id);
    return {
      id,
      workspace_path: WS,
      type: 'architect',
      role_id: 'main',
      pid: 5000,
      shellper_socket: `/var/run/shellper-${id}.sock`,
      shellper_pid: 6000,
      shellper_start_time: 1,
      cwd: WS,
      created_at: '2026-01-01T00:00:00.000Z',
    };
  }

  function initWithClient(): void {
    const deps = makeDeps({
      shellperManager: { reconnectSession: vi.fn(async () => makeReconnectClient()) } as any,
    });
    initTerminals(deps);
  }

  describe('startup reconcile (reconcileTerminalSessions)', () => {
    it('retired architect (restartOptions undefined) → restartOnExit stays false', async () => {
      mockBuildRestartOptions.mockReturnValue(undefined);
      initWithClient();
      mockDbAll.mockReturnValue([architectRow('arch-rec-retired')]);

      await reconcileTerminalSessions();

      const session = getTerminalManager().getSession('arch-rec-retired');
      expect(session).toBeDefined();
      expect(session!.restartOnExit).toBe(false);
    });

    it('supported architect (restartOptions defined) → restartOnExit true (happy path preserved)', async () => {
      mockBuildRestartOptions.mockReturnValue(LIVE_RESTART_OPTIONS);
      initWithClient();
      mockDbAll.mockReturnValue([architectRow('arch-rec-live')]);

      await reconcileTerminalSessions();

      const session = getTerminalManager().getSession('arch-rec-live');
      expect(session).toBeDefined();
      expect(session!.restartOnExit).toBe(true);
    });
  });

  describe('on-the-fly reconnect (getTerminalsForWorkspace)', () => {
    it('retired architect (restartOptions undefined) → restartOnExit stays false', async () => {
      mockBuildRestartOptions.mockReturnValue(undefined);
      initWithClient();
      mockDbAll.mockReturnValue([architectRow('arch-otf-retired')]);

      await getTerminalsForWorkspace(WS, 'http://example.test');

      const session = getTerminalManager().getSession('arch-otf-retired');
      expect(session).toBeDefined();
      expect(session!.restartOnExit).toBe(false);
    });

    it('supported architect (restartOptions defined) → restartOnExit true (happy path preserved)', async () => {
      mockBuildRestartOptions.mockReturnValue(LIVE_RESTART_OPTIONS);
      initWithClient();
      mockDbAll.mockReturnValue([architectRow('arch-otf-live')]);

      await getTerminalsForWorkspace(WS, 'http://example.test');

      const session = getTerminalManager().getSession('arch-otf-live');
      expect(session).toBeDefined();
      expect(session!.restartOnExit).toBe(true);
    });
  });
});
