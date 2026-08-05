/**
 * Unit tests for the pure stage-grouping helper backing the VSCode Builders
 * tree's action axis (#952). Lives in `__tests__/` (vitest) since the helper
 * touches no `vscode` APIs; imports from `@cluesmith/codev-sdk/phase-grouping`
 * (resolves via the package `exports` map → built `dist`, so `codev-core` must
 * be built first — the standard pipeline order).
 */

import { describe, it, expect } from 'vitest';
import {
  groupByStage,
  stageForPhase,
  PHASE_TO_STAGE,
  STAGE_ORDER,
  type BuilderStage,
} from '@cluesmith/codev-sdk/phase-grouping';

/** Minimal item shape — groupByStage is generic; it only needs a phase getter. */
const phase = (p: string) => ({ phase: p });
const stagesOf = (items: ReturnType<typeof phase>[]) =>
  groupByStage(items, i => i.phase).map(g => g.stage);

describe('stageForPhase — every bundled-protocol phase id maps to a canonical stage', () => {
  const cases: Array<[string[], BuilderStage]> = [
    [['specify', 'hypothesis', 'scope'], 'specify'],
    [['plan', 'design', 'investigate'], 'plan'],
    [['implement', 'fix', 'execute', 'maintain', 'spike'], 'implement'],
    [['review', 'synthesize', 'analyze', 'critique'], 'review'],
    [['pr'], 'pr'],
    [['verify', 'verified', 'complete'], 'verified'],
  ];

  for (const [ids, stage] of cases) {
    for (const id of ids) {
      it(`${id} → ${stage}`, () => {
        expect(stageForPhase(id)).toBe(stage);
      });
    }
  }

  it('investigate → plan specifically (architect-confirmed ambiguous call)', () => {
    expect(stageForPhase('investigate')).toBe('plan');
  });

  it('verify, verified, complete all fold into the single `verified` stage', () => {
    expect(stageForPhase('verify')).toBe('verified');
    expect(stageForPhase('verified')).toBe('verified');
    expect(stageForPhase('complete')).toBe('verified');
  });

  it('empty string → unknown', () => {
    expect(stageForPhase('')).toBe('unknown');
  });

  it('unrecognized future phase → unknown (NOT its own stage)', () => {
    expect(stageForPhase('frobnicate')).toBe('unknown');
  });

  it('every PHASE_TO_STAGE value is a member of STAGE_ORDER', () => {
    for (const stage of Object.values(PHASE_TO_STAGE)) {
      expect(STAGE_ORDER).toContain(stage);
    }
  });
});

describe('groupByStage', () => {
  it('emits stages in fixed lifecycle order regardless of input order', () => {
    const items = [phase('verify'), phase('plan'), phase('implement'), phase('specify'), phase('review'), phase('pr')];
    expect(stagesOf(items)).toEqual(['specify', 'plan', 'implement', 'review', 'pr', 'verified']);
  });

  it('folds auxiliary protocol phases into the canonical stages, NOT their own groups', () => {
    // bugfix investigate/fix, research scope/synthesize/critique, experiment
    // hypothesis/design/execute/analyze, maintain, spike — all fold in.
    const items = [
      phase('hypothesis'), phase('scope'),          // → specify
      phase('design'), phase('investigate'),        // → plan
      phase('fix'), phase('execute'), phase('maintain'), phase('spike'), // → implement
      phase('synthesize'), phase('analyze'), phase('critique'),          // → review
    ];
    expect(stagesOf(items)).toEqual(['specify', 'plan', 'implement', 'review']);
  });

  it('omits empty stages (a stage with no members produces no group)', () => {
    const items = [phase('implement'), phase('implement'), phase('pr')];
    expect(stagesOf(items)).toEqual(['implement', 'pr']);
  });

  it('empty and unrecognized phases collapse into a single trailing unknown group', () => {
    const items = [phase('implement'), phase(''), phase('frobnicate'), phase('plan')];
    const groups = groupByStage(items, i => i.phase);
    expect(groups.map(g => g.stage)).toEqual(['plan', 'implement', 'unknown']);
    // both the empty-string and the unrecognized id land in the one unknown bucket
    expect(groups.find(g => g.stage === 'unknown')!.items).toHaveLength(2);
  });

  it('preserves input order within a stage', () => {
    const a = phase('implement');
    const b = phase('implement');
    const c = phase('implement');
    const group = groupByStage([a, b, c], i => i.phase)[0];
    expect(group.items).toEqual([a, b, c]);
  });

  it('verify (in-progress) and verified/complete (terminal) share the verified group', () => {
    const items = [phase('verify'), phase('verified'), phase('complete')];
    const groups = groupByStage(items, i => i.phase);
    expect(groups).toHaveLength(1);
    expect(groups[0].stage).toBe('verified');
    expect(groups[0].items).toHaveLength(3);
  });

  it('empty input → no groups', () => {
    expect(groupByStage([], (i: { phase: string }) => i.phase)).toEqual([]);
  });

  it('caps at the closed stage set: never more than STAGE_ORDER.length groups', () => {
    // One builder per known phase id + an unmapped one → still ≤ 7 groups.
    const items = Object.keys(PHASE_TO_STAGE).map(phase).concat(phase('frobnicate'));
    const groups = groupByStage(items, i => i.phase);
    expect(groups.length).toBeLessThanOrEqual(STAGE_ORDER.length);
  });
});
