/**
 * Unit tests for the cross-client builder-state helpers: `isIdleWaiting` and the `deriveAttention`
 * roll-up (the shared "what needs a human" projection over the overview cache). Pure — no host.
 */

import { describe, it, expect } from 'vitest';
import type { ArchitectState, OverviewBuilder, OverviewData, ServedAgentState } from '@cluesmith/codev-types';
import {
  agentAttentionState,
  BACKGROUND_WORK_STALE_MS,
  compareAttention,
  deriveAttention,
  describeNeedsInput,
  formatAge,
  isIdleWaiting,
  IDLE_WAITING_THRESHOLD_MS,
} from '../builder-helpers.js';
import type { AttentionSummary } from '../builder-helpers.js';

const NOW = Date.parse('2026-08-25T12:00:00Z');
const STALE = new Date(NOW - IDLE_WAITING_THRESHOLD_MS - 60_000).toISOString(); // 6 min ago → idle
const FRESH = new Date(NOW - 60_000).toISOString(); // 1 min ago → not idle

/** A minimal `OverviewBuilder`; only the fields the helpers read carry real values. */
function builderRow(over: Partial<OverviewBuilder> & { id: string }): OverviewBuilder {
  return {
    issueId: null,
    issueTitle: null,
    phase: 'implement',
    blocked: null,
    blockedGate: null,
    blockedSince: null,
    prReady: false,
    lastDataAt: null,
    ...over,
  } as OverviewBuilder;
}

function overview(over: Partial<OverviewData>): OverviewData {
  return {
    builders: [],
    heldCount: 0,
    mailboxEscalated: false,
    queuedFeedback: {},
    ...over,
  } as OverviewData;
}

describe('isIdleWaiting', () => {
  it('is true for a silent, unblocked, in-progress builder past the threshold', () => {
    expect(isIdleWaiting(builderRow({ id: 'a', lastDataAt: STALE }), NOW)).toBe(true);
  });
  it('is false when blocked, complete, fresh, or missing lastDataAt', () => {
    expect(isIdleWaiting(builderRow({ id: 'a', lastDataAt: STALE, blocked: 'plan review' }), NOW)).toBe(false);
    expect(isIdleWaiting(builderRow({ id: 'a', lastDataAt: STALE, phase: 'complete' }), NOW)).toBe(false);
    expect(isIdleWaiting(builderRow({ id: 'a', lastDataAt: FRESH }), NOW)).toBe(false);
    expect(isIdleWaiting(builderRow({ id: 'a', lastDataAt: null }), NOW)).toBe(false);
  });
});

// --- Spec 1595: the served-state classifier and predicate ---

const ago = (ms: number) => new Date(NOW - ms).toISOString();
const SINCE = ago(2 * 60_000);

/** A served state row; only the fields under test carry real values. */
function served(state: ServedAgentState['state'], over: Partial<ServedAgentState> = {}): ServedAgentState {
  return {
    state,
    since: SINCE,
    source: 'harness',
    alive: true,
    activity: null,
    activityAt: null,
    backgroundWork: false,
    ...over,
  };
}

