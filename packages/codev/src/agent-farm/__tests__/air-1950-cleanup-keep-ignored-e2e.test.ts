/**
 * Issue #1950 — `afx cleanup --keep-ignored` end to end through `cleanup()`, with the real keep
 * module, a real git repository as the worktree, and a real `cleanup.keepIgnored` in the
 * workspace's `.codev/config.json`.
 *
 * Faked: Tower, the state rows, and the shell commands that would remove the worktree and branch
 * (recorded, not run), so the test can show the copy lands before removal is attempted.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Builder, Config } from '../types.js';

const paths = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'air-1950-keep-e2e-')));
  return { root, farm: path.join(root, 'agent-farm') };
});

vi.mock('../db/index.js', () => {
  const db = { prepare: () => ({ run: () => ({ changes: 0 }), all: () => [] }) };
  return { getDb: () => db, getGlobalDb: () => db, closeDb: () => {}, closeGlobalDb: () => {} };
});
vi.mock('../db/mailbox.js', () => ({ dismissHeldForAgent: () => 0 }));
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual, // execFileSync stays real: the keep module asks git which files to keep
    // `ps` (cmd, args, cb) is faked; the dirty notice's `git status` (cmd, args, options, cb) runs for real.
    execFile: vi.fn((c: string, a: string[], optionsOrCb: unknown, maybeCb?: unknown) => {
      if (typeof optionsOrCb !== 'function') {
        return (actual.execFile as unknown as (...args: unknown[]) => unknown)(c, a, optionsOrCb, maybeCb);
      }
      (optionsOrCb as (e: Error | null, out: string) => void)(null, '');
      return {};
    }),
  };
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

const logged: string[] = [];
vi.mock('../utils/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/logger.js')>();
  const capture = Object.fromEntries(
    Object.keys(actual.logger).map((k) => [k, vi.fn((msg?: unknown) => { logged.push(String(msg)); })]),
  );
  return { ...actual, logger: capture, fatal: (msg: string) => { throw new Error(msg); } };
});

const steps: string[] = [];
vi.mock('../utils/shell.js', () => ({
  run: async (command: string) => { steps.push(command); return { stdout: '', stderr: '' }; },
}));
vi.mock('../lib/tower-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/tower-client.js')>()),
  AGENT_FARM_DIR: paths.farm,
  TowerClient: class {
    async killTerminal() { return true; }
    async refreshOverview() {}
  },
}));
vi.mock('../utils/file-tabs.js', () => ({ deleteFileTabsByPathPrefix: () => 0 }));
vi.mock('../../lib/forge.js', () => ({ executeForgeCommand: vi.fn(async () => []) }));

const { cleanup } = await import('../commands/cleanup.js');

const workspaceRoot = join(paths.root, 'my-repo');
const worktree = join(workspaceRoot, '.builders', 'bugfix-7');
const keptDir = join(paths.farm, 'kept', basename(workspaceRoot), 'bugfix-7');

function write(rel: string, content = rel): void {
  mkdirSync(dirname(join(worktree, rel)), { recursive: true });
  writeFileSync(join(worktree, rel), content);
}
const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: worktree, stdio: 'pipe' });

const builder: Builder = {
  id: 'bugfix-7', name: 'Bugfix #7', status: 'complete', phase: 'done',
  worktree, branch: 'builder/bugfix-7', type: 'bugfix', issueNumber: 7,
};

beforeAll(() => {
  mkdirSync(join(workspaceRoot, '.codev'), { recursive: true });
  writeFileSync(join(workspaceRoot, '.codev', 'config.json'), JSON.stringify({ cleanup: { keepIgnored: ['tmp/**', 'logs/**'] } }));
  mkdirSync(worktree, { recursive: true });
  git('init', '-q');
  write('.gitignore', 'tmp/\nlogs/\nnode_modules/\n.env\ncodev/projects/\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  write('notes.md', 'my notes');
  write('tmp/review/out.md', 'review output');
  write('logs/run.log', 'log');
  write('tmp/node_modules/pkg/index.js');
  write('node_modules/pkg/index.js');
  write('codev/projects/7-x/status.yaml'); // on the default list, not on this workspace's list
  write('.env', 'SECRET=1');

  mockGetConfig.mockReturnValue({
    workspaceRoot,
    codevDir: join(workspaceRoot, 'codev'),
    buildersDir: join(workspaceRoot, '.builders'),
    stateDir: join(workspaceRoot, '.codev'),
    templatesDir: join(workspaceRoot, 'templates'),
    serversDir: join(workspaceRoot, 'servers'),
    bundledRolesDir: join(workspaceRoot, 'roles'),
    terminalBackend: 'node-pty',
  });
  mockLoadState.mockReturnValue({ builders: [builder], architects: [], utils: [], annotations: [] });
});

afterAll(() => rmSync(paths.root, { recursive: true, force: true }));

describe('afx cleanup --keep-ignored, end to end (#1950)', () => {
  it.skipIf(process.platform === 'win32')('copies with the configured keep list, then goes on to remove', async () => {
    await cleanup({ issue: 7, keepIgnored: true });

    expect(readFileSync(join(keptDir, 'notes.md'), 'utf-8')).toBe('my notes');
    expect(readFileSync(join(keptDir, 'tmp/review/out.md'), 'utf-8')).toBe('review output');
    expect(readFileSync(join(keptDir, 'logs/run.log'), 'utf-8')).toBe('log');
    for (const never of ['.env', 'node_modules', 'tmp/node_modules', 'codev/projects', '.gitignore']) {
      expect(existsSync(join(keptDir, never)), never).toBe(false);
    }
    expect(logged).toContain(`Kept 3 file(s) in ${keptDir}`);
    expect(logged).toContain('Not kept (dependency or build output): 1 file(s)');
    expect(logged).toContain('Worktree has uncommitted changes: 1 uncommitted file(s)'); // notes.md, read by real git status
    expect(steps).toContain(`git worktree remove "${worktree}" --force`);
    expect(mockRemoveBuilder).toHaveBeenCalledWith('bugfix-7', workspaceRoot);
  });

  it.skipIf(process.platform === 'win32')('a second cleanup refuses: the kept folder already exists', async () => {
    steps.length = 0;
    mockRemoveBuilder.mockClear();
    await expect(cleanup({ issue: 7, keepIgnored: true })).rejects.toThrow(`kept folder already exists: ${keptDir}`);
    expect(steps).toEqual([]);
    expect(mockRemoveBuilder).not.toHaveBeenCalled();
    expect(realpathSync(keptDir)).toBe(keptDir);
  });
});
