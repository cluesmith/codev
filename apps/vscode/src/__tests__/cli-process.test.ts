/**
 * Spec 1658 Phase 6: the extension spawns `afx`/`codev` through the shared shim
 * resolver, with no console window. On macOS/Linux the command and arguments
 * pass through unchanged.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const childProcess = vi.hoisted(() => ({ spawn: vi.fn(() => ({ unref: vi.fn() })), execFile: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ChildProcess: actual.ChildProcess, spawn: childProcess.spawn, execFile: childProcess.execFile };
});

const sdk = vi.hoisted(() => ({ resolveSpawnable: vi.fn() }));
vi.mock('@cluesmith/codev-sdk/node/executable', () => ({ resolveSpawnable: sdk.resolveSpawnable }));

import { spawnCodevCli, execCodevCli } from '../cli-process.js';

const realPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

beforeEach(() => {
  childProcess.spawn.mockClear();
  childProcess.execFile.mockReset();
  sdk.resolveSpawnable.mockReset();
});

afterEach(() => {
  setPlatform(realPlatform);
});

describe('spawnCodevCli', () => {
  it('spawns the resolver output with its verbatim flag, hidden', () => {
    sdk.resolveSpawnable.mockReturnValue({
      command: 'C:\\Windows\\system32\\cmd.exe',
      args: ['/d', '/s', '/c', '"C:\\npm\\afx.cmd ^"tower^" ^"start^""'],
      windowsVerbatimArguments: true,
    });
    spawnCodevCli('afx', ['tower', 'start'], { detached: true, stdio: 'ignore' });
    expect(sdk.resolveSpawnable).toHaveBeenCalledWith('afx', ['tower', 'start']);
    expect(childProcess.spawn).toHaveBeenCalledWith(
      'C:\\Windows\\system32\\cmd.exe',
      ['/d', '/s', '/c', '"C:\\npm\\afx.cmd ^"tower^" ^"start^""'],
      { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true },
    );
  });

  it('execCodevCli runs the resolver output hidden and resolves its output', async () => {
    sdk.resolveSpawnable.mockReturnValue({
      command: 'C:\\Program Files\\nodejs\\node.exe',
      args: ['C:\\npm\\node_modules\\@cluesmith\\codev\\bin\\porch.js', 'approve', '42', 'pr'],
      windowsVerbatimArguments: false,
    });
    childProcess.execFile.mockImplementation((_file: string, _args: string[], _opts: unknown, cb: (e: Error | null, o: string, e2: string) => void) => {
      cb(null, 'approved\n', '');
    });
    await expect(execCodevCli('porch', ['approve', '42', 'pr'], { cwd: 'C:\\ws' }))
      .resolves.toEqual({ stdout: 'approved\n', stderr: '' });
    expect(sdk.resolveSpawnable).toHaveBeenCalledWith('porch', ['approve', '42', 'pr']);
    expect(childProcess.execFile).toHaveBeenCalledWith(
      'C:\\Program Files\\nodejs\\node.exe',
      ['C:\\npm\\node_modules\\@cluesmith\\codev\\bin\\porch.js', 'approve', '42', 'pr'],
      { cwd: 'C:\\ws', encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: false },
      expect.any(Function),
    );
  });

  it('execCodevCli rejects on a failing exit, carrying its output', async () => {
    setPlatform('linux');
    sdk.resolveSpawnable.mockImplementation((command: string, args: string[]) => ({ command, args, windowsVerbatimArguments: false }));
    childProcess.execFile.mockImplementation((_file: string, _args: string[], _opts: unknown, cb: (e: Error | null, o: string, e2: string) => void) => {
      cb(new Error('exit 1'), '', 'no such builder');
    });
    await expect(execCodevCli('afx', ['cleanup', '-p', 'x'], {})).rejects.toMatchObject({ message: 'exit 1', stderr: 'no such builder' });
  });

  it('passes a POSIX command through unchanged', () => {
    setPlatform('linux');
    sdk.resolveSpawnable.mockImplementation((command: string, args: string[]) => ({ command, args, windowsVerbatimArguments: false }));
    spawnCodevCli('codev', ['--version'], { cwd: '/repo' });
    expect(childProcess.spawn).toHaveBeenCalledWith('codev', ['--version'], {
      cwd: '/repo',
      windowsHide: true,
      windowsVerbatimArguments: false,
    });
  });
});

describe('a bare name not on PATH on Windows (#1911)', () => {
  // The resolver hands an unresolved name back unchanged; spawning it would let
  // Windows run a same-named program from the workspace folder instead.
  beforeEach(() => {
    setPlatform('win32');
    sdk.resolveSpawnable.mockImplementation((command: string, args: string[]) => ({ command, args, windowsVerbatimArguments: false }));
  });

  it('spawnCodevCli never spawns it and emits ENOENT asynchronously', async () => {
    const child = spawnCodevCli('afx', ['tower', 'start'], { cwd: 'C:\\ws' });
    expect(childProcess.spawn).not.toHaveBeenCalled();
    const error = await new Promise<NodeJS.ErrnoException>((resolve) => child.on('error', resolve));
    expect(error).toMatchObject({ code: 'ENOENT', path: 'afx', syscall: 'spawn afx', spawnargs: ['tower', 'start'] });
  });

  it('execCodevCli never runs it and rejects with ENOENT', async () => {
    await expect(execCodevCli('porch', ['approve', '42', 'pr'], { cwd: 'C:\\ws' })).rejects.toMatchObject({ code: 'ENOENT', path: 'porch' });
    expect(childProcess.execFile).not.toHaveBeenCalled();
  });

  it('still spawns a name the resolver found', () => {
    sdk.resolveSpawnable.mockReturnValue({ command: 'C:\\npm\\codev.exe', args: ['--version'], windowsVerbatimArguments: false });
    spawnCodevCli('codev', ['--version'], {});
    expect(childProcess.spawn).toHaveBeenCalledWith('C:\\npm\\codev.exe', ['--version'], { windowsHide: true, windowsVerbatimArguments: false });
  });
});