describe('agentAttentionState / isIdleWaiting over a served state (Spec 1595)', () => {
  const OVER_THRESHOLD = IDLE_WAITING_THRESHOLD_MS + 60_000;
  const cases: Array<{
    name: string;
    agentState: ServedAgentState;
    lastDataAt: string | null;
    expected: ReturnType<typeof agentAttentionState>;
    waiting: boolean;
  }> = [
    { name: 'needs-input with fresh output', agentState: served('needs-input'), lastDataAt: FRESH, expected: 'needs-input', waiting: true },
    { name: 'idle with fresh output', agentState: served('idle'), lastDataAt: FRESH, expected: 'idle', waiting: true },
    { name: 'dead with no output', agentState: served('dead', { alive: false, source: 'tower' }), lastDataAt: null, expected: 'dead', waiting: true },
    { name: 'blocked', agentState: served('blocked', { source: 'tower' }), lastDataAt: STALE, expected: 'blocked', waiting: false },
    { name: 'working with fresh output', agentState: served('working'), lastDataAt: FRESH, expected: 'working', waiting: false },
    { name: 'working just under the threshold', agentState: served('working'), lastDataAt: ago(IDLE_WAITING_THRESHOLD_MS), expected: 'working', waiting: false },
    { name: 'working silent past the threshold (SC6)', agentState: served('working'), lastDataAt: STALE, expected: 'idle', waiting: true },
    { name: 'working with no output yet', agentState: served('working'), lastDataAt: null, expected: 'working', waiting: false },
    {
      name: 'background working, silent, report within its bound',
      agentState: served('working', { backgroundWork: true, activityAt: ago(BACKGROUND_WORK_STALE_MS - 60_000) }),
      lastDataAt: ago(OVER_THRESHOLD),
      expected: 'working',
      waiting: false,
    },
    {
      name: 'background working, silent, report past its bound',
      agentState: served('working', { backgroundWork: true, activityAt: ago(BACKGROUND_WORK_STALE_MS + 60_000) }),
      lastDataAt: ago(BACKGROUND_WORK_STALE_MS + 60_000),
      expected: 'idle',
      waiting: true,
    },
    {
      name: 'background working with no report time falls back to the output rule',
      agentState: served('working', { backgroundWork: true, activityAt: null }),
      lastDataAt: STALE,
      expected: 'idle',
      waiting: true,
    },
    {
      name: 'background working with fresh output stays working past its bound',
      agentState: served('working', { backgroundWork: true, activityAt: ago(BACKGROUND_WORK_STALE_MS + 60_000) }),
      lastDataAt: FRESH,
      expected: 'working',
      waiting: false,
    },
  ];

  for (const c of cases) {
    it(`${c.name}: ${String(c.expected)}, waiting=${c.waiting}`, () => {
      const b = builderRow({ id: 'a', agentState: c.agentState, lastDataAt: c.lastDataAt });
      expect(agentAttentionState(b, NOW)).toBe(c.expected);
      expect(isIdleWaiting(b, NOW)).toBe(c.waiting);
    });
  }

  it('never counts a builder at a porch gate, even when the served state disagrees', () => {
    const b = builderRow({ id: 'a', blocked: 'plan review', agentState: served('needs-input'), lastDataAt: FRESH });
    expect(isIdleWaiting(b, NOW)).toBe(false);
  });

  it('never counts a complete or verified builder, whatever its state (SC14)', () => {
    for (const phase of ['complete', 'verified']) {
      for (const state of ['working', 'needs-input', 'idle', 'blocked', 'dead'] as const) {
        for (const lastDataAt of [STALE, FRESH, null]) {
          const b = builderRow({ id: 'a', phase, agentState: served(state), lastDataAt });
          expect(agentAttentionState(b, NOW)).toBeNull();
          expect(isIdleWaiting(b, NOW)).toBe(false);
        }
      }
    }
  });

  it('a null or absent state is unknown, and reproduces the PTY-silence rule exactly', () => {
    const fixtures: Array<Partial<OverviewBuilder>> = [
      { lastDataAt: STALE },
      { lastDataAt: FRESH },
      { lastDataAt: null },
      { lastDataAt: STALE, blocked: 'plan review' },
      { lastDataAt: STALE, phase: 'complete' },
      { lastDataAt: STALE, phase: 'verified' },
      { lastDataAt: ago(IDLE_WAITING_THRESHOLD_MS) },
      { lastDataAt: ago(IDLE_WAITING_THRESHOLD_MS + 1) },
      { lastDataAt: 'not-a-date' },
    ];
    const todays = (b: OverviewBuilder) => {
      if (b.blocked) { return false; }
      if (b.phase === 'complete' || b.phase === 'verified') { return false; }
      if (!b.lastDataAt) { return false; }
      return NOW - new Date(b.lastDataAt).getTime() > IDLE_WAITING_THRESHOLD_MS;
    };
    for (const fixture of fixtures) {
      for (const agentState of [null, undefined]) {
        const b = builderRow({ id: 'a', ...fixture, agentState });
        expect(agentAttentionState(b, NOW)).toBeNull();
        expect(isIdleWaiting(b, NOW)).toBe(todays(b));
      }
    }
  });
});

