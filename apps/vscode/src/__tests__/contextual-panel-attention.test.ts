/**
 * Unit tests for `deriveAttention` — the pure projection of the overview cache into the Attention
 * roll-up (#1553). No `vscode` host; each attention signal is exercised in isolation and combined.
 */

import { describe, it, expect } from 'vitest';
import type { OverviewBuilder, OverviewData } from '@cluesmith/codev-types';
import { deriveAttention } from '../contextual-panel/attention.js';

/** A minimal `OverviewBuilder`; only the fields the projection reads carry real values. */
function builderRow(over: Partial<OverviewBuilder> & { id: string }): OverviewBuilder {
  return {
    issueId: null,
    issueTitle: null,
    blocked: null,
    blockedGate: null,
    blockedSince: null,
    prReady: false,
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

describe('deriveAttention', () => {
  it('projects a blocked builder into a pending-gate row with its label and timestamp', () => {
    const summary = deriveAttention(overview({
      builders: [builderRow({ id: 'pir-1553', issueId: '#1553', issueTitle: 'Attention body', blocked: 'plan review', blockedSince: '2026-08-25T10:00:00Z' })],
    }));
    expect(summary.pendingGates).toEqual([
      { builderId: 'pir-1553', issueId: '#1553', issueTitle: 'Attention body', gate: 'plan review', since: '2026-08-25T10:00:00Z' },
    ]);
    expect(summary.isEmpty).toBe(false);
  });

  it('projects prReady into a "PR review" gate row (no timestamp)', () => {
    const summary = deriveAttention(overview({ builders: [builderRow({ id: 'pir-1552', prReady: true })] }));
    expect(summary.pendingGates).toEqual([
      { builderId: 'pir-1552', issueId: null, issueTitle: null, gate: 'PR review', since: null },
    ]);
  });

  it('emits both a blocked row and a PR-review row when a builder presents both', () => {
    const summary = deriveAttention(overview({
      builders: [builderRow({ id: 'pir-1553', blocked: 'dev review', blockedSince: '2026-08-25T10:00:00Z', prReady: true })],
    }));
    expect(summary.pendingGates.map((g) => g.gate)).toEqual(['dev review', 'PR review']);
  });

  it('surfaces workspace held totals, escalation, and per-builder held rows', () => {
    const summary = deriveAttention(overview({
      builders: [builderRow({ id: 'pir-1534', heldCount: 2 }), builderRow({ id: 'air-1108', heldCount: 0 })],
      heldCount: 3,
      mailboxEscalated: true,
    }));
    expect(summary.heldTotal).toBe(3);
    expect(summary.heldEscalated).toBe(true);
    expect(summary.heldMail).toEqual([{ builderId: 'pir-1534', issueId: null, issueTitle: null, count: 2 }]);
  });

  it('is not empty when mail is held even with no per-builder rows (e.g. an architect holds it)', () => {
    const summary = deriveAttention(overview({ builders: [builderRow({ id: 'pir-1553' })], heldCount: 1 }));
    expect(summary.heldMail).toEqual([]);
    expect(summary.isEmpty).toBe(false);
  });

  it('projects queued-feedback map entries greater than zero, keyed by builder', () => {
    const summary = deriveAttention(overview({
      builders: [builderRow({ id: 'pir-1552' }), builderRow({ id: 'air-1108' }), builderRow({ id: 'pir-1553' })],
      queuedFeedback: { 'pir-1552': 4, 'air-1108': 0, 'pir-1553': 1 },
    }));
    expect(summary.queuedFeedback).toEqual([
      { builderId: 'pir-1552', issueId: null, issueTitle: null, count: 4 },
      { builderId: 'pir-1553', issueId: null, issueTitle: null, count: 1 },
    ]);
  });

  it('preserves builder input order across the lists', () => {
    const summary = deriveAttention(overview({
      builders: [builderRow({ id: 'c', blocked: 'plan review' }), builderRow({ id: 'a', blocked: 'dev review' }), builderRow({ id: 'b', blocked: 'PR review' })],
    }));
    expect(summary.pendingGates.map((g) => g.builderId)).toEqual(['c', 'a', 'b']);
  });

  it('returns the empty summary for null data (cache not yet populated)', () => {
    const summary = deriveAttention(null);
    expect(summary).toEqual({
      pendingGates: [],
      heldTotal: 0,
      heldEscalated: false,
      heldMail: [],
      queuedFeedback: [],
      isEmpty: true,
    });
  });

  it('is empty for a populated overview with no attention signals', () => {
    const summary = deriveAttention(overview({ builders: [builderRow({ id: 'pir-1553' }), builderRow({ id: 'air-1108' })] }));
    expect(summary.isEmpty).toBe(true);
  });
});
