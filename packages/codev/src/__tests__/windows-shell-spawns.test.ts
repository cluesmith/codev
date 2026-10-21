/**
 * Spec 1658 Phase 6: shell-string spawns on native Windows (seam forced to
 * `win32`, `spawn` stubbed). `postSpawn` (runStreaming) and porch checks run
 * through the resolved Git Bash, never `shell: true` (cmd.exe); the executable
 * probe uses the PATHEXT-aware lookup instead of `which`; bare-command spawns
 * go through the shim resolver. POSIX keeps today's spawn arguments.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const childProcess = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: childProcess.spawn };
});

import { runStreaming, commandExists } from '../agent-farm/utils/shell.js';
import { runCheck } from '../commands/porch/checks.js';
import { spawnOnHost } from '../lib/shell-launch.js';
import { setHostPlatformForTests, resetHostPlatformForTests } from '../lib/platform.js';
import { setGitBashForTests } from '../lib/shell-launch.js';

const GIT_BASH = {
  path: 'C:\\Program Files\\Git\\bin\\bash.exe',
  root: 'C:\\Program Files\\Git',
  gitVersion: 'git version 2.47.1.windows.1',
  source: 'install' as const,
};

/** A child that exits 0 on the next tick. */
function fakeChild(): EventEmitter & { stdout: PassThrough; stderr: PassThrough; pid: number } {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), pid: 4242 });
  setImmediate(() => {
    child.stdout.end();
    child.stderr.end();
    child.emit('exit', 0, null);
    child.emit('close', 0);
  });
  return child;
}

beforeEach(() => {
  childProcess.spawn.mockReset();
  childProcess.spawn.mockImplementation(() => fakeChild());
  setGitBashForTests(GIT_BASH);
});

afterEach(() => {
  resetHostPlatformForTests();
  setGitBashForTests(null);
});

describe('postSpawn (runStreaming)', () => {
  it('POSIX: shell: true, exactly as before', async () => {
    setHostPlatformForTests('darwin');
    await runStreaming('cd apps/web && pnpm install', { cwd: '/ws/.builders/x', workspaceRoot: '/ws' });
    expect(childProcess.spawn).toHaveBeenCalledWith('cd apps/web && pnpm install', {
      cwd: '/ws/.builders/x',
      shell: true,
      stdio: 'inherit',
    });
  });

  it('Windows: Git Bash -c in the worktree, hidden', async () => {
    setHostPlatformForTests('win32');
    await runStreaming('cd apps/web && pnpm install', { cwd: 'C:\\ws\\.builders\\x', workspaceRoot: 'C:\\ws' });
    expect(childProcess.spawn).toHaveBeenCalledWith(GIT_BASH.path, ['-c', 'cd apps/web && pnpm install'], {
      cwd: 'C:\\ws\\.builders\\x',
      stdio: 'inherit',
      windowsHide: true,
    });
  });
});

describe('porch shell-string checks', () => {
  const env = { PROJECT_ID: '42', PROJECT_TITLE: 'demo' };

  it('POSIX: shell: true in its own process group', async () => {
    setHostPlatformForTests('linux');
    const result = await runCheck('build', 'npm run build', '/ws', env);
    expect(result.passed).toBe(true);
    const [file, args, opts] = childProcess.spawn.mock.calls[0];
    expect(file).toBe('npm');
    expect(args).toEqual(['run', 'build']);
    expect(opts).toMatchObject({ cwd: '/ws', shell: true, detached: true });
  });

  it('Windows: Git Bash -c with the check string intact, no shell: true', async () => {
    setHostPlatformForTests('win32');
    const result = await runCheck('tests', 'npm test -- --exclude=\'**/e2e/**\'', 'C:\\ws', env);
    expect(result.passed).toBe(true);
    const [file, args, opts] = childProcess.spawn.mock.calls[0];
    expect(file).toBe(GIT_BASH.path);
    expect(args).toEqual(['-c', 'npm test -- --exclude=\'**/e2e/**\'']);
    expect(opts).toMatchObject({ cwd: 'C:\\ws', windowsHide: true });
    expect(opts.shell).toBeUndefined();
    expect(opts.detached).toBeUndefined();
    expect(opts.env).toMatchObject(env);
  });
});

describe('commandExists', () => {
  it('POSIX: spawns which', async () => {
    setHostPlatformForTests('darwin');
    await commandExists('git');
    expect(childProcess.spawn).toHaveBeenCalledWith('which', ['git'], { stdio: 'ignore' });
  });

  it('Windows: a PATHEXT lookup, no which', async () => {
    setHostPlatformForTests('win32');
    const previous = process.env.PATH;
    process.env.PATH = '';
    try {
      expect(await commandExists('git')).toBe(false);
    } finally {
      process.env.PATH = previous;
    }
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });
});

describe('spawnOnHost', () => {
  it('POSIX: spawns exactly as given', () => {
    setHostPlatformForTests('darwin');
    spawnOnHost('afx', ['open', '/x'], { stdio: 'inherit', detached: true });
    expect(childProcess.spawn).toHaveBeenCalledWith('afx', ['open', '/x'], { stdio: 'inherit', detached: true });
  });

  it('Windows: hidden, through the shim resolver (unresolved names pass through)', () => {
    setHostPlatformForTests('win32');
    spawnOnHost('no-such-cli', ['a'], { stdio: 'inherit', env: { PATH: '' } });
    expect(childProcess.spawn).toHaveBeenCalledWith('no-such-cli', ['a'], {
      stdio: 'inherit',
      env: { PATH: '' },
      windowsHide: true,
      windowsVerbatimArguments: false,
    });
  });
});
