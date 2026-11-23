/**
 * Spec 1951 — the runner: the only subprocess path in `codev check`.
 */

import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunnerRefusal } from '../allow-list.js';
import { createRunner, formatDuration, type SpawnFn } from '../runner.js';

const isWindows = process.platform === 'win32';

/** A child that never exits on its own; records kill(). */
function hangingChild(): ChildProcess & { killedWith: string[] } {
  const child = new EventEmitter() as ChildProcess & { killedWith: string[] };
  child.stdout = new EventEmitter() as ChildProcess['stdout'];
  child.stderr = new EventEmitter() as ChildProcess['stderr'];
  child.killedWith = [];
  child.kill = ((signal: string) => {
    child.killedWith.push(signal);
    return true;
  }) as ChildProcess['kill'];
  return child;
}

let workspace: string;

function writeForgeConfig(forge: Record<string, unknown>): void {
  fs.mkdirSync(path.join(workspace, '.codev'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.codev', 'config.json'), JSON.stringify({ forge }));
}

beforeEach(() => {
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codev-check-runner-')));
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('Spec 1951 — runner: git', () => {
  it('refuses a command off the allow-list before spawning it', async () => {
    const spawn = vi.fn<SpawnFn>();
    const runner = createRunner({ cwd: workspace, workspaceRoot: workspace, spawn });
    for (const args of [['push', 'origin', 'main'], ['update-ref', 'refs/heads/x', 'a'.repeat(40)], ['branch', '-D', 'x'], ['status']]) {
      await expect(runner.git(args)).rejects.toThrow(RunnerRefusal);
    }
    expect(spawn).not.toHaveBeenCalled();
  });

  it('spawns git from argv, never a shell, with GIT_TERMINAL_PROMPT=0 and windowsHide', async () => {
    const child = hangingChild();
    const spawn = vi.fn<SpawnFn>(() => child);
    const runner = createRunner({ cwd: workspace, workspaceRoot: workspace, spawn, env: { EXTRA: '1' } });
    const pending = runner.git(['version']);
    child.stdout!.emit('data', Buffer.from('git version 2.50.1\n'));
    child.emit('close', 0);
    await expect(pending).resolves.toEqual({ stdout: 'git version 2.50.1\n', stderr: '', exitCode: 0, timedOut: false });
    const [command, args, options] = spawn.mock.calls[0];
    expect(command).toBe('git');
    expect(args).toEqual(['version']);
    expect(options.shell).toBeUndefined();
    expect(options.windowsHide).toBe(true);
    expect(options.cwd).toBe(workspace);
    expect(options.env).toMatchObject({ GIT_TERMINAL_PROMPT: '0', EXTRA: '1' });
  });

  it('bounds ls-remote by timeoutMs and kills the child', async () => {
    const child = hangingChild();
    const runner = createRunner({ cwd: workspace, workspaceRoot: workspace, spawn: () => child, timeoutMs: 50 });
    const result = await runner.git(['ls-remote', 'origin', 'refs/heads/main']);
    expect(result).toEqual({ stdout: '', stderr: '', exitCode: null, timedOut: true });
    expect(child.killedWith).toEqual(['SIGKILL']);
  });

  it('bounds fetch by timeoutMs', async () => {
    const child = hangingChild();
    const runner = createRunner({ cwd: workspace, workspaceRoot: workspace, spawn: () => child, timeoutMs: 50 });
    const result = await runner.git(['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', 'fetch', '--no-write-fetch-head', '--refmap=', 'origin', 'a'.repeat(40)]);
    expect(result.timedOut).toBe(true);
  });

  it('does not bound a local git call', async () => {
    const child = hangingChild();
    const runner = createRunner({ cwd: workspace, workspaceRoot: workspace, spawn: () => child, timeoutMs: 20 });
    const pending = runner.git(['version']);
    await new Promise((resolve) => setTimeout(resolve, 80));
    child.emit('close', 0);
    await expect(pending).resolves.toMatchObject({ exitCode: 0, timedOut: false });
    expect(child.killedWith).toEqual([]);
  });

  it('runs the real git', async () => {
    const runner = createRunner({ cwd: workspace, workspaceRoot: workspace });
    const result = await runner.git(['version']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^git version \d+\.\d+/);
  });

  it('formats durations for messages', () => {
    expect(formatDuration(30_000)).toBe('30s');
    expect(formatDuration(250)).toBe('250ms');
  });
});

describe('Spec 1951 — runner: forge', () => {
  it('refuses a concept off the read-only list before dispatch', async () => {
    writeForgeConfig({ 'pr-merge': 'echo merged > merged.txt' });
    const runner = createRunner({ cwd: workspace, workspaceRoot: workspace });
    await expect(runner.forge('pr-merge')).rejects.toThrow(RunnerRefusal);
    expect(fs.existsSync(path.join(workspace, 'merged.txt'))).toBe(false);
  });

  it('reports a disabled concept', async () => {
    writeForgeConfig({ provider: 'gitea' });
    const runner = createRunner({ cwd: workspace, workspaceRoot: workspace });
    await expect(runner.forge('pr-search')).resolves.toEqual({ ok: false, kind: 'disabled', reason: 'pr-search unavailable on gitea' });
    expect(runner.provider()).toBe('gitea');
  });

  it.skipIf(isWindows)('returns parsed data', async () => {
    writeForgeConfig({ 'pr-view': 'printf \'{"number":%s}\' "$CODEV_PR_NUMBER"' });
    const runner = createRunner({ cwd: workspace, workspaceRoot: workspace });
    await expect(runner.forge('pr-view', { CODEV_PR_NUMBER: '7' })).resolves.toEqual({ ok: true, data: { number: 7 } });
  });

  it.skipIf(isWindows)('reports invalid output when the concept prints non-JSON', async () => {
    writeForgeConfig({ 'pr-view': 'echo this is not json' });
    const runner = createRunner({ cwd: workspace, workspaceRoot: workspace });
    await expect(runner.forge('pr-view')).resolves.toEqual({ ok: false, kind: 'invalid', reason: 'pr-view returned invalid output' });
  });

  it.skipIf(isWindows)('reports a failure with the first line of stderr', async () => {
    writeForgeConfig({ 'pr-view': 'echo "no such PR" >&2; echo more >&2; exit 3' });
    const runner = createRunner({ cwd: workspace, workspaceRoot: workspace });
    await expect(runner.forge('pr-view')).resolves.toEqual({ ok: false, kind: 'failed', reason: 'pr-view failed: no such PR' });
  });

  it.skipIf(isWindows)('reports a call past timeoutMs as timed out', async () => {
    writeForgeConfig({ 'pr-view': 'sleep 5' });
    const runner = createRunner({ cwd: workspace, workspaceRoot: workspace, timeoutMs: 300 });
    const started = Date.now();
    await expect(runner.forge('pr-view')).resolves.toEqual({ ok: false, kind: 'timeout', reason: 'pr-view timed out after 300ms' });
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it.skipIf(isWindows)('does not wait for a grandchild that holds the output pipe open', async () => {
    // The shell is killed at the time limit, but the background sleep keeps stdout open,
    // so the dispatcher alone would wait the full 8 s. The runner's own deadline does not.
    writeForgeConfig({ 'pr-view': 'sleep 8 & wait' });
    const runner = createRunner({ cwd: workspace, workspaceRoot: workspace, timeoutMs: 200 });
    const started = Date.now();
    const outcome = await runner.forge('pr-view');
    expect(outcome).toMatchObject({ ok: false, kind: 'timeout' });
    expect(Date.now() - started).toBeLessThan(4_000);
  }, 10_000);

  it.skipIf(isWindows)('passes the runner environment to the concept', async () => {
    writeForgeConfig({ 'pr-view': 'printf \'{"v":"%s"}\' "$CHECK_RUNNER_PROBE"' });
    const runner = createRunner({ cwd: workspace, workspaceRoot: workspace, env: { CHECK_RUNNER_PROBE: 'yes' } });
    await expect(runner.forge('pr-view')).resolves.toEqual({ ok: true, data: { v: 'yes' } });
  });
});
