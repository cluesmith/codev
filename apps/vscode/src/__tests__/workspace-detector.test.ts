/**
 * Workspace detection (#1144): the opened folder itself must be a codev
 * workspace root — no ancestor walk.
 *
 * The walk this replaces made every folder under a codev-enabled HOME
 * directory silently inherit that workspace: with `onStartupFinished`
 * activation, any random project opened under `~` connected to Tower and
 * rendered the full Workspace view. The nested-folder case below is the
 * regression test for that leak.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let workspaceFolders: Array<{ uri: { fsPath: string } }> | undefined;
let workspacePathOverride: string | undefined;

vi.mock('vscode', () => ({
  workspace: {
    get workspaceFolders() { return workspaceFolders; },
    getConfiguration: () => ({
      get: (key: string) => {
        if (key === 'workspacePath') { return workspacePathOverride; }
        return undefined;
      },
    }),
  },
}));

import { detectWorkspace, detectWorkspacePath, detectIsBuilderWorktree, isCodevWorkspaceRoot } from '../workspace-detector.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'codev-detector-'));
  workspaceFolders = undefined;
  workspacePathOverride = undefined;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const openFolder = (dir: string) => {
  workspaceFolders = [{ uri: { fsPath: dir } }];
};

describe('isCodevWorkspaceRoot', () => {
  it('matches a directory containing codev/', () => {
    mkdirSync(join(root, 'codev'));
    expect(isCodevWorkspaceRoot(root)).toBe(true);
  });

  it('matches a directory containing .codev/', () => {
    mkdirSync(join(root, '.codev'));
    expect(isCodevWorkspaceRoot(root)).toBe(true);
  });

  it('does not match a directory without markers', () => {
    expect(isCodevWorkspaceRoot(root)).toBe(false);
  });
});

describe('detectWorkspacePath', () => {
  it('returns the opened folder when it is a codev root', () => {
    mkdirSync(join(root, '.codev'));
    openFolder(root);
    expect(detectWorkspacePath()).toBe(root);
  });

  it('does NOT inherit a codev root from an ancestor directory', () => {
    // The home-directory leak: `root` is codev-enabled, the opened folder
    // is a plain project nested under it. Detection must say null.
    mkdirSync(join(root, 'codev'));
    const nested = join(root, 'some', 'plain-project');
    mkdirSync(nested, { recursive: true });
    openFolder(nested);
    expect(detectWorkspacePath()).toBeNull();
  });

  it('returns null with no folder open', () => {
    workspaceFolders = undefined;
    expect(detectWorkspacePath()).toBeNull();
    workspaceFolders = [];
    expect(detectWorkspacePath()).toBeNull();
  });

  it('honors the codev.workspacePath override without touching detection', () => {
    workspacePathOverride = '/somewhere/else';
    openFolder(root); // plain folder, no markers
    expect(detectWorkspacePath()).toBe('/somewhere/else');
  });
});

describe('detectWorkspace — builder worktrees (#1809)', () => {
  const makeWorktree = (id: string) => {
    const worktree = join(root, '.builders', id);
    mkdirSync(join(worktree, 'codev'), { recursive: true });
    return worktree;
  };

  it('classifies a codev root as a root', () => {
    mkdirSync(join(root, 'codev'));
    openFolder(root);
    expect(detectWorkspace()).toEqual({ kind: 'root', path: root });
    expect(detectIsBuilderWorktree()).toBe(false);
  });

  it('classifies a builder worktree and resolves its parent root', () => {
    const worktree = makeWorktree('pir-1809');
    openFolder(worktree);
    expect(detectWorkspace()).toEqual({
      kind: 'builder-worktree',
      path: worktree,
      workspaceRoot: root,
      builderId: 'pir-1809',
    });
    expect(detectIsBuilderWorktree()).toBe(true);
  });

  it('detectWorkspacePath returns the PARENT root for a worktree window', () => {
    openFolder(makeWorktree('pir-1809'));
    expect(detectWorkspacePath()).toBe(root);
  });

  it('classifies an override that points into a worktree as a worktree', () => {
    workspacePathOverride = '/repo/.builders/bugfix-7';
    expect(detectWorkspace()).toEqual({
      kind: 'builder-worktree',
      path: '/repo/.builders/bugfix-7',
      workspaceRoot: '/repo',
      builderId: 'bugfix-7',
    });
    expect(detectWorkspacePath()).toBe('/repo');
  });
});
