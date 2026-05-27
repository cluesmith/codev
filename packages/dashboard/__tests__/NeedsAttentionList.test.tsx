import { describe, it, expect } from 'vitest';
import { buildItems } from '../src/components/NeedsAttentionList.js';
import type { OverviewPR, OverviewBuilder } from '../src/lib/api.js';

function makePR(overrides: Partial<OverviewPR> = {}): OverviewPR {
  return {
    id: '100',
    title: 'PR title',
    url: 'https://github.com/org/repo/pull/100',
    reviewStatus: 'REVIEW_REQUIRED',
    linkedIssue: '42',
    createdAt: new Date('2026-01-01T00:00:00Z').toISOString(),
    ...overrides,
  };
}

function makeBuilder(overrides: Partial<OverviewBuilder> = {}): OverviewBuilder {
  return {
    id: 'bugfix-42',
    issueId: '42',
    issueTitle: 'Issue 42',
    phase: 'review',
    mode: 'strict',
    gates: {},
    worktreePath: '/path',
    roleId: 'builder-bugfix-42',
    protocol: 'bugfix',
    planPhases: [],
    progress: 0.5,
    blocked: null,
    blockedGate: null,
    blockedSince: null,
    startedAt: null,
    idleMs: 0,
    lastDataAt: null,
    spawnedByArchitect: 'main',
    prReady: false,
    ...overrides,
  };
}

