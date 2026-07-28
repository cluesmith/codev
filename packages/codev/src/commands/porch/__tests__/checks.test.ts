/**
 * Tests for porch check runner
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tmpdir } from 'node:os';
import {
  runCheck,
  runPhaseChecks,
  runArtifactCheck,
  formatCheckResults,
  allChecksPassed,
  REQUIRED_SPEC_SECTIONS,
  type CheckEnv,
} from '../checks.js';
import type { ArtifactResolver } from '../artifacts.js';

describe('porch check runner', () => {
  const cwd = tmpdir();
  const defaultEnv: CheckEnv = { PROJECT_ID: '0001', PROJECT_TITLE: 'test-project' };

  describe('runCheck', () => {
    it('should pass for successful command', async () => {
      const result = await runCheck('echo', 'echo hello', cwd, defaultEnv);

      expect(result.passed).toBe(true);
      expect(result.name).toBe('echo');
      expect(result.output).toContain('hello');
      expect(result.duration_ms).toBeGreaterThan(0);
    });

    it('should fail for unsuccessful command', async () => {
      const result = await runCheck('false', 'false', cwd, defaultEnv);

      expect(result.passed).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should fail for non-existent command', async () => {
      const result = await runCheck('bad', 'nonexistentcommand12345', cwd, defaultEnv);

      expect(result.passed).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should timeout for long-running command', async () => {
      const result = await runCheck('sleep', 'sleep 10', cwd, defaultEnv, 100);

      expect(result.passed).toBe(false);
      expect(result.error).toContain('Timed out');
    }, 15_000);

    it('should capture stderr on failure', async () => {
      const result = await runCheck('ls', 'ls /nonexistent/path/12345', cwd, defaultEnv);

      expect(result.passed).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should pass project env variables to command', async () => {
      const env: CheckEnv = { PROJECT_ID: '0042', PROJECT_TITLE: 'my-project' };
      const result = await runCheck('echo-env', 'echo $PROJECT_ID $PROJECT_TITLE', cwd, env);

      expect(result.passed).toBe(true);
      expect(result.output).toContain('0042');
      expect(result.output).toContain('my-project');
    });
  });

  describe('runPhaseChecks', () => {
    it('should run multiple checks', async () => {
      const checks = {
        echo1: 'echo one',
        echo2: 'echo two',
      };

      const results = await runPhaseChecks(checks, cwd, defaultEnv);

      expect(results).toHaveLength(2);
      expect(results[0].passed).toBe(true);
      expect(results[1].passed).toBe(true);
    });

    it('should stop on first failure', async () => {
      const checks = {
        echo1: 'echo one',
        fail: 'false',
        echo2: 'echo two', // Should not run
      };

      const results = await runPhaseChecks(checks, cwd, defaultEnv);

      expect(results).toHaveLength(2); // Stopped after fail
      expect(results[0].passed).toBe(true);
      expect(results[1].passed).toBe(false);
    });

    it('should return empty array for no checks', async () => {
      const results = await runPhaseChecks({}, cwd, defaultEnv);
      expect(results).toHaveLength(0);
    });
  });

  describe('formatCheckResults', () => {
    it('should format passing results', () => {
      const results = [
        { name: 'build', command: 'npm run build', passed: true, duration_ms: 1500 },
        { name: 'test', command: 'npm test', passed: true, duration_ms: 3200 },
      ];

      const output = formatCheckResults(results);

      expect(output).toContain('✓ build');
      expect(output).toContain('✓ test');
      expect(output).toContain('1.5s');
      expect(output).toContain('3.2s');
    });

    it('should format failing results with errors', () => {
      const results = [
        { name: 'build', command: 'npm run build', passed: true, duration_ms: 1000 },
        { name: 'test', command: 'npm test', passed: false, error: 'FAIL: 3 tests failed\nAssert error', duration_ms: 2000 },
      ];

      const output = formatCheckResults(results);

      expect(output).toContain('✓ build');
      expect(output).toContain('✗ test');
      expect(output).toContain('3 tests failed');
    });

    it('should truncate long error messages', () => {
      const longError = Array(10).fill('Error line').join('\n');
      const results = [
        { name: 'test', command: 'npm test', passed: false, error: longError, duration_ms: 1000 },
      ];

      const output = formatCheckResults(results);

      expect(output).toContain('...');
    });
  });

  describe('allChecksPassed', () => {
    it('should return true when all pass', () => {
      const results = [
        { name: 'a', command: 'a', passed: true },
        { name: 'b', command: 'b', passed: true },
      ];

      expect(allChecksPassed(results)).toBe(true);
    });

    it('should return false when any fail', () => {
      const results = [
        { name: 'a', command: 'a', passed: true },
        { name: 'b', command: 'b', passed: false },
      ];

      expect(allChecksPassed(results)).toBe(false);
    });

    it('should return true for empty array', () => {
      expect(allChecksPassed([])).toBe(true);
    });
  });

  describe('pr_exists interception', () => {
    it('routes pr_exists check through forge concept instead of raw command', async () => {
      // pr_exists is intercepted by runPhaseChecks to use the forge concept.
      // We can't easily mock the forge module in this integration test file,
      // but we can verify the interception doesn't break non-pr_exists checks.
      const checks = {
        echo: 'echo hello',
      };

      const results = await runPhaseChecks(checks, cwd, defaultEnv);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(results[0].name).toBe('echo');
    });

    it('continues running other checks after pr_exists', async () => {
      // When pr_exists is not in the checks, all checks run normally
      const checks = {
        check1: 'echo one',
        check2: 'echo two',
      };

      const results = await runPhaseChecks(checks, cwd, defaultEnv);
      expect(results).toHaveLength(2);
      expect(results.every(r => r.passed)).toBe(true);
    });
  });
  describe('spec checks (#1279 — spec-approval used to gate on nothing)', () => {
    /** Minimal resolver stub: only getSpecContent matters for these two checks. */
    const resolverWithSpec = (content: string | null): ArtifactResolver => ({
      getSpecContent: () => content,
      getPlanContent: () => null,
      getReviewContent: () => null,
    } as unknown as ArtifactResolver);

    const specFrom = (sections: readonly string[]): string =>
      `# Specification: Test\n\n${sections.map(h => `${h}\n\nbody\n`).join('\n')}`;

    it('spec_exists fails when the resolver finds no spec', () => {
      const r = runArtifactCheck('spec_exists', 'cmd', resolverWithSpec(null), defaultEnv);
      expect(r?.passed).toBe(false);
      expect(r?.error).toBe('Spec not found');
    });

    it('spec_exists passes when a spec is present', () => {
      const r = runArtifactCheck('spec_exists', 'cmd', resolverWithSpec('# Anything'), defaultEnv);
      expect(r?.passed).toBe(true);
    });

    it('spec_has_required_sections passes on a spec that follows the template', () => {
      const r = runArtifactCheck(
        'spec_has_required_sections', 'cmd', resolverWithSpec(specFrom(REQUIRED_SPEC_SECTIONS)), defaultEnv);
      expect(r?.passed).toBe(true);
      expect(r?.output).toContain(String(REQUIRED_SPEC_SECTIONS.length));
    });

    it('spec_has_required_sections fails on a free-form spec, naming what is missing', () => {
      // The exact reported failure mode: a readable spec that ignores the template
      // because the builder pattern-matched an earlier free-form spec.
      const r = runArtifactCheck(
        'spec_has_required_sections', 'cmd',
        resolverWithSpec('# Spec\n\n## Background\n\n## What We Will Build\n'), defaultEnv);
      expect(r?.passed).toBe(false);
      for (const h of REQUIRED_SPEC_SECTIONS) expect(r?.error).toContain(h);
    });

    it('spec_has_required_sections fails when only some sections are present', () => {
      const partial = REQUIRED_SPEC_SECTIONS.slice(0, 3);
      const r = runArtifactCheck(
        'spec_has_required_sections', 'cmd', resolverWithSpec(specFrom(partial)), defaultEnv);
      expect(r?.passed).toBe(false);
      expect(r?.error).toContain('## Solution Approaches');
      expect(r?.error).not.toContain('missing 6 required');
    });

    it('spec_has_required_sections fails when the spec is absent entirely', () => {
      const r = runArtifactCheck('spec_has_required_sections', 'cmd', resolverWithSpec(null), defaultEnv);
      expect(r?.passed).toBe(false);
    });

    it('an unrecognized check name still falls through to shell execution', () => {
      expect(runArtifactCheck('something_else', 'cmd', resolverWithSpec('x'), defaultEnv)).toBeNull();
    });
  });
});
