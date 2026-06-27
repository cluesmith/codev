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

/**
 * `codev.hasDevCommand` gating for the dev-server commands (#975).
 *
 * The builder-row Run/Stop Dev Server context-menu entries must only
 * surface when a runnable `worktree.devCommand` is configured. Previously
 * they gated on view + viewItem family only, so they showed even with no
 * dev command — picking one ran against a missing command. The fix appends
 * `&& codev.hasDevCommand` (a setContext key extension.ts refreshes from the
 * Tower-merged config on connect + the `codev-config-updated` SSE) to the
 * `when` clause.
 *
 * The same gate extends to the keybindings and the workspace-dev palette
 * entries for consistency; the builder-row dev commands are `when: false`
 * in the palette because they need a tree-row argument (same rationale as
 * the view{Spec,Plan,Review}File commands above).
 *
 * Pinning the wiring here: a drift in any of these `when` shapes would
 * silently re-expose a command that can't run — no compile/runtime error
 * would catch it.
 */
describe('codev.hasDevCommand gating for dev-server commands', () => {
  const paletteEntries: Array<{ command: string; when?: string }> =
    PKG.contributes.menus.commandPalette;
  const keybindings: Array<{ command: string; when?: string }> =
    PKG.contributes.keybindings;

  for (const cmd of ['codev.runWorktreeDev', 'codev.stopWorktreeDev']) {
    it(`${cmd} builder-row menu entry is gated by codev.hasDevCommand`, () => {
      const entry = viewItemMenuEntries.find(
        e => e.command === cmd && e.when.includes('view == codev.builders'));
      expect(entry, `builders view/item/context entry for ${cmd}`).toBeDefined();
      expect(entry!.when, `${cmd} when-clause`).toContain('&& codev.hasDevCommand');
    });

    it(`${cmd} is hidden from the command palette (needs a row argument)`, () => {
      const entry = paletteEntries.find(e => e.command === cmd);
      expect(entry, `commandPalette entry for ${cmd}`).toBeDefined();
      expect(entry!.when, `${cmd} palette when-clause`).toBe('false');
    });
  }

  for (const cmd of ['codev.runWorkspaceDev', 'codev.stopWorkspaceDev']) {
    it(`${cmd} command palette entry is gated by codev.hasDevCommand`, () => {
      const entry = paletteEntries.find(e => e.command === cmd);
      expect(entry, `commandPalette entry for ${cmd}`).toBeDefined();
      expect(entry!.when, `${cmd} palette when-clause`).toBe('codev.hasDevCommand');
    });

    it(`${cmd} keybinding is gated by codev.hasDevCommand`, () => {
      const entry = keybindings.find(k => k.command === cmd);
      expect(entry, `keybinding for ${cmd}`).toBeDefined();
      expect(entry!.when, `${cmd} keybinding when-clause`).toBe('codev.hasDevCommand');
    });
  }

  it('does not gate the Workspace view dev rows on codev.hasDevCommand (they gate via viewItem)', () => {
    // The Workspace view rows are config-gated by row existence (the
    // viewItem is only emitted when a dev command is configured), so their
    // menu `when` must stay viewItem-only — no redundant context key.
    for (const cmd of ['codev.runWorkspaceDev', 'codev.stopWorkspaceDev']) {
      const entry = viewItemMenuEntries.find(
        e => e.command === cmd && e.when.includes('view == codev.workspace'));
      expect(entry, `workspace view/item/context entry for ${cmd}`).toBeDefined();
      expect(entry!.when, `${cmd} workspace when-clause`).not.toContain('codev.hasDevCommand');
    }
  });
});
