/**
 * Tests for cleanup command — shellper process kill (Bugfix #389)
 *
 * When `afx cleanup` runs, it must kill shellper processes associated with the
 * builder's worktree. Previously, cleanup relied solely on the Tower API which
 * silently fails when Tower is not running or the terminal was already removed.
 *
 * The fix adds a direct `ps`-based search for shellper-main.js processes whose
 * JSON config contains the worktree path, killing them via process group signal.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { killShellperProcesses } from '../commands/cleanup.js';
import { execFile } from 'node:child_process';

// Mock execFile to simulate ps output
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execFile: vi.fn(),
  };
});

const mockExecFile = vi.mocked(execFile);

// Mock process.kill to track kill signals
const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

afterEach(() => {
  vi.clearAllMocks();
});

describe('killShellperProcesses (Bugfix #389)', () => {
  const worktree = '/workspace/.builders/bugfix-42-login-fails';

  function simulatePsOutput(stdout: string): void {
    mockExecFile.mockImplementation((_cmd, _args, callback) => {
      (callback as (err: Error | null, stdout: string) => void)(null, stdout);
      return {} as ReturnType<typeof execFile>;
    });
  }

  function simulatePsError(): void {
    mockExecFile.mockImplementation((_cmd, _args, callback) => {
      (callback as (err: Error | null, stdout: string) => void)(new Error('ps failed'), '');
      return {} as ReturnType<typeof execFile>;
    });
  }

  it('kills shellper processes matching the worktree cwd', async () => {
    simulatePsOutput(
      `  PID ARGS\n` +
      `12345 node /path/to/shellper-main.js {"command":"/bin/bash","args":[],"cwd":"${worktree}","socketPath":"/tmp/shellper-abc.sock"}\n` +
      `99999 node /usr/bin/some-other-process\n`
    );

    const killed = await killShellperProcesses(worktree);

    expect(killed).toBe(1);
    // Should attempt process group kill first (-pid)
    expect(killSpy).toHaveBeenCalledWith(-12345, 'SIGTERM');
  });

  it('does not kill shellper processes for different worktrees', async () => {
    simulatePsOutput(
      `  PID ARGS\n` +
      `12345 node /path/to/shellper-main.js {"command":"/bin/bash","args":[],"cwd":"/workspace/.builders/bugfix-99-other","socketPath":"/tmp/shellper-abc.sock"}\n`
    );

    const killed = await killShellperProcesses(worktree);

    expect(killed).toBe(0);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('does not match partial worktree path prefixes', async () => {
    // bugfix-42 should NOT match bugfix-42-login-fails-continued
    const shortWorktree = '/workspace/.builders/bugfix-42';
    simulatePsOutput(
      `  PID ARGS\n` +
      `12345 node /path/to/shellper-main.js {"command":"/bin/bash","args":[],"cwd":"${shortWorktree}-login-fails-continued","socketPath":"/tmp/shellper-abc.sock"}\n`
    );

    const killed = await killShellperProcesses(shortWorktree);

    expect(killed).toBe(0);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('kills multiple shellper processes for the same worktree', async () => {
    simulatePsOutput(
      `  PID ARGS\n` +
      `12345 node /path/to/shellper-main.js {"command":"/bin/bash","args":[],"cwd":"${worktree}","socketPath":"/tmp/shellper-abc.sock"}\n` +
      `12346 node /path/to/shellper-main.js {"command":"/bin/bash","args":[],"cwd":"${worktree}","socketPath":"/tmp/shellper-def.sock"}\n`
    );

    const killed = await killShellperProcesses(worktree);

    expect(killed).toBe(2);
    expect(killSpy).toHaveBeenCalledWith(-12345, 'SIGTERM');
    expect(killSpy).toHaveBeenCalledWith(-12346, 'SIGTERM');
  });

  it('falls back to individual PID kill when process group kill fails', async () => {
    simulatePsOutput(
      `  PID ARGS\n` +
      `12345 node /path/to/shellper-main.js {"command":"/bin/bash","args":[],"cwd":"${worktree}","socketPath":"/tmp/shellper-abc.sock"}\n`
    );

    // First call (-pid group kill) fails, second call (individual pid) succeeds
    killSpy
      .mockImplementationOnce(() => { throw new Error('ESRCH'); })
      .mockImplementationOnce(() => true);

    const killed = await killShellperProcesses(worktree);

    expect(killed).toBe(1);
    expect(killSpy).toHaveBeenCalledWith(-12345, 'SIGTERM');
    expect(killSpy).toHaveBeenCalledWith(12345, 'SIGTERM');
  });

  it('returns 0 when no shellper processes found', async () => {
    simulatePsOutput(
      `  PID ARGS\n` +
      `99999 node /usr/bin/some-other-process\n`
    );

    const killed = await killShellperProcesses(worktree);

    expect(killed).toBe(0);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('returns 0 gracefully when ps fails', async () => {
    simulatePsError();

    const killed = await killShellperProcesses(worktree);

    expect(killed).toBe(0);
  });

  it('skips non-shellper processes even if they mention the worktree', async () => {
    simulatePsOutput(
      `  PID ARGS\n` +
      `12345 claude --cwd ${worktree}\n`
    );

    const killed = await killShellperProcesses(worktree);

    expect(killed).toBe(0);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('does not kill its own process', async () => {
    simulatePsOutput(
      `  PID ARGS\n` +
      `${process.pid} node /path/to/shellper-main.js {"command":"/bin/bash","args":[],"cwd":"${worktree}","socketPath":"/tmp/shellper-abc.sock"}\n`
    );

    const killed = await killShellperProcesses(worktree);

    expect(killed).toBe(0);
    expect(killSpy).not.toHaveBeenCalled();
  });
});
