/**
 * Spec 1280 — replacement for retired assertion R1.
 *
 * R1 retired the pure-addition diff of the three builder-prompts against their PRE-746
 * baselines. That assertion proved Spec 746's Baked Decisions paragraph was ADDED without
 * destroying prior content — true and useful at the moment of addition, but as a standing
 * assertion it forbade any future deletion-rewrite of those files forever.
 *
 * The protection worth keeping is narrower and survives rewrites: **once this project has
 * finished rewriting a prompt, later edits must not silently delete from it.** So the same
 * machinery is re-anchored on POST-1280 baselines.
 *
 * ANTI-VACUITY, INVERTED FOR THE NEW ERA
 * --------------------------------------
 * 746's pollution check asserted its baseline did NOT contain '## Baked Decisions' — proving
 * the baseline predated the edit it verified. The equivalent guarantee here runs the other way:
 * the post-1280 baseline MUST contain '## Baked Decisions'. If a future edit strips 746's
 * content and someone re-baselines to hide it, the new baseline lacks the heading and this
 * fails. Without that check, re-baselining would silently launder a deletion — which is exactly
 * the failure mode R1's analysis identified and declined to ship.
 *
 * R2 (approved 2026-08-04) extends the same machinery to the two SPIR/ASPIR specify.md drafting
 * prompts, whose Phase 2 pure-addition guard R1 left in force and Phase 5 retired. Their
 * anti-vacuity string is the literal `Baked Decisions` (specify.md carries the clause as a bullet,
 * not a `## Baked Decisions` heading like the builder-prompts). Full trace:
 * codev/resources/1280-retirements.md (R2).
 *
 * R3 (approved 2026-08-06) does the same for air/implement.md — the last PHASE_2 file — after
 * Phase 6's P1 rewrite retired its pure-addition guard. Full trace: 1280-retirements.md (R3).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '../../../..');
const baselineDir = path.join(repoRoot, 'packages/codev/src/__tests__/fixtures/spec-1280-baselines');

const GUARDED = ['spir', 'aspir', 'air'] as const;
const baselinePath = (p: string) => path.join(baselineDir, `${p}-builder-prompt.md.baseline`);
const currentPath = (p: string) =>
  path.join(repoRoot, 'codev/protocols', p, 'builder-prompt.md');

/** Every baseline line must reappear, in order, in the current file. */
function expectNoDeletion(label: string, baseline: string, current: string): void {
  const base = baseline.split('\n');
  const curr = current.split('\n');
  let bi = 0;
  for (let ci = 0; bi < base.length && ci < curr.length; ci++) {
    if (base[bi] === curr[ci]) bi++;
  }
  if (bi < base.length) {
    throw new Error(
      `${label}: content deleted since the Spec 1280 baseline — line ${bi + 1} ` +
        `("${base[bi]}") no longer present in order. If the removal is intentional, ` +
        `record it in codev/resources/1280-retirements.md and re-baseline in the same commit.`,
    );
  }
}

describe('Spec 1280 — builder-prompts do not silently lose content (replaces R1)', () => {
  for (const p of GUARDED) {
    describe(p, () => {
      it('has a post-1280 baseline committed', () => {
        expect(
          fs.existsSync(baselinePath(p)),
          `missing baseline for ${p}; the guard cannot protect what it has no reference for`,
        ).toBe(true);
      });

      it('anti-vacuity: the baseline carries Spec 746 content', () => {
        // If someone strips Baked Decisions and re-baselines to hide it, the new baseline
        // fails here rather than passing silently.
        const baseline = fs.readFileSync(baselinePath(p), 'utf-8');
        expect(baseline).toContain('## Baked Decisions');
        expect(baseline.toLowerCase()).toContain('do not autonomously');
      });

      it('no baseline line has been deleted', () => {
        expectNoDeletion(
          `${p} builder-prompt`,
          fs.readFileSync(baselinePath(p), 'utf-8'),
          fs.readFileSync(currentPath(p), 'utf-8'),
        );
      });

      it('the skeleton twin still matches', () => {
        const ours = fs.readFileSync(currentPath(p), 'utf-8');
        const skeleton = fs.readFileSync(
          path.join(repoRoot, 'codev-skeleton/protocols', p, 'builder-prompt.md'),
          'utf-8',
        );
        expect(skeleton).toBe(ours);
      });
    });
  }
});

