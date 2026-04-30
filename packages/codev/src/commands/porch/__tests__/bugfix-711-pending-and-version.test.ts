/**
 * Regression test for issue #711:
 *   - `porch --version` should print the package version, not help.
 *   - `porch pending` should be a real command (was documented but missing).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { cli, pending } from '../index.js';
import { writeState, getStatusPath } from '../state.js';
import type { ProjectState } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestDir(prefix: string): string {
  const dir = path.join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeState(overrides: Partial<ProjectState> = {}): ProjectState {
  const now = new Date().toISOString();
  return {
    id: '0001',
    title: 'test-feature',
    protocol: 'spir',
    phase: 'specify',
    plan_phases: [],
    current_plan_phase: null,
    gates: {},
    iteration: 1,
    build_complete: false,
    history: [],
    started_at: now,
    updated_at: now,
    ...overrides,
  };
}

function writeProject(workspaceRoot: string, state: ProjectState): string {
  const statusPath = getStatusPath(workspaceRoot, state.id, state.title);
  fs.mkdirSync(path.dirname(statusPath), { recursive: true });
  writeState(statusPath, state);
  return statusPath;
}

function captureStdout<T>(fn: () => Promise<T>): Promise<{ result: T; stdout: string }> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(' '));
  });
  return fn()
    .then((result) => ({ result, stdout: lines.join('\n') }))
    .finally(() => spy.mockRestore());
}

// ---------------------------------------------------------------------------
// --version
// ---------------------------------------------------------------------------

describe('porch --version', () => {
  it('prints a semver-shaped version string and does not exit', async () => {
    const { stdout } = await captureStdout(() => cli(['--version']));
    expect(stdout).toMatch(/^\d+\.\d+\.\d+/);
    // Crucially: it does NOT print the help banner.
    expect(stdout).not.toContain('Protocol Orchestrator');
  });

  it('-v shorthand also prints the version', async () => {
    const { stdout } = await captureStdout(() => cli(['-v']));
    expect(stdout).toMatch(/^\d+\.\d+\.\d+/);
  });
});

// ---------------------------------------------------------------------------
// pending
// ---------------------------------------------------------------------------

describe('porch pending', () => {
  let testDir: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    testDir = createTestDir('porch-711-pending');
    process.chdir(testDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('reports "no gates pending" when the workspace is empty', async () => {
    const { stdout } = await captureStdout(() => pending(testDir));
    expect(stdout).toContain('No gates pending approval');
  });

  it('lists projects whose gate is pending and has a requested_at timestamp', async () => {
    writeProject(
      testDir,
      makeState({
        id: '0042',
        title: 'feature-a',
        gates: {
          'spec-approval': { status: 'pending', requested_at: '2026-01-01T00:00:00Z' },
        },
      }),
    );
    writeProject(
      testDir,
      makeState({
        id: '0043',
        title: 'feature-b',
        phase: 'plan',
        gates: {
          'plan-approval': { status: 'approved', approved_at: '2026-01-02T00:00:00Z' },
        },
      }),
    );

    const { stdout } = await captureStdout(() => pending(testDir));

    expect(stdout).toContain('1 gate pending approval');
    expect(stdout).toContain('0042');
    expect(stdout).toContain('feature-a');
    expect(stdout).toContain('spec-approval');
    // approved gates and projects without a pending gate must NOT appear.
    expect(stdout).not.toContain('0043');
    expect(stdout).not.toContain('plan-approval');
  });

  it('skips pending gates that have not yet been requested', async () => {
    // Gate is "pending" by default but no requested_at — porch hasn't asked
    // for human approval yet, so it shouldn't be surfaced as actionable.
    writeProject(
      testDir,
      makeState({
        gates: { 'spec-approval': { status: 'pending' } },
      }),
    );

    const { stdout } = await captureStdout(() => pending(testDir));
    expect(stdout).toContain('No gates pending approval');
  });

  it('finds gates inside builder worktrees under .builders/*', async () => {
    const worktreeRoot = path.join(testDir, '.builders', 'spir-77-thing');
    fs.mkdirSync(worktreeRoot, { recursive: true });
    writeProject(
      worktreeRoot,
      makeState({
        id: '0077',
        title: 'thing',
        phase: 'plan',
        gates: {
          'plan-approval': { status: 'pending', requested_at: '2026-04-30T00:00:00Z' },
        },
      }),
    );

    const { stdout } = await captureStdout(() => pending(testDir));
    expect(stdout).toContain('0077');
    expect(stdout).toContain('plan-approval');
  });

  it('sorts oldest-requested first', async () => {
    writeProject(
      testDir,
      makeState({
        id: '0050',
        title: 'newer',
        gates: { 'spec-approval': { status: 'pending', requested_at: '2026-04-29T00:00:00Z' } },
      }),
    );
    writeProject(
      testDir,
      makeState({
        id: '0049',
        title: 'older',
        gates: { 'spec-approval': { status: 'pending', requested_at: '2026-04-15T00:00:00Z' } },
      }),
    );

    const { stdout } = await captureStdout(() => pending(testDir));
    const olderIdx = stdout.indexOf('0049');
    const newerIdx = stdout.indexOf('0050');
    expect(olderIdx).toBeGreaterThan(-1);
    expect(newerIdx).toBeGreaterThan(-1);
    expect(olderIdx).toBeLessThan(newerIdx);
  });
});
