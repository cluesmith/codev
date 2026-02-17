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

  // === Protocol Options ===

  it('--help shows --protocol option', () => {
    const result = runConsult(['--help'], env.dir, env.env);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--protocol');
  });

  it('--help shows --type option', () => {
    const result = runConsult(['--help'], env.dir, env.env);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--type');
  });

  it('--help shows --prompt option', () => {
    const result = runConsult(['--help'], env.dir, env.env);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--prompt');
  });

  it('--help shows stats subcommand', () => {
    const result = runConsult(['--help'], env.dir, env.env);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('stats');
  });

  // === Model Options ===

  it('accepts --model gemini option', () => {
    const result = runConsult(['--model', 'gemini', '--help'], env.dir, env.env);
    expect(result.status).toBe(0);
  });

  it('accepts --model codex option', () => {
    const result = runConsult(['--model', 'codex', '--help'], env.dir, env.env);
    expect(result.status).toBe(0);
  });

  it('accepts --model claude option', () => {
    const result = runConsult(['--model', 'claude', '--help'], env.dir, env.env);
    expect(result.status).toBe(0);
  });

  // === Input Validation ===

  it('--type without --model fails', () => {
    const result = runConsult(['--type', 'spec'], env.dir, env.env);
    expect(result.status).not.toBe(0);
  });

  it('unknown subcommand shows helpful error', () => {
    const result = runConsult(['nonexistent-cmd'], env.dir, env.env);
    expect(result.status).not.toBe(0);
    const output = result.stdout + result.stderr;
    expect(output).toContain('Unknown subcommand');
  });
});
