/**
 * Issue #1950 — `porch -C <dir>`: run as if porch had been started in `<dir>`, like `git -C`.
 *
 * The case it exists for: an architect checks a builder's project without `cd`-ing into the
 * worktree (a `cd` that persists later nests builders when `afx spawn` runs from there).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { cli } from '../index.js';
import { writeState, getStatusPath, readState } from '../state.js';
import type { ProjectState } from '../types.js';

function setupProtocol(root: string): void {
  const dir = path.join(root, 'codev', 'protocols', 'pir');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'protocol.json'), JSON.stringify({
    name: 'pir',
    version: '1.0.0',
    phases: [
      { id: 'plan', name: 'Plan', type: 'build_verify', gate: 'plan-approval', next: 'implement' },
      { id: 'implement', name: 'Implement', type: 'build_verify', next: null },
    ],
  }));
}

const state = (): ProjectState => ({
  id: '842', title: 'fix-avatar-crop', protocol: 'pir', phase: 'plan', plan_phases: [],
  current_plan_phase: null, gates: { 'plan-approval': { status: 'pending', requested_at: '2026-11-01T00:00:00.000Z' } },
  iteration: 1, build_complete: true, history: [],
  started_at: '2026-11-01T00:00:00.000Z', updated_at: '2026-11-01T00:00:00.000Z',
});

describe('porch -C <dir> (#1950)', () => {
  const origCwd = process.cwd();
  let root: string;
  let worktree: string;
  let elsewhere: string;
  let stdout: string[];
  let stderr: string[];
  let exitCode: number | null;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'air-1950-porch-c-')));
    worktree = path.join(root, 'repo', '.builders', 'pir-842-fix-avatar-crop');
    elsewhere = path.join(root, 'elsewhere');
    fs.mkdirSync(worktree, { recursive: true });
    fs.mkdirSync(elsewhere);
    setupProtocol(worktree);
    writeState(getStatusPath(worktree, '842', 'fix-avatar-crop'), state());

    stdout = [];
    stderr = [];
    exitCode = null;
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { stdout.push(String(chunk)); return true; });
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { stdout.push(a.map(String).join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { stderr.push(a.map(String).join(' ')); });
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      if (exitCode === null) exitCode = code ?? 0;
      throw new Error('__process_exit__');
    }) as never);
  });

  afterEach(() => {
    process.chdir(origCwd);
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function run(cwd: string, args: string[]): Promise<string> {
    process.chdir(cwd);
    stdout.length = 0;
    await cli(args).catch((e: Error) => { if (e.message !== '__process_exit__') throw e; });
    return stdout.join('\n');
  }

  /** The `--json` line; an auto-detected project is announced on a line of its own before it. */
  const json = (out: string) => JSON.parse(out.split('\n').filter((l) => l.startsWith('{')).pop()!);

  it('resolves the same project as running from inside the directory', async () => {
    const inside = await run(worktree, ['status', '--json']);
    const viaC = await run(elsewhere, ['-C', worktree, 'status', '--json']);
    expect(json(viaC)).toEqual(json(inside));
    expect(json(viaC)).toMatchObject({ id: '842', gate: 'plan-approval', gate_status: 'pending' });
  });

  it('prints the directory it resolved, on stderr', async () => {
    await run(elsewhere, ['-C', path.relative(elsewhere, worktree), 'status', '--json']);
    expect(stderr.join('\n')).toContain(`[porch -C: running in ${worktree}]`);
  });

  it('composes like git: each -C resolves against the last', async () => {
    const viaTwo = await run(elsewhere, ['-C', path.join(root, 'repo'), '-C', '.builders/pir-842-fix-avatar-crop', 'status', '--json']);
    expect(json(viaTwo)).toMatchObject({ id: '842' });
  });

  it('grants nothing: approve still requires the human-approval flag', async () => {
    const out = await run(elsewhere, ['-C', worktree, 'approve', '842', 'plan-approval']);
    expect(exitCode).toBe(1);
    expect(out).toContain('Human approval required');
    const statusPath = getStatusPath(worktree, '842', 'fix-avatar-crop');
    expect(readState(statusPath).gates['plan-approval'].status).toBe('pending');
  });

  it('grants nothing: skip-phase still requires the human-approval flag', async () => {
    await run(elsewhere, ['-C', worktree, 'skip-phase', '842', 'phase_1', '--reason', 'x']);
    expect(exitCode).toBe(1);
  });

  it('refuses a directory that does not exist', async () => {
    await run(elsewhere, ['-C', path.join(root, 'nope'), 'status']);
    expect(exitCode).toBe(1);
    expect(stderr.join('\n')).toContain('not a directory');
  });

  it('refuses -C with no directory', async () => {
    await run(elsewhere, ['-C']);
    expect(exitCode).toBe(1);
    expect(stderr.join('\n')).toContain('-C requires a directory');
  });
});
