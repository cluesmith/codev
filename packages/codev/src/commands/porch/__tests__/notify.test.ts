/**
 * Tests for notifyArchitect (Spec 0108)
 *
 * Verifies that porch sends gate notifications via af send
 * and that failures are swallowed (fire-and-forget).
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
import { notifyArchitect } from '../notify.js';

const mockExecFile = vi.mocked(execFile);

describe('notifyArchitect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls execFile with correct arguments', () => {
    notifyArchitect('0108', 'spec-approval', '/projects/test');

    expect(mockExecFile).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = mockExecFile.mock.calls[0];
    expect(cmd).toBe(process.execPath);
    expect(args).toContain('send');
    expect(args).toContain('architect');
    expect(args).toContain('--raw');
    expect(args).toContain('--no-enter');
    expect((opts as { cwd: string }).cwd).toBe('/projects/test');
  });

  it('formats message with gate name and project id', () => {
    notifyArchitect('0108', 'plan-approval', '/projects/test');

    const message = mockExecFile.mock.calls[0][1]![3];
    expect(message).toContain('GATE: plan-approval (Builder 0108)');
    expect(message).toContain('Builder 0108 is waiting for approval.');
    expect(message).toContain('Run: porch approve 0108 plan-approval');
  });

  it('sets timeout to 10 seconds', () => {
    notifyArchitect('0108', 'spec-approval', '/projects/test');

    const opts = mockExecFile.mock.calls[0][2] as { timeout: number };
    expect(opts.timeout).toBe(10_000);
  });

  it('sets cwd to worktreeDir', () => {
    notifyArchitect('0108', 'spec-approval', '/my/worktree');

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

    // Should not throw
    expect(() => notifyArchitect('0108', 'spec-approval', '/projects/test')).not.toThrow();

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Gate notification failed')
    );

    consoleSpy.mockRestore();
  });

  it('logs error message on failure', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    mockExecFile.mockImplementation(
      (_cmd: any, _args: any, _opts: any, cb: any) => {
        cb(new Error('connection refused'));
        return undefined as any;
      }
    );

    notifyArchitect('0108', 'spec-approval', '/projects/test');

    expect(consoleSpy).toHaveBeenCalledWith(
      '[porch] Gate notification failed: connection refused'
    );

    consoleSpy.mockRestore();
  });

  it('uses af binary path ending with bin/af.js', () => {
    notifyArchitect('0108', 'spec-approval', '/projects/test');

    const args = mockExecFile.mock.calls[0][1]!;
    // The af binary should be a resolved path ending with bin/af.js
    expect(args[0]).toMatch(/bin\/af\.js$/);
  });
});
