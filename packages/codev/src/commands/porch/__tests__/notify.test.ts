/**
 * Tests for notifyTerminal — the builder wake-up after gate approval.
 *
 * Architect-bound notifications were removed deliberately; the only caller
 * of notifyTerminal today is the gate-approve path, which wakes the builder
 * so its idle Claude session advances on the next turn.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock child_process.execFile before importing the module under test
vi.mock('node:child_process', () => ({
  execFile: vi.fn((_cmd: string, _args: string[], _opts: object, cb: (err: Error | null) => void) => {
    cb(null);
  }),
  spawn: vi.fn(),
  execSync: vi.fn(),
  spawnSync: vi.fn(),
}));

import { execFile } from 'node:child_process';
import { notifyTerminal, gateApprovedMessage } from '../notify.js';

const mockExecFile = vi.mocked(execFile);

describe('notifyTerminal', () => {
  beforeEach(() => {
    mockExecFile.mockReset();
    mockExecFile.mockImplementation(
      (_cmd: any, _args: any, _opts: any, cb: any) => {
        cb(null);
        return undefined as any;
      }
    );
  });

  it('routes message to the named target via afx send', () => {
    notifyTerminal({
      target: 'pir-0108',
      message: 'wake up',
      worktreeDir: '/projects/test',
    });

    expect(mockExecFile).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = mockExecFile.mock.calls[0];
    expect(cmd).toBe(process.execPath);
    expect(args).toContain('send');
    expect(args).toContain('pir-0108');
    expect(args).toContain('wake up');
    expect(args).toContain('--raw');
    expect((opts as { cwd: string }).cwd).toBe('/projects/test');
  });

  it('submits as a regular message (no --no-enter)', () => {
    notifyTerminal({
      target: 'pir-0108',
      message: 'approved',
      worktreeDir: '/projects/test',
    });

    const args = mockExecFile.mock.calls[0][1]!;
    expect(args).not.toContain('--no-enter');
  });

  it('sets timeout to 10 seconds', () => {
    notifyTerminal({
      target: 'pir-0108',
      message: 'x',
      worktreeDir: '/projects/test',
    });

    const opts = mockExecFile.mock.calls[0][2] as { timeout: number };
    expect(opts.timeout).toBe(10_000);
  });

  it('sets cwd to worktreeDir', () => {
    notifyTerminal({
      target: 'pir-0108',
      message: 'x',
      worktreeDir: '/my/worktree',
    });

    const opts = mockExecFile.mock.calls[0][2] as { cwd: string };
    expect(opts.cwd).toBe('/my/worktree');
  });

  it('swallows execFile errors without throwing', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    mockExecFile.mockImplementation(
      (_cmd: any, _args: any, _opts: any, cb: any) => {
        cb(new Error('Tower is down'));
        return undefined as any;
      }
    );

    expect(() =>
      notifyTerminal({ target: 'pir-0108', message: 'x', worktreeDir: '/p' })
    ).not.toThrow();

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('notifyTerminal(pir-0108) failed')
    );

    consoleSpy.mockRestore();
  });

  it('uses afx binary path ending with bin/afx.js', () => {
    notifyTerminal({
      target: 'pir-0108',
      message: 'x',
      worktreeDir: '/projects/test',
    });

    const args = mockExecFile.mock.calls[0][1]!;
    expect(args[0]).toMatch(/bin\/afx\.js$/);
  });
});

describe('gateApprovedMessage', () => {
  it('references the gate and porch next', () => {
    const msg = gateApprovedMessage('dev-approval');
    expect(msg).toContain('dev-approval');
    expect(msg).toContain('porch next');
  });
});
