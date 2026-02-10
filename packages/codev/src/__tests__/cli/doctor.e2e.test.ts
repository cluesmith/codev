/**
 * CLI Integration: codev doctor Tests
 * Migrated from tests/e2e/doctor.bats
 *
 * Tests that codev doctor checks dependencies correctly.
 * Runs against dist/ (built artifact), not source.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupCliEnv, teardownCliEnv, CliEnv, runCodev } from './helpers.js';

describe('codev doctor (CLI)', () => {
  let env: CliEnv;

  beforeEach(() => {
    env = setupCliEnv();
  });

  afterEach(() => {
    teardownCliEnv(env);
  });

  it('runs without crashing', () => {
    const result = runCodev(['doctor'], env.dir, env.env);
    // Doctor may exit non-zero if optional deps missing, but shouldn't crash
    expect([0, 1]).toContain(result.status);
  });

  it('checks Node.js', () => {
    const result = runCodev(['doctor'], env.dir, env.env);
    expect(result.stdout).toContain('Node');
  });

  it('checks git', () => {
    const result = runCodev(['doctor'], env.dir, env.env);
    expect(result.stdout).toContain('git');
  });

  it('shows check results', () => {
    const result = runCodev(['doctor'], env.dir, env.env);
    const output = result.stdout;
    const hasIndicators = /found|missing|ok|✓|✗|pass|fail|error|Node|git|npm/i.test(output);
    expect(hasIndicators).toBe(true);
  });

  it('checks for tmux (optional)', () => {
    const result = runCodev(['doctor'], env.dir, env.env);
    expect(result.stdout).toContain('tmux');
  });

  it('output is readable (multiple lines)', () => {
    const result = runCodev(['doctor'], env.dir, env.env);
    const lines = result.stdout.split('\n').filter(l => l.trim());
    expect(lines.length).toBeGreaterThan(1);
  });
});
