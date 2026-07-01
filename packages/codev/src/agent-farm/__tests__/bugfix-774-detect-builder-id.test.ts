/**
 * Regression test for Issue #774 (+ #1094 anti-spoofing), updated for Issue #1118.
 *
 * The #774 bug: `detectCurrentBuilderId()` used the singleton `getDb()`, which
 * resolved to the worktree's own `.agent-farm/state.db` when CWD was inside
 * `.builders/<id>/` — an empty DB, so the lookup fell back to the bare worktree
 * dir name and misrouted `afx send architect`.
 *
 * Issue #1118 retired per-workspace `state.db`: builders live in the single
 * shared `global.db`, scoped by `workspace_path`. `detectCurrentBuilderId()` now
 * opens `global.db` (read-only) and filters by the worktree's owning workspace.
 * The #1094 contract is unchanged: inside a confirmed builder worktree, an
 * inability to verify the canonical id is an ERROR (throw), never a silent
 * bare-name fallback.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { GLOBAL_SCHEMA } from '../db/schema.js';

// Issue #1118: detectCurrentBuilderId reads global.db at getGlobalDbPath();
// redirect it to a per-test temp file.
const dbState = vi.hoisted(() => ({ globalDbPath: '' }));
vi.mock('../db/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/index.js')>();
  return { ...actual, getGlobalDbPath: () => dbState.globalDbPath };
});

const {
  detectCurrentBuilderId,
  BuilderIdResolutionError,
  describeStateDbOpenFailure,
} = await import('../commands/send.js');

/** Seed global.db with a builder row scoped to `workspacePath`. */
function seedBuilder(globalDbPath: string, workspacePath: string, id: string, worktree: string): void {
  const db = new Database(globalDbPath);
  db.exec(GLOBAL_SCHEMA);
  db.prepare(
    `INSERT INTO builders (workspace_path, id, name, worktree, branch, type, status, spawned_by_architect)
     VALUES (?, ?, ?, ?, ?, 'bugfix', 'implementing', 'ob-refine')`,
  ).run(realpathSync(workspacePath), id, id, worktree, `builder/${id}`);
  db.close();
}

describe('detectCurrentBuilderId — issue #774 / #1118', () => {
  let tmpRoot: string;
  let workspacePath: string;
  let worktreePath: string;
  const origCwd = process.cwd();

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bugfix-774-'));
    workspacePath = join(tmpRoot, 'workspace');
    worktreePath = join(workspacePath, '.builders', 'bugfix-1599');
    mkdirSync(worktreePath, { recursive: true });

    dbState.globalDbPath = join(tmpRoot, 'global.db');
    seedBuilder(dbState.globalDbPath, workspacePath, 'builder-bugfix-1599', worktreePath);
  });

  afterEach(() => {
    process.chdir(origCwd);
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns the canonical ID from global.db, scoped to the worktree workspace', () => {
    process.chdir(worktreePath);
    expect(detectCurrentBuilderId()).toBe('builder-bugfix-1599');
  });

  it('does not match a same-id builder from a DIFFERENT workspace (Issue #1118 scoping)', () => {
    // Another workspace has a builder whose worktree tail matches, but its
    // workspace_path differs — it must NOT be returned for this workspace.
    const db = new Database(dbState.globalDbPath);
    db.prepare(
      `INSERT INTO builders (workspace_path, id, name, worktree, branch, type, status)
       VALUES ('/some/other/workspace', 'other-id', 'x', '/some/other/workspace/.builders/bugfix-1599', 'm', 'bugfix', 'implementing')`,
    ).run();
    db.close();

    process.chdir(worktreePath);
    expect(detectCurrentBuilderId()).toBe('builder-bugfix-1599');
  });

  it('resolves the INNER builder for a nested worktree (greedy .builders match — codex iter3)', () => {
    // Unsupported anti-pattern (spawn from inside a worktree), but the parse
    // must resolve the LAST `/.builders/`, not the first.
    const innerWs = join(workspacePath, '.builders', 'pir-outer');
    const innerWorktree = join(innerWs, '.builders', 'bugfix-inner');
    mkdirSync(innerWorktree, { recursive: true });
    seedBuilder(dbState.globalDbPath, innerWs, 'builder-bugfix-inner', innerWorktree);

    process.chdir(innerWorktree);
    expect(detectCurrentBuilderId()).toBe('builder-bugfix-inner');
  });

  // Issue #1094: unverifiable id inside a confirmed worktree must THROW.

  it('throws (not bare name) when global.db is missing', () => {
    rmSync(dbState.globalDbPath);
    process.chdir(worktreePath);
    expect(() => detectCurrentBuilderId()).toThrow(BuilderIdResolutionError);
    expect(() => detectCurrentBuilderId()).toThrow(/bugfix-1599/);
  });

  it('throws (not bare name) when no builder row matches this workspace', () => {
    const db = new Database(dbState.globalDbPath);
    db.prepare('DELETE FROM builders').run();
    db.close();
    process.chdir(worktreePath);
    expect(() => detectCurrentBuilderId()).toThrow(BuilderIdResolutionError);
    expect(() => detectCurrentBuilderId()).toThrow(/no matching builder row/);
  });

  it('throws (not bare name) when global.db cannot be opened — issue #1094', () => {
    // Replace the DB file with a directory: existsSync passes, open throws.
    rmSync(dbState.globalDbPath);
    mkdirSync(dbState.globalDbPath, { recursive: true });
    process.chdir(worktreePath);
    expect(() => detectCurrentBuilderId()).toThrow(BuilderIdResolutionError);
    expect(() => detectCurrentBuilderId()).toThrow(/issue #1094/);
  });

  it('returns null when not in a builder worktree', () => {
    process.chdir(workspacePath);
    expect(detectCurrentBuilderId()).toBeNull();
  });
});

describe('describeStateDbOpenFailure — issue #1094 actionable messages', () => {
  it('names the better-sqlite3 ABI mismatch and points at reinstalling codev', () => {
    const abiErr = new Error(
      "The module was compiled against a different Node.js version using NODE_MODULE_VERSION 147. " +
        "This version of Node.js requires NODE_MODULE_VERSION 127.",
    );
    const msg = describeStateDbOpenFailure('/ws/.agent-farm/global.db', 'bugfix-2461', abiErr);
    expect(msg).toMatch(/ABI mismatch/i);
    expect(msg).toMatch(/reinstall codev/i);
    expect(msg).toContain('bugfix-2461');
    expect(msg).toMatch(/issue #1094/);
  });

  it('gives a generic hint for non-ABI open failures', () => {
    const msg = describeStateDbOpenFailure('/ws/.agent-farm/global.db', 'bugfix-2461', new Error('disk I/O error'));
    expect(msg).toMatch(/corruption|permissions|stale lock/i);
    expect(msg).not.toMatch(/ABI mismatch/i);
    expect(msg).toContain('bugfix-2461');
  });
});
