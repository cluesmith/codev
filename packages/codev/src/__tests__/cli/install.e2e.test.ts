/**
 * CLI Integration: Package Installation Tests
 * Migrated from tests/e2e/install.bats
 *
 * Tests that the built CLI binaries are accessible and functional.
 * Runs against dist/ (built artifact), not source.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  setupCliEnv, teardownCliEnv, CliEnv,
  runCodev, runAfx, runAf, runConsult,
  CODEV_BIN, AFX_BIN, AF_BIN, CONSULT_BIN,
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

  it('afx binary exists', () => {
    expect(existsSync(AFX_BIN)).toBe(true);
  });

  it('deprecated af binary exists', () => {
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

  it('afx --version returns a version string', () => {
    const result = runAfx(['--version'], env.dir, env.env);
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

  it('afx --help shows available commands', () => {
    const result = runAfx(['--help'], env.dir, env.env);
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

  it('afx fails gracefully with unknown command', () => {
    const result = runAfx(['unknown-command-that-does-not-exist'], env.dir, env.env);
    expect(result.status).not.toBe(0);
  });

  it('consult --version returns a version string', () => {
    const result = runConsult(['--version'], env.dir, env.env);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/\d+\.\d+\.\d+/);
  });

  it('skeleton directory is included in package', () => {
    // Verify skeleton/ dir exists alongside dist/ — critical for runtime protocol resolution
    const skeletonDir = resolve(CODEV_BIN, '../../skeleton');
    expect(existsSync(skeletonDir)).toBe(true);
  });

  it('dist directory is included in package', () => {
    const distDir = resolve(CODEV_BIN, '../../dist');
    expect(existsSync(distDir)).toBe(true);
  });
});
