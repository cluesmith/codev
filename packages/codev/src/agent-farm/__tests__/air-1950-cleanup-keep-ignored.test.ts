/**
 * Issue #1950 — `afx cleanup --keep-ignored` runs before anything is removed, and a failure
 * stops cleanup with the worktree, the branch and the builder row intact.
 *
 * The copy itself is covered against a real repository in air-1950-keep-files.test.ts; here
 * the keep module is replaced so each case can fail it on purpose and watch what cleanup does.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Builder, Config } from '../types.js';

vi.mock('../db/index.js', () => {
  const db = { prepare: () => ({ run: () => ({ changes: 0 }), all: () => [] }) };
  return { getDb: () => db, getGlobalDb: () => db, closeDb: () => {}, closeGlobalDb: () => {} };
});
vi.mock('../db/mailbox.js', () => ({ dismissHeldForAgent: () => 0 }));
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execFile: vi.fn((_c: string, _a: string[], cb: (e: Error | null, out: string) => void) => { cb(null, ''); return {}; }),
  };
});

const mockRemoveBuilder = vi.fn();
const mockLoadState = vi.fn();
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
  return { ...actual, logger: silent, fatal: (msg: string) => { throw new Error(msg); } };
});

const steps: string[] = [];
vi.mock('../utils/shell.js', () => ({
  run: async (command: string) => { steps.push(command); return { stdout: '', stderr: '' }; },
}));
vi.mock('../lib/tower-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/tower-client.js')>()),
  TowerClient: class {
    async killTerminal() { steps.push('kill-terminal'); return true; }
    async refreshOverview() {}
  },
}));
vi.mock('../utils/file-tabs.js', () => ({ deleteFileTabsByPathPrefix: () => 0 }));
vi.mock('../../lib/forge.js', () => ({ executeForgeCommand: vi.fn(async () => []) }));

const root = mkdtempSync(join(tmpdir(), 'air-1950-cleanup-'));
const keptDir = join(root, 'kept', 'ws', 'bugfix-7');
const mockKeepFiles = vi.fn();
vi.mock('../lib/keep-files.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/keep-files.js')>()),
  keptDirFor: () => keptDir,
  listKeepCandidates: () => ['notes.md'],
  keepFiles: (...args: unknown[]) => mockKeepFiles(...args),
}));

const { cleanup } = await import('../commands/cleanup.js');

const workspaceRoot = join(root, 'ws');
const worktree = join(workspaceRoot, '.builders', 'bugfix-7');

afterAll(() => rmSync(root, { recursive: true, force: true }));

const config = (): Config => ({
  workspaceRoot,
  codevDir: join(workspaceRoot, 'codev'),
  buildersDir: join(workspaceRoot, '.builders'),
  stateDir: join(workspaceRoot, '.codev'),
  templatesDir: join(workspaceRoot, 'templates'),
  serversDir: join(workspaceRoot, 'servers'),
  bundledRolesDir: join(workspaceRoot, 'roles'),
  terminalBackend: 'node-pty',
});

const bugfixBuilder: Builder = {
  id: 'bugfix-7', name: 'Bugfix #7', status: 'complete', phase: 'done',
  worktree, branch: 'builder/bugfix-7', type: 'bugfix', issueNumber: 7, terminalId: 'term-1',
};

const removed = () => ({
  worktree: steps.some((s) => s.startsWith('git worktree remove')),
  branch: steps.some((s) => s.startsWith('git branch -D')),
  row: mockRemoveBuilder.mock.calls.length > 0,
});

describe('afx cleanup --keep-ignored (#1950)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    steps.length = 0;
    rmSync(keptDir, { recursive: true, force: true });
    mkdirSync(worktree, { recursive: true });
    mockGetConfig.mockReturnValue(config());
    mockLoadState.mockReturnValue({ builders: [bugfixBuilder], architects: [], utils: [], annotations: [] });
    mockKeepFiles.mockImplementation(async () => {
      steps.push('keep');
      return { copied: 1, skippedSymlinks: [] };
    });
  });

  it.skipIf(process.platform === 'win32')('keeps the files before the worktree is removed', async () => {
    await cleanup({ issue: 7, keepIgnored: true });
    expect(mockKeepFiles).toHaveBeenCalledWith(worktree, keptDir, ['notes.md']);
    const keep = steps.indexOf('keep');
    expect(keep).toBeGreaterThan(steps.indexOf('kill-terminal'));
    expect(keep).toBeLessThan(steps.findIndex((s) => s.startsWith('git worktree remove')));
    expect(removed()).toEqual({ worktree: true, branch: true, row: true });
  });

  it('a checksum mismatch aborts before the worktree, branch or row is removed', async () => {
    mockKeepFiles.mockRejectedValue(new Error('checksum mismatch after copying notes.md'));
    await expect(cleanup({ issue: 7, keepIgnored: true })).rejects.toThrow(
      /checksum mismatch after copying notes\.md\. Nothing was removed/,
    );
    expect(removed()).toEqual({ worktree: false, branch: false, row: false });
  });

  it('an existing kept folder aborts before anything is touched, the session included', async () => {
    mkdirSync(keptDir, { recursive: true });
    await expect(cleanup({ issue: 7, keepIgnored: true })).rejects.toThrow(`kept folder already exists: ${keptDir}`);
    expect(steps).toEqual([]);
    expect(mockKeepFiles).not.toHaveBeenCalled();
    expect(removed()).toEqual({ worktree: false, branch: false, row: false });
  });

  it('keeps nothing without the flag', async () => {
    await cleanup({ issue: 7 });
    expect(mockKeepFiles).not.toHaveBeenCalled();
  });

  it('keeps nothing when the worktree is preserved (non-ephemeral builder)', async () => {
    mockLoadState.mockReturnValue({
      builders: [{ ...bugfixBuilder, id: 'spir-7', type: 'spec' }], architects: [], utils: [], annotations: [],
    });
    await cleanup({ project: 'spir-7', keepIgnored: true });
    expect(mockKeepFiles).not.toHaveBeenCalled();
    expect(removed().worktree).toBe(false);
  });
});
