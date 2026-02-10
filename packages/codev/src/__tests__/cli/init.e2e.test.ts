/**
 * CLI Integration: codev init Tests
 * Migrated from tests/e2e/init.bats
 *
 * Tests that codev init creates project structure correctly.
 * Runs against dist/ (built artifact), not source.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupCliEnv, teardownCliEnv, CliEnv, runCodev } from './helpers.js';

describe('codev init (CLI)', () => {
  let env: CliEnv;

  beforeEach(() => {
    env = setupCliEnv();
  });

  afterEach(() => {
    teardownCliEnv(env);
  });

  it('creates project directory', () => {
    const result = runCodev(['init', 'my-project', '--yes'], env.dir, env.env);
    expect(result.status).toBe(0);
    expect(existsSync(join(env.dir, 'my-project'))).toBe(true);
  });

  it('creates codev directory structure', () => {
    runCodev(['init', 'my-project', '--yes'], env.dir, env.env);
    const base = join(env.dir, 'my-project');
    expect(existsSync(join(base, 'codev'))).toBe(true);
    expect(existsSync(join(base, 'codev/specs'))).toBe(true);
    expect(existsSync(join(base, 'codev/plans'))).toBe(true);
    expect(existsSync(join(base, 'codev/reviews'))).toBe(true);
    expect(existsSync(join(base, 'codev/projectlist.md'))).toBe(true);
  });

  it('creates projectlist.md with proper content', () => {
    runCodev(['init', 'my-project', '--yes'], env.dir, env.env);
    const content = readFileSync(join(env.dir, 'my-project/codev/projectlist.md'), 'utf-8');
    expect(content).toContain('# Project List');
  });

  it('creates CLAUDE.md', () => {
    runCodev(['init', 'my-project', '--yes'], env.dir, env.env);
    expect(existsSync(join(env.dir, 'my-project/CLAUDE.md'))).toBe(true);
  });

  it('creates AGENTS.md', () => {
    runCodev(['init', 'my-project', '--yes'], env.dir, env.env);
    expect(existsSync(join(env.dir, 'my-project/AGENTS.md'))).toBe(true);
  });

  it('creates .gitignore', () => {
    runCodev(['init', 'my-project', '--yes'], env.dir, env.env);
    expect(existsSync(join(env.dir, 'my-project/.gitignore'))).toBe(true);
  });

  it('initializes git repository', () => {
    runCodev(['init', 'my-project', '--yes'], env.dir, env.env);
    expect(existsSync(join(env.dir, 'my-project/.git'))).toBe(true);
  });

  it('replaces PROJECT_NAME placeholder', () => {
    runCodev(['init', 'my-custom-project', '--yes'], env.dir, env.env);
    const content = readFileSync(join(env.dir, 'my-custom-project/CLAUDE.md'), 'utf-8');
    expect(content).toContain('my-custom-project');
    expect(content).not.toContain('{{PROJECT_NAME}}');
  });

  it('output mentions embedded framework files', () => {
    const result = runCodev(['init', 'my-project', '--yes'], env.dir, env.env);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Framework files provided by @cluesmith/codev');
  });

  it('fails if directory already exists', () => {
    mkdirSync(join(env.dir, 'existing-dir'));
    const result = runCodev(['init', 'existing-dir', '--yes'], env.dir, env.env);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('already exists');
  });

  it('--yes requires project name argument', () => {
    const result = runCodev(['init', '--yes'], env.dir, env.env);
    expect(result.status).not.toBe(0);
  });

  it('project name with spaces works when quoted', () => {
    const result = runCodev(['init', 'project with spaces', '--yes'], env.dir, env.env);
    expect(result.status).toBe(0);
    expect(existsSync(join(env.dir, 'project with spaces'))).toBe(true);
    expect(existsSync(join(env.dir, 'project with spaces/codev'))).toBe(true);
  });
});
