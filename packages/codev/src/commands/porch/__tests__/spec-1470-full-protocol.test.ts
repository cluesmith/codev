/**
 * Spec 1470, Phase 8 — full-protocol simulation (spec test 36).
 *
 * ## Why a simulation, when Phase 2 already tests every transition site
 *
 * Phase 2 tests each site in isolation, from a fixture state constructed to sit
 * just before it. That proves each site fires; it cannot prove the *sequence*
 * works, and the sequence is where at-most-once actually lives. Specifically it
 * cannot see:
 *
 *  - a boundary firing twice across a real run, because each isolated test
 *    starts from a fresh state that has never refreshed;
 *  - a boundary that never fires because an EARLIER transition left the state
 *    in a shape the later site does not recognise;
 *  - the project failing to progress at all once refresh tasks are interleaved
 *    with real work.
 *
 * So this drives one project through the real `next()`, acknowledging each
 * refresh the way a returning builder does, and asserts the refresh history as
 * a whole at the end.
 *
 * ## The loop is bounded and the bound is asserted
 *
 * A driver that spins forever would hang CI; a driver that exits early would
 * make every assertion vacuous. So the loop has a hard step ceiling AND the
 * tests assert real progress was made — a ceiling alone would turn "porch
 * stopped advancing" into a green run.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { next } from '../next.js';
// Imported rather than hardcoded: writing `plan-phase:${id}` here would let the
// expectation drift from the code that produces it. The first draft of this
// test did hardcode it, guessed `plan_phase:`, and failed against correct
// behaviour — a test asserting its author's memory of a format string.
import { enterBoundary, planPhaseBoundary } from '../context-refresh.js';
import {
  PROJECT_ID,
  SPIR_ON_ENTER,
  aspirLike,
  baseState,
  isRefreshTask,
  readState,
  spirLike,
  writeApprovedSpec,
  writeApprovingReviews,
  writePlan,
  writeProtocol,
  writeState,
} from './helpers/spec-1470-fixture.js';

vi.mock('../../../lib/config.js', async importOriginal => {
  const original = await importOriginal<typeof import('../../../lib/config.js')>();
  return {
    ...original,
    loadConfig: (_workspaceRoot: string) => ({
      porch: { consultation: { models: ['codex', 'claude'] } },
    }),
  };
});

vi.mock('../../../lib/github.js', () => ({
  fetchIssue: vi.fn().mockResolvedValue(null),
}));

let root: string;

const PLAN_PHASES = ['phase_a', 'phase_b', 'phase_c'];
const MAX_STEPS = 80;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(tmpdir(), 'porch-1470-full-'));
  fs.mkdirSync(path.join(root, 'codev'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

interface RunResult {
  /** Boundaries recorded, in order. */
  boundaries: string[];
  /** How many refresh TASKS porch emitted (vs how many records it wrote). */
  refreshTasksSeen: number;
  /** Distinct phases the project passed through. */
  phasesSeen: string[];
  steps: number;
  hitCeiling: boolean;
  finalStatus: string;
  lastSubjects: string[];
}

/**
 * Drive a project forward, behaving like a compliant builder.
 *
 * The behaviours that matter, because they are what a real builder does and
 * what the at-most-once guarantee is defined against:
 *  - on a refresh task, call `next()` AGAIN (the builder returns and asks for
 *    work) rather than treating the refresh as the phase's work;
 *  - approve gates only when parked at one;
 *  - write approving reviews whenever a consultation is requested.
 */
async function drive(): Promise<RunResult> {
  let finalStatus = 'never-ran';
  let lastSubjects: string[] = [];
  let refreshTasksSeen = 0;
  let steps = 0;
  const phasesSeen: string[] = [];

  while (steps < MAX_STEPS) {
    steps++;
    const response = await next(root, PROJECT_ID);
    finalStatus = response.status;
    lastSubjects = (response.tasks ?? []).map(t => t.subject);

    const state = readState(root);
    if (phasesSeen[phasesSeen.length - 1] !== state.phase) phasesSeen.push(state.phase);

    if (response.status === 'complete' || response.status === 'verified') break;
    if (response.status === 'error') break;

    if (response.status === 'gate_pending') {
      // A human approves. This is the ONLY place a gate advances, which is what
      // makes "reset after approval, never while parked" observable here.
      // Anything not yet approved. Matching on a specific pending spelling is
      // how the first draft of this driver silently did nothing: it looked for
      // 'requested', porch writes 'pending', so the loop broke at the first
      // gate and every gated assertion passed on an empty run.
      const entry = Object.entries(state.gates).find(([, g]) => g.status !== 'approved');
      if (!entry) break;
      state.gates[entry[0]] = {
        ...state.gates[entry[0]],
        status: 'approved',
        approved_at: '2026-01-02T00:00:00.000Z',
      };
      writeState(root, state);
      continue;
    }

    if (isRefreshTask(response)) {
      refreshTasksSeen++;
      // A returning builder acknowledges by asking for work again.
      continue;
    }

    const needsConsult = response.tasks?.some(t => t.subject.includes('consultation'));
    if (needsConsult) {
      writeApprovingReviews(root, state.current_plan_phase ?? state.phase, state.iteration);
      continue;
    }

    const fresh = readState(root);
    fresh.build_complete = true;
    writeState(root, fresh);
  }

  const final = readState(root);
  return {
    boundaries: (final.context_refreshes ?? []).map(r => r.boundary),
    refreshTasksSeen,
    phasesSeen,
    steps,
    hitCeiling: steps >= MAX_STEPS,
    finalStatus,
    lastSubjects,
  };
}

