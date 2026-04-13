/**
 * Regression test for pr-exists forge scripts.
 *
 * Bugfix #568: pr-exists must include --state all to catch merged PRs.
 * Spec #653: pr-exists must exclude CLOSED-not-merged PRs (only OPEN or MERGED count).
 *
 * These tests validate the forge scripts directly, not protocol.json commands.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SCRIPTS_ROOT = path.resolve(__dirname, '../../../../scripts/forge');

describe('pr-exists forge scripts', () => {
  describe('github/pr-exists.sh', () => {
    const scriptPath = path.join(SCRIPTS_ROOT, 'github', 'pr-exists.sh');

    it('exists and is readable', () => {
      expect(fs.existsSync(scriptPath)).toBe(true);
    });

    it('fetches all PR states (--state all) to catch merged PRs (#568)', () => {
      const content = fs.readFileSync(scriptPath, 'utf-8');
      expect(content).toContain('--state all');
    });

    it('filters to OPEN or MERGED only, excluding CLOSED (#653)', () => {
      const content = fs.readFileSync(scriptPath, 'utf-8');
      expect(content).toContain('select(.state == "OPEN" or .state == "MERGED")');
    });

    it('uses CODEV_BRANCH_NAME for branch filtering', () => {
      const content = fs.readFileSync(scriptPath, 'utf-8');
      expect(content).toContain('CODEV_BRANCH_NAME');
    });
  });

  describe('gitlab/pr-exists.sh', () => {
    const scriptPath = path.join(SCRIPTS_ROOT, 'gitlab', 'pr-exists.sh');

    it('exists and is readable', () => {
      expect(fs.existsSync(scriptPath)).toBe(true);
    });

    it('fetches all MR states (--all) to catch merged MRs (#568)', () => {
      const content = fs.readFileSync(scriptPath, 'utf-8');
      expect(content).toContain('--all');
    });

    it('filters to opened or merged only, excluding closed (#653)', () => {
      const content = fs.readFileSync(scriptPath, 'utf-8');
      expect(content).toContain('select(');
      expect(content).toMatch(/opened.*merged|merged.*opened/);
    });
  });

  describe('gitea/pr-exists.sh', () => {
    const scriptPath = path.join(SCRIPTS_ROOT, 'gitea', 'pr-exists.sh');

    it('exists and is readable', () => {
      expect(fs.existsSync(scriptPath)).toBe(true);
    });

    it('fetches all pull states (--state all) to catch merged pulls (#568)', () => {
      const content = fs.readFileSync(scriptPath, 'utf-8');
      expect(content).toContain('--state all');
    });

    it('filters out closed-not-merged PRs (#653)', () => {
      const content = fs.readFileSync(scriptPath, 'utf-8');
      // Gitea: merged PRs have state="closed" + merged=true
      expect(content).toContain('.merged == true');
    });
  });
});
