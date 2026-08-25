/**
 * Unit tests for the cross-client builder-state helpers: `isIdleWaiting` and the `deriveAttention`
 * roll-up (the shared "what needs a human" projection over the overview cache). Pure — no host.
 */

import { describe, it, expect } from 'vitest';
import type { OverviewBuilder, OverviewData } from '@cluesmith/codev-types';
import { deriveAttention, isIdleWaiting, IDLE_WAITING_THRESHOLD_MS } from '../builder-helpers.js';

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
});
