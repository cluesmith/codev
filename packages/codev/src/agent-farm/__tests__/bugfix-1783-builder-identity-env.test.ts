/**
 * Regression test for Issue #1783.
 *
 * A builder that ran `cd <workspace root> && afx send architect "…"` — as the
 * "run afx from the main workspace root" rule tells it to — resolved as a
 * NON-builder, because identity came only from the cwd. Plain `architect` then
 * routed to `main` instead of the builder's spawning architect, and the
 * `architect:<name>` spoofing guard was skipped.
 *
 * The fix: `.builder-start.sh` exports `CODEV_BUILDER_WORKTREE`, and the identity
 * resolvers prefer it over the cwd — still verified against global.db.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { GLOBAL_SCHEMA } from '../db/schema.js';
import { BUILDER_WORKTREE_ENV, sanitizeAgentEnv } from '../../lib/agent-env.js';

const dbState = vi.hoisted(() => ({ globalDbPath: '' }));
vi.mock('../db/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/index.js')>();
  return { ...actual, getGlobalDbPath: () => dbState.globalDbPath };
});

const { detectCurrentBuilderId, detectWorkspaceRoot, BuilderIdResolutionError } = await import(
  '../commands/send.js'
);

function seedBuilder(workspacePath: string, id: string, worktree: string): void {
  const db = new Database(dbState.globalDbPath);
  db.exec(GLOBAL_SCHEMA);
  db.prepare(
    `INSERT INTO builders (workspace_path, id, name, worktree, branch, type, status, spawned_by_architect)
     VALUES (?, ?, ?, ?, ?, 'bugfix', 'implementing', 'vscode')`,
  ).run(realpathSync(workspacePath), id, id, worktree, `builder/${id}`);
  db.close();
}

describe('builder identity from the spawn environment — issue #1783', () => {
  let tmpRoot: string;
  let workspacePath: string;
  let worktreePath: string;
  const origCwd = process.cwd();

  beforeEach(() => {
    tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), 'bugfix-1783-')));
    workspacePath = join(tmpRoot, 'workspace');
    worktreePath = join(workspacePath, '.builders', 'experiment-1782');
    mkdirSync(worktreePath, { recursive: true });
    mkdirSync(join(workspacePath, '.git'));
    dbState.globalDbPath = join(tmpRoot, 'global.db');
    seedBuilder(workspacePath, 'builder-experiment-1782', worktreePath);
  });

  afterEach(() => {
    process.chdir(origCwd);
    delete process.env[BUILDER_WORKTREE_ENV];
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('resolves the builder from the workspace root when the spawn env names its worktree', () => {
    process.env[BUILDER_WORKTREE_ENV] = worktreePath;
    process.chdir(workspacePath);
    expect(detectCurrentBuilderId()).toBe('builder-experiment-1782');
    expect(detectWorkspaceRoot()).toBe(workspacePath);
  });

  it('without the env, the workspace root still resolves as a non-builder (the pre-fix path)', () => {
    process.chdir(workspacePath);
    expect(detectCurrentBuilderId()).toBeNull();
  });

  it('the spawn env wins over a cwd inside a different worktree', () => {
    const sibling = join(workspacePath, '.builders', 'bugfix-9');
    mkdirSync(sibling, { recursive: true });
    seedBuilder(workspacePath, 'builder-bugfix-9', sibling);
    process.env[BUILDER_WORKTREE_ENV] = worktreePath;
    process.chdir(sibling);
    expect(detectCurrentBuilderId()).toBe('builder-experiment-1782');
  });

  it.each([
    ['the workspace root', () => workspacePath],
    ['a relative path', () => 'workspace/.builders/experiment-1782'],
  ])('ignores an env value that is %s, falling back to the cwd', (_label, value) => {
    process.env[BUILDER_WORKTREE_ENV] = value();
    process.chdir(worktreePath);
    expect(detectCurrentBuilderId()).toBe('builder-experiment-1782');
  });

  it('an env-named worktree with no builder row throws — never laundered into a non-builder', () => {
    process.env[BUILDER_WORKTREE_ENV] = join(workspacePath, '.builders', 'unregistered');
    process.chdir(workspacePath);
    expect(() => detectCurrentBuilderId()).toThrow(BuilderIdResolutionError);
  });

  it('an env-named worktree that no longer exists (cleaned up: dir and row gone) throws — not a non-builder', () => {
    const db = new Database(dbState.globalDbPath);
    db.prepare('DELETE FROM builders WHERE id = ?').run('builder-experiment-1782');
    db.close();
    rmSync(worktreePath, { recursive: true, force: true });
    process.env[BUILDER_WORKTREE_ENV] = worktreePath;
    process.chdir(workspacePath);
    expect(() => detectCurrentBuilderId()).toThrow(BuilderIdResolutionError);
    expect(() => detectCurrentBuilderId()).toThrow(/experiment-1782/);
  });

  it('sanitizeAgentEnv strips the builder identity so a Tower started from a builder shell cannot leak it', () => {
    const out = sanitizeAgentEnv({ [BUILDER_WORKTREE_ENV]: worktreePath, PATH: '/bin' });
    expect(out).toEqual({ PATH: '/bin' });
  });
});
