/**
 * CLI Integration: Package Installation Tests
 * Migrated from tests/e2e/install.bats
 *
 * Tests that the built CLI binaries are accessible and functional.
 * Runs against dist/ (built artifact), not source.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import {
  setupCliEnv, teardownCliEnv, CliEnv,
  runCodev, runAf, runConsult,
  CODEV_BIN, AF_BIN, CONSULT_BIN,
} from './helpers.js';

describe('package installation (CLI)', () => {
  let env: CliEnv;

  beforeEach(() => {
    env = setupCliEnv();
  });

  afterEach(() => {
    teardownCliEnv(env);
  });

  it('codev binary exists', () => {
    expect(existsSync(CODEV_BIN)).toBe(true);
  });

  it('af binary exists', () => {
    expect(existsSync(AF_BIN)).toBe(true);
  });

  it('consult binary exists', () => {
    expect(existsSync(CONSULT_BIN)).toBe(true);
  });

  it('codev --version returns a version string', () => {
    const result = runCodev(['--version'], env.dir, env.env);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/\d+\.\d+\.\d+/);
  });

  it('af --version returns a version string', () => {
    const result = runAf(['--version'], env.dir, env.env);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/\d+\.\d+\.\d+/);
  });

  it('codev --help shows available commands', () => {
    const result = runCodev(['--help'], env.dir, env.env);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('init');
    expect(result.stdout).toContain('adopt');
    expect(result.stdout).toContain('doctor');
  });

  it('af --help shows available commands', () => {
    const result = runAf(['--help'], env.dir, env.env);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('start');
    expect(result.stdout).toContain('spawn');
    expect(result.stdout).toContain('status');
  });

  it('consult --help shows available commands', () => {
    const result = runConsult(['--help'], env.dir, env.env);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('pr');
    expect(result.stdout).toContain('spec');
    expect(result.stdout).toContain('plan');
  });

  it('codev fails gracefully with unknown command', () => {
    const result = runCodev(['unknown-command-that-does-not-exist'], env.dir, env.env);
    expect(result.status).not.toBe(0);
  });

  it('af fails gracefully with unknown command', () => {
    const result = runAf(['unknown-command-that-does-not-exist'], env.dir, env.env);
    expect(result.status).not.toBe(0);
  });
});
