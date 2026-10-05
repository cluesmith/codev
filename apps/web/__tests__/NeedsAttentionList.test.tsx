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
    protocolPhase: 'review',
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

  it('surfaces a BUGFIX PR via the pr gate (post-#887, gate-authoritative shape)', () => {
    // #887 gave BUGFIX a `pr` gate, so a prReady BUGFIX builder carries
    // blocked='PR review' + blockedSince (gate-authoritative). The PR surfaces
    // as a PR row, and its wait time is the gate-requested time — not createdAt.
    const createdAt = new Date('2026-01-01T00:00:00Z').toISOString();
    const blockedSince = new Date('2026-01-02T00:00:00Z').toISOString();
    const prs = [makePR({ id: '111', linkedIssue: '42', createdAt })];
    const builders = [
      makeBuilder({
        issueId: '42',
        protocol: 'bugfix',
        phase: 'review',
        blocked: 'PR review',
        blockedGate: 'pr',
        blockedSince,
        prReady: true,
      }),
    ];

    const items = buildItems(prs, builders);
    const row = items.find(i => i.key === 'pr-111');

    expect(row).toBeDefined();
    expect(row!.waitingSince).toBe(blockedSince);
  });

  it('surfaces a human-authored PR (no matching builder) only when reviewStatus is REVIEW_REQUIRED, using pr.createdAt', () => {
    const createdAt = new Date('2026-01-03T00:00:00Z').toISOString();
    const required = makePR({ id: '200', linkedIssue: null, reviewStatus: 'REVIEW_REQUIRED', createdAt });
    const approved = makePR({ id: '201', linkedIssue: null, reviewStatus: 'APPROVED' });

    const items = buildItems([required, approved], []);
    const row = items.find(i => i.key === 'pr-200');

    expect(row).toBeDefined();
    // Unaffiliated PR has no gate signal — wait time falls back to createdAt.
    expect(row!.waitingSince).toBe(createdAt);
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

  it('does NOT surface a prReady BUGFIX builder when its PR is missing from prs (#927: no builder stand-in)', () => {
    // #927 inverts the pre-existing defensive builder-emit: a builder NEVER
    // stands in for a PR. If a prReady builder's PR is absent from `prs` (cache
    // miss / pagination / merged), emit NOTHING — the next refresh surfaces it
    // once `pendingPRs` includes the open PR.
    const prs: OverviewPR[] = [];
    const builders = [
      makeBuilder({
        id: 'bugfix-42',
        issueId: '42',
        protocol: 'bugfix',
        phase: 'verified',
        blocked: null,
        blockedGate: null,
        blockedSince: null,
        startedAt: new Date('2026-01-05T12:00:00Z').toISOString(),
        prReady: true,
      }),
    ];

    const items = buildItems(prs, builders);

    expect(items.find(i => i.key === 'gate-bugfix-42')).toBeUndefined();
    expect(items).toHaveLength(0);
  });

  it('does NOT surface a prReady gated builder (AIR/SPIR shape) when its PR is missing from prs (#927)', () => {
    // Same rule for the gate-bearing shape: prReady + PR absent ⇒ no row.
    const prs: OverviewPR[] = [];
    const builders = [
      makeBuilder({
        id: 'air-42',
        issueId: '42',
        protocol: 'air',
        blocked: 'PR review',
        blockedGate: 'pr',
        blockedSince: new Date('2026-01-05T12:00:00Z').toISOString(),
        prReady: true,
      }),
    ];

    const items = buildItems(prs, builders);

    expect(items.find(i => i.key === 'gate-air-42')).toBeUndefined();
    expect(items).toHaveLength(0);
  });

  it('does NOT surface a merged PR (absent from prs) — no recentlyMerged list needed (#927)', () => {
    // Post-merge the PR is correctly absent from `prs` (open-only) and the
    // builder may still carry stale prReady. #927 removed the merged-suppression
    // list (recentlyMergedIssueIds): a missing PR simply yields no row, by the
    // same "no builder stand-in" rule.
    const prs: OverviewPR[] = [];
    const builders = [
      makeBuilder({
        id: 'spir-1842',
        issueId: '1842',
        protocol: 'spir',
        phase: 'verified',
        blocked: null,
        blockedGate: null,
        blockedSince: null,
        prReady: true,
      }),
    ];

    const items = buildItems(prs, builders);

    expect(items).toHaveLength(0);
  });

  it('surfaces a verify-approval-pending builder as a gate row labeled "verify review" (#927)', () => {
    // Post-merge human gate. prReady=false (pr gate not pending); `blocked` is
    // set by the server's GATE_LABELS. Surfaces as a gate row, not a PR row,
    // with the verify styling class.
    const prs: OverviewPR[] = [];
    const blockedSince = new Date('2026-01-06T08:00:00Z').toISOString();
    const builders = [
      makeBuilder({
        id: 'spir-77',
        issueId: '77',
        protocol: 'spir',
        phase: 'verify',
        blocked: 'verify review',
        blockedGate: 'verify-approval',
        blockedSince,
        prReady: false,
      }),
    ];

    const items = buildItems(prs, builders);
    const row = items.find(i => i.key === 'gate-spir-77');

    expect(row).toBeDefined();
    expect(row!.kind).toBe('verify review');
    expect(row!.kindClass).toBe('attention-kind--verify');
    expect(row!.waitingSince).toBe(blockedSince);
  });

  it('surfaces a dev-approval-pending builder as a gate row with --dev styling (#931, PIR)', () => {
    // PIR's pre-PR human gate. The overview server's GATE_LABELS maps
    // dev-approval → "dev review"; gateKindClass must map that label to
    // attention-kind--dev so the row renders with its own color. Before #931
    // there was no `case 'dev review'`, so it fell through to the default
    // attention-kind--plan (the plan gate's color) — this guards against that.
    const prs: OverviewPR[] = [];
    const blockedSince = new Date('2026-01-06T08:00:00Z').toISOString();
    const builders = [
      makeBuilder({
        id: 'pir-88',
        issueId: '88',
        protocol: 'pir',
        phase: 'implement',
        blocked: 'dev review',
        blockedGate: 'dev-approval',
        blockedSince,
        prReady: false,
      }),
    ];

    const items = buildItems(prs, builders);
    const row = items.find(i => i.key === 'gate-pir-88');

    expect(row).toBeDefined();
    expect(row!.kind).toBe('dev review');
    expect(row!.kindClass).toBe('attention-kind--dev');
    // The user-visible symptom of #931 was dev rows being indistinguishable
    // from plan rows. Guard that dev maps to its OWN class, never the plan
    // class (the old default fallthrough). The class carries a distinct color
    // (--status-implementing vs plan's --status-error) defined in index.css.
    expect(row!.kindClass).not.toBe('attention-kind--plan');
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

describe('NeedsAttentionList buildItems — non-core gates (#1779)', () => {
  it.each([
    ['experiment review', 'experiment-complete'],
    ['maintenance review', 'maintain-complete'],
    ['scope review', 'scope-approval'],
    ['research review', 'research-complete'],
  ])('styles a %s row with the neutral --other class, not the plan fallback', (blocked, blockedGate) => {
    const blockedSince = new Date('2026-01-06T08:00:00Z').toISOString();
    const builders = [makeBuilder({ id: 'b-1', blocked, blockedGate, blockedSince })];

    const row = buildItems([], builders).find(i => i.key === 'gate-b-1');

    expect(row).toBeDefined();
    expect(row!.kind).toBe(blocked);
    expect(row!.kindClass).toBe('attention-kind--other');
  });
});
