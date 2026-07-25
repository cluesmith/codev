/**
 * Bugfix #1241 — the builder launch loop must only auto-restart on unnatural
 * exits. A deliberate quit (exit 0: double Ctrl+C, `/quit`) ends the loop and
 * waits for a keypress instead of respawning.
 *
 * These tests EXECUTE the generated script with bash rather than pattern-match
 * it: the regression is a shell control-flow bug, and only running it proves
 * the agent was launched once instead of in a loop.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildWorktreeLaunchScript } from '../commands/spawn-worktree.js';

let worktree: string;
let counter: string;

/** Build the real launch script with a fake agent that exits with `code`. */
function writeLaunchScript(code: number): string {
  // The fake agent records each launch, so the test can count respawns.
  const baseCmd = `sh -c "echo run >> '${counter}'; exit ${code}"`;
  const script = buildWorktreeLaunchScript(worktree, baseCmd, null, worktree);
  const scriptPath = path.join(worktree, 'launch.sh');
  fs.writeFileSync(scriptPath, script);
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function runCount(): number {
  if (!fs.existsSync(counter)) return 0;
  return fs.readFileSync(counter, 'utf-8').trim().split('\n').filter(Boolean).length;
}

beforeEach(() => {
  worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-1241-'));
  counter = path.join(worktree, 'runs.txt');
});

afterEach(() => {
  fs.rmSync(worktree, { recursive: true, force: true });
});

describe('builder launch loop exit handling (Bugfix #1241)', () => {
  it('does not respawn the agent after a deliberate exit (code 0)', () => {
    const scriptPath = writeLaunchScript(0);

    // stdin is closed, so the relaunch prompt reads EOF and the script ends.
    // Without the fix this loops forever and the timeout below kills it.
    const result = spawnSync('/bin/bash', [scriptPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf-8',
      timeout: 10_000,
    });

    expect(result.signal).toBeNull(); // exited on its own, was not timed out
    expect(result.status).toBe(0);
    expect(runCount()).toBe(1);
    expect(result.stdout).toContain('Agent exited at your request');
    expect(result.stdout).not.toContain('Restarting in 2 seconds');
  });

  it('relaunches once per keypress after a deliberate exit', () => {
    const scriptPath = writeLaunchScript(0);

    // One Enter → one relaunch; then EOF ends the loop.
    const result = spawnSync('/bin/bash', [scriptPath], {
      input: '\n',
      encoding: 'utf-8',
      timeout: 10_000,
    });

    expect(result.status).toBe(0);
    expect(runCount()).toBe(2);
  });

  it('still auto-restarts after a crash (nonzero exit)', () => {
    const scriptPath = writeLaunchScript(7);

    // No natural end for a crash loop — kill it after two restart delays.
    const result = spawnSync('/bin/bash', [scriptPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf-8',
      timeout: 5_000,
      killSignal: 'SIGKILL',
    });

    expect(runCount()).toBeGreaterThan(1);
    expect(result.stdout).toContain('Restarting in 2 seconds');
    expect(result.stdout).toContain('code 7');
    expect(result.stdout).not.toContain('Agent exited at your request');
  }, 15_000);
});
