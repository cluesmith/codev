/**
 * Regression test for GitHub Issue #744
 *
 * The SPIR/ASPIR builder-prompt templates did not state the PR-strategy
 * convention explicitly. Builders interpreted "each phase commits
 * independently" as "each phase gets its own PR" and shipped per-phase
 * PRs that the architect then had to close.
 *
 * This test verifies that all four SPIR/ASPIR builder-prompt files contain:
 *   1. An explicit prohibition on the builder autonomously opening a PR
 *      per implementation phase.
 *   2. The clarification that "each phase commits independently" refers
 *      to git commits, not PRs.
 *   3. The architect-override carve-out — the architect may still request
 *      a PR at any point (spec review, mid-impl feedback, slicing, etc.).
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');

const PROMPT_FILES = [
  'codev/protocols/spir/builder-prompt.md',
  'codev-skeleton/protocols/spir/builder-prompt.md',
  'codev/protocols/aspir/builder-prompt.md',
  'codev-skeleton/protocols/aspir/builder-prompt.md',
];

describe('bugfix-744: SPIR/ASPIR builder-prompt PR strategy', () => {
  for (const relPath of PROMPT_FILES) {
    const fullPath = path.join(repoRoot, relPath);

    it(`${relPath} — prohibits builder from autonomously opening per-phase PRs`, () => {
      const content = fs.readFileSync(fullPath, 'utf-8');
      expect(content).toMatch(/Do not autonomously open a PR per implementation phase/);
    });

    it(`${relPath} — clarifies phase-commits are git commits, not PRs`, () => {
      const content = fs.readFileSync(fullPath, 'utf-8');
      expect(content).toMatch(/refers to git commits, not PRs/);
    });

    it(`${relPath} — preserves architect-override carve-out`, () => {
      const content = fs.readFileSync(fullPath, 'utf-8');
      // The architect must be explicitly allowed to request a PR at any point —
      // the prohibition is on autonomous builder action, not on PRs themselves.
      expect(content).toMatch(/architect MAY request a PR/i);
    });
  }
});
