/**
 * CLI Integration: consult Command Tests
 * Migrated from tests/e2e/consult.bats
 *
 * Tests that the consult CLI works correctly.
 * Only verifies help output and CLI structure, not actual AI consultations.
 * Runs against dist/ (built artifact), not source.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupCliEnv, teardownCliEnv, CliEnv, runConsult } from './helpers.js';

describe('consult command (CLI)', () => {
  let env: CliEnv;

  beforeEach(() => {
    env = setupCliEnv();
  });

  afterEach(() => {
    teardownCliEnv(env);
  });

  // === Help and Version ===

  it('--help shows available commands', () => {
    const result = runConsult(['--help'], env.dir, env.env);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('pr');
    expect(result.stdout).toContain('spec');
    expect(result.stdout).toContain('plan');
    expect(result.stdout).toContain('general');
  });

  it('shows model options', () => {
    const result = runConsult(['--help'], env.dir, env.env);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('model');
  });

  // === Subcommand Help ===

  it('pr --help shows options', () => {
    const result = runConsult(['pr', '--help'], env.dir, env.env);
    expect(result.status).toBe(0);
  });

  it('spec --help shows options', () => {
    const result = runConsult(['spec', '--help'], env.dir, env.env);
    expect(result.status).toBe(0);
  });

  it('plan --help shows options', () => {
    const result = runConsult(['plan', '--help'], env.dir, env.env);
    expect(result.status).toBe(0);
  });

  it('general --help shows options', () => {
    const result = runConsult(['general', '--help'], env.dir, env.env);
    expect(result.status).toBe(0);
  });

  // === Error Handling ===

  it('without subcommand shows help or error', () => {
    const result = runConsult([], env.dir, env.env);
    expect([0, 1]).toContain(result.status);
  });

  it('with unknown subcommand fails gracefully', () => {
    const result = runConsult(['unknown-subcommand'], env.dir, env.env);
    expect(result.status).not.toBe(0);
  });

  it('pr without number shows error', () => {
    const result = runConsult(['pr'], env.dir, env.env);
    expect(result.status).not.toBe(0);
  });

  it('spec without number shows error', () => {
    const result = runConsult(['spec'], env.dir, env.env);
    expect(result.status).not.toBe(0);
  });

  // === Custom Role Support ===

  it('--help shows --role option', () => {
    const result = runConsult(['--help'], env.dir, env.env);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--role');
  });

  it('--role blocks directory traversal', () => {
    const result = runConsult(
      ['--model', 'gemini', '--role', '../../../etc/passwd', 'general', 'test', '--dry-run'],
      env.dir, env.env
    );
    expect(result.status).not.toBe(0);
    const output = result.stdout + result.stderr;
    expect(output).toContain('Invalid role name');
  });

  it('--role blocks path separators', () => {
    const result = runConsult(
      ['--model', 'gemini', '--role', 'foo/bar', 'general', 'test', '--dry-run'],
      env.dir, env.env
    );
    expect(result.status).not.toBe(0);
    const output = result.stdout + result.stderr;
    expect(output).toContain('Invalid role name');
  });

  it('supports --dry-run flag', () => {
    const result = runConsult(['--help'], env.dir, env.env);
    expect(result.stdout).toContain('dry');
  });
});