describe('NeedsAttentionList buildItems — PR gating (issue #844)', () => {
  it('excludes a PR whose builder is still in CMAP review (not yet at pr gate)', () => {
    const prs = [makePR({ id: '100', linkedIssue: '42' })];
    const builders = [makeBuilder({ issueId: '42', blocked: null })];

    const items = buildItems(prs, builders);

    expect(items.find(i => i.key === 'pr-100')).toBeUndefined();
  });

  it('includes a PR once the builder signals prReady', () => {
    const prs = [makePR({ id: '100', linkedIssue: '42' })];
    const builders = [
      makeBuilder({
        issueId: '42',
        blocked: 'PR review',
        blockedGate: 'pr',
        blockedSince: new Date('2026-01-02T00:00:00Z').toISOString(),
        prReady: true,
      }),
    ];

    const items = buildItems(prs, builders);

    expect(items.find(i => i.key === 'pr-100')).toBeDefined();
  });

  it('emits the PR exactly once when builder signals prReady (no dedupe double-count)', () => {
    const prs = [makePR({ id: '100', linkedIssue: '42' })];
    const builders = [
      makeBuilder({
        issueId: '42',
        blocked: 'PR review',
        blockedGate: 'pr',
        blockedSince: new Date('2026-01-02T00:00:00Z').toISOString(),
        prReady: true,
      }),
    ];

    const items = buildItems(prs, builders);

    expect(items.filter(i => i.issueOrPR === '#100')).toHaveLength(1);
  });

  it('surfaces a BUGFIX PR whose builder has no gate (Issue #872)', () => {
    // BUGFIX has no `pr` gate — the v3.1.3 derivation (blocked === 'PR review')
    // silently dropped these PRs. The canonical `prReady` signal fixes this.
    const prs = [makePR({ id: '111', linkedIssue: '42' })];
    const builders = [
      makeBuilder({
        issueId: '42',
        protocol: 'bugfix',
        phase: 'verified',
        blocked: null,
        blockedGate: null,
        blockedSince: null,
        prReady: true,
      }),
    ];

    const items = buildItems(prs, builders);

    expect(items.find(i => i.key === 'pr-111')).toBeDefined();
  });

  it('surfaces a human-authored PR (no matching builder) only when reviewStatus is REVIEW_REQUIRED', () => {
    const required = makePR({ id: '200', linkedIssue: null, reviewStatus: 'REVIEW_REQUIRED' });
    const approved = makePR({ id: '201', linkedIssue: null, reviewStatus: 'APPROVED' });

    const items = buildItems([required, approved], []);

    expect(items.find(i => i.key === 'pr-200')).toBeDefined();
    expect(items.find(i => i.key === 'pr-201')).toBeUndefined();
  });

  it('still surfaces other gate-pending builders (spec/plan/dev review)', () => {
    const prs: OverviewPR[] = [];
    const builders = [
      makeBuilder({
        id: 'spir-99',
        issueId: '99',
        blocked: 'spec review',
        blockedGate: 'spec-approval',
        blockedSince: new Date('2026-01-02T00:00:00Z').toISOString(),
      }),
    ];

    const items = buildItems(prs, builders);

    expect(items.find(i => i.key === 'gate-spir-99')).toBeDefined();
  });

  it('treats a PR whose linkedIssue does not match any builder as unaffiliated', () => {
    // PR claims to link issue 42, but no builder is tracking issue 42 — treat
    // it the same as a human-authored PR (surface only if reviewStatus needs it).
    const prs = [makePR({ id: '300', linkedIssue: '42', reviewStatus: 'APPROVED' })];
    const builders: OverviewBuilder[] = [];

    const items = buildItems(prs, builders);

    expect(items.find(i => i.key === 'pr-300')).toBeUndefined();
  });

  it('uses the builder blockedSince (not pr.createdAt) as waitingSince for affiliated PRs', () => {
    const createdAt = new Date('2026-01-01T00:00:00Z').toISOString();
    const blockedSince = new Date('2026-01-05T12:00:00Z').toISOString();
    const prs = [makePR({ id: '400', linkedIssue: '42', createdAt })];
    const builders = [
      makeBuilder({ issueId: '42', blocked: 'PR review', blockedGate: 'pr', blockedSince, prReady: true }),
    ];

    const items = buildItems(prs, builders);
    const pr = items.find(i => i.key === 'pr-400');

    expect(pr).toBeDefined();
    expect(pr!.waitingSince).toBe(blockedSince);
  });

  it('falls back to pr.createdAt for a prReady builder without blockedSince (BUGFIX shape)', () => {
    // BUGFIX has no gate, so blockedSince is null even though prReady=true.
    const createdAt = new Date('2026-01-01T00:00:00Z').toISOString();
    const prs = [makePR({ id: '410', linkedIssue: '42', createdAt })];
    const builders = [
      makeBuilder({
        issueId: '42',
        protocol: 'bugfix',
        phase: 'verified',
        blocked: null,
        blockedGate: null,
        blockedSince: null,
        prReady: true,
      }),
    ];

    const items = buildItems(prs, builders);
    const pr = items.find(i => i.key === 'pr-410');

    expect(pr).toBeDefined();
    expect(pr!.waitingSince).toBe(createdAt);
  });

  it('still surfaces a prReady BUGFIX builder when its PR is missing from prs (realistic shape, Issue #872 iter-2)', () => {
    // Defensive: if a BUGFIX builder signals prReady but its PR didn't appear
    // in `prs` (cache miss / pagination / API error), do NOT silently drop the
    // builder. The iter-1 version of this test mocked blocked='PR review' on
    // a BUGFIX builder, which is unrealistic — real BUGFIX builders have
    // blocked=null/blockedSince=null because BUGFIX has no `pr` gate. With
    // the realistic shape, the original gate-loop early-out filtered the
    // builder before the prReady check could fire. Architect-side CMAP
    // caught this; the loop now checks prReady BEFORE the !b.blocked skip.
    const prs: OverviewPR[] = [];
    const startedAt = new Date('2026-01-05T12:00:00Z').toISOString();
    const builders = [
      makeBuilder({
        id: 'bugfix-42',
        issueId: '42',
        protocol: 'bugfix',
        phase: 'verified',
        blocked: null,
        blockedGate: null,
        blockedSince: null,
        startedAt,
        prReady: true,
      }),
    ];

    const items = buildItems(prs, builders);
    const row = items.find(i => i.key === 'gate-bugfix-42');

    expect(row).toBeDefined();
    expect(row!.kind).toBe('PR review');
    // Falls back to startedAt when no gate gives us blockedSince.
    expect(row!.waitingSince).toBe(startedAt);
  });

  it('still surfaces a prReady gated builder (AIR/SPIR shape) when its PR is missing from prs', () => {
    // Gate-bearing variant — preserves the iter-1 coverage but with the
    // expectation explicitly tied to the gate-blocked shape.
    const prs: OverviewPR[] = [];
    const blockedSince = new Date('2026-01-05T12:00:00Z').toISOString();
    const builders = [
      makeBuilder({
        id: 'air-42',
        issueId: '42',
        protocol: 'air',
        blocked: 'PR review',
        blockedGate: 'pr',
        blockedSince,
        prReady: true,
      }),
    ];

    const items = buildItems(prs, builders);
    const row = items.find(i => i.key === 'gate-air-42');

    expect(row).toBeDefined();
    expect(row!.waitingSince).toBe(blockedSince);
  });

  it('does NOT double-emit when both the PR and the builder are present', () => {
    // Regression guard for the dedupe invariant after the missing-PR fallback
    // was added: when the PR IS emitted, the builder loop must skip.
    const prs = [makePR({ id: '500', linkedIssue: '42' })];
    const builders = [
      makeBuilder({
        id: 'bugfix-42',
        issueId: '42',
        blocked: 'PR review',
        blockedGate: 'pr',
        blockedSince: new Date('2026-01-02T00:00:00Z').toISOString(),
        prReady: true,
      }),
    ];

    const items = buildItems(prs, builders);

    expect(items).toHaveLength(1);
    expect(items[0].key).toBe('pr-500');
  });
});
