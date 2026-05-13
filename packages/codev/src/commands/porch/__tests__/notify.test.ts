/**
 * Tests for notifyTerminal (Spec 0108 generalized)
 *
 * Verifies that porch sends gate notifications via `afx send` and that
 * failures are swallowed (fire-and-forget). Also covers the message-builder
 * helpers used by both architect-pending and builder-approval flows.
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
import { notifyTerminal, gatePendingMessage, gateApprovedMessage } from '../notify.js';

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
      target: 'architect',
      message: 'hello',
      worktreeDir: '/projects/test',
    });

    expect(mockExecFile).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = mockExecFile.mock.calls[0];
    expect(cmd).toBe(process.execPath);
    expect(args).toContain('send');
    expect(args).toContain('architect');
    expect(args).toContain('hello');
    expect(args).toContain('--raw');
    expect((opts as { cwd: string }).cwd).toBe('/projects/test');
  });

  it('appends --no-enter when draft is true', () => {
    notifyTerminal({
      target: 'architect',
      message: 'pending',
      worktreeDir: '/projects/test',
      draft: true,
    });

    const args = mockExecFile.mock.calls[0][1]!;
    expect(args).toContain('--no-enter');
  });

  it('omits --no-enter when draft is false/undefined', () => {
    notifyTerminal({
      target: 'pir-0108',
      message: 'wake up',
      worktreeDir: '/projects/test',
    });

    const args = mockExecFile.mock.calls[0][1]!;
    expect(args).not.toContain('--no-enter');
  });

  it('uses the builder id as target for wake-ups', () => {
    notifyTerminal({
      target: 'pir-0108',
      message: 'approved',
      worktreeDir: '/projects/test',
    });

    const args = mockExecFile.mock.calls[0][1]!;
    expect(args).toContain('pir-0108');
  });

  it('sets timeout to 10 seconds', () => {
    notifyTerminal({
      target: 'architect',
      message: 'x',
      worktreeDir: '/projects/test',
    });

    const opts = mockExecFile.mock.calls[0][2] as { timeout: number };
    expect(opts.timeout).toBe(10_000);
  });

  it('sets cwd to worktreeDir', () => {
    notifyTerminal({
      target: 'architect',
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
      notifyTerminal({ target: 'architect', message: 'x', worktreeDir: '/p' })
    ).not.toThrow();

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('notifyTerminal(architect) failed')
    );

    consoleSpy.mockRestore();
  });

  it('uses afx binary path ending with bin/afx.js', () => {
    notifyTerminal({
      target: 'architect',
      message: 'x',
      worktreeDir: '/projects/test',
    });

    const args = mockExecFile.mock.calls[0][1]!;
    expect(args[0]).toMatch(/bin\/afx\.js$/);
  });
});

describe('message helpers', () => {
  it('gatePendingMessage formats with project id and gate name', () => {
    const msg = gatePendingMessage('0108', 'plan-approval');
    expect(msg).toContain('GATE: plan-approval (Builder 0108)');
    expect(msg).toContain('Builder 0108 is waiting for approval.');
    expect(msg).toContain('Run: porch approve 0108 plan-approval');
  });

  it('gateApprovedMessage references the gate and porch next', () => {
    const msg = gateApprovedMessage('code-review');
    expect(msg).toContain('code-review');
    expect(msg).toContain('porch next');
  });
});
