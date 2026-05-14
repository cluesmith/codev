/**
 * Regression tests for Bugfix #745: dirty-worktree check should ignore untracked files.
 *
 * The check exists to prevent silently dropping work the architect just wrote
 * (specs, plans, codev/ changes). Untracked files at the root are local
 * artifacts (build outputs, local-install symlinks, editor state) — they
 * didn't come from main and aren't work-in-progress the builder needs.
 *
 * Pre-fix behavior: `git status --porcelain` flagged untracked files, forcing
 *   `afx spawn --force` on every spawn in repos with chronic untracked files.
 * Post-fix behavior: only modifications and staged changes to tracked files
 *   trigger the check. The spec case (`git add codev/specs/foo.md`) is still
 *   caught — the file becomes tracked once staged.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { hasUncommittedTrackedChanges } from '../utils/git.js';

describe('hasUncommittedTrackedChanges (Bugfix #745)', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'spawn-dirty-check-'));
    const opts = { cwd: repo, stdio: 'pipe' as const };
    execSync('git init -q', opts);
    execSync('git config user.email test@test.local', opts);
    execSync('git config user.name Test', opts);
    execSync('git config commit.gpgsign false', opts);
    writeFileSync(join(repo, 'tracked.txt'), 'initial\n');
    execSync('git add tracked.txt', opts);
    execSync('git commit -q -m init', opts);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('returns false for a clean worktree', async () => {
    expect(await hasUncommittedTrackedChanges(repo)).toBe(false);
  });

  it('returns false when only untracked files exist (the bug)', async () => {
    // Simulates the reported scenario: .claude/scheduled_tasks.lock, bin/,
    // packages/codev/dashboard/ — all untracked, none tracked-and-modified.
    writeFileSync(join(repo, 'untracked.txt'), 'local artifact\n');
    writeFileSync(join(repo, 'another.lock'), '\n');
    expect(await hasUncommittedTrackedChanges(repo)).toBe(false);
  });

  it('returns true when a tracked file has unstaged modifications', async () => {
    writeFileSync(join(repo, 'tracked.txt'), 'modified\n');
    expect(await hasUncommittedTrackedChanges(repo)).toBe(true);
  });

  it('returns true when a tracked file is staged but not committed', async () => {
    writeFileSync(join(repo, 'tracked.txt'), 'modified\n');
    execSync('git add tracked.txt', { cwd: repo, stdio: 'pipe' });
    expect(await hasUncommittedTrackedChanges(repo)).toBe(true);
  });

  it('returns true when a previously-untracked file is staged (the spec case)', async () => {
    // The check must still catch the original failure mode: architect writes
    // a spec, runs `git add codev/specs/foo.md`, forgets to commit, spawns
    // a builder. Once staged, the file is in the index — a tracked change.
    writeFileSync(join(repo, 'new-spec.md'), 'spec content\n');
    execSync('git add new-spec.md', { cwd: repo, stdio: 'pipe' });
    expect(await hasUncommittedTrackedChanges(repo)).toBe(true);
  });

  it('returns true with mixed untracked + tracked modifications', async () => {
    writeFileSync(join(repo, 'tracked.txt'), 'modified\n');
    writeFileSync(join(repo, 'untracked.txt'), 'local\n');
    expect(await hasUncommittedTrackedChanges(repo)).toBe(true);
  });

  it('returns false for a brand-new untracked file (documented tradeoff)', async () => {
    // Per #745, the fix prioritizes signal-to-noise over catching every
    // possible architect-forgetting-to-stage scenario. If a new spec/plan is
    // `git add`-staged (test above), the check fires. If it's left entirely
    // untracked, it slips through — the same way `bin/` and other local
    // artifacts slip through. The protected workflow is `git add` then spawn;
    // a totally-unstaged file is treated as draft work the architect is
    // still authoring.
    writeFileSync(join(repo, 'codev-specs-new.md'), 'draft spec\n');
    expect(await hasUncommittedTrackedChanges(repo)).toBe(false);
  });

  it('returns false (fail-open) when git is unavailable / cwd is not a repo', async () => {
    const notARepo = mkdtempSync(join(tmpdir(), 'not-a-repo-'));
    try {
      expect(await hasUncommittedTrackedChanges(notARepo)).toBe(false);
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });
});
