/**
 * Tests for `porch skip-phase` (GitHub Issue #1900).
 *
 * Plan phases are snapshotted into status.yaml once, on entering implement, so
 * a phase the owner drops from the approved plan stays pending forever and the
 * review phase is unreachable. `porch skip-phase` drops one unbuilt phase from
 * state, records why, and advances.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { skipPhase } from '../index.js';
import { advancePlanPhase, getCurrentPlanPhase, skipPlanPhase } from '../plan.js';
import { writeState, readState, getStatusPath } from '../state.js';
import type { PlanPhase, ProjectState } from '../types.js';

const HUMAN = true;

// The REAL shipped SPIR protocol, not a hand-written fixture: implement's
// successor lives in `transition.on_all_phases_complete`, and a fixture with a
// plain `next: 'review'` hid a bug where skipping looped back to implement.
const SPIR_PROTOCOL = path.resolve(__dirname, '../../../../../../codev-skeleton/protocols/spir/protocol.json');

function phases(...statuses: PlanPhase['status'][]): PlanPhase[] {
  return statuses.map((status, i) => ({ id: `phase_${i + 1}`, title: `Phase ${i + 1}`, status }));
}

function makeState(overrides: Partial<ProjectState> = {}): ProjectState {
  return {
    id: '0042',
    title: 'test-feature',
    protocol: 'spir',
    phase: 'implement',
    plan_phases: phases('complete', 'in_progress', 'pending'),
    current_plan_phase: 'phase_2',
    gates: {
      'spec-approval': { status: 'approved' },
      'plan-approval': { status: 'approved' },
    },
    iteration: 3,
    build_complete: true,
    history: [],
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('porch skip-phase (issue #1900)', () => {
  let testDir: string;
  let statusPath: string;

  function seed(overrides: Partial<ProjectState> = {}): void {
    statusPath = getStatusPath(testDir, '0042', 'test-feature');
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
    writeState(statusPath, makeState(overrides));
  }

  beforeEach(() => {
    testDir = path.join(tmpdir(), `porch-skip-phase-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const protocolDir = path.join(testDir, 'codev', 'protocols', 'spir');
    fs.mkdirSync(protocolDir, { recursive: true });
    fs.copyFileSync(SPIR_PROTOCOL, path.join(protocolDir, 'protocol.json'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('skipping the last unsettled phase reaches review', async () => {
    // The reported case: earlier phases built, the owner dropped the last one.
    seed({ plan_phases: phases('complete', 'complete', 'in_progress'), current_plan_phase: 'phase_3' });

    await skipPhase(testDir, '0042', 'phase_3', 'dropped by owner', HUMAN);

    const s = readState(statusPath);
    expect(s.phase).toBe('review');
    expect(s.current_plan_phase).toBeNull();
    expect(s.iteration).toBe(1);
    expect(s.build_complete).toBe(false);
    expect(s.plan_phases[2]).toMatchObject({ status: 'skipped', skip_reason: 'dropped by owner' });
    expect(s.plan_phases[2].skipped_at).toEqual(expect.any(String));
  });

  it('skipping a pending last phase reaches review once the current phase completes', async () => {
    seed(); // phase_2 in progress, phase_3 pending

    await skipPhase(testDir, '0042', 'phase_3', 'out of scope', HUMAN);

    const s = readState(statusPath);
    expect(s.phase).toBe('implement');
    expect(s.current_plan_phase).toBe('phase_2');
    // Skipping a phase that is not under construction leaves the in-flight cycle alone.
    expect(s.iteration).toBe(3);
    expect(s.build_complete).toBe(true);

    const { phases: after, moveToReview } = advancePlanPhase(s.plan_phases, 'phase_2');
    expect(moveToReview).toBe(true);
    expect(after.map(p => p.status)).toEqual(['complete', 'complete', 'skipped']);
  });

  it('skipping the in-progress middle phase advances to the next one', async () => {
    seed();

    await skipPhase(testDir, '0042', 'phase_2', 'superseded', HUMAN);

    const s = readState(statusPath);
    expect(s.phase).toBe('implement');
    expect(s.current_plan_phase).toBe('phase_3');
    expect(s.plan_phases.map(p => p.status)).toEqual(['complete', 'skipped', 'in_progress']);
    expect(s.iteration).toBe(1);
    expect(s.build_complete).toBe(false);
  });

  it('a skipped pending middle phase is stepped over, not resurrected, on advance', async () => {
    seed({ plan_phases: phases('in_progress', 'pending', 'pending'), current_plan_phase: 'phase_1' });

    await skipPhase(testDir, '0042', 'phase_2', 'not needed', HUMAN);

    const s = readState(statusPath);
    expect(s.current_plan_phase).toBe('phase_1');
    const { phases: after, moveToReview } = advancePlanPhase(s.plan_phases, 'phase_1');
    expect(after.map(p => p.status)).toEqual(['complete', 'skipped', 'in_progress']);
    expect(getCurrentPlanPhase(after)?.id).toBe('phase_3');
    expect(moveToReview).toBe(false);
  });

  it('refuses to skip a completed phase', async () => {
    seed();
    await expect(skipPhase(testDir, '0042', 'phase_1', 'oops', HUMAN)).rejects.toThrow('already complete');
    expect(readState(statusPath).plan_phases[0].status).toBe('complete');
  });

  it('refuses without the human flag, and writes nothing', async () => {
    seed();
    const before = fs.readFileSync(statusPath, 'utf-8');
    await expect(skipPhase(testDir, '0042', 'phase_3', 'dropped', false)).rejects.toThrow('Human approval required');
    expect(fs.readFileSync(statusPath, 'utf-8')).toBe(before);
  });

  it('refuses without a reason', async () => {
    seed();
    await expect(skipPhase(testDir, '0042', 'phase_3', '  ', HUMAN)).rejects.toThrow('--reason is required');
  });

  it('refuses an unknown plan phase, listing the valid ones', async () => {
    seed();
    await expect(skipPhase(testDir, '0042', 'phase_9', 'x', HUMAN)).rejects.toThrow(/Unknown plan phase: phase_9[\s\S]*phase_1, phase_2, phase_3/);
  });

  it('refuses outside a per-plan-phase protocol phase', async () => {
    seed({ phase: 'review', plan_phases: phases('complete', 'skipped'), current_plan_phase: null });
    await expect(skipPhase(testDir, '0042', 'phase_2', 'x', HUMAN)).rejects.toThrow('only applies while plan phases are being implemented');
  });

  it('refuses to skip an already-skipped phase', () => {
    const skipped = skipPlanPhase(phases('in_progress', 'pending'), 'phase_2', 'first', 'now').phases;
    expect(() => skipPlanPhase(skipped, 'phase_2', 'again', 'now')).toThrow('already skipped (reason: first)');
  });
});