describe('deriveAttention over a served state (Spec 1595)', () => {
  it('lists a needs-input builder at once, with its state and the state\'s since', () => {
    const summary = deriveAttention(overview({
      builders: [builderRow({ id: 'spir-1', agentState: served('needs-input', { activity: 'needs-input' }), lastDataAt: FRESH })],
    }), NOW);
    expect(summary.waiting).toEqual([{ builderId: 'spir-1', issueId: null, issueTitle: null, state: 'needs-input', since: SINCE }]);
    expect(summary.isEmpty).toBe(false);
  });

  it('dates a dead builder with no output by its state, not lastDataAt', () => {
    const summary = deriveAttention(overview({
      builders: [builderRow({ id: 'spir-2', agentState: served('dead', { alive: false, source: 'tower' }), lastDataAt: null })],
    }), NOW);
    expect(summary.waiting).toEqual([{ builderId: 'spir-2', issueId: null, issueTitle: null, state: 'dead', since: SINCE }]);
  });

  it('dates a stale working builder by its last output', () => {
    const summary = deriveAttention(overview({ builders: [builderRow({ id: 'spir-3', agentState: served('working'), lastDataAt: STALE })] }), NOW);
    expect(summary.waiting).toEqual([{ builderId: 'spir-3', issueId: null, issueTitle: null, state: 'idle', since: STALE }]);
  });

  it('does not list a working builder whose output is fresh', () => {
    const summary = deriveAttention(overview({ builders: [builderRow({ id: 'spir-4', agentState: served('working'), lastDataAt: FRESH })] }), NOW);
    expect(summary.waiting).toEqual([]);
    expect(summary.isEmpty).toBe(true);
  });

  it('keeps a served blocked builder on the gate path only (never counted twice)', () => {
    const summary = deriveAttention(overview({
      builders: [builderRow({ id: 'spir-5', blocked: 'plan review', blockedGate: 'plan-approval', agentState: served('blocked', { source: 'tower' }), lastDataAt: STALE })],
    }), NOW);
    expect(summary.pendingGates.map((g) => g.builderId)).toEqual(['spir-5']);
    expect(summary.waiting).toEqual([]);
  });

  it('shows a prompt on a porch-gated builder under the gate only', () => {
    const summary = deriveAttention(overview({
      builders: [builderRow({ id: 'spir-6', blocked: 'plan review', agentState: served('needs-input'), lastDataAt: FRESH })],
    }), NOW);
    expect(summary.pendingGates.map((g) => g.builderId)).toEqual(['spir-6']);
    expect(summary.waiting).toEqual([]);
  });

  it('lists needs-input and dead on a prReady-only builder alongside its PR row (SC1, SC7)', () => {
    const summary = deriveAttention(overview({
      builders: [
        builderRow({ id: 'pir-7', prReady: true, agentState: served('needs-input'), lastDataAt: FRESH }),
        builderRow({ id: 'pir-8', prReady: true, agentState: served('dead', { alive: false }), lastDataAt: null }),
      ],
    }), NOW);
    expect(summary.pendingGates.map((g) => g.builderId)).toEqual(['pir-7', 'pir-8']);
    expect(summary.waiting.map((w) => [w.builderId, w.state])).toEqual([['pir-7', 'needs-input'], ['pir-8', 'dead']]);
  });

  it('suppresses idle and stale working on a prReady-only builder', () => {
    const summary = deriveAttention(overview({
      builders: [
        builderRow({ id: 'pir-9', prReady: true, agentState: served('idle'), lastDataAt: FRESH }),
        builderRow({ id: 'pir-10', prReady: true, agentState: served('working'), lastDataAt: STALE }),
      ],
    }), NOW);
    expect(summary.waiting).toEqual([]);
  });

  it('never lists a complete or verified builder (SC14)', () => {
    const summary = deriveAttention(overview({
      builders: [
        builderRow({ id: 'a', phase: 'complete', agentState: served('dead', { alive: false }) }),
        builderRow({ id: 'b', phase: 'verified', agentState: served('needs-input'), lastDataAt: STALE }),
      ],
    }), NOW);
    expect(summary.waiting).toEqual([]);
    expect(summary.isEmpty).toBe(true);
  });
});

