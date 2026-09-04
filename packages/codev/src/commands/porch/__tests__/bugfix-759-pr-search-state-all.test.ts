/**
 * Regression test for pr-search forge scripts.
 *
 * Bugfix #759: pr-search must include all PR states so post-merge lookups
 * (consult --type pr after a PR merges) still find the PR. Without it,
 * `gh pr list --search` / `glab mr list --search` default to open-only and
 * return nothing once the PR has merged.
 *
 * These tests validate the forge scripts directly, not protocol.json commands.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SCRIPTS_ROOT = path.resolve(__dirname, '../../../../scripts/forge');

describe('pr-search forge scripts', () => {
  describe('github/pr-search.sh', () => {
    const scriptPath = path.join(SCRIPTS_ROOT, 'github', 'pr-search.sh');

    it('exists and is readable', () => {
      expect(fs.existsSync(scriptPath)).toBe(true);
    });

    it('fetches all PR states (--state all) so merged PRs are found (#759)', () => {
      const content = fs.readFileSync(scriptPath, 'utf-8');
      expect(content).toContain('--state all');
    });

    it('still searches with the provided query', () => {
      const content = fs.readFileSync(scriptPath, 'utf-8');
      expect(content).toContain('--search "$CODEV_SEARCH_QUERY"');
    });
  });

  describe('gitlab/pr-search.sh', () => {
    const scriptPath = path.join(SCRIPTS_ROOT, 'gitlab', 'pr-search.sh');

    it('exists and is readable', () => {
      expect(fs.existsSync(scriptPath)).toBe(true);
    });

    it('fetches all MR states (--all) so merged MRs are found (#759)', () => {
      const content = fs.readFileSync(scriptPath, 'utf-8');
      expect(content).toContain('--all');
    });

    it('still searches with the provided query', () => {
      const content = fs.readFileSync(scriptPath, 'utf-8');
      expect(content).toContain('--search "$CODEV_SEARCH_QUERY"');
    });
  });
});
