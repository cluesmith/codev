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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import * as yaml from 'js-yaml';
import {
  REFRESH_STALL_GRACE_MS,
  acknowledgeRefreshes,
  stalledRefreshes,
  unacknowledgedRefreshes,
} from '../context-refresh.js';
import { status } from '../index.js';
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

  it('reports the raw fact regardless of age — history, not judgement', () => {
    const justNow = stateWith([{ boundary: 'enter:review', at: new Date().toISOString() }]);
    expect(unacknowledgedRefreshes(justNow)).toHaveLength(1);
  });
});

describe('stalledRefreshes — the grace period', () => {
  const now = Date.parse('2026-08-19T12:00:00Z');

  it('does NOT warn while a healthy refresh is still in flight', () => {
    // The defect this fixes: warning on any unacknowledged boundary meant a
    // stall was reported during EVERY normal refresh. A signal that fires
    // during normal operation is not a signal.
    const inFlight = stateWith([
      { boundary: 'enter:review', at: new Date(now - 30_000).toISOString() },
    ]);
    expect(stalledRefreshes(inFlight, now)).toHaveLength(0);
  });

  it('warns once the boundary is older than the grace period', () => {
    const stalled = stateWith([
      { boundary: 'enter:review', at: new Date(now - REFRESH_STALL_GRACE_MS - 1000).toISOString() },
    ]);
    const result = stalledRefreshes(stalled, now);
    expect(result).toHaveLength(1);
    expect(result[0].ageMs).toBeGreaterThan(REFRESH_STALL_GRACE_MS);
  });

  it('never warns about an acknowledged boundary, however old', () => {
    const old = stateWith([
      { boundary: 'enter:implement', at: '2020-01-01T00:00:00Z', acknowledged_at: '2020-01-01T00:00:30Z' },
    ]);
    expect(stalledRefreshes(old, now)).toHaveLength(0);
  });

  it('treats an unparseable timestamp as stalled rather than ignoring it', () => {
    // NaN comparisons are all false, so a naive filter would silently never
    // warn. A record we cannot age is a record we cannot vouch for.
    const broken = stateWith([{ boundary: 'enter:review', at: 'not-a-date' }]);
    expect(stalledRefreshes(broken, now)).toHaveLength(1);
  });

  it('is exactly at the boundary inclusive, so the threshold is not off by one', () => {
    const exact = stateWith([
      { boundary: 'enter:review', at: new Date(now - REFRESH_STALL_GRACE_MS).toISOString() },
    ]);
    expect(stalledRefreshes(exact, now)).toHaveLength(1);
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


// ---------------------------------------------------------------------------
// status() itself — the wiring, not just the helpers
// ---------------------------------------------------------------------------

/**
 * Tests the OUTPUT, because helper tests cannot see whether `status()` renders
 * any of it. Codex found that removing the entire history section, the warning,
 * the recovery line, or the new JSON fields would have left the helper tests
 * green — the fourth instance of that gap on this project.
 */
describe('status() output', () => {
  let root: string;
  let logged: string[];

  const PROJECT = '9470-ctx';

  function writeProject(refreshes: ProjectState['context_refreshes']): void {
    const dir = path.join(root, 'codev/projects', PROJECT);
    fs.mkdirSync(dir, { recursive: true });
    const state = stateWith(refreshes);
    state.id = '9470';
    state.title = 'ctx';
    state.protocol = 'fixture-spir';
    // A PHASED project with a current plan phase, so the pre-existing
    // CURRENT / FROM THE PLAN / CRITICAL RULES output is reachable. The first
    // version of this fixture had no plan phases, which is why it could not see
    // that the new section had swallowed that block.
    state.plan_phases = [
      { id: 'phase_1_a', title: 'A', status: 'in_progress' },
      { id: 'phase_2_b', title: 'B', status: 'pending' },
    ];
    state.current_plan_phase = 'phase_1_a';
    fs.writeFileSync(path.join(dir, 'status.yaml'), yaml.dump(state));

    const proto = path.join(root, 'codev/protocols/fixture-spir');
    fs.mkdirSync(proto, { recursive: true });
    fs.writeFileSync(
      path.join(proto, 'protocol.json'),
      JSON.stringify({
        name: 'fixture-spir',
        version: '1.0.0',
        description: 'f',
        phases: [
          {
            id: 'implement',
            name: 'Implement',
            type: 'per_plan_phase',
            build: { prompt: 'i.md', artifact: 'src/**/*.ts' },
            verify: { type: 'impl', models: ['codex', 'claude'] },
          },
        ],
      }),
    );
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(tmpdir(), 'porch-status-1470-'));
    logged = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logged.push(args.join(' '));
    });
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      logged.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const out = (): string => logged.join('\n');

  it('renders the refresh history', async () => {
    writeProject([
      { boundary: 'enter:plan', at: '2026-08-19T10:00:00Z', acknowledged_at: '2026-08-19T10:00:20Z' },
    ]);

    await status(root, '9470');

    expect(out()).toMatch(/CONTEXT REFRESHES/);
    expect(out()).toMatch(/enter:plan/);
  });

  it('shows NO stall warning for a healthy project', async () => {
    writeProject([
      { boundary: 'enter:plan', at: '2026-08-19T10:00:00Z', acknowledged_at: '2026-08-19T10:00:20Z' },
    ]);

    await status(root, '9470');

    expect(out()).not.toMatch(/never acknowledged/);
    expect(out()).not.toMatch(/⚠/);
  });

  it('shows a refresh in flight as in-flight, not as a fault', async () => {
    writeProject([{ boundary: 'enter:review', at: new Date().toISOString() }]);

    await status(root, '9470');

    expect(out()).toMatch(/in flight/i);
    expect(out()).not.toMatch(/never acknowledged/);
  });

  it('warns AND gives the recovery command once a refresh is stalled', async () => {
    const old = new Date(Date.now() - REFRESH_STALL_GRACE_MS - 60_000).toISOString();
    writeProject([{ boundary: 'enter:review', at: old }]);

    await status(root, '9470');

    expect(out()).toMatch(/never acknowledged/);
    // The recovery line matters as much as the warning: whoever reads this is
    // not necessarily whoever built the feature.
    expect(out()).toMatch(/afx send/);
    expect(out()).toMatch(/\.builder-reorient\.md/);
  });

  it('says nothing at all when no refresh has happened', async () => {
    writeProject(undefined);

    await status(root, '9470');

    expect(out()).not.toMatch(/CONTEXT REFRESHES/);
  });

  it('REGRESSION: still shows CURRENT and CRITICAL RULES with no refreshes', async () => {
    // The new section was nested such that it swallowed the pre-existing
    // CURRENT / FROM THE PLAN / CRITICAL RULES block for any project without
    // refreshes — legacy projects, non-declaring protocols, and SPIR before its
    // first plan-phase advance. 458 porch tests passed with that regression
    // present, because none of them invoked status().
    writeProject(undefined);

    await status(root, '9470');

    expect(out()).toMatch(/CURRENT: phase_1_a/);
    expect(out()).toMatch(/CRITICAL RULES/);
    expect(out()).toMatch(/DO NOT start/);
  });

  it('shows CURRENT and CRITICAL RULES alongside the refresh section', async () => {
    // Both, not either: adding a section must not displace what was there.
    writeProject([
      { boundary: 'enter:implement', at: '2026-08-19T10:00:00Z', acknowledged_at: '2026-08-19T10:00:20Z' },
    ]);

    await status(root, '9470');

    expect(out()).toMatch(/CONTEXT REFRESHES/);
    expect(out()).toMatch(/CURRENT: phase_1_a/);
    expect(out()).toMatch(/CRITICAL RULES/);
  });

  it('--json carries the new fields without dropping the old ones', async () => {
    const old = new Date(Date.now() - REFRESH_STALL_GRACE_MS - 60_000).toISOString();
    writeProject([{ boundary: 'enter:review', at: old }]);

    await status(root, '9470', undefined, { json: true });

    const payload = JSON.parse(out());
    // New.
    expect(payload.context_refreshes).toHaveLength(1);
    expect(payload.stalled_refreshes).toHaveLength(1);
    expect(payload.unacknowledged_refreshes).toHaveLength(1);
    // Pre-existing consumers must keep parsing: fields added, none removed.
    for (const key of ['id', 'title', 'protocol', 'phase', 'iteration', 'build_complete', 'gate']) {
      expect(payload, `--json must still carry ${key}`).toHaveProperty(key);
    }
  });
});