describe('deriveAttention architects (Spec 1595)', () => {
  function architect(name: string, agentState: ServedAgentState | null | undefined, lastDataAt: string | null = FRESH): ArchitectState {
    return { name, port: 0, pid: 0, agentState, lastDataAt };
  }

  it('lists architect needs-input and dead in order; idle, working and unknown are absent', () => {
    const summary = deriveAttention(overview({
      architects: [
        architect('main', served('needs-input', { since: '2026-08-25T11:00:00Z' })),
        architect('idle-one', served('idle')),
        architect('busy', served('working')),
        architect('stale', served('working'), STALE),
        architect('old', null, STALE),
        architect('older', undefined, STALE),
        architect('gone', served('dead', { alive: false, source: 'tower', since: '2026-08-25T10:00:00Z' }), null),
      ],
    }), NOW);
    expect(summary.architects).toEqual([
      { architect: 'main', state: 'needs-input', since: '2026-08-25T11:00:00Z' },
      { architect: 'gone', state: 'dead', since: '2026-08-25T10:00:00Z' },
    ]);
    expect(summary.isEmpty).toBe(false);
  });

  it('is empty with only idle architects, and tolerates an overview without architects', () => {
    expect(deriveAttention(overview({ architects: [architect('main', served('idle'))] }), NOW).isEmpty).toBe(true);
    expect(deriveAttention(overview({}), NOW).architects).toEqual([]);
  });

  it('sorts an architect-only summary in the waiting bucket, by its oldest since', () => {
    const arch = (since: string) => deriveAttention(overview({ architects: [architect('main', served('needs-input', { since }))] }), NOW);
    const gateSummary = deriveAttention(overview({ builders: [builderRow({ id: 'g', blocked: 'plan review', blockedSince: '2026-08-25T11:00:00Z' })] }), NOW);
    const heldSummary = deriveAttention(overview({ heldCount: 3 }), NOW);
    expect(sign(compareAttention(gateSummary, arch('2026-08-25T09:00:00Z')))).toBe(-1);
    expect(sign(compareAttention(arch('2026-08-25T09:00:00Z'), heldSummary))).toBe(-1);
    expect(sign(compareAttention(arch('2026-08-25T09:00:00Z'), arch('2026-08-25T11:00:00Z')))).toBe(-1);
    const builderWait = deriveAttention(overview({ builders: [builderRow({ id: 'w', lastDataAt: '2026-08-25T10:00:00Z' })] }), NOW);
    expect(sign(compareAttention(arch('2026-08-25T09:00:00Z'), builderWait))).toBe(-1);
    expect(sign(compareAttention(builderWait, arch('2026-08-25T11:00:00Z')))).toBe(-1);
  });
});

