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
import { mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';

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
    // Spec 0126: spawn now uses positional arg + --protocol instead of -p/--project
    expect(result.stdout).toContain('protocol');
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

  it('status outside codev project handles gracefully', () => {
    const result = runAf(['status'], env.dir, env.env);
    expect([0, 1]).toContain(result.status);
  });

  // === Stale State Recovery (Issue #148) ===

  it('status handles stale architect state gracefully', () => {
    runCodev(['init', 'test-project', '--yes'], env.dir, env.env);
    const projectDir = join(env.dir, 'test-project');

    // Create stale architect state with a definitely-dead PID (Issue #148)
    const afDir = join(projectDir, '.agent-farm');
    mkdirSync(afDir, { recursive: true });
    const db = new Database(join(afDir, 'state.db'));
    db.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS architect (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        pid INTEGER NOT NULL,
        port INTEGER NOT NULL,
        cmd TEXT NOT NULL,
        started_at TEXT NOT NULL,
        tmux_session TEXT
      );
      INSERT OR REPLACE INTO _migrations (version) VALUES (1);
      INSERT OR REPLACE INTO architect (id, pid, port, cmd, started_at, tmux_session)
      VALUES (1, 999999, 4501, 'claude', '2024-01-01T00:00:00Z', 'af-architect-4501');
    `);
    db.close();

    // af status should not crash with stale DB state
    const result = runAf(['status'], projectDir, env.env);
    expect([0, 1]).toContain(result.status);
    const output = result.stdout + result.stderr;
    expect(output).toMatch(/Agent Farm|Tower|Status/i);
  });

  it('status handles live architect state gracefully', () => {
    runCodev(['init', 'test-project', '--yes'], env.dir, env.env);
    const projectDir = join(env.dir, 'test-project');

    // Create architect state with current process PID (which IS alive)
    const afDir = join(projectDir, '.agent-farm');
    mkdirSync(afDir, { recursive: true });
    const db = new Database(join(afDir, 'state.db'));
    db.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS architect (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        pid INTEGER NOT NULL,
        port INTEGER NOT NULL,
        cmd TEXT NOT NULL,
        started_at TEXT NOT NULL,
        tmux_session TEXT
      );
      INSERT OR REPLACE INTO _migrations (version) VALUES (1);
      INSERT OR REPLACE INTO architect (id, pid, port, cmd, started_at, tmux_session)
      VALUES (1, ${process.pid}, 4501, 'claude', '2024-01-01T00:00:00Z', 'af-architect-4501');
    `);
    db.close();

    // af status should work correctly with valid architect state
    const result = runAf(['status'], projectDir, env.env);
    expect([0, 1]).toContain(result.status);
    const output = result.stdout + result.stderr;
    expect(output).toMatch(/Agent Farm|Tower|Status/i);
  });
});
