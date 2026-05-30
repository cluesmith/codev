/**
 * Unit tests for the pure helpers that back a builder row's label and icon
 * in the Builders tree (#810):
 * - `builderRowLabel` — phase-prefix label across active / blocked / idle
 *   states plus the empty-phase edge case.
 * - `gateIconFor` — gate → codicon mapping, keyed off the CANONICAL gate name.
 *
 * Lives in `__tests__/` (vitest) rather than `src/test/` (vscode-test Electron
 * harness) because the helpers touch no `vscode` APIs.
 */

import { describe, it, expect } from 'vitest';
import type { OverviewBuilder } from '@cluesmith/codev-types';
import { builderRowLabel, gateIconFor } from '../views/builder-row.js';

// A fixed clock so elapsed-time suffixes are deterministic.
const NOW = new Date('2026-05-30T12:00:00Z').getTime();
const TWELVE_MIN_AGO = new Date(NOW - 12 * 60_000).toISOString();
// Strictly past IDLE_WAITING_THRESHOLD_MS (5m), so isIdleWaiting() is true.
const SIX_MIN_AGO = new Date(NOW - 6 * 60_000).toISOString();

function builder(overrides: Partial<OverviewBuilder>): OverviewBuilder {
  return {
    id: 'pir-810',
    issueId: '810',
    issueTitle: 'builder row legibility',
    phase: 'implement',
    protocolPhase: 'implement',
    mode: 'strict',
    gates: {},
    worktreePath: '/tmp/wt',
    roleId: null,
    protocol: 'pir',
    planPhases: [],
    progress: 0,
    blocked: null,
    blockedGate: null,
    blockedSince: null,
    startedAt: null,
    idleMs: 0,
    lastDataAt: null,
    spawnedByArchitect: null,
    area: 'Uncategorized',
    prReady: false,
    ...overrides,
  } as OverviewBuilder;
}

describe('builderRowLabel', () => {
  it('active builder: protocol-phase prefix after the issue number, no trailing state label', () => {
    const b = builder({
      issueId: '882',
      issueTitle: 'refactor extract',
      protocolPhase: 'implement',
    });
    expect(builderRowLabel(b, false, NOW)).toBe('[implement] #882 refactor extract');
  });

  it('renders the coarse protocolPhase, NOT the collapsed sub-phase id in `phase`', () => {
    // The defining case: a builder mid-implementation has `phase` overwritten
    // with a plan sub-phase id, but the prefix must show the protocol phase.
    const b = builder({
      issueId: '1190',
      issueTitle: 'Audit and unify',
      phase: 'phase_0_rebase_onto_ci',
      protocolPhase: 'implement',
    });
    expect(builderRowLabel(b, false, NOW)).toBe('[implement] #1190 Audit and unify');
  });

  it('blocked builder: phase prefix + trailing "blocked on <label> [<elapsed>]"', () => {
    const b = builder({
      issueId: '791',
      issueTitle: 'Startup preflight',
      protocolPhase: 'plan',
      blocked: 'plan review',
      blockedSince: TWELVE_MIN_AGO,
    });
    // isIdle is false: blocked takes precedence (caller computes !isBlocked && ...).
    expect(builderRowLabel(b, false, NOW)).toBe(
      '[plan] #791 Startup preflight blocked on plan review [12m]',
    );
  });

  it('idle builder: phase prefix + trailing "waiting on input [<elapsed> silent]"', () => {
    const b = builder({
      issueId: '794',
      issueTitle: 'Notification refactor',
      protocolPhase: 'implement',
      blocked: null,
      lastDataAt: SIX_MIN_AGO,
    });
    expect(builderRowLabel(b, true, NOW)).toBe(
      '[implement] #794 Notification refactor waiting on input [6m silent]',
    );
  });

  it('empty protocolPhase: no "[] " literal prefix', () => {
    const b = builder({ issueId: '810', issueTitle: 'x', protocolPhase: '' });
    expect(builderRowLabel(b, false, NOW)).toBe('#810 x');
  });

  it('falls back to id when issueId/issueTitle are null', () => {
    const b = builder({ id: 'pir-999', issueId: null, issueTitle: null, protocolPhase: 'plan' });
    expect(builderRowLabel(b, false, NOW)).toBe('[plan] #pir-999 ');
  });
});

describe('gateIconFor', () => {
  it('maps each canonical gate name to its codicon', () => {
    expect(gateIconFor('spec-approval')).toBe('book');
    expect(gateIconFor('plan-approval')).toBe('checklist');
    expect(gateIconFor('dev-approval')).toBe('code');
    expect(gateIconFor('pr')).toBe('git-pull-request');
    expect(gateIconFor('verify-approval')).toBe('verified');
  });

  it('falls back to bell for unknown / future gates', () => {
    expect(gateIconFor('some-future-gate')).toBe('bell');
  });

  it('falls back to bell when not blocked (null gate)', () => {
    expect(gateIconFor(null)).toBe('bell');
  });

  it('regression: keys off the canonical gate name, NOT the human-readable label', () => {
    // `b.blocked` holds "plan review"; `b.blockedGate` holds "plan-approval".
    // Passing the label must NOT match the map — guards against reverting to
    // keying the icon off `b.blocked` (which would no-op the whole feature).
    expect(gateIconFor('plan review')).toBe('bell');
    expect(gateIconFor('dev review')).toBe('bell');
    expect(gateIconFor('PR review')).toBe('bell');
  });
});
