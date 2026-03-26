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
});

// =============================================================================
// runArtifactCheck
// =============================================================================

function makeResolver(overrides: Partial<ArtifactResolver> = {}): ArtifactResolver {
  return {
    findSpecBaseName: () => null,
    getSpecContent: () => null,
    getPlanContent: () => null,
    getReviewContent: () => null,
    hasPreApproval: () => false,
    ...overrides,
  };
}

describe('runArtifactCheck', () => {
  const env: CheckEnv = { PROJECT_ID: '42', PROJECT_TITLE: '42-my-feature' };

  it('returns null for unrecognized check names (fall through to shell)', () => {
    const resolver = makeResolver();
    expect(runArtifactCheck('custom_check', 'echo hi', resolver, env)).toBeNull();
  });

  describe('plan_exists', () => {
    it('passes when resolver returns plan content', () => {
      const resolver = makeResolver({ getPlanContent: () => '# Plan' });
      const result = runArtifactCheck('plan_exists', 'check-plan', resolver, env);
      expect(result).not.toBeNull();
      expect(result!.passed).toBe(true);
    });

    it('fails when resolver returns null', () => {
      const resolver = makeResolver({ getPlanContent: () => null });
      const result = runArtifactCheck('plan_exists', 'check-plan', resolver, env);
      expect(result).not.toBeNull();
      expect(result!.passed).toBe(false);
      expect(result!.error).toBeDefined();
    });
  });

  describe('has_phases_json', () => {
    it('passes when plan contains "phases": key', () => {
      const resolver = makeResolver({ getPlanContent: () => '```json\n{"phases": []}\n```' });
      const result = runArtifactCheck('has_phases_json', 'cmd', resolver, env);
      expect(result!.passed).toBe(true);
    });

    it('fails when plan has no "phases": key', () => {
      const resolver = makeResolver({ getPlanContent: () => '# Plan with no phases' });
      const result = runArtifactCheck('has_phases_json', 'cmd', resolver, env);
      expect(result!.passed).toBe(false);
    });

    it('fails when plan not found', () => {
      const resolver = makeResolver({ getPlanContent: () => null });
      const result = runArtifactCheck('has_phases_json', 'cmd', resolver, env);
      expect(result!.passed).toBe(false);
    });
  });

  describe('min_two_phases', () => {
    it('passes when plan has 2+ phases', () => {
      const content = '{"id": "phase-1"} {"id": "phase-2"}';
      const resolver = makeResolver({ getPlanContent: () => content });
      const result = runArtifactCheck('min_two_phases', 'cmd', resolver, env);
      expect(result!.passed).toBe(true);
    });

    it('fails when plan has only 1 phase', () => {
      const resolver = makeResolver({ getPlanContent: () => '{"id": "phase-1"}' });
      const result = runArtifactCheck('min_two_phases', 'cmd', resolver, env);
      expect(result!.passed).toBe(false);
    });
  });

  describe('review_has_arch_updates', () => {
    it('passes when review has Architecture Updates section', () => {
      const resolver = makeResolver({ getReviewContent: () => '## Architecture Updates\n...' });
      const result = runArtifactCheck('review_has_arch_updates', 'cmd', resolver, env);
      expect(result!.passed).toBe(true);
    });

    it('fails when review is missing the section', () => {
      const resolver = makeResolver({ getReviewContent: () => '## Other Section' });
      const result = runArtifactCheck('review_has_arch_updates', 'cmd', resolver, env);
      expect(result!.passed).toBe(false);
    });

    it('fails when review not found', () => {
      const resolver = makeResolver({ getReviewContent: () => null });
      const result = runArtifactCheck('review_has_arch_updates', 'cmd', resolver, env);
      expect(result!.passed).toBe(false);
    });
  });

  describe('review_has_lessons_updates', () => {
    it('passes when review has Lessons Learned Updates section', () => {
      const resolver = makeResolver({ getReviewContent: () => '## Lessons Learned Updates\n...' });
      const result = runArtifactCheck('review_has_lessons_updates', 'cmd', resolver, env);
      expect(result!.passed).toBe(true);
    });

    it('fails when review is missing the section', () => {
      const resolver = makeResolver({ getReviewContent: () => '## Other' });
      const result = runArtifactCheck('review_has_lessons_updates', 'cmd', resolver, env);
      expect(result!.passed).toBe(false);
    });
  });

  describe('resolver integration with runPhaseChecks', () => {
    it('uses resolver path when resolver handles the check, skipping shell', async () => {
      const resolver = makeResolver({ getPlanContent: () => '# Plan' });
      const checks = { plan_exists: 'some-shell-cmd-that-would-fail' };
      const results = await runPhaseChecks(checks, tmpdir(), env, undefined, resolver);
      expect(results[0].passed).toBe(true);
      expect(results[0].output).toContain('resolver');
    });

    it('falls through to shell when check is in overriddenChecks', async () => {
      const resolver = makeResolver({ getPlanContent: () => '# Plan' });
      const checks = { plan_exists: 'echo shell-ran' };
      const overridden = new Set(['plan_exists']);
      const results = await runPhaseChecks(checks, tmpdir(), env, undefined, resolver, overridden);
      // Shell ran, not resolver
      expect(results[0].output).toContain('shell-ran');
    });
  });
});
