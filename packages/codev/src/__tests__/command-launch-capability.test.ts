/**
 * Spec 1658, Amendment 2 phase A2-1: the command launch capability.
 *
 * The contract, checked on both implementations with child_process stubbed:
 * the POSIX implementation makes exactly the calls the call sites made before
 * the refactor (`shell: true`, `/bin/sh -lc`, `/bin/bash`, `exec`, the caller's
 * own `which` probe), and the Windows implementation routes through the
 * resolved Git Bash and the shim resolver. The accessor follows the seam.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const childProcess = vi.hoisted(() => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
  exec: vi.fn(),
  execSync: vi.fn(),
  execFile: vi.fn(),
  execFileSync: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, ...childProcess };
});

import { commandLaunch } from '../lib/platform/command-launch.js';
import { posixCommandLaunch } from '../lib/platform/command-launch.posix.js';
import { windowsCommandLaunch } from '../lib/platform/command-launch.windows.js';
import { setGitBashForTests } from '../lib/shell-launch.js';
import { useHostPlatform } from './helpers/host-platform.js';
import { toMsysPath } from '../lib/msys-path.js';

const GIT_BASH = {
  path: 'C:\\Program Files\\Git\\bin\\bash.exe',
  root: 'C:\\Program Files\\Git',
  gitVersion: 'git version 2.47.1.windows.1',
  source: 'install' as const,
};

beforeEach(() => {
  for (const fn of Object.values(childProcess)) {
    fn.mockReset();
  }
  childProcess.exec.mockImplementation((_cmd: string, _opts: unknown, cb: (err: Error | null, out: { stdout: string; stderr: string }) => void) => {
    cb(null, { stdout: 'posix-out', stderr: '' });
  });
  childProcess.execFile.mockImplementation((_file: string, _args: string[], _opts: unknown, cb: (err: Error | null, out: { stdout: string; stderr: string }) => void) => {
    cb(null, { stdout: 'windows-out', stderr: '' });
  });
  setGitBashForTests(GIT_BASH);
});

afterEach(() => {
  setGitBashForTests(null);
});

describe('commandLaunch() follows the host seam', () => {
  describe('on darwin', () => {
    useHostPlatform('darwin');
    it('returns the POSIX implementation', () => {
      expect(commandLaunch()).toBe(posixCommandLaunch);
    });
  });
  describe('on win32', () => {
    useHostPlatform('win32');
    it('returns the Windows implementation', () => {
      expect(commandLaunch()).toBe(windowsCommandLaunch);
    });
  });
});

describe('POSIX implementation: the pre-refactor calls, verbatim', () => {
  it('spawnShellString runs the string under shell: true with the caller options', () => {
    posixCommandLaunch.spawnShellString('npm install', { cwd: '/w', stdio: 'inherit' }, { workspaceRoot: '/w' });
    expect(childProcess.spawn).toHaveBeenCalledWith('npm install', { cwd: '/w', stdio: 'inherit', shell: true });
  });

  it('spawnShellString keeps porch runCheck form: detached, whitespace re-joined', () => {
    posixCommandLaunch.spawnShellString('npm  run   "a  b"', { cwd: '/w' }, { posixDetached: true, posixCollapseWhitespace: true });
    expect(childProcess.spawn).toHaveBeenCalledWith('npm run "a b"', { cwd: '/w', shell: true, detached: true });
  });

  it('execShellString and execShellStringSync exec the string as given', async () => {
    childProcess.execSync.mockReturnValue('sync-out');
    const options = { cwd: '/w', env: { A: '1' }, timeout: 30_000, maxBuffer: 10, workspaceRoot: '/w', msysPathEnvKeys: ['A'] };
    await expect(posixCommandLaunch.execShellString('gh pr list', options)).resolves.toBe('posix-out');
    expect(childProcess.exec.mock.calls[0][0]).toBe('gh pr list');
    expect(childProcess.exec.mock.calls[0][1]).toEqual({ cwd: '/w', env: { A: '1' }, timeout: 30_000, maxBuffer: 10 });
    expect(posixCommandLaunch.execShellStringSync('gh pr list', options)).toBe('sync-out');
    expect(childProcess.execSync).toHaveBeenCalledWith('gh pr list', {
      cwd: '/w', env: { A: '1' }, encoding: 'utf-8', timeout: 30_000, maxBuffer: 10, stdio: ['pipe', 'pipe', 'pipe'],
    });
  });

  it('argv forms: the caller-named shell, /bin/bash for scripts', () => {
    expect(posixCommandLaunch.shellStringArgv('npm run dev', { command: '/bin/sh', flag: '-lc' })).toEqual({ command: '/bin/sh', args: ['-lc', 'npm run dev'] });
    expect(posixCommandLaunch.shellStringArgv('ls', { command: '/bin/bash', flag: '-c' })).toEqual({ command: '/bin/bash', args: ['-c', 'ls'] });
    expect(posixCommandLaunch.scriptFileArgv('/w/.builders/x/start.sh', [])).toEqual({ command: '/bin/bash', args: ['/w/.builders/x/start.sh'] });
  });

  it('spawn and spawnSync pass through unchanged', () => {
    posixCommandLaunch.spawn('afx', ['open', '/x'], { stdio: 'inherit' });
    expect(childProcess.spawn).toHaveBeenCalledWith('afx', ['open', '/x'], { stdio: 'inherit' });
    posixCommandLaunch.spawnSync('codex', ['--version'], { encoding: 'utf-8' });
    expect(childProcess.spawnSync).toHaveBeenCalledWith('codex', ['--version'], { encoding: 'utf-8' });
  });

  it('commandExists runs the caller probe', async () => {
    const probe = vi.fn(() => true);
    expect(posixCommandLaunch.commandExists('claude', probe)).toBe(true);
    expect(probe).toHaveBeenCalledOnce();
    await expect(posixCommandLaunch.commandExistsAsync('claude', async () => false)).resolves.toBe(false);
  });

  it('launch script pieces are the native path and nothing extra', () => {
    expect(posixCommandLaunch.launchScriptPath('/w/x')).toBe('/w/x');
    expect(posixCommandLaunch.launchScriptExports('/w')).toBe('');
    expect(posixCommandLaunch.sessionIdMintFallback()).toBeUndefined();
  });

  it('terminalProfile and workspaceShell use $SHELL and never read the configured shell', () => {
    const configured = vi.fn(() => 'zsh');
    const shell = posixCommandLaunch.workspaceShell('/w', configured);
    expect(shell.args).toEqual([]);
    expect(configured).not.toHaveBeenCalled();
    const profile = posixCommandLaunch.terminalProfile('/bin/zsh');
    expect(profile.shell).toBe('/bin/zsh');
    expect(profile.baseEnv.SHELL).toBe('/bin/zsh');
    expect(profile.baseEnv.TERM).toBe('xterm-256color');
  });
});

describe('Windows implementation: Git Bash and the shim resolver', () => {
  useHostPlatform('win32');

  it('spawnShellString runs Git Bash -c, hidden, never detached', () => {
    windowsCommandLaunch.spawnShellString('npm test', { cwd: 'C:\\w', stdio: 'inherit' }, { workspaceRoot: 'C:\\w', posixDetached: true, posixCollapseWhitespace: true });
    expect(childProcess.spawn).toHaveBeenCalledWith(GIT_BASH.path, ['-c', 'npm test'], { cwd: 'C:\\w', stdio: 'inherit', windowsHide: true });
  });

  it('execShellString: a shell string runs under -c with MSYS conversion off and path inputs in POSIX form', async () => {
    const options = { cwd: 'C:\\w', env: { CODEV_OUTPUT_DIR: 'C:\\out', B: '2' }, timeout: 30_000, maxBuffer: 10, workspaceRoot: 'C:\\w', msysPathEnvKeys: ['CODEV_OUTPUT_DIR'] };
    await expect(windowsCommandLaunch.execShellString('gh pr list', options)).resolves.toBe('windows-out');
    const [file, args, opts] = childProcess.execFile.mock.calls[0];
    expect(file).toBe(GIT_BASH.path);
    expect(args).toEqual(['-c', 'gh pr list']);
    expect(opts.env.CODEV_OUTPUT_DIR).toBe('/c/out');
    expect(opts.env.B).toBe('2');
    expect(opts.env.MSYS_NO_PATHCONV).toBe('1');
    expect(opts.windowsHide).toBe(true);
  });

  it('execShellString: a bare path to an existing .sh file runs as a script, its path in POSIX form', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spec1658-a21-'));
    try {
      const script = join(dir, 'issue-view.sh');
      writeFileSync(script, '#!/bin/bash\n');
      await windowsCommandLaunch.execShellString(script, { cwd: dir, env: {}, timeout: 30_000, maxBuffer: 10, workspaceRoot: dir });
      const [file, args] = childProcess.execFile.mock.calls[0];
      expect(file).toBe(GIT_BASH.path);
      expect(args).toEqual([toMsysPath(script)]);
      expect(args[0]).not.toBe('-c');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('execShellStringSync: Git Bash -c, utf-8, piped, hidden, MSYS conversion off', () => {
    childProcess.execFileSync.mockReturnValue('sync-windows');
    const out = windowsCommandLaunch.execShellStringSync('gh issue list', { cwd: 'C:\\w', env: { CODEV_OUTPUT_DIR: 'C:\\out' }, timeout: 30_000, maxBuffer: 10, workspaceRoot: 'C:\\w', msysPathEnvKeys: ['CODEV_OUTPUT_DIR'] });
    expect(out).toBe('sync-windows');
    const [file, args, opts] = childProcess.execFileSync.mock.calls[0];
    expect(file).toBe(GIT_BASH.path);
    expect(args).toEqual(['-c', 'gh issue list']);
    expect(opts).toMatchObject({ cwd: 'C:\\w', encoding: 'utf-8', timeout: 30_000, maxBuffer: 10, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    expect(opts.env.CODEV_OUTPUT_DIR).toBe('/c/out');
    expect(opts.env.MSYS_NO_PATHCONV).toBe('1');
  });

  it('terminalProfile: Windows PowerShell by default, the Windows base variables, no POSIX SHELL', () => {
    const profile = windowsCommandLaunch.terminalProfile(undefined);
    expect(profile.shell.toLowerCase()).toContain('powershell.exe');
    expect(profile.baseEnv.TERM).toBe('xterm-256color');
    expect(profile.baseEnv.SHELL).toBeUndefined();
    expect(windowsCommandLaunch.terminalProfile('pwsh').shell).toBe('pwsh');
  });

  it('argv forms: Git Bash -c (no login shell) and MSYS script paths', () => {
    expect(windowsCommandLaunch.shellStringArgv('npm run dev', { command: '/bin/sh', flag: '-lc' }, 'C:\\w')).toEqual({ command: GIT_BASH.path, args: ['-c', 'npm run dev'] });
    expect(windowsCommandLaunch.scriptFileArgv('C:\\w\\start.sh', [], 'C:\\w')).toEqual({ command: GIT_BASH.path, args: ['/c/w/start.sh'] });
  });

  it('commandExists never runs the POSIX probe', () => {
    const probe = vi.fn(() => true);
    windowsCommandLaunch.commandExists('definitely-not-a-real-command-1658', probe);
    expect(probe).not.toHaveBeenCalled();
  });

  it('launch script pieces: MSYS paths and the Git Bash export for the harness', () => {
    expect(windowsCommandLaunch.launchScriptPath('C:\\w\\x')).toBe('/c/w/x');
    expect(windowsCommandLaunch.launchScriptExports('C:\\w')).toBe(`export CLAUDE_CODE_GIT_BASH_PATH='${GIT_BASH.path}'\n`);
    expect(windowsCommandLaunch.sessionIdMintFallback()).toContain('randomUUID');
  });

  it('workspaceShell reads the configured shell', () => {
    const configured = vi.fn(() => 'powershell');
    const shell = windowsCommandLaunch.workspaceShell('C:\\w', configured);
    expect(configured).toHaveBeenCalledOnce();
    expect(shell.command.toLowerCase()).toContain('powershell.exe');
  });
});
