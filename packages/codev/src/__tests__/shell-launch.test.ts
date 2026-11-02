/**
 * Spec 1658 Phase 6: the launcher helpers. Git Bash argv for scripts and shell
 * strings, memoized resolution keyed by the workspace override, the Windows
 * shell roles (Area F), the client POSIX-shell mapping, the PTY command and
 * base environment, and the host default interactive shell.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const gitBashModule = vi.hoisted(() => ({ resolveGitBash: vi.fn() }));
const sdk = vi.hoisted(() => ({ resolveSpawnable: vi.fn() }));
vi.mock('@cluesmith/codev-sdk/node/executable', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cluesmith/codev-sdk/node/executable')>();
  sdk.resolveSpawnable.mockImplementation(actual.resolveSpawnable);
  return { ...actual, resolveSpawnable: sdk.resolveSpawnable };
});
vi.mock('../lib/git-bash.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/git-bash.js')>();
  return { ...actual, resolveGitBash: gitBashModule.resolveGitBash };
});

import {
  gitBashFor,
  gitBashCommand,
  gitBashScript,
  gitBashEnv,
  setGitBashForTests,
  windowsInteractiveShell,
  windowsPowerShellPath,
  windowsShellRequest,
} from '../lib/shell-launch.js';
import { ptyCommand, windowsPtyBaseEnv } from '../lib/pty-command.js';
import { defaultInteractiveShell, setHostPlatformForTests, resetHostPlatformForTests, windowsSystem32Path } from '../lib/platform.js';
import { getDefaultConfig } from '../lib/config.js';

const GIT_BASH = {
  path: 'C:\\Program Files\\Git\\bin\\bash.exe',
  root: 'C:\\Program Files\\Git',
  gitVersion: 'git version 2.47.1.windows.1',
  source: 'install' as const,
};

let workDir: string;

beforeEach(() => {
  gitBashModule.resolveGitBash.mockReset();
  gitBashModule.resolveGitBash.mockReturnValue(GIT_BASH);
  setGitBashForTests(null);
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-1658-launch-'));
});

afterEach(() => {
  setGitBashForTests(null);
  resetHostPlatformForTests();
  fs.rmSync(workDir, { recursive: true, force: true });
});

function writeConfig(config: Record<string, unknown>): void {
  fs.mkdirSync(path.join(workDir, '.codev'), { recursive: true });
  fs.writeFileSync(path.join(workDir, '.codev', 'config.json'), JSON.stringify(config));
}

describe('gitBashFor', () => {
  it('passes the workspace windows.gitBashPath override to the resolver', () => {
    writeConfig({ windows: { gitBashPath: 'D:\\Tools\\Git\\bin\\bash.exe' } });
    expect(gitBashFor(workDir)).toBe(GIT_BASH);
    expect(gitBashModule.resolveGitBash).toHaveBeenCalledWith({ configPath: 'D:\\Tools\\Git\\bin\\bash.exe' });
  });

  it('resolves once per override value', () => {
    gitBashFor(workDir);
    gitBashFor(workDir);
    gitBashFor();
    expect(gitBashModule.resolveGitBash).toHaveBeenCalledTimes(1);
  });

  it('propagates a resolution failure', () => {
    gitBashModule.resolveGitBash.mockImplementation(() => {
      throw new Error('Git for Windows (Git Bash) not found');
    });
    expect(() => gitBashFor(workDir)).toThrow(/Git for Windows/);
  });
});

describe('Git Bash argv', () => {
  beforeEach(() => setGitBashForTests(GIT_BASH));

  it('runs a shell string with -c', () => {
    expect(gitBashCommand('npm ci && npm run build')).toEqual({
      command: GIT_BASH.path,
      args: ['-c', 'npm ci && npm run build'],
    });
  });

  it('runs a script by its POSIX path', () => {
    expect(gitBashScript('C:\\Users\\dev\\repo\\.builders\\x\\.builder-start.sh', ['a b'])).toEqual({
      command: GIT_BASH.path,
      args: ['/c/Users/dev/repo/.builders/x/.builder-start.sh', 'a b'],
    });
  });

  it('turns MSYS argument conversion off', () => {
    expect(gitBashEnv({ PATH: 'x' })).toEqual({ PATH: 'x', MSYS_NO_PATHCONV: '1', MSYS2_ARG_CONV_EXCL: '*' });
  });
});

describe('Windows shell roles (Area F)', () => {
  const env = { SystemRoot: 'C:\\Windows', PATH: '' };

  beforeEach(() => setGitBashForTests(GIT_BASH));

  it('powershell names map to the built-in Windows PowerShell by full path', () => {
    const expected = { command: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', args: ['-NoLogo'] };
    expect(windowsInteractiveShell('powershell.exe', undefined, env)).toEqual(expected);
    expect(windowsInteractiveShell('PowerShell', undefined, env)).toEqual(expected);
    expect(windowsPowerShellPath(env)).toBe(expected.command);
  });

  it('bash means Git Bash, never System32 bash.exe', () => {
    for (const name of ['bash', 'bash.exe', '/bin/bash']) {
      const launch = windowsInteractiveShell(name, undefined, env);
      expect(launch).toEqual({ command: GIT_BASH.path, args: ['-i'] });
      expect(launch.command.toLowerCase()).not.toContain('system32');
    }
  });

  it('any other shell (pwsh opt-in) resolves through PATHEXT and is otherwise passed through', () => {
    expect(windowsInteractiveShell('pwsh', undefined, env)).toEqual({ command: 'pwsh', args: [] });
  });

  it('maps a client POSIX shell onto Git Bash, login -lc becoming -c', () => {
    expect(windowsShellRequest('/bin/sh', ['-lc', 'pnpm dev'])).toEqual({ command: GIT_BASH.path, args: ['-c', 'pnpm dev'] });
    expect(windowsShellRequest('/bin/bash', ['/c/x/.builder-start.sh'])).toEqual({ command: GIT_BASH.path, args: ['/c/x/.builder-start.sh'] });
  });

  it('leaves every other client command alone', () => {
    expect(windowsShellRequest('claude', ['--resume', 'x'])).toEqual({ command: 'claude', args: ['--resume', 'x'] });
    expect(windowsShellRequest(GIT_BASH.path, ['-c', 'x'])).toEqual({ command: GIT_BASH.path, args: ['-c', 'x'] });
  });
});

describe('windowsSystem32Path', () => {
  it('builds a full System32 path from SystemRoot, so a system program is never spawned by bare name', () => {
    expect(windowsSystem32Path('taskkill.exe', { SystemRoot: 'D:\\Win' })).toBe('D:\\Win\\System32\\taskkill.exe');
    expect(windowsSystem32Path('cmd.exe', { SYSTEMROOT: 'C:\\WINDOWS' })).toBe('C:\\WINDOWS\\System32\\cmd.exe');
    expect(windowsSystem32Path('cmd.exe', {})).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(windowsPowerShellPath({ SystemRoot: 'C:\\Windows' })).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  });
});

describe('defaultInteractiveShell', () => {
  it('is bash on POSIX', () => {
    setHostPlatformForTests('darwin');
    expect(defaultInteractiveShell()).toBe('bash');
    expect(getDefaultConfig().shell?.shell).toBe('bash');
  });

  it('is Windows PowerShell on Windows', () => {
    setHostPlatformForTests('win32');
    expect(defaultInteractiveShell()).toBe('powershell.exe');
    expect(getDefaultConfig().shell?.shell).toBe('powershell.exe');
  });
});

describe('ptyCommand', () => {
  it('is the identity on POSIX', () => {
    setHostPlatformForTests('linux');
    expect(ptyCommand('claude', ['--x'], {})).toEqual({ file: 'claude', args: ['--x'] });
  });

  it('spawns the resolved .exe form with an argv array on Windows', () => {
    setHostPlatformForTests('win32');
    sdk.resolveSpawnable.mockReturnValueOnce({
      command: 'C:\\Program Files\\nodejs\\node.exe',
      args: ['C:\\npm\\node_modules\\cli\\bin.js', '--resume', 'abc'],
      windowsVerbatimArguments: false,
    });
    const env = { PATH: 'C:\\npm' };
    expect(ptyCommand('claude', ['--resume', 'abc'], env)).toEqual({
      file: 'C:\\Program Files\\nodejs\\node.exe',
      args: ['C:\\npm\\node_modules\\cli\\bin.js', '--resume', 'abc'],
    });
    expect(sdk.resolveSpawnable).toHaveBeenCalledWith('claude', ['--resume', 'abc'], { platform: 'win32', env });
  });

  it('hands a pre-quoted cmd.exe line to node-pty as its string args form', () => {
    setHostPlatformForTests('win32');
    sdk.resolveSpawnable.mockReturnValueOnce({
      command: 'C:\\Windows\\system32\\cmd.exe',
      args: ['/d', '/s', '/c', '"C:\\tools\\agent.cmd ^"a b^""'],
      windowsVerbatimArguments: true,
    });
    expect(ptyCommand('agent', ['a b'], {})).toEqual({
      file: 'C:\\Windows\\system32\\cmd.exe',
      args: '/d /s /c "C:\\tools\\agent.cmd ^"a b^""',
    });
  });

  it('leaves an unresolvable Windows command unchanged so the spawn fails with ENOENT', () => {
    setHostPlatformForTests('win32');
    expect(ptyCommand('no-such-cli', [], { PATH: '' })).toEqual({ file: 'no-such-cli', args: [] });
  });
});

describe('windowsPtyBaseEnv', () => {
  it('copies the Windows essentials case-insensitively and sets HOME to the profile', () => {
    const base = windowsPtyBaseEnv({
      Path: 'C:\\Windows\\system32;C:\\Program Files\\Git\\cmd',
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      SystemRoot: 'C:\\Windows',
      ComSpec: 'C:\\Windows\\system32\\cmd.exe',
      USERPROFILE: 'C:\\Users\\dev',
      SECRET_TOKEN: 'nope',
    });
    expect(base).toMatchObject({
      PATH: 'C:\\Windows\\system32;C:\\Program Files\\Git\\cmd',
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      SystemRoot: 'C:\\Windows',
      COMSPEC: 'C:\\Windows\\system32\\cmd.exe',
      USERPROFILE: 'C:\\Users\\dev',
      HOME: 'C:\\Users\\dev',
    });
    expect(base.SECRET_TOKEN).toBeUndefined();
  });

  it('keeps an explicit HOME', () => {
    expect(windowsPtyBaseEnv({ USERPROFILE: 'C:\\Users\\dev', HOME: 'D:\\home' }).HOME).toBe('D:\\home');
  });
});
