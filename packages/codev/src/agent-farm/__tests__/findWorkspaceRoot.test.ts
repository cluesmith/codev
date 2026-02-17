/**
 * Regression test for issue #407: Builder worktree leakage
 *
 * findWorkspaceRoot() must return the worktree's own root (not the main repo)
 * when running inside a builder worktree that has its own codev/ directory.
 * The old code always resolved worktree → main repo via git rev-parse,
 * causing file writes to leak into the main tree.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { _findWorkspaceRoot as findWorkspaceRoot } from '../utils/config.js';

describe('findWorkspaceRoot (issue #407)', () => {
  const testBase = path.join(tmpdir(), `codev-wsr-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

  beforeEach(() => {
    fs.mkdirSync(testBase, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(testBase, { recursive: true, force: true });
  });

  it('finds codev/ in a normal project directory', () => {
    const projectRoot = path.join(testBase, 'my-project');
    fs.mkdirSync(path.join(projectRoot, 'codev'), { recursive: true });

    const result = findWorkspaceRoot(projectRoot);
    expect(result).toBe(projectRoot);
  });

  it('finds codev/ when starting from a subdirectory', () => {
    const projectRoot = path.join(testBase, 'my-project');
    fs.mkdirSync(path.join(projectRoot, 'codev'), { recursive: true });

    const subDir = path.join(projectRoot, 'packages', 'foo', 'src');
    fs.mkdirSync(subDir, { recursive: true });

    const result = findWorkspaceRoot(subDir);
    expect(result).toBe(projectRoot);
  });

  it('finds .git as fallback when no codev/ exists', () => {
    const projectRoot = path.join(testBase, 'git-only');
    fs.mkdirSync(path.join(projectRoot, '.git'), { recursive: true });

    const result = findWorkspaceRoot(projectRoot);
    expect(result).toBe(projectRoot);
  });

  it('prefers codev/ over .git higher in the tree', () => {
    // Simulate: /repo has .git, /repo/sub has codev/
    const repoRoot = path.join(testBase, 'repo');
    fs.mkdirSync(path.join(repoRoot, '.git'), { recursive: true });

    const subProject = path.join(repoRoot, 'sub');
    fs.mkdirSync(path.join(subProject, 'codev'), { recursive: true });

    const result = findWorkspaceRoot(subProject);
    expect(result).toBe(subProject);
  });

  it('returns worktree root (not main repo) when worktree has codev/', () => {
    // Simulate a main repo with .builders/ worktree layout
    const mainRepo = path.join(testBase, 'main-repo');
    fs.mkdirSync(path.join(mainRepo, 'codev'), { recursive: true });
    fs.mkdirSync(path.join(mainRepo, '.git'), { recursive: true });

    // Worktree at .builders/bugfix-42/
    const worktree = path.join(mainRepo, '.builders', 'bugfix-42');
    fs.mkdirSync(path.join(worktree, 'codev'), { recursive: true });

    // Key test: starting from worktree root, should find worktree's codev/
    // (NOT resolve up to main repo)
    const result = findWorkspaceRoot(worktree);
    expect(result).toBe(worktree);
    expect(result).not.toBe(mainRepo);
  });

  it('returns worktree root when starting from subdirectory within worktree', () => {
    const mainRepo = path.join(testBase, 'main-repo');
    fs.mkdirSync(path.join(mainRepo, 'codev'), { recursive: true });
    fs.mkdirSync(path.join(mainRepo, '.git'), { recursive: true });

    const worktree = path.join(mainRepo, '.builders', 'bugfix-42');
    fs.mkdirSync(path.join(worktree, 'codev'), { recursive: true });

    // Start from deep inside the worktree
    const deepDir = path.join(worktree, 'packages', 'codev-pkg', 'src');
    fs.mkdirSync(deepDir, { recursive: true });

    const result = findWorkspaceRoot(deepDir);
    expect(result).toBe(worktree);
    expect(result).not.toBe(mainRepo);
  });

  it('returns startDir when no markers found', () => {
    const noMarkersDir = path.join(testBase, 'empty');
    fs.mkdirSync(noMarkersDir, { recursive: true });

    const result = findWorkspaceRoot(noMarkersDir);
    expect(result).toBe(noMarkersDir);
  });
});

/**
 * Integration tests using real git worktrees.
 * These exercise the getMainRepoFromWorktree() → worktree branch in
 * findWorkspaceRoot(), which the filesystem-only tests above don't reach
 * (git rev-parse fails in non-git temp dirs, so mainRepo is always null).
 */
describe('findWorkspaceRoot with real git worktrees (issue #407)', () => {
  // Resolve tmpdir symlinks (macOS /var → /private/var) so paths match git output
  const testBase = path.join(fs.realpathSync(tmpdir()), `codev-wsr-git-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  let mainRepo: string;
  let worktreePath: string;

  beforeEach(() => {
    fs.mkdirSync(testBase, { recursive: true });

    // Create a real git repo with codev/
    mainRepo = path.join(testBase, 'main-repo');
    fs.mkdirSync(mainRepo, { recursive: true });
    execSync('git init', { cwd: mainRepo, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: mainRepo, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: mainRepo, stdio: 'pipe' });

    fs.mkdirSync(path.join(mainRepo, 'codev'), { recursive: true });
    fs.writeFileSync(path.join(mainRepo, 'codev', '.gitkeep'), '');
    execSync('git add codev/.gitkeep', { cwd: mainRepo, stdio: 'pipe' });
    execSync('git commit -m "init"', { cwd: mainRepo, stdio: 'pipe' });

    // Create a real worktree (simulating a builder worktree)
    worktreePath = path.join(testBase, 'worktree-42');
    execSync(`git worktree add "${worktreePath}" -b test-branch`, { cwd: mainRepo, stdio: 'pipe' });
  });

  afterEach(() => {
    // Must remove worktree before deleting temp dir
    try {
      execSync(`git worktree remove "${worktreePath}" --force`, { cwd: mainRepo, stdio: 'pipe' });
    } catch {
      // Worktree may already be removed
    }
    fs.rmSync(testBase, { recursive: true, force: true });
  });

  it('returns worktree root when worktree has codev/ (exercises git rev-parse path)', () => {
    // The worktree already has codev/ from the checkout.
    // findWorkspaceRoot should detect the worktree via git rev-parse
    // and return the worktree root, NOT the main repo.
    const result = findWorkspaceRoot(worktreePath);
    expect(result).toBe(worktreePath);
    expect(result).not.toBe(mainRepo);
  });

  it('returns worktree root from subdirectory (exercises git rev-parse path)', () => {
    const deepDir = path.join(worktreePath, 'packages', 'foo', 'src');
    fs.mkdirSync(deepDir, { recursive: true });

    const result = findWorkspaceRoot(deepDir);
    expect(result).toBe(worktreePath);
    expect(result).not.toBe(mainRepo);
  });

  it('falls back to main repo when worktree lacks codev/', () => {
    // Remove codev/ from the worktree to simulate a worktree without it
    fs.rmSync(path.join(worktreePath, 'codev'), { recursive: true, force: true });

    const result = findWorkspaceRoot(worktreePath);
    expect(result).toBe(mainRepo);
  });
});