describe('deriveAttention', () => {
  it('projects a blocked builder into a pending-gate row with its label and timestamp', () => {
    const summary = deriveAttention(overview({
      builders: [builderRow({ id: 'pir-1553', issueId: '#1553', issueTitle: 'Attention body', blocked: 'plan review', blockedGate: 'plan-approval', blockedSince: '2026-08-25T10:00:00Z' })],
    }), NOW);
    expect(summary.pendingGates).toEqual([
      { builderId: 'pir-1553', issueId: '#1553', issueTitle: 'Attention body', gate: 'plan review', gateId: 'plan-approval', since: '2026-08-25T10:00:00Z' },
    ]);
    expect(summary.isEmpty).toBe(false);
  });

  it('carries a non-core gate id through, and a null id when Tower omits it (#1779)', () => {
    const summary = deriveAttention(overview({
      builders: [
        builderRow({ id: 'experiment-1', blocked: 'experiment review', blockedGate: 'experiment-complete' }),
        builderRow({ id: 'legacy', blocked: 'plan review', blockedGate: undefined as unknown as null }),
      ],
    }), NOW);
    expect(summary.pendingGates.map((g) => g.gateId)).toEqual(['experiment-complete', null]);
  });

  it('projects prReady into a "PR review" gate row (no timestamp)', () => {
    const summary = deriveAttention(overview({ builders: [builderRow({ id: 'pir-1552', prReady: true })] }), NOW);
    expect(summary.pendingGates).toEqual([
      { builderId: 'pir-1552', issueId: null, issueTitle: null, gate: 'PR review', gateId: 'pr', since: null },
    ]);
  });

  it('emits both a blocked row and a PR-review row when a builder presents both', () => {
    const summary = deriveAttention(overview({
      builders: [builderRow({ id: 'pir-1553', blocked: 'dev review', blockedSince: '2026-08-25T10:00:00Z', prReady: true })],
    }), NOW);
    expect(summary.pendingGates.map((g) => g.gate)).toEqual(['dev review', 'PR review']);
  });

  it('emits one row for a lane at the porch pr gate whose PR is open (porch row wins, keeps since) (#1787)', () => {
    const summary = deriveAttention(overview({
      builders: [builderRow({ id: 'bugfix-15', blocked: 'PR review', blockedGate: 'pr', blockedSince: '2026-10-05T09:00:00Z', prReady: true })],
    }), NOW);
    expect(summary.pendingGates).toEqual([
      { builderId: 'bugfix-15', issueId: null, issueTitle: null, gate: 'PR review', gateId: 'pr', since: '2026-10-05T09:00:00Z' },
    ]);
  });

  it('keeps the PR-review row when blockedGate says pr but no porch row was emitted', () => {
    const summary = deriveAttention(overview({
      builders: [builderRow({ id: 'bugfix-16', blocked: null, blockedGate: 'pr', prReady: true })],
    }), NOW);
    expect(summary.pendingGates.map((g) => g.gate)).toEqual(['PR review']);
  });

  it('projects an idle-waiting builder into the waiting list with its lastDataAt', () => {
    const summary = deriveAttention(overview({ builders: [builderRow({ id: 'air-1108', lastDataAt: STALE })] }), NOW);
    expect(summary.waiting).toEqual([{ builderId: 'air-1108', issueId: null, issueTitle: null, since: STALE }]);
    expect(summary.isEmpty).toBe(false);
  });

  it('does not double-list a builder that is both idle and at a gate (gate wins)', () => {
    const summary = deriveAttention(overview({
      builders: [builderRow({ id: 'pir-1552', prReady: true, lastDataAt: STALE })],
    }), NOW);
    expect(summary.pendingGates.map((g) => g.builderId)).toEqual(['pir-1552']);
    expect(summary.waiting).toEqual([]);
  });

  it('surfaces workspace held totals, escalation, and per-builder held rows', () => {
    const summary = deriveAttention(overview({
      builders: [builderRow({ id: 'pir-1534', heldCount: 2 }), builderRow({ id: 'air-1108', heldCount: 0 })],
      heldCount: 3,
      mailboxEscalated: true,
    }), NOW);
    expect(summary.heldTotal).toBe(3);
    expect(summary.heldEscalated).toBe(true);
    expect(summary.heldMail).toEqual([{ builderId: 'pir-1534', issueId: null, issueTitle: null, count: 2 }]);
  });

  it('is not empty when mail is held even with no per-builder rows (e.g. an architect holds it)', () => {
    const summary = deriveAttention(overview({ builders: [builderRow({ id: 'pir-1553' })], heldCount: 1 }), NOW);
    expect(summary.heldMail).toEqual([]);
    expect(summary.isEmpty).toBe(false);
  });

  it('projects queued-feedback map entries greater than zero, keyed by builder', () => {
    const summary = deriveAttention(overview({
      builders: [builderRow({ id: 'pir-1552' }), builderRow({ id: 'air-1108' }), builderRow({ id: 'pir-1553' })],
      queuedFeedback: { 'pir-1552': 4, 'air-1108': 0, 'pir-1553': 1 },
    }), NOW);
    expect(summary.queuedFeedback).toEqual([
      { builderId: 'pir-1552', issueId: null, issueTitle: null, count: 4 },
      { builderId: 'pir-1553', issueId: null, issueTitle: null, count: 1 },
    ]);
  });

  it('preserves builder input order across the lists', () => {
    const summary = deriveAttention(overview({
      builders: [builderRow({ id: 'c', blocked: 'plan review' }), builderRow({ id: 'a', blocked: 'dev review' }), builderRow({ id: 'b', blocked: 'PR review' })],
    }), NOW);
    expect(summary.pendingGates.map((g) => g.builderId)).toEqual(['c', 'a', 'b']);
  });

  it('returns the empty summary for null data (cache not yet populated)', () => {
    expect(deriveAttention(null, NOW)).toEqual({
      pendingGates: [],
      waiting: [],
      architects: [],
      heldTotal: 0,
      heldEscalated: false,
      heldMail: [],
      queuedFeedback: [],
      isEmpty: true,
    });
  });

  it('is empty for a populated overview with no attention signals', () => {
    const summary = deriveAttention(overview({ builders: [builderRow({ id: 'pir-1553' }), builderRow({ id: 'air-1108', lastDataAt: FRESH })] }), NOW);
    expect(summary.isEmpty).toBe(true);
  });

  it('returns a fresh empty summary each call (no shared mutable singleton)', () => {
    const first = deriveAttention(null, NOW);
    first.pendingGates.push({ builderId: 'x', issueId: null, issueTitle: null, gate: 'plan review', gateId: 'plan-approval', since: null });
    const second = deriveAttention(null, NOW);
    expect(second.pendingGates).toEqual([]);
    expect(first).not.toBe(second);
  });
});

