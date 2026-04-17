/**
 * Regression test for bugfix #676: `porch approve plan-approval` fails with
 * "Plan not found" when the plan lives in a builder worktree.
 *
 * Reproduction:
 *   1. Architect runs `porch approve NNN plan-approval ...` from the main
 *      workspace root (cwd = repo root).
 *   2. `findStatusPath` (fixed in PR #674) correctly locates the project's
 *      status.yaml inside `.builders/<slug>/codev/projects/...`.
 *   3. BUT the artifact resolver and the cwd passed to `runPhaseChecks` are
 *      still scoped to the main workspace, so the `plan_exists` check looks
 *      at `<main>/codev/plans/` — where the plan does not exist yet —
 *      and fails.
 *
 * Fix: `check`, `done`, and `approve` derive the artifact root from the
 * resolved status path (via `getArtifactRoot`) and rebuild the resolver +
 * check cwd to point at that worktree.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { approve, check, done } from '../index.js';
import { writeState, readState, getStatusPath } from '../state.js';
import type { ProjectState } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Mimic the on-disk layout: `<mainRoot>/.builders/<slug>/...` with its own codev/. */
function makeWorkspace(suffix: string): { mainRoot: string; worktreeRoot: string; worktreeSlug: string } {
  const mainRoot = path.join(tmpdir(), `porch-676-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(mainRoot, { recursive: true });
  const worktreeSlug = 'spir-42-test-feature';
  const worktreeRoot = path.join(mainRoot, '.builders', worktreeSlug);
  fs.mkdirSync(worktreeRoot, { recursive: true });
  return { mainRoot, worktreeRoot, worktreeSlug };
}

function writeProtocol(root: string, protocol: { name: string; [k: string]: unknown }): void {
  const dir = path.join(root, 'codev', 'protocols', protocol.name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'protocol.json'), JSON.stringify(protocol, null, 2));
}

function writeWorktreeStatus(worktreeRoot: string, state: ProjectState): string {
  const statusPath = getStatusPath(worktreeRoot, state.id, state.title);
  fs.mkdirSync(path.dirname(statusPath), { recursive: true });
  writeState(statusPath, state);
  return statusPath;
}

function makeState(overrides: Partial<ProjectState> = {}): ProjectState {
  return {
    id: '0042',
    title: 'test-feature',
    protocol: 'spir-676-test',
    phase: 'plan',
    plan_phases: [],
    current_plan_phase: null,
    gates: {
      'plan-approval': { status: 'pending', requested_at: new Date().toISOString() },
    },
    iteration: 1,
    build_complete: false,
    history: [],
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

// Protocol is saved to disk as JSON and normalized by `loadProtocol`.
// Phase `checks` is an object of name → command (not an array).
const testProtocolJson = {
  name: 'spir-676-test',
  version: '1.0.0',
  phases: [
    {
      id: 'plan',
      name: 'Plan',
      gate: 'plan-approval',
      checks: {
        plan_exists: 'test -f codev/plans/${PROJECT_TITLE}.md',
      },
      next: 'implement',
    },
    { id: 'implement', name: 'Implement', next: null },
  ],
};

// Suppress noisy CLI output; keep process.exit swallowable so we can inspect state.
let logSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code ?? 0})`);
  }) as never);
});

afterEach(() => {
  logSpy.mockRestore();
  exitSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('bugfix #676 — artifact resolver follows worktree status path', () => {
  it('approve resolves plan_exists against the worktree, not the main workspace', async () => {
    const { mainRoot, worktreeRoot } = makeWorkspace('approve');
    writeProtocol(mainRoot, testProtocolJson);
    // Protocol files are read from the main workspace — but artifacts live in the worktree.

    const statusPath = writeWorktreeStatus(worktreeRoot, makeState());

    // Plan exists ONLY in the worktree; the main workspace has NO codev/plans/ directory.
    const worktreePlansDir = path.join(worktreeRoot, 'codev', 'plans');
    fs.mkdirSync(worktreePlansDir, { recursive: true });
    fs.writeFileSync(path.join(worktreePlansDir, '0042-test-feature.md'), '# Plan\n');

    expect(fs.existsSync(path.join(mainRoot, 'codev', 'plans'))).toBe(false);

    // Architect runs approve from main workspace root
    await approve(mainRoot, '0042', 'plan-approval', true);

    // Gate should be approved (checks passed because resolver found the plan in the worktree)
    const updated = readState(statusPath);
    expect(updated.gates['plan-approval'].status).toBe('approved');
    expect(updated.gates['plan-approval'].approved_at).toBeDefined();
  });

  it('approve fails cleanly when the plan is missing from the worktree', async () => {
    const { mainRoot, worktreeRoot } = makeWorkspace('approve-missing');
    writeProtocol(mainRoot, testProtocolJson);
    const statusPath = writeWorktreeStatus(worktreeRoot, makeState());

    // Writing a plan in the MAIN workspace must NOT trick the check into
    // approving the gate — only the worktree is authoritative.
    const mainPlansDir = path.join(mainRoot, 'codev', 'plans');
    fs.mkdirSync(mainPlansDir, { recursive: true });
    fs.writeFileSync(path.join(mainPlansDir, '0042-test-feature.md'), '# Decoy\n');

    await expect(approve(mainRoot, '0042', 'plan-approval', true)).rejects.toThrow(/process\.exit/);

    // Gate must NOT be approved when the worktree lacks the plan
    const updated = readState(statusPath);
    expect(updated.gates['plan-approval'].status).toBe('pending');
    expect(updated.gates['plan-approval'].approved_at).toBeUndefined();
  });

  it('check resolves plan_exists against the worktree', async () => {
    const { mainRoot, worktreeRoot } = makeWorkspace('check');
    writeProtocol(mainRoot, testProtocolJson);
    writeWorktreeStatus(worktreeRoot, makeState());

    const worktreePlansDir = path.join(worktreeRoot, 'codev', 'plans');
    fs.mkdirSync(worktreePlansDir, { recursive: true });
    fs.writeFileSync(path.join(worktreePlansDir, '0042-test-feature.md'), '# Plan\n');

    // check() prints results but must not throw when all checks pass
    await expect(check(mainRoot, '0042')).resolves.toBeUndefined();
  });

  it('done resolves plan_exists against the worktree', async () => {
    const { mainRoot, worktreeRoot } = makeWorkspace('done');
    // Protocol where the plan phase has no gate, so done() will attempt to advance
    const protocolNoGate = {
      name: 'spir-676-test-done',
      version: '1.0.0',
      phases: [
        {
          id: 'plan',
          name: 'Plan',
          checks: { plan_exists: 'test -f codev/plans/${PROJECT_TITLE}.md' },
          next: 'review',
        },
        { id: 'review', name: 'Review', next: null },
      ],
    };
    writeProtocol(mainRoot, protocolNoGate);

    const state = makeState({ protocol: 'spir-676-test-done', gates: {} });
    const statusPath = writeWorktreeStatus(worktreeRoot, state);

    const worktreePlansDir = path.join(worktreeRoot, 'codev', 'plans');
    fs.mkdirSync(worktreePlansDir, { recursive: true });
    fs.writeFileSync(path.join(worktreePlansDir, '0042-test-feature.md'), '# Plan\n');

    await done(mainRoot, '0042');

    const updated = readState(statusPath);
    expect(updated.phase).toBe('review');
  });
});
