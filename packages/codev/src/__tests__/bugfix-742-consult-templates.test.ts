/**
 * Regression test for GitHub Issue #742
 *
 * The BUGFIX protocol's `pr-review.md` and `impl-review.md` consult templates
 * were byte-identical to the SPIR versions, causing reviewer models to apply
 * SPIR-specific criteria (spec/plan/review trinity, `[Spec NNNN]` commit
 * format, `status.yaml.build_complete`, multi-phase scoping) to BUGFIX PRs.
 *
 * These checks pin the BUGFIX templates so they:
 *   1. Diverge from their SPIR counterparts
 *   2. Do not reference SPIR-only artifacts as review criteria
 *   3. Explicitly call out the BUGFIX-relevant artifacts (issue + regression
 *      test + `Fix #N` commits)
 *   4. Stay in sync between codev/ (self-hosted) and codev-skeleton/ (shipped
 *      template)
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '../../../..');

const templates = {
  bugfixPrReview: path.join(repoRoot, 'codev/protocols/bugfix/consult-types/pr-review.md'),
  bugfixImplReview: path.join(repoRoot, 'codev/protocols/bugfix/consult-types/impl-review.md'),
  spirPrReview: path.join(repoRoot, 'codev/protocols/spir/consult-types/pr-review.md'),
  spirImplReview: path.join(repoRoot, 'codev/protocols/spir/consult-types/impl-review.md'),
  skeletonBugfixPrReview: path.join(
    repoRoot,
    'codev-skeleton/protocols/bugfix/consult-types/pr-review.md',
  ),
  skeletonBugfixImplReview: path.join(
    repoRoot,
    'codev-skeleton/protocols/bugfix/consult-types/impl-review.md',
  ),
};

const read = (p: string) => fs.readFileSync(p, 'utf-8');

describe('BUGFIX consult templates (#742)', () => {
  describe('codev/ (self-hosted)', () => {
    it('pr-review.md must differ from the SPIR version', () => {
      const bugfix = read(templates.bugfixPrReview);
      const spir = read(templates.spirPrReview);
      expect(bugfix).not.toEqual(spir);
    });

    it('impl-review.md must differ from the SPIR version', () => {
      const bugfix = read(templates.bugfixImplReview);
      const spir = read(templates.spirImplReview);
      expect(bugfix).not.toEqual(spir);
    });
  });

  describe('codev-skeleton/ (shipped template)', () => {
    it('pr-review.md must match the codev/ copy byte-for-byte', () => {
      expect(read(templates.skeletonBugfixPrReview)).toEqual(read(templates.bugfixPrReview));
    });

    it('impl-review.md must match the codev/ copy byte-for-byte', () => {
      expect(read(templates.skeletonBugfixImplReview)).toEqual(read(templates.bugfixImplReview));
    });
  });

  describe.each([
    ['codev/ pr-review.md', templates.bugfixPrReview],
    ['codev/ impl-review.md', templates.bugfixImplReview],
    ['skeleton pr-review.md', templates.skeletonBugfixPrReview],
    ['skeleton impl-review.md', templates.skeletonBugfixImplReview],
  ])('content of %s', (_label, filePath) => {
    const content = read(filePath);

    it('does not require SPIR commit format `[Spec NNNN][Phase]` as a review criterion', () => {
      // The SPIR template asked: "Are all commits properly formatted (`[Spec XXXX][Phase]`)?"
      // That exact phrasing is the bug. The BUGFIX template may still *mention*
      // `[Spec NNNN][Phase]` in its "Out of Scope" section to explicitly forbid
      // citing it as a review reason — that's correct, not a regression.
      expect(content).not.toMatch(/Are all commits properly formatted.*\[Spec/i);
      expect(content).not.toMatch(/commits.*properly formatted.*`?\[Spec\s+X{3,4}\]\[Phase/i);
    });

    it('does not cite missing `codev/specs/`, `codev/plans/`, or `codev/reviews/` files as REQUEST_CHANGES criteria', () => {
      const lower = content.toLowerCase();
      // The new template references these paths only to mark them as out-of-scope.
      // It must NOT use them as review focus areas: e.g., "Is the review document
      // written (`codev/reviews/XXXX-name.md`)?" was the bug.
      expect(content).not.toMatch(/is the review document written.*codev\/reviews/i);
      expect(content).not.toMatch(/are all spec requirements implemented/i);
      expect(content).not.toMatch(/are all plan phases complete/i);
      // The phrase "Spec Adherence" was a SPIR-only focus area.
      expect(lower).not.toContain('1. **spec adherence**');
      expect(lower).not.toContain('**spec adherence**');
      // Likewise "Plan Alignment".
      expect(lower).not.toContain('**plan alignment**');
    });

    it('does not contain SPIR multi-phase scoping section', () => {
      expect(content).not.toMatch(/##\s*Scoping\s*\(Multi-Phase Plans\)/i);
    });

    it('explicitly identifies itself as a BUGFIX template', () => {
      expect(content).toMatch(/BUGFIX/);
    });

    it('mentions the BUGFIX commit format `Fix #N`', () => {
      expect(content).toMatch(/Fix\s+#/);
    });

    it('mentions the regression test as a required BUGFIX artifact', () => {
      expect(content.toLowerCase()).toMatch(/regression test/);
    });

    it('explicitly marks SPIR artifacts as out-of-scope for BUGFIX review', () => {
      // The template must explicitly list at least the spec/plan/review trinity
      // and the [Spec NNNN] commit format as things NOT to flag.
      expect(content.toLowerCase()).toMatch(/out of scope/);
      expect(content).toMatch(/status\.yaml/);
    });
  });
});