// --- compareAttention: the canonical cross-client urgency order ---

const ref = { builderId: 'b', issueId: null, issueTitle: null };

/** An `AttentionSummary` with only the fields under test set; the rest empty/quiet. */
function summary(over: Partial<AttentionSummary>): AttentionSummary {
  return {
    pendingGates: [],
    waiting: [],
    architects: [],
    heldTotal: 0,
    heldEscalated: false,
    heldMail: [],
    queuedFeedback: [],
    isEmpty: true,
    ...over,
  };
}

const gate = (since: string | null) => summary({ pendingGates: [{ ...ref, gate: 'plan review', gateId: 'plan-approval', since }], isEmpty: false });
const waiting = (since: string | null) => summary({ waiting: [{ ...ref, since }], isEmpty: false });
const held = (heldTotal: number, heldEscalated = false) => summary({ heldTotal, heldEscalated, heldMail: [{ ...ref, count: heldTotal }], isEmpty: false });
const queued = (count: number) => summary({ queuedFeedback: [{ ...ref, count }], isEmpty: false });
const architectWaiting = (since: string | null) => summary({ architects: [{ architect: 'main', state: 'needs-input', since }], isEmpty: false });
const quiet = () => summary({});

function sign(n: number): number {
  if (n < 0) { return -1; }
  if (n > 0) { return 1; }
  return 0;
}

