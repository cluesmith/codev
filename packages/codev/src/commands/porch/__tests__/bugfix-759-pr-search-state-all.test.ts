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

    it('emits state so the spawn guard can filter merged PRs (#1637)', () => {
      // Paired-consumer contract: --state all keeps merged PRs visible for consult
      // (#759), while the `state` field lets the spawn collision guard ignore them.
      const content = fs.readFileSync(scriptPath, 'utf-8');
      expect(content).toContain('--state all');
      expect(content).toMatch(/--json\s+\S*\bstate\b/);
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

    it('normalizes opened MRs to the OPEN state so the guard can filter (#1637)', () => {
      // glab reports state lowercase; the script maps opened -> OPEN so the spawn
      // collision guard's state === "OPEN" comparison is forge-agnostic.
      const content = fs.readFileSync(scriptPath, 'utf-8');
      expect(content).toContain('--all');
      expect(content).toContain('"OPEN"');
    });
  });
});
