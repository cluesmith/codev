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
import type { ServedAgentState } from '@cluesmith/codev-types';
import {
  BUILDER_STATE_GLYPH,
  builderRowLabel,
  builderRowTooltip,
  classifyBuilderRow,
  gateIconFor,
  rollupGroupState,
  worstBuilderState,
} from '../views/builder-row.js';
import { areaGrouping } from '../views/builder-grouping.js';

// A fixed clock so elapsed-time suffixes are deterministic.
const NOW = new Date('2026-05-30T12:00:00Z').getTime();
const TWELVE_MIN_AGO = new Date(NOW - 12 * 60_000).toISOString();
// Strictly past IDLE_WAITING_THRESHOLD_MS (5m), so isIdleWaiting() is true.
const SIX_MIN_AGO = new Date(NOW - 6 * 60_000).toISOString();
const THREE_MIN_AGO = new Date(NOW - 3 * 60_000).toISOString();
const ONE_MIN_AGO = new Date(NOW - 60_000).toISOString();

/** A served agent state (Spec 1595), `since` three minutes ago. */
function served(state: ServedAgentState['state'], extra: Partial<ServedAgentState> = {}): ServedAgentState {
  return {
    state,
    since: THREE_MIN_AGO,
    source: 'harness',
    alive: true,
    activity: null,
    activityAt: THREE_MIN_AGO,
    backgroundWork: false,
    ...extra,
  };
}

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

// builderRowLabel is now a pure formatter: it prepends the prefix the active
// grouping strategy computed (axis selection is tested in builder-grouping.test.ts)
// and appends the blocked/idle state suffix. These cases pin the formatting.
describe('builderRowLabel', () => {
  it('prepends the supplied prefix, before the issue number, no trailing state label when active', () => {
    const b = builder({ issueId: '882', issueTitle: 'refactor extract' });
    expect(builderRowLabel(b, 'active', NOW, '[vscode] ')).toBe('[vscode] #882 refactor extract');
  });

  it('empty prefix → row starts at the issue number', () => {
    const b = builder({ issueId: '810', issueTitle: 'x' });
    expect(builderRowLabel(b, 'active', NOW, '')).toBe('#810 x');
  });

  it('blocked builder: prefix + trailing "blocked on <label> [<elapsed>]"', () => {
    const b = builder({
      issueId: '791',
      issueTitle: 'Startup preflight',
      blocked: 'plan review',
      blockedSince: TWELVE_MIN_AGO,
    });
    expect(builderRowLabel(b, 'blocked', NOW, '[core] ')).toBe(
      '[core] #791 Startup preflight blocked on plan review [12m]',
    );
  });

  it('experiment-complete-blocked builder: [analyze] prefix + "blocked on experiment review" (#1777)', () => {
    const b = builder({
      id: 'experiment-1560',
      issueId: '1560',
      issueTitle: 'spike',
      protocol: 'experiment',
      protocolPhase: 'analyze',
      blocked: 'experiment review',
      blockedGate: 'experiment-complete',
      blockedSince: TWELVE_MIN_AGO,
    });
    expect(builderRowLabel(b, 'blocked', NOW, areaGrouping().rowPrefix(b))).toBe(
      '[analyze] #1560 spike blocked on experiment review [12m]',
    );
    expect(gateIconFor(b.blockedGate)).toBe('beaker');
  });

  it('idle builder: prefix + trailing "waiting on input [<elapsed> silent]"', () => {
    const b = builder({
      issueId: '794',
      issueTitle: 'Notification refactor',
      blocked: null,
      lastDataAt: SIX_MIN_AGO,
    });
    expect(builderRowLabel(b, 'idle', NOW, '[vscode] ')).toBe(
      '[vscode] #794 Notification refactor waiting on input [6m silent]',
    );
  });

  it('falls back to id when issueId/issueTitle are null', () => {
    const b = builder({ id: 'pir-999', issueId: null, issueTitle: null });
    expect(builderRowLabel(b, 'active', NOW, '[vscode] ')).toBe('[vscode] #pir-999 ');
  });
});

