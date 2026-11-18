/**
 * Spec 1658 Phase 6: the extension spawns `afx`/`codev` through the shared shim
 * resolver, with no console window. On macOS/Linux the command and arguments
 * pass through unchanged.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const childProcess = vi.hoisted(() => ({ spawn: vi.fn(() => ({ unref: vi.fn() })), execFile: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: childProcess.spawn, execFile: childProcess.execFile }));

const sdk = vi.hoisted(() => ({ resolveSpawnable: vi.fn() }));
vi.mock('@cluesmith/codev-sdk/node/executable', () => ({ resolveSpawnable: sdk.resolveSpawnable }));

import { spawnCodevCli, execCodevCli } from '../cli-process.js';

beforeEach(() => {
  childProcess.spawn.mockClear();
  childProcess.execFile.mockReset();
  sdk.resolveSpawnable.mockReset();
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
    sdk.resolveSpawnable.mockImplementation((command: string, args: string[]) => ({ command, args, windowsVerbatimArguments: false }));
    childProcess.execFile.mockImplementation((_file: string, _args: string[], _opts: unknown, cb: (e: Error | null, o: string, e2: string) => void) => {
      cb(new Error('exit 1'), '', 'no such builder');
    });
    await expect(execCodevCli('afx', ['cleanup', '-p', 'x'], {})).rejects.toMatchObject({ message: 'exit 1', stderr: 'no such builder' });
  });

  it('passes a POSIX command through unchanged', () => {
    sdk.resolveSpawnable.mockImplementation((command: string, args: string[]) => ({ command, args, windowsVerbatimArguments: false }));
    spawnCodevCli('codev', ['--version'], { cwd: '/repo' });
    expect(childProcess.spawn).toHaveBeenCalledWith('codev', ['--version'], {
      cwd: '/repo',
      windowsHide: true,
      windowsVerbatimArguments: false,
    });
  });
});
