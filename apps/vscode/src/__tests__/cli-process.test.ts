/**
 * Spec 1658 Phase 6: the extension spawns `afx`/`codev` through the shared shim
 * resolver, with no console window. On macOS/Linux the command and arguments
 * pass through unchanged.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const childProcess = vi.hoisted(() => ({ spawn: vi.fn(() => ({ unref: vi.fn() })) }));
vi.mock('node:child_process', () => ({ spawn: childProcess.spawn }));

const sdk = vi.hoisted(() => ({ resolveSpawnable: vi.fn() }));
vi.mock('@cluesmith/codev-sdk/node/executable', () => ({ resolveSpawnable: sdk.resolveSpawnable }));

import { spawnCodevCli } from '../cli-process.js';

beforeEach(() => {
  childProcess.spawn.mockClear();
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
