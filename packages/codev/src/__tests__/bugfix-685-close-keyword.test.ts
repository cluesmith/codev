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

const codevTargets: PromptTarget[] = [
  { protocol: 'spir', relPath: 'codev/protocols/spir/prompts/review.md' },
  { protocol: 'aspir', relPath: 'codev/protocols/aspir/prompts/review.md' },
  { protocol: 'air', relPath: 'codev/protocols/air/prompts/pr.md' },
  { protocol: 'bugfix', relPath: 'codev/protocols/bugfix/prompts/pr.md' },
  { protocol: 'maintain', relPath: 'codev/protocols/maintain/prompts/review.md' },
  { protocol: 'experiment', relPath: 'codev/protocols/experiment/builder-prompt.md' },
];

const skeletonTargets: PromptTarget[] = codevTargets.map((t) => ({
  protocol: t.protocol,
  relPath: t.relPath.replace(/^codev\//, 'codev-skeleton/'),
}));

const allTargets = [...codevTargets, ...skeletonTargets];

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

  it('codev-skeleton copies match codev originals for every edited prompt', () => {
    for (const { relPath } of codevTargets) {
      const codevContent = fs.readFileSync(path.join(repoRoot, relPath), 'utf-8');
      const skeletonPath = relPath.replace(/^codev\//, 'codev-skeleton/');
      const skeletonContent = fs.readFileSync(path.join(repoRoot, skeletonPath), 'utf-8');
      expect(skeletonContent, `mismatch: ${skeletonPath}`).toBe(codevContent);
    }
  });
});
