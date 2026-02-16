/**
 * CLI Integration: codev adopt Tests
 * Migrated from tests/e2e/adopt.bats
 *
 * Tests that codev adopt adds Codev to existing projects correctly.
 * Runs against dist/ (built artifact), not source.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { setupCliEnv, teardownCliEnv, CliEnv, runCodev } from './helpers.js';

describe('codev adopt (CLI)', () => {
  let env: CliEnv;

  beforeEach(() => {
    env = setupCliEnv();
  });

  afterEach(() => {
    teardownCliEnv(env);
  });

  function createExistingProject(name: string, opts?: { withGit?: boolean }): string {
    const projectDir = join(env.dir, name);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, 'README.md'), '# My Project\n');
    if (opts?.withGit !== false) {
      execFileSync('git', ['init', '-q'], { cwd: projectDir, env: env.env });
    }
    return projectDir;
  }

  it('adds codev to existing project', () => {
    const projectDir = createExistingProject('existing-project');
    const result = runCodev(['adopt', '--yes'], projectDir, env.env);
    expect(result.status).toBe(0);
    expect(existsSync(join(projectDir, 'codev'))).toBe(true);
    expect(existsSync(join(projectDir, 'codev/specs'))).toBe(true);
    expect(existsSync(join(projectDir, 'codev/plans'))).toBe(true);
    expect(existsSync(join(projectDir, 'codev/reviews'))).toBe(true);
    // Spec 0126: projectlist.md is no longer created
    expect(existsSync(join(projectDir, 'codev/projectlist.md'))).toBe(false);
  });

  it('preserves existing README', () => {
    const projectDir = createExistingProject('existing-project');
    writeFileSync(join(projectDir, 'README.md'), '# My Existing Project\nThis is my project description.\n');
    runCodev(['adopt', '--yes'], projectDir, env.env);
    const content = readFileSync(join(projectDir, 'README.md'), 'utf-8');
    expect(content).toContain('My Existing Project');
    expect(content).toContain('project description');
  });

  it('creates CLAUDE.md', () => {
    const projectDir = createExistingProject('existing-project');
    runCodev(['adopt', '--yes'], projectDir, env.env);
    expect(existsSync(join(projectDir, 'CLAUDE.md'))).toBe(true);
  });

  it('creates AGENTS.md', () => {
    const projectDir = createExistingProject('existing-project');
    runCodev(['adopt', '--yes'], projectDir, env.env);
    expect(existsSync(join(projectDir, 'AGENTS.md'))).toBe(true);
  });

  it('does not create projectlist.md (Spec 0126)', () => {
    const projectDir = createExistingProject('existing-project');
    runCodev(['adopt', '--yes'], projectDir, env.env);
    expect(existsSync(join(projectDir, 'codev/projectlist.md'))).toBe(false);
  });

  it('second run fails with update suggestion', () => {
    const projectDir = createExistingProject('existing-project');
    runCodev(['adopt', '--yes'], projectDir, env.env);
    const result = runCodev(['adopt', '--yes'], projectDir, env.env);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('already exists');
  });

  it('preserves existing source files', () => {
    const projectDir = createExistingProject('existing-project');
    mkdirSync(join(projectDir, 'src'));
    writeFileSync(join(projectDir, 'src/index.js'), "console.log('hello');\n");
    runCodev(['adopt', '--yes'], projectDir, env.env);
    expect(existsSync(join(projectDir, 'src/index.js'))).toBe(true);
    const content = readFileSync(join(projectDir, 'src/index.js'), 'utf-8');
    expect(content).toContain('console.log');
  });

  it('preserves existing .gitignore entries', () => {
    const projectDir = createExistingProject('existing-project');
    writeFileSync(join(projectDir, '.gitignore'), 'node_modules/\n*.log\n');
    runCodev(['adopt', '--yes'], projectDir, env.env);
    const content = readFileSync(join(projectDir, '.gitignore'), 'utf-8');
    expect(content).toContain('node_modules/');
    expect(content).toContain('*.log');
  });

  it('with existing CLAUDE.md preserves it', () => {
    const projectDir = createExistingProject('existing-project');
    writeFileSync(join(projectDir, 'CLAUDE.md'), '# My Custom Claude Instructions\n');
    runCodev(['adopt', '--yes'], projectDir, env.env);
    expect(existsSync(join(projectDir, 'CLAUDE.md'))).toBe(true);
  });

  it('in empty directory creates structure', () => {
    const projectDir = join(env.dir, 'empty-project');
    mkdirSync(projectDir);
    execFileSync('git', ['init', '-q'], { cwd: projectDir, env: env.env });
    const result = runCodev(['adopt', '--yes'], projectDir, env.env);
    expect(result.status).toBe(0);
    expect(existsSync(join(projectDir, 'codev'))).toBe(true);
  });
});
