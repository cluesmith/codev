/**
 * Regression test for GitHub Issue #744
 *
 * The SPIR/ASPIR builder-prompt templates did not state the one-PR-per-spec
 * convention explicitly. Builders interpreted "each phase commits independently"
 * as "each phase gets its own PR" and shipped per-phase PRs that the architect
 * then had to close.
 *
 * This test verifies that all four SPIR/ASPIR builder-prompt files contain
 * explicit guidance that all plan phases ship in a single PR.
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

describe('bugfix-744: SPIR/ASPIR builder-prompt states one-PR-per-spec', () => {
  for (const relPath of PROMPT_FILES) {
    const fullPath = path.join(repoRoot, relPath);

    it(`${relPath} — declares one PR per spec`, () => {
      const content = fs.readFileSync(fullPath, 'utf-8');
      expect(content).toMatch(/ONE PR per spec/);
    });

    it(`${relPath} — clarifies phase-commits != per-phase PRs`, () => {
      const content = fs.readFileSync(fullPath, 'utf-8');
      // Must clarify that "each phase commits independently" refers to git commits, not PRs
      expect(content).toMatch(/git commits.*not separate PRs|not separate PRs/);
    });
  }
});
