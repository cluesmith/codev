/**
 * Spec 1658 Phase 6: forge concepts on native Windows run through the resolved
 * Git Bash (seam forced to `win32`, child_process stubbed). Every concept of
 * every provider is checked for the expected bash argv, cwd and MSYS opt-out
 * environment; POSIX keeps today's `exec` of the command string.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const childProcess = vi.hoisted(() => ({
  exec: vi.fn(),
  execSync: vi.fn(),
  execFile: vi.fn(),
  execFileSync: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, ...childProcess };
});

import { executeForgeCommand, executeForgeCommandSync, getForgeCommand, getKnownProviders } from '../lib/forge.js';
import { setHostPlatformForTests, resetHostPlatformForTests } from '../lib/platform.js';
import { setGitBashForTests } from '../lib/shell-launch.js';
import { toMsysPath } from '../lib/msys-path.js';

const GIT_BASH = {
  path: 'C:\\Program Files\\Git\\bin\\bash.exe',
  root: 'C:\\Program Files\\Git',
  gitVersion: 'git version 2.47.1.windows.1',
  source: 'install' as const,
};

const CONCEPTS = [
  'issue-view', 'pr-list', 'issue-list', 'issue-search', 'issue-comment', 'pr-exists',
  'recently-closed', 'recently-merged', 'user-identity', 'team-activity',
  'on-it-timestamps', 'pr-create', 'pr-merge', 'pr-search', 'pr-view', 'pr-diff',
  'auth-status', 'repo-archive',
];

const CWD = 'C:\\Users\\dev\\repo';

beforeEach(() => {
  for (const fn of Object.values(childProcess)) {
    fn.mockReset();
  }
  // promisify(execFile) / promisify(exec) resolve with the callback's value.
  childProcess.execFile.mockImplementation((_file: string, _args: string[], _opts: unknown, cb: (err: Error | null, out: { stdout: string; stderr: string }) => void) => {
    cb(null, { stdout: '{"ok":true}', stderr: '' });
  });
  childProcess.exec.mockImplementation((_cmd: string, _opts: unknown, cb: (err: Error | null, out: { stdout: string; stderr: string }) => void) => {
    cb(null, { stdout: '{"ok":true}', stderr: '' });
  });
  childProcess.execFileSync.mockReturnValue('{"ok":true}');
  childProcess.execSync.mockReturnValue('{"ok":true}');
});

afterEach(() => {
  resetHostPlatformForTests();
  setGitBashForTests(null);
});

describe('forge concepts on native Windows', () => {
  beforeEach(() => {
    setHostPlatformForTests('win32');
    setGitBashForTests(GIT_BASH);
  });

  for (const provider of getKnownProviders()) {
    it(`${provider}: every concept runs its script through Git Bash with conversion off`, async () => {
      const forgeConfig = { provider };
      let ran = 0;
      for (const concept of CONCEPTS) {
        const script = getForgeCommand(concept, forgeConfig);
        if (script === null) {
          continue;
        }
        childProcess.execFile.mockClear();
        const data = await executeForgeCommand(concept, { CODEV_ISSUE_ID: '42' }, { cwd: CWD, forgeConfig });
        expect(data).toEqual({ ok: true });
        expect(childProcess.execFile).toHaveBeenCalledTimes(1);
        const [file, args, opts] = childProcess.execFile.mock.calls[0];
        expect(file).toBe(GIT_BASH.path);
        expect(args).toEqual([toMsysPath(script)]);
        expect(opts).toMatchObject({ cwd: CWD, windowsHide: true });
        expect(opts.env).toMatchObject({ MSYS_NO_PATHCONV: '1', MSYS2_ARG_CONV_EXCL: '*', CODEV_ISSUE_ID: '42' });
        ran++;
      }
      expect(ran).toBeGreaterThan(0);
      expect(childProcess.exec).not.toHaveBeenCalled();
    });

    it(`${provider}: the sync path runs the same launcher`, () => {
      const forgeConfig = { provider };
      const script = getForgeCommand('issue-view', forgeConfig);
      expect(script).not.toBeNull();
      executeForgeCommandSync('issue-view', { CODEV_ISSUE_ID: '7' }, { cwd: CWD, forgeConfig });
      const [file, args, opts] = childProcess.execFileSync.mock.calls[0];
      expect(file).toBe(GIT_BASH.path);
      expect(args).toEqual([toMsysPath(script as string)]);
      expect(opts).toMatchObject({ cwd: CWD, windowsHide: true, encoding: 'utf-8' });
      expect(opts.env).toMatchObject({ MSYS_NO_PATHCONV: '1', CODEV_ISSUE_ID: '7' });
      expect(childProcess.execSync).not.toHaveBeenCalled();
    });
  }

  it('a configured shell string runs as bash -c, slash-prefixed arguments intact', async () => {
    const forgeConfig = { 'pr-list': 'gh api /repos/acme/widgets/pulls --jq .' };
    await executeForgeCommand('pr-list', undefined, { cwd: CWD, forgeConfig });
    const [file, args, opts] = childProcess.execFile.mock.calls[0];
    expect(file).toBe(GIT_BASH.path);
    expect(args).toEqual(['-c', 'gh api /repos/acme/widgets/pulls --jq .']);
    expect(opts.env).toMatchObject({ MSYS_NO_PATHCONV: '1', MSYS2_ARG_CONV_EXCL: '*' });
  });

  it('hands a path input to the script in POSIX form', async () => {
    const forgeConfig = { provider: 'github' };
    await executeForgeCommand('repo-archive', { CODEV_OUTPUT_DIR: 'C:\\Users\\dev\\AppData\\Local\\Temp\\x' }, { cwd: CWD, forgeConfig, raw: true });
    const opts = childProcess.execFile.mock.calls[0][2];
    expect(opts.env.CODEV_OUTPUT_DIR).toBe('/c/Users/dev/AppData/Local/Temp/x');
  });

  it('keeps the failure detail when the script exits non-zero', async () => {
    childProcess.execFile.mockImplementation((_f: string, _a: string[], _o: unknown, cb: (err: Error | null) => void) => {
      cb(Object.assign(new Error('Command failed'), { code: 4, stderr: 'HTTP 401' }));
    });
    const { executeForgeCommandDetailed } = await import('../lib/forge.js');
    const result = await executeForgeCommandDetailed('issue-view', undefined, { cwd: CWD, forgeConfig: { provider: 'github' } });
    expect(result.data).toBeNull();
    expect(result.error).toMatchObject({ exitCode: 4, stderr: 'HTTP 401' });
  });
});

describe('forge concepts on POSIX', () => {
  it('runs the command string through exec, with no MSYS variables', async () => {
    setHostPlatformForTests('linux');
    const forgeConfig = { provider: 'github' };
    const script = getForgeCommand('issue-view', forgeConfig);
    await executeForgeCommand('issue-view', { CODEV_ISSUE_ID: '1' }, { cwd: '/repo', forgeConfig });
    expect(childProcess.execFile).not.toHaveBeenCalled();
    const [command, opts] = childProcess.exec.mock.calls[0];
    expect(command).toBe(script);
    expect(opts.cwd).toBe('/repo');
    expect(opts.env.MSYS_NO_PATHCONV).toBeUndefined();
    expect(opts.windowsHide).toBeUndefined();
  });
});