describe('compareAttention — bucket precedence', () => {
  // Ordered most-urgent → least-urgent.
  const ladder: Array<[string, AttentionSummary]> = [
    ['pending-gate', gate('2026-08-25T10:00:00Z')],
    ['idle-waiting', waiting('2026-08-25T10:00:00Z')],
    ['held-mail', held(2)],
    ['queued-feedback', queued(2)],
    ['quiet', quiet()],
  ];

  it('ranks pending-gate > waiting > held-mail > queued-feedback > quiet', () => {
    for (let i = 0; i < ladder.length - 1; i++) {
      const [na, a] = ladder[i];
      const [nb, b] = ladder[i + 1];
      expect(`${na}<${nb}:${sign(compareAttention(a, b))}`).toBe(`${na}<${nb}:-1`);
    }
  });

  it('uses the MOST-urgent signal present as the bucket (a gate+held summary is a gate)', () => {
    const gateAndHeld = summary({ pendingGates: [{ ...ref, gate: 'plan review', gateId: 'plan-approval', since: '2026-08-25T10:00:00Z' }], heldTotal: 9, heldMail: [{ ...ref, count: 9 }], isEmpty: false });
    expect(sign(compareAttention(gateAndHeld, held(9)))).toBe(-1); // gate wins over pure held
  });
});

describe('compareAttention — within-bucket tie-breaks', () => {
  it('pending-gate & waiting: oldest since first, null since last', () => {
    expect(sign(compareAttention(gate('2026-08-25T09:00:00Z'), gate('2026-08-25T11:00:00Z')))).toBe(-1);
    expect(sign(compareAttention(gate('2026-08-25T09:00:00Z'), gate(null)))).toBe(-1); // PR-ready (null) sorts last
    expect(sign(compareAttention(waiting('2026-08-25T09:00:00Z'), waiting('2026-08-25T11:00:00Z')))).toBe(-1);
  });
  it('held-mail: escalated before plain, then higher total first', () => {
    expect(sign(compareAttention(held(1, true), held(9, false)))).toBe(-1); // escalation beats volume
    expect(sign(compareAttention(held(5), held(2)))).toBe(-1); // higher total first
  });
  it('queued-feedback: higher total first', () => {
    expect(sign(compareAttention(queued(5), queued(2)))).toBe(-1);
  });
});

describe('compareAttention — order properties', () => {
  const samples: AttentionSummary[] = [
    gate('2026-08-25T09:00:00Z'), gate('2026-08-25T11:00:00Z'), gate(null),
    waiting('2026-08-25T08:00:00Z'), waiting('2026-08-25T12:00:00Z'),
    architectWaiting('2026-08-25T10:00:00Z'), architectWaiting(null),
    held(1, true), held(9, false), held(3, false),
    queued(5), queued(1), quiet(),
  ];

  it('is antisymmetric: sgn(cmp(a,b)) === sgn(-cmp(b,a)) for every pair', () => {
    for (const a of samples) {
      for (const b of samples) {
        expect(sign(compareAttention(a, b))).toBe(sign(-compareAttention(b, a)));
      }
    }
  });

  it('is reflexive: every summary compares equal to itself', () => {
    for (const a of samples) { expect(compareAttention(a, a)).toBe(0); }
  });

  it('is transitive across every ordered triple', () => {
    for (const a of samples) {
      for (const b of samples) {
        for (const c of samples) {
          if (compareAttention(a, b) <= 0 && compareAttention(b, c) <= 0) {
            expect(compareAttention(a, c)).toBeLessThanOrEqual(0);
          }
        }
      }
    }
  });

  it('equal summaries compare 0 (caller supplies any label tie-break via a stable sort)', () => {
    expect(compareAttention(gate('2026-08-25T10:00:00Z'), gate('2026-08-25T10:00:00Z'))).toBe(0);
    expect(compareAttention(quiet(), quiet())).toBe(0);
    expect(compareAttention(held(3, true), held(3, true))).toBe(0);
  });

  it('stays a total preorder with malformed timestamps (no NaN leak)', () => {
    const bad = gate('not-a-date');
    // Reflexive despite the unparseable since (would be NaN if it reached `ascending`).
    expect(compareAttention(bad, bad)).toBe(0);
    // A malformed since sorts as +∞ (last within the bucket), so a real gate outranks it.
    expect(sign(compareAttention(gate('2026-08-25T09:00:00Z'), bad))).toBe(-1);
    // Antisymmetry still holds against every sample.
    for (const other of [gate('2026-08-25T09:00:00Z'), waiting('2026-08-25T09:00:00Z'), quiet()]) {
      expect(sign(compareAttention(bad, other))).toBe(sign(-compareAttention(other, bad)));
    }
  });

  it('never buckets a non-empty summary below a quiet one (!isEmpty ⇒ bucket < quiet)', () => {
    // A held-mail-only summary (heldMail rows present) must outrank quiet even if heldTotal were 0.
    const heldRowsOnly = summary({ heldMail: [{ ...ref, count: 2 }], heldTotal: 0, isEmpty: false });
    expect(sign(compareAttention(heldRowsOnly, quiet()))).toBe(-1);
  });

  it('sorts a shuffled fleet into a stable, deterministic total order', () => {
    const sorted = [...samples].sort(compareAttention);
    // Re-sorting the already-sorted list is a no-op (stable + total).
    expect([...sorted].sort(compareAttention)).toEqual(sorted);
    // First is the oldest gate, last is quiet.
    expect(sorted[0]).toBe(samples[0]); // gate @ 09:00
    expect(sorted[sorted.length - 1]).toBe(quietRef(sorted));
  });
});

