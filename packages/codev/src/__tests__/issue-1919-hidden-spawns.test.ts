/**
 * Issue #1919: Tower-side spawns behind the console-window flash.
 *
 * - `getRepoInfo` (run on every Team view / overview refresh) spawns `git`
 *   hidden, and reuses a resolved origin instead of spawning on every call.
 * - `sessionHasLiveHolder` never spawns `ps` on Windows when no detector is given.
 *
 * The static guard over every reachable spawn site is
 * `windows-console-spawn-guard.test.ts`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const childProcess = vi.hoisted(() => ({ execFile: vi.fn(), execFileSync: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: childProcess.execFile, execFileSync: childProcess.execFileSync };
});

import { getRepoInfo, REPO_INFO_TTL_MS, REPO_INFO_NEGATIVE_TTL_MS } from '../lib/team-github.js';
import { sessionHasLiveHolder } from '../agent-farm/servers/tower-utils.js';
import { GitRefResolver, GIT_FETCH_TIMEOUT_MS } from '../commands/porch/artifacts.js';
import { forceHostPlatform } from './helpers/host-platform.js';

type ExecFileCallback = (err: Error | null, result?: { stdout: string; stderr: string }) => void;

function remoteIs(url: string): void {
  childProcess.execFile.mockImplementation((_file: string, _args: string[], _opts: unknown, cb: ExecFileCallback) => {
    cb(null, { stdout: `${url}\n`, stderr: '' });
  });
}

beforeEach(() => {
  childProcess.execFile.mockReset();
  childProcess.execFileSync.mockReset();
  // No clearRepoInfoCache() here: the shared setup (vitest-setup.ts) resets the
  // origin cache before every test, and these tests rely on it.
});

afterEach(() => {
  vi.useRealTimers();
});

describe('getRepoInfo', () => {
  it('reads the origin with git, hidden', async () => {
    remoteIs('git@github.com:cluesmith/codev.git');
    expect(await getRepoInfo('/ws')).toEqual({ owner: 'cluesmith', name: 'codev' });
    expect(childProcess.execFile).toHaveBeenCalledWith(
      'git',
      ['remote', 'get-url', 'origin'],
      { cwd: '/ws', windowsHide: true },
      expect.any(Function),
    );
  });

  it('reuses the origin per workspace within the TTL, then reads it again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    remoteIs('https://github.com/cluesmith/codev.git');
    await getRepoInfo('/ws');
    await getRepoInfo('/ws');
    expect(childProcess.execFile).toHaveBeenCalledTimes(1);

    await getRepoInfo('/other');
    expect(childProcess.execFile).toHaveBeenCalledTimes(2);

    vi.setSystemTime(Date.now() + REPO_INFO_TTL_MS + 1);
    remoteIs('https://github.com/cluesmith/renamed.git');
    expect(await getRepoInfo('/ws')).toEqual({ owner: 'cluesmith', name: 'renamed' });
    expect(childProcess.execFile).toHaveBeenCalledTimes(3);
  });

  it('caches a missing origin only briefly, so an added origin shows up soon', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    childProcess.execFile.mockImplementation((_f: string, _a: string[], _o: unknown, cb: ExecFileCallback) => {
      cb(new Error('No such remote'));
    });
    expect(await getRepoInfo('/ws')).toBeNull();
    expect(await getRepoInfo('/ws')).toBeNull();
    expect(childProcess.execFile).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + REPO_INFO_NEGATIVE_TTL_MS + 1);
    remoteIs('https://github.com/cluesmith/codev.git');
    expect(await getRepoInfo('/ws')).toEqual({ owner: 'cluesmith', name: 'codev' });
    expect(childProcess.execFile).toHaveBeenCalledTimes(2);
  });
});

describe('sessionHasLiveHolder', () => {
  it('Windows: answers "could not determine" without spawning ps', () => {
    forceHostPlatform('win32');
    expect(sessionHasLiveHolder('abc-123-def')).toBe(false);
    expect(childProcess.execFileSync).not.toHaveBeenCalled();
  });

  it('Windows: an injected detector is still used', () => {
    forceHostPlatform('win32');
    expect(sessionHasLiveHolder('abc-123-def', { list: () => ['claude --resume abc-123-def'] })).toBe(true);
  });

  it('POSIX: scans ps as before', () => {
    forceHostPlatform('linux');
    childProcess.execFileSync.mockReturnValue('claude --session-id abc-123-def\n');
    expect(sessionHasLiveHolder('abc-123-def')).toBe(true);
    expect(childProcess.execFileSync).toHaveBeenCalledWith('ps', ['-ww', '-A', '-o', 'args='], expect.any(Object));
  });
});

describe('GitRefResolver fetch', () => {
  it('runs hidden, refuses credential prompts, and is bounded', () => {
    new GitRefResolver('/ws', 'origin/builder/pir-1919');
    expect(childProcess.execFileSync).toHaveBeenCalledWith(
      'git',
      ['fetch', 'origin', 'builder/pir-1919'],
      expect.objectContaining({
        windowsHide: true,
        timeout: GIT_FETCH_TIMEOUT_MS,
        env: expect.objectContaining({ GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }),
      }),
    );
  });

  it('a timed-out fetch only warns', () => {
    childProcess.execFileSync.mockImplementation(() => { throw Object.assign(new Error('spawnSync git ETIMEDOUT'), { stderr: '' }); });
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => new GitRefResolver('/ws', 'origin/main')).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('git fetch origin main'));
    warn.mockRestore();
  });
});
