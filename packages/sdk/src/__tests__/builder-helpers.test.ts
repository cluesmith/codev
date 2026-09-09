/**
 * Unit tests for the cross-client builder-state helpers: `isIdleWaiting` and the `deriveAttention`
 * roll-up (the shared "what needs a human" projection over the overview cache). Pure — no host.
 */

import { describe, it, expect } from 'vitest';
import type { OverviewBuilder, OverviewData } from '@cluesmith/codev-types';
import { compareAttention, deriveAttention, isIdleWaiting, IDLE_WAITING_THRESHOLD_MS } from '../builder-helpers.js';
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

describe('deriveAttention', () => {
  it('projects a blocked builder into a pending-gate row with its label and timestamp', () => {
    const summary = deriveAttention(overview({
      builders: [builderRow({ id: 'pir-1553', issueId: '#1553', issueTitle: 'Attention body', blocked: 'plan review', blockedSince: '2026-08-25T10:00:00Z' })],
    }), NOW);
    expect(summary.pendingGates).toEqual([
      { builderId: 'pir-1553', issueId: '#1553', issueTitle: 'Attention body', gate: 'plan review', since: '2026-08-25T10:00:00Z' },
    ]);
    expect(summary.isEmpty).toBe(false);
  });

  it('projects prReady into a "PR review" gate row (no timestamp)', () => {
    const summary = deriveAttention(overview({ builders: [builderRow({ id: 'pir-1552', prReady: true })] }), NOW);
    expect(summary.pendingGates).toEqual([
      { builderId: 'pir-1552', issueId: null, issueTitle: null, gate: 'PR review', since: null },
    ]);
  });

  it('emits both a blocked row and a PR-review row when a builder presents both', () => {
    const summary = deriveAttention(overview({
      builders: [builderRow({ id: 'pir-1553', blocked: 'dev review', blockedSince: '2026-08-25T10:00:00Z', prReady: true })],
    }), NOW);
    expect(summary.pendingGates.map((g) => g.gate)).toEqual(['dev review', 'PR review']);
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
    first.pendingGates.push({ builderId: 'x', issueId: null, issueTitle: null, gate: 'plan review', since: null });
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
    heldTotal: 0,
    heldEscalated: false,
    heldMail: [],
    queuedFeedback: [],
    isEmpty: true,
    ...over,
  };
}

const gate = (since: string | null) => summary({ pendingGates: [{ ...ref, gate: 'plan review', since }], isEmpty: false });
const waiting = (since: string | null) => summary({ waiting: [{ ...ref, since }], isEmpty: false });
const held = (heldTotal: number, heldEscalated = false) => summary({ heldTotal, heldEscalated, heldMail: [{ ...ref, count: heldTotal }], isEmpty: false });
const queued = (count: number) => summary({ queuedFeedback: [{ ...ref, count }], isEmpty: false });
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
    const gateAndHeld = summary({ pendingGates: [{ ...ref, gate: 'plan review', since: '2026-08-25T10:00:00Z' }], heldTotal: 9, heldMail: [{ ...ref, count: 9 }], isEmpty: false });
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
