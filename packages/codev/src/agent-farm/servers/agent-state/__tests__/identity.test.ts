/**
 * Spec 1595, Test 5 (identity half): a lifecycle report's launch identity
 * resolves to Tower's canonical agent id, whatever spelling of the path the
 * reporter carried, against a real temp `global.db` and real symlinks.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { GLOBAL_SCHEMA } from '../../../db/schema.js';
import {
  resolveAgentIdentity,
  invalidateAgentIdentityMemo,
  IDENTITY_MEMO_TTL_MS,
} from '../identity.js';

let tmpRoot: string;
let workspace: string;
let db: Database.Database;
let clock: number;

function seedBuilder(id: string, worktree: string, workspacePath = workspace): void {
  db.prepare(
    `INSERT INTO builders (workspace_path, id, name, worktree, branch, type, status)
     VALUES (?, ?, ?, ?, ?, 'spec', 'implementing')`,
  ).run(workspacePath, id, id, worktree, `builder/${id}`);
}

function seedArchitect(name: string, workspacePath = workspace): void {
  db.prepare(
    `INSERT INTO architect (workspace_path, id, pid, port, cmd) VALUES (?, ?, 1, 0, 'claude')`,
  ).run(workspacePath, name);
}

function resolve(identity: Parameters<typeof resolveAgentIdentity>[0]) {
  return resolveAgentIdentity(identity, { db: () => db, now: () => clock });
}

beforeEach(() => {
  invalidateAgentIdentityMemo();
  clock = 1_000_000;
  tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), 'spec-1595-identity-')));
  workspace = join(tmpRoot, 'workspace');
  mkdirSync(join(workspace, '.builders', 'spir-1595-agent-attention'), { recursive: true });
  db = new Database(join(tmpRoot, 'global.db'));
  db.exec(GLOBAL_SCHEMA);
});

afterEach(() => {
  db.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('resolveAgentIdentity: builders', () => {
  const dir = 'spir-1595-agent-attention';

  it('resolves a builder worktree to its canonical role id', () => {
    seedBuilder('builder-spir-1595', join(workspace, '.builders', dir));
    expect(resolve({ kind: 'builder', worktreePath: join(workspace, '.builders', dir) }))
      .toEqual({ workspacePath: workspace, agentId: 'builder-spir-1595' });
  });

  it('keys by the canonical id, never the raw path or a non-role stored id', () => {
    // A legacy row id that is not a role id takes the id derived from the dir name.
    seedBuilder('bugfix-42', join(workspace, '.builders', 'bugfix-42-fix'));
    mkdirSync(join(workspace, '.builders', 'bugfix-42-fix'));
    const resolved = resolve({ kind: 'builder', worktreePath: join(workspace, '.builders', 'bugfix-42-fix') });
    expect(resolved?.agentId).toBe('builder-bugfix-42');
  });

  it('resolves a trailing slash, a relative segment and a symlink to the same builder', () => {
    seedBuilder('builder-spir-1595', join(workspace, '.builders', dir));
    const link = join(tmpRoot, 'link-to-workspace');
    symlinkSync(workspace, link);
    const expected = { workspacePath: workspace, agentId: 'builder-spir-1595' };

    expect(resolve({ kind: 'builder', worktreePath: `${join(workspace, '.builders', dir)}/` })).toEqual(expected);
    expect(resolve({ kind: 'builder', worktreePath: `${workspace}/.builders/x/../${dir}` })).toEqual(expected);
    expect(resolve({ kind: 'builder', worktreePath: join(link, '.builders', dir) })).toEqual(expected);
  });

  it('matches a stored worktree spelled through a symlink (both sides normalized)', () => {
    const link = join(tmpRoot, 'link-to-workspace');
    symlinkSync(workspace, link);
    // The row recorded the symlinked spelling; the report carries the real path.
    seedBuilder('builder-spir-1595', join(link, '.builders', dir));
    expect(resolve({ kind: 'builder', worktreePath: join(workspace, '.builders', dir) })?.agentId)
      .toBe('builder-spir-1595');
  });

  it('matches a row whose stored workspace_path is another spelling (both sides normalized)', () => {
    const link = join(tmpRoot, 'link-to-workspace');
    symlinkSync(workspace, link);
    seedBuilder('builder-spir-1595', join(link, '.builders', dir), link);
    expect(resolve({ kind: 'builder', worktreePath: join(workspace, '.builders', dir) }))
      .toEqual({ workspacePath: workspace, agentId: 'builder-spir-1595' });
  });

  it('does not resolve a builder registered in another workspace', () => {
    seedBuilder('builder-spir-1595', join('/elsewhere', '.builders', dir), '/elsewhere');
    expect(resolve({ kind: 'builder', worktreePath: join(workspace, '.builders', dir) })).toBeNull();
  });

  it('rejects a path outside any builder worktree and an unregistered worktree', () => {
    expect(resolve({ kind: 'builder', worktreePath: workspace })).toBeNull();
    expect(resolve({ kind: 'builder', worktreePath: join(workspace, '.builders', dir) })).toBeNull();
  });
});

describe('resolveAgentIdentity: architects', () => {
  it('resolves an architect by name within its workspace', () => {
    seedArchitect('main');
    seedArchitect('ob-refine');
    expect(resolve({ kind: 'architect', workspacePath: workspace, name: 'ob-refine' }))
      .toEqual({ workspacePath: workspace, agentId: 'ob-refine' });
  });

  it('resolves a differently spelled workspace path to the same architect', () => {
    seedArchitect('main');
    const link = join(tmpRoot, 'link-to-workspace');
    symlinkSync(workspace, link);
    expect(resolve({ kind: 'architect', workspacePath: `${link}/`, name: 'main' }))
      .toEqual({ workspacePath: workspace, agentId: 'main' });
  });

  it('matches an architect row whose stored workspace_path is another spelling', () => {
    const link = join(tmpRoot, 'link-to-workspace');
    symlinkSync(workspace, link);
    seedArchitect('main', `${link}/`);
    expect(resolve({ kind: 'architect', workspacePath: workspace, name: 'main' }))
      .toEqual({ workspacePath: workspace, agentId: 'main' });
  });

  it('rejects an unknown name or a name from another workspace', () => {
    seedArchitect('main', '/elsewhere');
    expect(resolve({ kind: 'architect', workspacePath: workspace, name: 'main' })).toBeNull();
    expect(resolve({ kind: 'architect', workspacePath: workspace, name: 'ghost' })).toBeNull();
  });
});

describe('resolveAgentIdentity: memo and failure', () => {
  it('resolves a newly registered agent on its first report (misses are not memoized)', () => {
    expect(resolve({ kind: 'architect', workspacePath: workspace, name: 'late' })).toBeNull();
    seedArchitect('late');
    expect(resolve({ kind: 'architect', workspacePath: workspace, name: 'late' })?.agentId).toBe('late');
  });

  it('reuses a resolution while the registry is unchanged, without re-reading it', () => {
    seedArchitect('main');
    const identity = { kind: 'architect' as const, workspacePath: workspace, name: 'main' };
    expect(resolve(identity)).not.toBeNull();

    const prepare = vi.spyOn(db, 'prepare');
    expect(resolve(identity)?.agentId).toBe('main');
    expect(prepare.mock.calls.some(([sql]) => String(sql).includes('FROM architect'))).toBe(false);
    prepare.mockRestore();

    clock += IDENTITY_MEMO_TTL_MS + 1;
    const afterTtl = vi.spyOn(db, 'prepare');
    expect(resolve(identity)?.agentId).toBe('main');
    expect(afterTtl.mock.calls.some(([sql]) => String(sql).includes('FROM architect'))).toBe(true);
    afterTtl.mockRestore();
  });

  it('forgets a removed agent at once when the registry changes on this connection', () => {
    seedArchitect('main');
    const identity = { kind: 'architect' as const, workspacePath: workspace, name: 'main' };
    expect(resolve(identity)).not.toBeNull();
    db.prepare('DELETE FROM architect').run();
    expect(resolve(identity)).toBeNull();
  });

  it('forgets a removed agent at once when another process changes the registry', () => {
    seedBuilder('builder-spir-1595', join(workspace, '.builders', 'spir-1595-agent-attention'));
    const identity = { kind: 'builder' as const, worktreePath: join(workspace, '.builders', 'spir-1595-agent-attention') };
    expect(resolve(identity)).not.toBeNull();

    const other = new Database(join(tmpRoot, 'global.db'));
    other.prepare('DELETE FROM builders').run();
    other.close();
    expect(resolve(identity)).toBeNull();
  });

  it('never throws: an unreadable registry resolves to null', () => {
    const broken = () => { throw new Error('db unavailable'); };
    expect(resolveAgentIdentity({ kind: 'architect', workspacePath: workspace, name: 'main' }, { db: broken }))
      .toBeNull();
  });
});
