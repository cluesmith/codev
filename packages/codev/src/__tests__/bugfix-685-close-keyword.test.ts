/**
 * Regression test for GitHub Issue #685
 *
 * Some protocols' PR-creating prompts did not require the builder to include
 * a GitHub close-keyword (`Closes #N` / `Fixes #N`) in the PR body, so merged
 * PRs did not auto-close their driving issues. This test verifies every
 * protocol's PR-creating prompt contains both a close-keyword directive and
 * the partial-fix exception guidance.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '../../../..');

interface PromptTarget {
  protocol: string;
  relPath: string;
}

// Spec 1252 (Phase 4): the codev/protocols shadow tree was deleted — the
// skeleton is the single owner, so the former codev-vs-skeleton mirror pair
// collapsed to one target list (and the mirror-parity test below was removed
// as vacuous: there is no second tree to compare against).
const allTargets: PromptTarget[] = [
  { protocol: 'spir', relPath: 'codev-skeleton/protocols/spir/prompts/review.md' },
  { protocol: 'aspir', relPath: 'codev-skeleton/protocols/aspir/prompts/review.md' },
  { protocol: 'air', relPath: 'codev-skeleton/protocols/air/prompts/pr.md' },
  { protocol: 'bugfix', relPath: 'codev-skeleton/protocols/bugfix/prompts/pr.md' },
  { protocol: 'maintain', relPath: 'codev-skeleton/protocols/maintain/prompts/review.md' },
  { protocol: 'experiment', relPath: 'codev-skeleton/protocols/experiment/builder-prompt.md' },
];

describe('PR close-keyword directive (#685)', () => {
  it.each(allTargets)(
    '$protocol prompt at $relPath mentions Closes/Fixes keyword',
    ({ relPath }) => {
      const content = fs.readFileSync(path.join(repoRoot, relPath), 'utf-8');
      expect(content).toMatch(/`Closes #|`Fixes #/);
    },
  );

  it.each(allTargets)(
    '$protocol prompt at $relPath documents the partial-fix exception',
    ({ relPath }) => {
      const content = fs.readFileSync(path.join(repoRoot, relPath), 'utf-8');
      expect(content).toMatch(/`Refs #|`Part of #/);
    },
  );

  it.each(allTargets)(
    '$protocol prompt at $relPath explains why the keyword matters',
    ({ relPath }) => {
      const content = fs.readFileSync(path.join(repoRoot, relPath), 'utf-8');
      expect(content).toMatch(/auto-close/i);
    },
  );


  /**
   * Porch's phase prompt renderer (packages/codev/src/commands/porch/prompts.ts
   * `substituteVariables`) only replaces `{{word}}` tokens — NOT dotted paths
   * like `{{issue.number}}`. So any `{{issue...}}` left inside the PR body
   * template would render literally and break GitHub auto-close.
   *
   * New directive text added for #685 must use `<N>` placeholders, not
   * `{{issue.number}}`, inside the PR body template (the lines between
   * `gh pr create ... --body "$(cat <<'EOF'` and the matching `EOF`).
   *
   * The bugfix prompt's `{{issue.number}}` in `gh pr create --title` and in
   * the notification `afx send architect` command predates this fix and is
   * out of scope — this test only guards the PR body template itself.
   */
  const prBodyTargets: PromptTarget[] = [
    { protocol: 'bugfix', relPath: 'codev-skeleton/protocols/bugfix/prompts/pr.md' },
    { protocol: 'air', relPath: 'codev-skeleton/protocols/air/prompts/pr.md' },
    { protocol: 'spir', relPath: 'codev-skeleton/protocols/spir/prompts/review.md' },
    { protocol: 'aspir', relPath: 'codev-skeleton/protocols/aspir/prompts/review.md' },
    { protocol: 'maintain', relPath: 'codev-skeleton/protocols/maintain/prompts/review.md' },
  ];

  it.each(prBodyTargets)(
    '$protocol PR body template does not contain unrendered {{issue...}} tokens',
    ({ relPath }) => {
      const content = fs.readFileSync(path.join(repoRoot, relPath), 'utf-8');
      const bodyMatch = content.match(/--body\s+"\$\(cat\s+<<\s*'(\w+)'([\s\S]*?)^\1\s*$/m);
      expect(bodyMatch, `PR body template not found in ${relPath}`).not.toBeNull();
      const body = bodyMatch![2];
      expect(body, `${relPath} PR body contains {{issue.*}}`).not.toMatch(/\{\{issue\./);
    },
  );
});