/**
 * Pre-approved artifacts: porch takes the PRE-APPROVAL SKIP through `specify`
 * and `plan`, which by explicit human ruling fires NO refresh — "a skip is not
 * work", so there is no context worth clearing. See the amendment recorded in
 * both the spec and the plan.
 */
function setupSpirPreApproved(): void {
  writeProtocol(root, spirLike());
  writeApprovedSpec(root);
  writePlan(root, PLAN_PHASES, true);
  writeState(root, baseState({ phase: 'specify' }));
}

/**
 * No pre-approval frontmatter: the project parks at each gate and the driver
 * approves it, so porch takes the GATE-APPROVED transition site — the one that
 * does fire, because real work happened before the gate.
 *
 * Keeping both setups is the point. The two paths differ ONLY in whether a
 * refresh fires, and a suite that exercised just one would let the other
 * silently invert.
 */
function setupSpirGated(): void {
  writeProtocol(root, spirLike());
  writePlan(root, PLAN_PHASES, false);
  writeState(root, baseState({ phase: 'specify' }));
}

const setupSpir = setupSpirPreApproved;

describe('spec test 36 — one refresh per declared boundary across a full protocol', () => {
  it('makes real progress rather than stalling or spinning', async () => {
    setupSpir();
    const result = await drive();

    // Guards every other assertion in this file: a run that never left
    // `specify` would satisfy "no duplicates" trivially.
    expect(result.hitCeiling, 'hit the step ceiling — porch stopped advancing').toBe(false);
    expect(result.phasesSeen.length, `only reached: ${result.phasesSeen.join(' → ')}`)
      .toBeGreaterThan(1);
  });

  it('never reaches the same boundary twice in a healthy sequence', async () => {
    setupSpir();
    const { boundaries } = await drive();

    expect(boundaries.length, 'no boundaries fired — the check would be vacuous').toBeGreaterThan(0);
    const counts = new Map<string, number>();
    for (const b of boundaries) counts.set(b, (counts.get(b) ?? 0) + 1);
    const repeated = [...counts.entries()].filter(([, n]) => n > 1);

    // Precise about what this proves. A healthy run never revisits a
    // transition, so this passes even with the at-most-once GUARD disabled —
    // verified by mutation. What it actually checks is that the ordinary
    // sequence produces no accidental repeat; the guard itself is stressed by
    // the replay test below and by the Phase 2 #1408 cases.
    expect(repeated, `boundaries recorded more than once: ${JSON.stringify(repeated)}`).toEqual([]);
  });

  it('records only boundaries the protocol actually declares', async () => {
    setupSpir();
    const { boundaries } = await drive();

    expect(boundaries.length, 'no boundaries fired — the check would be vacuous').toBeGreaterThan(0);
    const declared = new Set<string>([
      ...SPIR_ON_ENTER.map(enterBoundary),
      ...PLAN_PHASES.map(planPhaseBoundary),
    ]);
    const undeclared = boundaries.filter(b => !declared.has(b));
    expect(undeclared, `fired at undeclared boundaries: ${undeclared.join(', ')}`).toEqual([]);
  });

  it('exercises every declared boundary, not just one', async () => {
    // A floor of "> 0" would pass on a run that fired a single boundary and
    // then stalled, which is exactly the failure this simulation exists to
    // catch. Pinning the full set makes the coverage a checked property: if a
    // transition site stops firing, this fails even though every other
    // assertion here stays green.
    setupSpirPreApproved();
    const { boundaries, refreshTasksSeen } = await drive();

    // `enter:plan` and `enter:implement` are ABSENT deliberately: both phases
    // were pre-approved and skipped here, and a skip fires no refresh. The
    // gate-approved counterpart is covered by the next test.
    const expected = [
      planPhaseBoundary('phase_b'),
      planPhaseBoundary('phase_c'),
      enterBoundary('review'),
    ];
    expect([...boundaries].sort()).toEqual([...expected].sort());
    expect(refreshTasksSeen).toBe(expected.length);
  });

  it('fires nothing on a pre-approval skip, and does fire once a gate is approved', async () => {
    // The human-ruled distinction, asserted as a PAIR in one test so neither
    // half can be "fixed" without confronting the other.
    setupSpirPreApproved();
    const skipped = await drive();
    expect(
      skipped.boundaries,
      'a pre-approval skip must fire no refresh — a skip is not work',
    ).not.toContain(enterBoundary('plan'));

    fs.rmSync(root, { recursive: true, force: true });
    root = fs.mkdtempSync(path.join(tmpdir(), 'porch-1470-full-'));
    fs.mkdirSync(path.join(root, 'codev'), { recursive: true });

    setupSpirGated();
    const gated = await drive();
    expect(
      gated.boundaries,
      'a gate a human actually approved must fire, unlike a skip',
    ).toContain(enterBoundary('plan'));
  });

  it('emits no refresh at all for a protocol declaring none', async () => {
    // The negative that protects every project not opting in: a protocol with
    // no `context_refresh` must be entirely unaffected by this feature.
    const noRefresh = spirLike();
    delete (noRefresh as Record<string, unknown>).context_refresh;
    writeProtocol(root, noRefresh);
    writeApprovedSpec(root);
    writePlan(root, PLAN_PHASES, true);
    writeState(root, baseState({ phase: 'specify' }));

    const { boundaries, refreshTasksSeen, phasesSeen } = await drive();

    expect(phasesSeen.length, 'the no-refresh run must still progress').toBeGreaterThan(1);
    expect(boundaries).toEqual([]);
    expect(refreshTasksSeen).toBe(0);
  });

  it('an ungated (ASPIR-shaped) protocol still records each boundary once', async () => {
    // ASPIR has no spec/plan gates, so it reaches later phases through the
    // no-gate transition site rather than the gate-approved one. ASPIR's
    // inclusion was explicitly endorsed at the spec gate.
    writeProtocol(root, aspirLike());
    writeApprovedSpec(root);
    writePlan(root, PLAN_PHASES, true);
    writeState(root, baseState({ protocol: 'fixture-aspir', phase: 'specify' }));

    const { boundaries, hitCeiling } = await drive();

    expect(hitCeiling).toBe(false);
    // The floor comes FIRST and deliberately. "No duplicates" is satisfied by
    // an empty run, so without this the ASPIR arm would pass while testing
    // nothing — which is exactly how the gated arm of the test above failed
    // silently until a positive expectation was pinned there too.
    expect(boundaries.length, 'ASPIR run fired no boundaries at all').toBeGreaterThan(0);
    const counts = new Map<string, number>();
    for (const b of boundaries) counts.set(b, (counts.get(b) ?? 0) + 1);
    expect([...counts.entries()].filter(([, n]) => n > 1)).toEqual([]);
  });
});

