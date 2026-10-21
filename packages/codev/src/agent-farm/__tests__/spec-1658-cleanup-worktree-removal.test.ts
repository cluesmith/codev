/**
 * Spec 1658 Phase 7: how `afx cleanup` removes an ephemeral builder's worktree.
 *
 * - POSIX: `git worktree remove --force`, as before Windows support.
 * - Seam `win32`: the shellper tree is killed first, then the directory is
 *   removed by `removeWorktreeDirectory` (no link traversal, busy retries) and
 *   the worktree entry is pruned BEFORE the branch is deleted (git refuses to
 *   delete a branch a registered worktree still has checked out). A removal
 *   failure ends cleanup naming the blocking path, before the branch and
 *   builder state are touched.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Builder, Config } from '../types.js';
import { setHostPlatformForTests, resetHostPlatformForTests } from '../../lib/platform.js';

vi.mock('../db/index.js', () => {
  const db = { prepare: () => ({ run: () => ({ changes: 0 }), all: () => [] }) };
  return { getDb: () => db, getGlobalDb: () => db, closeDb: () => {}, closeGlobalDb: () => {} };
});
vi.mock('../db/mailbox.js', () => ({ dismissHeldForAgent: () => 0 }));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, execFile: vi.fn() };
});

const mockLoadState = vi.fn();
const mockRemoveBuilder = vi.fn();
vi.mock('../state.js', () => ({
  loadState: (ws: string) => mockLoadState(ws),
  removeBuilder: (id: string, ws?: string) => mockRemoveBuilder(id, ws),
}));

const mockGetConfig = vi.fn<() => Config>();
vi.mock('../utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/index.js')>()),
  getConfig: () => mockGetConfig(),
}));

vi.mock('../utils/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/logger.js')>();
  const silent = Object.fromEntries(Object.keys(actual.logger).map((k) => [k, vi.fn()]));
  return {
    ...actual,
    logger: silent,
    fatal: (msg: string) => {
      throw new Error(msg);
    },
  };
});

const steps: string[] = [];
const mockRun = vi.fn(async (command: string) => {
  steps.push(command);
  return { stdout: '', stderr: '' };
});
vi.mock('../utils/shell.js', () => ({ run: (command: string) => mockRun(command) }));

vi.mock('../lib/tower-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/tower-client.js')>()),
  TowerClient: class {
    async killTerminal() {
      return false;
    }
    async refreshOverview() {}
  },
}));
vi.mock('../utils/file-tabs.js', () => ({ deleteFileTabsByPathPrefix: () => 0 }));
vi.mock('../../lib/forge.js', () => ({ executeForgeCommand: vi.fn(async () => []) }));
vi.mock('../servers/process-census.js', () => ({
  listProcessCensus: vi.fn(async () => {
    steps.push('census');
    return [];
  }),
}));

const mockRemoveWorktreeDirectory = vi.fn(async (path: string) => {
  steps.push(`removeWorktreeDirectory ${path}`);
});
vi.mock('../lib/worktree-links.js', () => ({
  removeWorktreeDirectory: (path: string) => mockRemoveWorktreeDirectory(path),
}));

const { cleanup } = await import('../commands/cleanup.js');

const workspaceRoot = mkdtempSync(join(tmpdir(), 'spec-1658-cleanup-'));
const worktree = join(workspaceRoot, '.builders', 'bugfix-7');

afterAll(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

function config(): Config {
  return {
    workspaceRoot,
    codevDir: join(workspaceRoot, 'codev'),
    buildersDir: join(workspaceRoot, '.builders'),
    stateDir: join(workspaceRoot, '.codev'),
    templatesDir: join(workspaceRoot, 'templates'),
    serversDir: join(workspaceRoot, 'servers'),
    bundledRolesDir: join(workspaceRoot, 'roles'),
    terminalBackend: 'node-pty',
  };
}

const bugfixBuilder: Builder = {
  id: 'bugfix-7',
  name: 'Bugfix #7',
  status: 'complete',
  phase: 'done',
  worktree,
  branch: 'builder/bugfix-7',
  type: 'bugfix',
  issueNumber: 7,
};

describe('Spec 1658: cleanup removes an ephemeral worktree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    steps.length = 0;
    mkdirSync(worktree, { recursive: true });
    mockGetConfig.mockReturnValue(config());
    mockLoadState.mockReturnValue({ builders: [bugfixBuilder], architects: [], utils: [], annotations: [] });
    vi.mocked(execFile).mockImplementation(((_cmd: string, _args: string[], cb: (e: Error | null, out: string) => void) => {
      steps.push('ps');
      cb(null, '');
      return {} as ReturnType<typeof execFile>;
    }) as unknown as typeof execFile);
  });

  afterEach(() => {
    resetHostPlatformForTests();
  });

  it.skipIf(process.platform === 'win32')('POSIX: runs git worktree remove --force, unchanged', async () => {
    await cleanup({ issue: 7 });
    expect(steps).toContain(`git worktree remove "${worktree}" --force`);
    expect(mockRemoveWorktreeDirectory).not.toHaveBeenCalled();
  });

  it('Windows: kills the session tree, removes without git, prunes, then deletes the branch', async () => {
    setHostPlatformForTests('win32');
    await cleanup({ issue: 7 });

    expect(steps.some((s) => s.startsWith('git worktree remove'))).toBe(false);
    const census = steps.indexOf('census');
    const removal = steps.indexOf(`removeWorktreeDirectory ${worktree}`);
    const prune = steps.indexOf('git worktree prune');
    const branch = steps.indexOf('git branch -D "builder/bugfix-7"');
    expect(census).toBeGreaterThanOrEqual(0);
    expect(removal).toBeGreaterThan(census);
    expect(prune).toBeGreaterThan(removal);
    expect(branch).toBeGreaterThan(prune);
  });

  it('Windows: a failed removal names the blocking path and stops before the branch and state', async () => {
    setHostPlatformForTests('win32');
    mockRemoveWorktreeDirectory.mockRejectedValueOnce(
      new Error(`Could not remove ${worktree}\\node_modules\\x.node (EBUSY): a process may still have it open`),
    );
    await expect(cleanup({ issue: 7 })).rejects.toThrow('node_modules\\x.node (EBUSY)');
    expect(steps.some((s) => s.startsWith('git branch -D'))).toBe(false);
    expect(steps).not.toContain('git worktree prune');
    expect(mockRemoveBuilder).not.toHaveBeenCalled();
  });
});