/** The quiet summary instance in a sorted array (there is exactly one in `samples`). */
function quietRef(sorted: AttentionSummary[]): AttentionSummary {
  return sorted.find((s) => s.isEmpty)!;
}

describe('formatAge — the canonical cross-client relative age', () => {
  const now = Date.parse('2026-09-11T12:00:00Z');
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it('reads "just now" under a minute', () => {
    expect(formatAge(ago(30_000), now)).toBe('just now');
    expect(formatAge(ago(0), now)).toBe('just now');
  });
  it('reads minutes, hours, then days', () => {
    expect(formatAge(ago(6 * 60_000), now)).toBe('6m');
    expect(formatAge(ago(2 * 3_600_000), now)).toBe('2h');
    expect(formatAge(ago(3 * 86_400_000), now)).toBe('3d');
  });
  it('returns null for absent, unparseable, or future timestamps', () => {
    expect(formatAge(null, now)).toBeNull();
    expect(formatAge('not-a-date', now)).toBeNull();
    expect(formatAge(new Date(now + 60_000).toISOString(), now)).toBeNull();
  });
});

describe('describeNeedsInput (Spec 1595)', () => {
  it('names the tool and summary of a permission prompt', () => {
    expect(describeNeedsInput({ kind: 'permission', tool: 'Bash', summary: 'git push' })).toBe('at a permission prompt: Bash git push');
  });

  it('omits whichever of tool and summary is absent', () => {
    expect(describeNeedsInput({ kind: 'permission', tool: 'Edit' })).toBe('at a permission prompt: Edit');
    expect(describeNeedsInput({ kind: 'permission', summary: 'src/a.ts' })).toBe('at a permission prompt: src/a.ts');
    expect(describeNeedsInput({ kind: 'permission' })).toBe('at a permission prompt');
  });

  it('reads a question as asking a question, and anything else as needing input', () => {
    expect(describeNeedsInput({ kind: 'question', tool: 'AskUserQuestion' })).toBe('asking a question');
    expect(describeNeedsInput({ kind: 'other' })).toBe('needs input');
    expect(describeNeedsInput(undefined)).toBe('needs input');
  });

  it('copies markup in the summary verbatim for the caller to render as text', () => {
    const summary = '[click](command:workbench.action.terminal.sendSequence) **bold**';
    expect(describeNeedsInput({ kind: 'permission', tool: 'Bash', summary })).toBe(`at a permission prompt: Bash ${summary}`);
  });
});
