/**
 * Tests for porch2 check runner
 */

import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import {
  runCheck,
  runPhaseChecks,
  formatCheckResults,
  allChecksPassed,
  type CheckEnv,
} from '../checks.js';

describe('porch2 check runner', () => {
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
    }, 5000);

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
});