describe('gateIconFor', () => {
  it('maps each canonical gate name to its codicon', () => {
    expect(gateIconFor('spec-approval')).toBe('book');
    expect(gateIconFor('plan-approval')).toBe('checklist');
    expect(gateIconFor('dev-approval')).toBe('code');
    expect(gateIconFor('pr')).toBe('git-pull-request');
    expect(gateIconFor('verify-approval')).toBe('verified');
    // #1777: EXPERIMENT / MAINTAIN / RESEARCH gates.
    expect(gateIconFor('experiment-complete')).toBe('beaker');
    expect(gateIconFor('maintain-complete')).toBe('tools');
    expect(gateIconFor('scope-approval')).toBe('search');
    expect(gateIconFor('research-complete')).toBe('library');
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

describe('rollupGroupState', () => {
  const blockedBuilder = () => builder({ blocked: 'plan review', blockedGate: 'plan-approval' });
  const idleBuilder = () => builder({ blocked: null, lastDataAt: SIX_MIN_AGO });
  const activeBuilder = () => builder({ blocked: null, lastDataAt: TWELVE_MIN_AGO, phase: 'verified' });

  it('all active → only the active count', () => {
    // `verified` phase makes isIdleWaiting false regardless of silence.
    const state = rollupGroupState([activeBuilder(), activeBuilder(), activeBuilder()], NOW);
    expect(state).toEqual({ blocked: 0, idle: 0, active: 3 });
  });

  it('one idle among actives → idle counted (idle beats active in the worst-of)', () => {
    const state = rollupGroupState([activeBuilder(), idleBuilder(), activeBuilder()], NOW);
    expect(state).toEqual({ blocked: 0, idle: 1, active: 2 });
  });

  it('one blocked → blocked counted (blocked beats idle + active)', () => {
    const state = rollupGroupState([activeBuilder(), idleBuilder(), blockedBuilder()], NOW);
    expect(state).toEqual({ blocked: 1, idle: 1, active: 1 });
  });

  it('blocked takes precedence over idle for the SAME builder', () => {
    // A builder that is both blocked AND silent past the threshold counts as
    // blocked only — mirrors the row classification (`!isBlocked && isIdle`).
    const both = builder({ blocked: 'plan review', blockedGate: 'plan-approval', lastDataAt: SIX_MIN_AGO });
    expect(rollupGroupState([both], NOW)).toEqual({ blocked: 1, idle: 0, active: 0 });
  });

  it('empty group → all zero', () => {
    expect(rollupGroupState([], NOW)).toEqual({ blocked: 0, idle: 0, active: 0 });
  });
});

describe('worstBuilderState', () => {
  it('blocked beats everything', () => {
    expect(worstBuilderState({ blocked: 1, idle: 5, active: 9 })).toBe('blocked');
  });

  it('idle beats active when nothing blocked', () => {
    expect(worstBuilderState({ blocked: 0, idle: 1, active: 9 })).toBe('idle');
  });

  it('active when nothing blocked or idle', () => {
    expect(worstBuilderState({ blocked: 0, idle: 0, active: 3 })).toBe('active');
  });

  it('all-zero (empty group) → active', () => {
    expect(worstBuilderState({ blocked: 0, idle: 0, active: 0 })).toBe('active');
  });
});

describe('classifyBuilderRow (Spec 1595)', () => {
  it('a porch gate wins over any served state', () => {
    const b = builder({ blocked: 'plan review', blockedGate: 'plan-approval', agentState: served('needs-input') });
    expect(classifyBuilderRow(b, NOW)).toBe('blocked');
  });

  it('reads needs-input, idle and dead from the served state, fresh output or not', () => {
    expect(classifyBuilderRow(builder({ lastDataAt: ONE_MIN_AGO, agentState: served('needs-input') }), NOW)).toBe('needs-input');
    expect(classifyBuilderRow(builder({ lastDataAt: ONE_MIN_AGO, agentState: served('idle') }), NOW)).toBe('idle');
    expect(classifyBuilderRow(builder({ lastDataAt: ONE_MIN_AGO, agentState: served('dead', { alive: false }) }), NOW)).toBe('dead');
  });

  it('a working agent is active, and a stale working one reads as idle', () => {
    expect(classifyBuilderRow(builder({ lastDataAt: ONE_MIN_AGO, agentState: served('working') }), NOW)).toBe('active');
    expect(classifyBuilderRow(builder({ lastDataAt: SIX_MIN_AGO, agentState: served('working') }), NOW)).toBe('idle');
  });

  it('with no served state, falls back to PTY silence', () => {
    expect(classifyBuilderRow(builder({ lastDataAt: SIX_MIN_AGO }), NOW)).toBe('idle');
    expect(classifyBuilderRow(builder({ lastDataAt: ONE_MIN_AGO, agentState: null }), NOW)).toBe('active');
  });

  it('a complete builder is active whatever its served state', () => {
    expect(classifyBuilderRow(builder({ phase: 'complete', agentState: served('dead') }), NOW)).toBe('active');
  });

  it('dead has its own glyph, distinct from idle and needs-input (SC7)', () => {
    const icons = new Set([BUILDER_STATE_GLYPH.dead.icon, BUILDER_STATE_GLYPH.idle.icon, BUILDER_STATE_GLYPH['needs-input'].icon]);
    expect(icons.size).toBe(3);
  });

  it('the group rollup counts every wait as idle', () => {
    const rows = [
      builder({ lastDataAt: ONE_MIN_AGO, agentState: served('needs-input') }),
      builder({ lastDataAt: ONE_MIN_AGO, agentState: served('dead') }),
      builder({ lastDataAt: ONE_MIN_AGO, agentState: served('working') }),
    ];
    expect(rollupGroupState(rows, NOW)).toEqual({ blocked: 0, idle: 2, active: 1 });
  });
});

describe('builderRowLabel over a served state (Spec 1595)', () => {
  it('needs-input at a permission prompt names the tool and summary, aged from the served since', () => {
    const b = builder({
      issueId: '794',
      issueTitle: 'x',
      lastDataAt: ONE_MIN_AGO,
      agentState: served('needs-input', { needsInput: { kind: 'permission', tool: 'Bash', summary: 'git push' } }),
    });
    expect(builderRowLabel(b, 'needs-input', NOW, '')).toBe('#794 x at a permission prompt: Bash git push [3m]');
  });

  it('needs-input on a question reads "asking a question"', () => {
    const b = builder({ issueId: '794', issueTitle: 'x', agentState: served('needs-input', { needsInput: { kind: 'question' } }) });
    expect(builderRowLabel(b, 'needs-input', NOW, '')).toBe('#794 x asking a question [3m]');
  });

  it('a served idle reads "turn ended"; a dead agent reads "agent exited"', () => {
    expect(builderRowLabel(builder({ issueId: '1', issueTitle: 'x', agentState: served('idle') }), 'idle', NOW, '')).toBe('#1 x turn ended [3m]');
    expect(builderRowLabel(builder({ issueId: '1', issueTitle: 'x', agentState: served('dead') }), 'dead', NOW, '')).toBe('#1 x agent exited [3m]');
  });

  it('a stale working reads as silence, aged from the last output', () => {
    const b = builder({ issueId: '1', issueTitle: 'x', lastDataAt: SIX_MIN_AGO, agentState: served('working', { since: TWELVE_MIN_AGO }) });
    expect(builderRowLabel(b, 'idle', NOW, '')).toBe('#1 x waiting on input [6m silent]');
  });
});

describe('builderRowTooltip (Spec 1595)', () => {
  it('is the protocol line alone for an active row', () => {
    expect(builderRowTooltip(builder({}), 'active')).toBe('Protocol: pir | Mode: strict | Progress: 0%');
  });

  it('carries a Markdown and command-link summary verbatim as plain text (SC19)', () => {
    const summary = '[run](command:workbench.action.terminal.sendSequence?%7B%7D) **x**';
    const b = builder({ agentState: served('needs-input', { needsInput: { kind: 'permission', tool: 'Bash', summary } }) });
    const tooltip = builderRowTooltip(b, 'needs-input');
    expect(typeof tooltip).toBe('string');
    expect(tooltip).toBe(`Protocol: pir | Mode: strict | Progress: 0%\nAt a permission prompt: Bash ${summary}`);
  });

  it('names a dead agent', () => {
    expect(builderRowTooltip(builder({ agentState: served('dead') }), 'dead')).toContain('\nAgent exited');
  });
});
