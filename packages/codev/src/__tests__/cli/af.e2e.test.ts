/**
 * CLI Integration: af (Agent Farm) Command Tests
 * Migrated from tests/e2e/af.bats
 *
 * Tests that the af CLI works correctly.
 * Runs against dist/ (built artifact), not source.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupCliEnv, teardownCliEnv, CliEnv, runAf, runCodev } from './helpers.js';
import { join } from 'node:path';

describe('af command (CLI)', () => {
  let env: CliEnv;

  beforeEach(() => {
    env = setupCliEnv();
  });

  afterEach(() => {
    teardownCliEnv(env);
  });

  // === Help and Version ===

  it('--help shows available commands', () => {
    const result = runAf(['--help'], env.dir, env.env);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('start');
    expect(result.stdout).toContain('spawn');
    expect(result.stdout).toContain('status');
  });

  it('--version returns a version string', () => {
    const result = runAf(['--version'], env.dir, env.env);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/\d+\.\d+\.\d+/);
  });

  it('help shows usage information', () => {
    const result = runAf(['help'], env.dir, env.env);
    expect([0, 1]).toContain(result.status);
  });

  // === Subcommand Help ===

  it('start --help shows options', () => {
    const result = runAf(['start', '--help'], env.dir, env.env);
    expect(result.status).toBe(0);
  });

  it('spawn --help shows options', () => {
    const result = runAf(['spawn', '--help'], env.dir, env.env);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('project');
  });

  it('cleanup --help shows options', () => {
    const result = runAf(['cleanup', '--help'], env.dir, env.env);
    expect(result.status).toBe(0);
  });

  // === Error Cases ===

  it('fails gracefully with unknown command', () => {
    const result = runAf(['unknown-command-xyz'], env.dir, env.env);
    expect(result.status).not.toBe(0);
  });

  it('spawn without project ID shows error', () => {
    // Initialize a codev project first
    runCodev(['init', 'test-project', '--yes'], env.dir, env.env);
    const projectDir = join(env.dir, 'test-project');
    const result = runAf(['spawn'], projectDir, env.env);
    expect(result.status).not.toBe(0);
  });

  // === Status Command ===

  it('status works in a codev project', () => {
    runCodev(['init', 'test-project', '--yes'], env.dir, env.env);
    const projectDir = join(env.dir, 'test-project');
    const result = runAf(['status'], projectDir, env.env);
    expect([0, 1]).toContain(result.status);
  });

  it('status shows agent farm info', () => {
    runCodev(['init', 'test-project', '--yes'], env.dir, env.env);
    const projectDir = join(env.dir, 'test-project');
    const result = runAf(['status'], projectDir, env.env);
    const output = result.stdout + result.stderr;
    const hasInfo = /Agent Farm|Tower|Status|running|stopped|No builders/i.test(output);
    expect(hasInfo).toBe(true);
  });
});