describe('the at-most-once guard, after a real run', () => {
  it('a #1408-style plan-phase reset re-walks advances without re-firing', async () => {
    // Phase 2 proves the guard from a hand-built state. This proves it against
    // history a REAL run produced — the distinction matters because the guard
    // reads `context_refreshes`, and a run that wrote those records itself is
    // the only way to know they are written in a form the guard can read back.
    //
    // #1408's real shape: verify-approval reset every plan phase to `pending`,
    // so the project re-walks advances it already made. Without the record,
    // that loop clears a builder once per plan phase.
    setupSpirPreApproved();
    const first = await drive();
    expect(first.boundaries.length, 'nothing to replay').toBeGreaterThan(0);

    const before = readState(root);
    const recordedBefore = (before.context_refreshes ?? []).length;

    // The reset itself: every plan phase back to pending, project back into
    // implement, as #1408 did.
    before.plan_phases = before.plan_phases.map(p => ({ ...p, status: 'pending' as const }));
    before.current_plan_phase = before.plan_phases[0]?.id ?? null;
    before.phase = 'implement';
    before.build_complete = false;
    before.iteration = 1;
    writeState(root, before);

    const replay = await drive();

    const after = readState(root);
    expect(
      (after.context_refreshes ?? []).length,
      `replay wrote ${(after.context_refreshes ?? []).length - recordedBefore} new refresh record(s)`,
    ).toBe(recordedBefore);
    expect(replay.refreshTasksSeen, 'a replay must emit no refresh TASKS either').toBe(0);
  });
});

describe('acknowledgment across a full run', () => {
  it('leaves nothing looking stalled when the builder kept returning', async () => {
    setupSpir();
    const { boundaries } = await drive();

    const final = readState(root);
    const unacked = (final.context_refreshes ?? []).filter(r => !r.acknowledged_at);

    expect(boundaries.length, 'no boundaries fired — nothing to acknowledge').toBeGreaterThan(0);
    // The driver always calls `next()` again after a refresh, which is exactly
    // what a compliant builder does — so nothing should look stalled.
    expect(
      unacked.map(r => r.boundary),
      'boundaries left looking stalled after a healthy run',
    ).toEqual([]);
  });
});
