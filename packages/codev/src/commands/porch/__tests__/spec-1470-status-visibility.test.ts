/**
 * Spec 1470, Phase 6 — stalled-refresh visibility.
 *
 * ## The failure this makes visible
 *
 * A refresh is unattended, and its worst outcome is silent: the builder clears,
 * the re-entry never arrives, and **a stalled builder looks exactly like a busy
 * one**. Nothing in the system says otherwise.
 *
 * ## Why an acknowledgment rather than a timestamp
 *
 * The plan originally proposed deriving the stall from `updated_at`. That does
 * not work, and the reason is worth stating because it is not obvious: `next()`
 * writes no state on the normal task-emission path, so `updated_at` stays pinned
 * at the transition for the whole of a healthy build. Any threshold long enough
 * to avoid false positives during a long build is far too long to catch the
 * stall it exists for.
 *
 * So porch records the fact. Reaching the normal path means a builder came back
 * and asked for work — the only evidence porch has — and a boundary recorded but
 * never acknowledged therefore means exactly one thing: nobody returned.
 */

import { describe, it, expect } from 'vitest';
import {
  acknowledgeRefreshes,
  unacknowledgedRefreshes,
} from '../context-refresh.js';
import type { ProjectState } from '../types.js';

function stateWith(
  refreshes: ProjectState['context_refreshes'],
): ProjectState {
  return {
    id: '1470',
    title: 'ctx',
    protocol: 'spir',
    phase: 'implement',
    plan_phases: [],
    current_plan_phase: null,
    gates: {},
    iteration: 1,
    build_complete: false,
    history: [],
    started_at: 'T0',
    updated_at: 'T0',
    context_refreshes: refreshes,
  };
}

describe('acknowledgeRefreshes', () => {
  it('marks an unacknowledged boundary and reports that it changed', () => {
    const state = stateWith([{ boundary: 'enter:review', at: 'T1' }]);

    expect(acknowledgeRefreshes(state, 'T2')).toBe(true);
    expect(state.context_refreshes?.[0].acknowledged_at).toBe('T2');
  });

  it('writes at most ONCE per boundary', () => {
    // The acknowledgment costs a state write. Once per refresh is acceptable;
    // once per `porch next` would put a commit on every task emission.
    const state = stateWith([{ boundary: 'enter:review', at: 'T1' }]);

    expect(acknowledgeRefreshes(state, 'T2')).toBe(true);
    expect(acknowledgeRefreshes(state, 'T3')).toBe(false);
    expect(acknowledgeRefreshes(state, 'T4')).toBe(false);
    // And the original timestamp survives — it records when the builder
    // returned, not when someone last looked.
    expect(state.context_refreshes?.[0].acknowledged_at).toBe('T2');
  });

  it('acknowledges every outstanding boundary, not just the newest', () => {
    const state = stateWith([
      { boundary: 'enter:plan', at: 'T1' },
      { boundary: 'enter:implement', at: 'T2' },
    ]);

    expect(acknowledgeRefreshes(state, 'T3')).toBe(true);
    expect(state.context_refreshes?.every(r => r.acknowledged_at === 'T3')).toBe(true);
  });

  it('leaves already-acknowledged records alone', () => {
    const state = stateWith([
      { boundary: 'enter:plan', at: 'T1', acknowledged_at: 'T2' },
      { boundary: 'enter:implement', at: 'T3' },
    ]);

    expect(acknowledgeRefreshes(state, 'T4')).toBe(true);
    expect(state.context_refreshes?.[0].acknowledged_at).toBe('T2');
    expect(state.context_refreshes?.[1].acknowledged_at).toBe('T4');
  });

  it('is a no-op with no refreshes at all', () => {
    const none = stateWith(undefined);
    expect(acknowledgeRefreshes(none, 'T1')).toBe(false);
    const empty = stateWith([]);
    expect(acknowledgeRefreshes(empty, 'T1')).toBe(false);
  });
});

describe('unacknowledgedRefreshes', () => {
  it('reports a boundary nobody returned from', () => {
    const state = stateWith([
      { boundary: 'enter:plan', at: 'T1', acknowledged_at: 'T2' },
      { boundary: 'enter:review', at: 'T3' },
    ]);

    const stalled = unacknowledgedRefreshes(state);
    expect(stalled).toHaveLength(1);
    expect(stalled[0].boundary).toBe('enter:review');
    expect(stalled[0].at).toBe('T3');
  });

  it('reports nothing for a healthy project', () => {
    // The signal only means something if it is usually silent.
    const state = stateWith([
      { boundary: 'enter:plan', at: 'T1', acknowledged_at: 'T2' },
      { boundary: 'enter:implement', at: 'T3', acknowledged_at: 'T4' },
    ]);
    expect(unacknowledgedRefreshes(state)).toHaveLength(0);
  });

  it('reports nothing when no refresh has happened', () => {
    expect(unacknowledgedRefreshes(stateWith(undefined))).toHaveLength(0);
  });

  it('does NOT use elapsed time, so a long healthy build is never flagged', () => {
    // The whole reason this is a recorded fact rather than a timestamp
    // comparison: `updated_at` does not move during a healthy build, so any
    // time-based rule would fire on exactly the projects that are fine.
    const acknowledgedLongAgo = stateWith([
      { boundary: 'enter:implement', at: '2020-01-01T00:00:00Z', acknowledged_at: '2020-01-01T00:00:01Z' },
    ]);
    expect(unacknowledgedRefreshes(acknowledgedLongAgo)).toHaveLength(0);
  });

  it('flags a stall immediately, without waiting for a threshold', () => {
    // Symmetric to the case above: an unacknowledged boundary is suspicious as
    // soon as it exists. "How long has it been" is shown to the human rather
    // than used to decide.
    const justNow = stateWith([{ boundary: 'enter:review', at: new Date().toISOString() }]);
    expect(unacknowledgedRefreshes(justNow)).toHaveLength(1);
  });
});

describe('the two functions agree', () => {
  it('acknowledging clears exactly what unacknowledgedRefreshes reported', () => {
    // Guards against the pair drifting apart — one reading a field the other
    // does not write would make the warning permanent or never appear.
    const state = stateWith([
      { boundary: 'enter:plan', at: 'T1' },
      { boundary: 'plan-phase:phase_2', at: 'T2' },
    ]);

    expect(unacknowledgedRefreshes(state)).toHaveLength(2);
    acknowledgeRefreshes(state, 'T3');
    expect(unacknowledgedRefreshes(state)).toHaveLength(0);
  });
});
