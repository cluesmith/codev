/**
 * cluesmith/codev#1759 — `porch pending` listed dead gate records.
 *
 * A long-lived workspace showed 810 "pending" gates with none live: records
 * left `pending` on projects that had moved past the gate, finished, or merged
 * their PR, and the same committed status.yaml counted once per builder
 * worktree copy. `pending` now hides those (listing only — no record changes)
 * and dedupes by project id with the root copy winning. `--all` shows the raw
 * view.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { pending, isStalePendingGate } from '../index.js';
import { writeState } from '../state.js';
import type { ProjectState, Protocol } from '../types.js';

function setupProtocol(root: string): void {
  const dir = path.join(root, 'codev', 'protocols', 'pir');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'protocol.json'),
    JSON.stringify({
      name: 'pir',
      version: '1.0.0',
      phases: [
        { id: 'plan', name: 'Plan', type: 'build_verify', gate: 'plan-approval', next: 'implement' },
        { id: 'implement', name: 'Implement', type: 'build_verify', gate: 'dev-approval', next: 'review' },
        { id: 'review', name: 'Review', type: 'build_verify', gate: 'pr', next: null },
      ],
    }),
  );
}

function makeState(overrides: Partial<ProjectState> = {}): ProjectState {
  return {
    id: 'pir-1',
    title: 'one',
    protocol: 'pir',
    phase: 'plan',
    plan_phases: [],
    current_plan_phase: null,
    gates: {},
    iteration: 1,
    build_complete: false,
    history: [],
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function writeProject(root: string, state: ProjectState): void {
  const dir = path.join(root, 'codev', 'projects', `${state.id}-${state.title}`);
  fs.mkdirSync(dir, { recursive: true });
  writeState(path.join(dir, 'status.yaml'), state);
}

const PENDING = { status: 'pending' as const, requested_at: '2026-02-19T23:08:54.715Z' };

describe('isStalePendingGate', () => {
  const protocol: Protocol = {
    name: 'pir',
    version: '1.0.0',
    phases: [
      { id: 'plan', name: 'Plan', type: 'build_verify', gate: 'plan-approval', next: 'implement' },
      { id: 'implement', name: 'Implement', type: 'build_verify', gate: 'dev-approval', next: 'review' },
      { id: 'review', name: 'Review', type: 'build_verify', gate: 'pr', next: null },
    ],
  } as unknown as Protocol;

  it('a gate on the current phase is live', () => {
    expect(isStalePendingGate(makeState({ phase: 'plan' }), 'plan-approval', protocol)).toBe(false);
  });

  it('a gate on a phase the project has left is stale', () => {
    expect(isStalePendingGate(makeState({ phase: 'review' }), 'plan-approval', protocol)).toBe(true);
  });

  it('a finished protocol (terminal phase) is stale for every gate', () => {
    expect(isStalePendingGate(makeState({ phase: 'verified' }), 'pr', protocol)).toBe(true);
    expect(isStalePendingGate(makeState({ phase: 'complete' }), 'pr', protocol)).toBe(true);
  });

  it('a recorded merged PR is stale for every gate', () => {
    const state = makeState({
      phase: 'review',
      pr_history: [{ phase: 'review', pr_number: 7, branch: 'b', created_at: 'x', merged: true }],
    });
    expect(isStalePendingGate(state, 'pr', protocol)).toBe(true);
  });

  it('without a protocol only the terminal/merged rules apply', () => {
    expect(isStalePendingGate(makeState({ phase: 'review' }), 'plan-approval', null)).toBe(false);
    expect(isStalePendingGate(makeState({ phase: 'verified' }), 'plan-approval', null)).toBe(true);
  });
});

describe('porch pending hides stale records and dedupes worktree copies', () => {
  let root: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  const output = () => logSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(tmpdir(), 'porch-pending-'));
    setupProtocol(root);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('lists only the live gate and reports the hidden count', async () => {
    // live: waiting at plan-approval
    writeProject(root, makeState({ id: 'pir-1', title: 'live', phase: 'plan', gates: { 'plan-approval': PENDING } }));
    // stale: moved past the gate
    writeProject(root, makeState({ id: 'pir-2', title: 'advanced', phase: 'review', gates: { 'plan-approval': PENDING } }));
    // stale: finished
    writeProject(root, makeState({ id: 'pir-3', title: 'done', phase: 'verified', gates: { pr: PENDING } }));
    // stale: merged PR on record
    writeProject(root, makeState({
      id: 'pir-4', title: 'merged', phase: 'review', gates: { pr: PENDING },
      pr_history: [{ phase: 'review', pr_number: 9, branch: 'b', created_at: 'x', merged: true }],
    }));

    await pending(root);
    const out = output();
    expect(out).toContain('1 gate pending approval');
    expect(out).toContain('pir-1');
    expect(out).not.toContain('pir-2');
    expect(out).not.toContain('pir-3');
    expect(out).not.toContain('pir-4');
    expect(out).toContain('3 stale pending records');
  });

  it('--all shows the raw view', async () => {
    writeProject(root, makeState({ id: 'pir-1', title: 'live', phase: 'plan', gates: { 'plan-approval': PENDING } }));
    writeProject(root, makeState({ id: 'pir-3', title: 'done', phase: 'verified', gates: { pr: PENDING } }));

    await pending(root, { all: true });
    const out = output();
    expect(out).toContain('2 gates pending approval');
    expect(out).toContain('pir-3');
    expect(out).not.toContain('stale pending record');
  });

  it('counts a project once even when a builder worktree holds a copy of its status.yaml', async () => {
    const live = makeState({ id: 'pir-1', title: 'live', phase: 'plan', gates: { 'plan-approval': PENDING } });
    writeProject(root, live);
    const wt = path.join(root, '.builders', 'bugfix-1');
    writeProject(wt, live);
    // a project only the worktree knows about is still listed
    writeProject(wt, makeState({ id: 'pir-5', title: 'wt-only', phase: 'plan', gates: { 'plan-approval': PENDING } }));

    await pending(root);
    const out = output();
    expect(out).toContain('2 gates pending approval');
    expect((out.match(/porch approve pir-1 /g) ?? []).length).toBe(1);
    expect(out).toContain('pir-5');
  });
});