// R2 (Spec 1280, approved 2026-08-04): the two SPIR/ASPIR specify.md drafting prompts, re-anchored
// on post-1280 baselines after Phase 5's P1/P2 rewrite retired their pre-746 pure-addition guard.
const GUARDED_SPECIFY = ['spir', 'aspir'] as const;
const specifyBaselinePath = (p: string) => path.join(baselineDir, `${p}-specify.md.baseline`);
const specifyCurrentPath = (p: string) =>
  path.join(repoRoot, 'codev/protocols', p, 'prompts/specify.md');

describe('Spec 1280 — SPIR/ASPIR specify.md do not silently lose content (replaces R2)', () => {
  for (const p of GUARDED_SPECIFY) {
    describe(`${p} specify.md`, () => {
      it('has a post-1280 baseline committed', () => {
        expect(
          fs.existsSync(specifyBaselinePath(p)),
          `missing baseline for ${p} specify.md; the guard cannot protect what it has no reference for`,
        ).toBe(true);
      });

      it('anti-vacuity: the baseline carries Spec 746 content', () => {
        // specify.md carries the Baked Decisions clause as a bullet, not a `## Baked Decisions`
        // heading — so the anti-vacuity string is the literal `Baked Decisions`. If someone strips
        // it and re-baselines to hide the deletion, the new baseline fails here rather than passing.
        const baseline = fs.readFileSync(specifyBaselinePath(p), 'utf-8');
        expect(baseline).toContain('Baked Decisions');
        expect(baseline.toLowerCase()).toContain('do not autonomously');
      });

      it('no baseline line has been deleted', () => {
        expectNoDeletion(
          `${p} specify.md`,
          fs.readFileSync(specifyBaselinePath(p), 'utf-8'),
          fs.readFileSync(specifyCurrentPath(p), 'utf-8'),
        );
      });

      it('the skeleton twin still matches', () => {
        const ours = fs.readFileSync(specifyCurrentPath(p), 'utf-8');
        const skeleton = fs.readFileSync(
          path.join(repoRoot, 'codev-skeleton/protocols', p, 'prompts/specify.md'),
          'utf-8',
        );
        expect(skeleton).toBe(ours);
      });
    });
  }
});

// R3 (Spec 1280, approved 2026-08-06): air/implement.md — the last PHASE_2 file — re-anchored on a
// post-1280 baseline after Phase 6's P1 rewrite retired its pre-746 pure-addition guard.
const airImplementBaseline = path.join(baselineDir, 'air-implement.md.baseline');
const airImplementCurrent = path.join(repoRoot, 'codev/protocols/air/prompts/implement.md');

describe('Spec 1280 — air/implement.md does not silently lose content (replaces R3)', () => {
  it('has a post-1280 baseline committed', () => {
    expect(
      fs.existsSync(airImplementBaseline),
      'missing baseline for air/implement.md; the guard cannot protect what it has no reference for',
    ).toBe(true);
  });

  it('anti-vacuity: the baseline carries Spec 746 content', () => {
    const baseline = fs.readFileSync(airImplementBaseline, 'utf-8');
    expect(baseline).toContain('Baked Decisions');
    expect(baseline.toLowerCase()).toContain('do not autonomously');
  });

  it('no baseline line has been deleted', () => {
    expectNoDeletion(
      'air/implement.md',
      fs.readFileSync(airImplementBaseline, 'utf-8'),
      fs.readFileSync(airImplementCurrent, 'utf-8'),
    );
  });

  it('the skeleton twin still matches', () => {
    const ours = fs.readFileSync(airImplementCurrent, 'utf-8');
    const skeleton = fs.readFileSync(
      path.join(repoRoot, 'codev-skeleton/protocols/air/prompts/implement.md'),
      'utf-8',
    );
    expect(skeleton).toBe(ours);
  });
});
