/**
 * Spec 1951 — spawn's scaffold files as one list, shared by `afx cleanup` and
 * `codev check worktree`, and the cleanup fix it carries (owner decision main-36): a worktree
 * holding only scaffold files, the write guard's included, is not dirty to cleanup.
 *
 * Evidence for the fix: cleanup reported "1 uncommitted file(s)" for two bugfix builders that
 * had nothing uncommitted. The one file was the write guard's `.claude/hooks/` directory,
 * which `git status --porcelain` lists as a directory and the old `.builder-` regex missed.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hasUncommittedChanges } from '../commands/cleanup.js';
import { isBuilderScaffold, OPENCODE_CONFIG_RELPATH, SCAFFOLD_PATHS } from '../lib/builder-scaffold.js';
import { DEFAULT_KEEP_IGNORED, isNeverKeep, keepPatterns } from '../lib/keep-list.js';
import * as keepFiles from '../lib/keep-files.js';
import { BUILTIN_HARNESSES } from '../utils/harness.js';
import { GUARD_SCRIPT_RELPATH, GUARD_SETTINGS_RELPATH } from '../utils/worktree-write-guard.js';

describe('Spec 1951 — isBuilderScaffold', () => {
  it('matches root-level .builder-* files and the fixed scaffold paths', () => {
    for (const p of ['.builder-prompt.txt', '.builder-role.md', '.builder-start.sh', '.builder-session-id', '.builder-state.md', '.builder-reorient.md']) {
      expect(isBuilderScaffold(p), p).toBe(true);
    }
    for (const p of [GUARD_SCRIPT_RELPATH, GUARD_SETTINGS_RELPATH, OPENCODE_CONFIG_RELPATH]) expect(isBuilderScaffold(p), p).toBe(true);
  });

  it('matches nothing else: nested .builder-* names, other hook files, look-alikes', () => {
    for (const p of ['src/.builder-x', '.claude/hooks/other.cjs', '.claude/settings.json', '.builder', 'builder-x', 'codev/state/x_thread.md', '.claude/hooks/']) {
      expect(isBuilderScaffold(p), p).toBe(false);
    }
  });

  it('names every file a built-in harness writes into a worktree, so the two cannot drift', () => {
    const written = Object.values(BUILTIN_HARNESSES).flatMap((h) => h.getWorktreeFiles?.('role', '/w/.builder-role.md', '/w') ?? []);
    expect([...new Set(written.map((f) => f.relativePath))].sort()).toEqual([...SCAFFOLD_PATHS].sort());
  });
});

describe('Spec 1951 — keep-list.ts is the one definition keep-files.ts uses', () => {
  it('keep-files re-exports the same objects', () => {
    expect(keepFiles.DEFAULT_KEEP_IGNORED).toBe(DEFAULT_KEEP_IGNORED);
    expect(keepFiles.keepPatterns).toBe(keepPatterns);
  });

  it('isNeverKeep: any dependency or build-output segment', () => {
    expect(isNeverKeep('node_modules/x/index.js')).toBe(true);
    expect(isNeverKeep('codev/projects/8/node_modules/a.js')).toBe(true);
    expect(isNeverKeep('packages/x/dist/out.js')).toBe(true);
    expect(isNeverKeep('codev/projects/8/review.txt')).toBe(false);
    expect(isNeverKeep('distribution/notes.md')).toBe(false);
  });
});

describe('Spec 1951 — afx cleanup: hasUncommittedChanges and the scaffold (main-36)', () => {
  let worktree: string;
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: worktree, stdio: 'pipe' });
  const write = (rel: string, content = `${rel}\n`): void => {
    mkdirSync(dirname(join(worktree, rel)), { recursive: true });
    writeFileSync(join(worktree, rel), content);
  };

  beforeEach(() => {
    worktree = realpathSync(mkdtempSync(join(tmpdir(), 'spec-1951-scaffold-')));
    git('init', '-q');
    write('src/tracked.ts');
    git('add', '.');
    git('commit', '-qm', 'init');
    for (const rel of ['.builder-prompt.txt', '.builder-role.md', '.builder-start.sh', GUARD_SCRIPT_RELPATH, GUARD_SETTINGS_RELPATH]) write(rel);
  });

  afterEach(() => {
    rmSync(worktree, { recursive: true, force: true });
  });

  it('only scaffold files, the write guard included: not dirty', async () => {
    expect(await hasUncommittedChanges(worktree)).toEqual({ dirty: false, scaffoldOnly: true, details: '' });
  });

  it('a clean worktree: not dirty, not scaffold-only', async () => {
    rmSync(join(worktree, '.claude'), { recursive: true });
    for (const rel of ['.builder-prompt.txt', '.builder-role.md', '.builder-start.sh']) rmSync(join(worktree, rel));
    expect(await hasUncommittedChanges(worktree)).toEqual({ dirty: false, scaffoldOnly: false, details: '' });
  });

  it('another file next to the write guard is dirty, counted by itself', async () => {
    write('.claude/hooks/mine.cjs');
    expect(await hasUncommittedChanges(worktree)).toEqual({ dirty: true, scaffoldOnly: false, details: '1 uncommitted file(s)' });
  });

  it('a modified tracked file is dirty, whatever the scaffold', async () => {
    write('src/tracked.ts', 'changed\n');
    write('notes.md');
    expect(await hasUncommittedChanges(worktree)).toEqual({ dirty: true, scaffoldOnly: false, details: '2 uncommitted file(s)' });
  });
});
