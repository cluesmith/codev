/**
 * Visibility contract for the three artifact-opening commands
 * (`codev.viewSpecFile` / `codev.viewPlanFile` / `codev.viewReviewFile`)
 * on the Builders tree, encoded as `view/item/context` `when` clauses
 * in package.json.
 *
 * Why test this here: the `when` clause is the *only* gate on whether
 * the menu entry shows for a row. Three separate regexes have to stay
 * in sync as protocols are added, and the PIR-specific "hide review if
 * no on-disk file" branch is non-obvious. A drift in the regex would
 * silently surface or hide a menu entry — no compile / runtime error
 * would catch it. This test pins the matrix.
 *
 * The test reads package.json, extracts the `viewItem =~ /.../` regex
 * from each command's `when` clause, and asserts the visibility matrix
 * across (protocol × state-family × has-review-file).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PKG = JSON.parse(
  readFileSync(resolve(__dirname, '../../package.json'), 'utf8'),
);

const viewItemMenuEntries: Array<{ command: string; when: string }> =
  PKG.contributes.menus['view/item/context'];

/** Extract the `viewItem =~ /.../ ` regex out of a `when` clause string. */
function extractViewItemRegex(when: string): RegExp {
  const m = when.match(/viewItem =~ \/(.+)\/$/);
  if (!m) {
    throw new Error(`No viewItem regex in when clause: ${when}`);
  }
  return new RegExp(m[1]);
}

function regexFor(command: string): RegExp {
  const entry = viewItemMenuEntries.find(e => e.command === command);
  if (!entry) {
    throw new Error(`No view/item/context entry for command ${command}`);
  }
  return extractViewItemRegex(entry.when);
}

const PROTOCOLS = ['spir', 'aspir', 'pir', 'air', 'bugfix', 'tick'] as const;
const FAMILIES = ['builder', 'blocked-builder', 'awaiting-builder'] as const;

/** Construct the contextValue the tree row would have for a given combo. */
function contextValue(family: typeof FAMILIES[number], protocol: typeof PROTOCOLS[number], hasReview: boolean) {
  return `${family}-${protocol}${hasReview ? '-review' : ''}`;
}

interface Expectation {
  spec: boolean;
  plan: boolean;
  review: boolean;
}

const EXPECTED: Record<typeof PROTOCOLS[number], { noReview: Expectation; withReview: Expectation }> = {
  spir:   { noReview: { spec: true,  plan: true,  review: true  }, withReview: { spec: true,  plan: true,  review: true } },
  aspir:  { noReview: { spec: true,  plan: true,  review: true  }, withReview: { spec: true,  plan: true,  review: true } },
  pir:    { noReview: { spec: false, plan: true,  review: false }, withReview: { spec: false, plan: true,  review: true } },
  air:    { noReview: { spec: false, plan: false, review: true  }, withReview: { spec: false, plan: false, review: true } },
  bugfix: { noReview: { spec: false, plan: false, review: false }, withReview: { spec: false, plan: false, review: false } },
  tick:   { noReview: { spec: false, plan: false, review: false }, withReview: { spec: false, plan: false, review: false } },
};

describe('view/item/context when-clause visibility for view{Spec,Plan,Review}File', () => {
  const specRegex = regexFor('codev.viewSpecFile');
  const planRegex = regexFor('codev.viewPlanFile');
  const reviewRegex = regexFor('codev.viewReviewFile');

  for (const family of FAMILIES) {
    for (const protocol of PROTOCOLS) {
      for (const hasReview of [false, true]) {
        const cv = contextValue(family, protocol, hasReview);
        const want = (hasReview ? EXPECTED[protocol].withReview : EXPECTED[protocol].noReview);

        it(`contextValue=${cv} → spec=${want.spec}, plan=${want.plan}, review=${want.review}`, () => {
          expect(specRegex.test(cv), `spec menu for ${cv}`).toBe(want.spec);
          expect(planRegex.test(cv), `plan menu for ${cv}`).toBe(want.plan);
          expect(reviewRegex.test(cv), `review menu for ${cv}`).toBe(want.review);
        });
      }
    }
  }

  it('rejects unrelated viewItem values (e.g. backlog-item, workspace-architect-sibling)', () => {
    for (const cv of ['backlog-item', 'workspace-architect-sibling', 'workspace-dev-start', 'builder-file-none']) {
      expect(specRegex.test(cv), `spec for ${cv}`).toBe(false);
      expect(planRegex.test(cv), `plan for ${cv}`).toBe(false);
      expect(reviewRegex.test(cv), `review for ${cv}`).toBe(false);
    }
  });
});

/**
 * commandPalette hiding for the three artifact commands.
 *
 * All three need a tree-item argument (a builder id) to do anything
 * useful — invoking them from the global Cmd+Shift+P palette without
 * that argument falls through to the missing-builder picker / toast.
 * To match every other builder-row command (`openBuilderById`,
 * `openBuilderRow`, `viewBacklogIssue`, `openBuilderFileDiff`, etc.)
 * we register them in `contributes.menus.commandPalette` with
 * `when: "false"` so they never surface in the palette UI.
 *
 * This test pins that decision: drift would silently restore the
 * palette entries (a UX regression — palette-invoking them does the
 * wrong thing).
 */
describe('commandPalette hiding for view{Spec,Plan,Review}File', () => {
  const paletteEntries: Array<{ command: string; when?: string }> =
    PKG.contributes.menus.commandPalette;

  for (const cmd of ['codev.viewSpecFile', 'codev.viewPlanFile', 'codev.viewReviewFile']) {
    it(`${cmd} is hidden from the command palette (when: false)`, () => {
      const entry = paletteEntries.find(e => e.command === cmd);
      expect(entry, `commandPalette entry for ${cmd}`).toBeDefined();
      expect(entry!.when, `${cmd} when-clause`).toBe('false');
    });
  }
});
