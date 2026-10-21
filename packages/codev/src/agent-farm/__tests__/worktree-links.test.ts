/**
 * Spec 1658 Phase 7: runnable-worktree links and worktree removal.
 *
 * - POSIX: the link is the `symlinkSync` call made before Windows support, and
 *   removal of a real tree leaves a linked directory's target intact.
 * - Seam `win32`, injected fs errors: EPERM on symlink falls back to a junction
 *   (directory), a hard link (file), or a copy (no hard link possible); the
 *   probe result is remembered. Removal unlinks link entries without
 *   traversal, retries busy entries, and finally names the blocking path.
 *
 * Real Windows behavior (junctions, hard links, a held handle) is covered by
 * worktree-links.windows.test.ts on the on-demand Windows workflow.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setHostPlatformForTests, resetHostPlatformForTests } from '../../lib/platform.js';

const fsCalls = vi.hoisted(() => ({
  symlinkSync: null as null | ((...args: unknown[]) => void),
  linkSync: null as null | ((...args: unknown[]) => void),
  copyFileSync: null as null | ((...args: unknown[]) => void),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const route = (name: keyof typeof fsCalls) => (...args: unknown[]) => {
    const injected = fsCalls[name];
    if (injected) return injected(...args);
    return (actual[name] as (...a: unknown[]) => unknown)(...args);
  };
  const routed = {
    ...actual,
    symlinkSync: vi.fn(route('symlinkSync')),
    linkSync: vi.fn(route('linkSync')),
    copyFileSync: vi.fn(route('copyFileSync')),
  };
  return { ...routed, default: routed };
});

import { symlinkSync, linkSync, copyFileSync } from 'node:fs';
import {
  createWorktreeLink,
  removeWorktreeDirectory,
  setSymlinkProbeForTests,
  WorktreeRemovalError,
  type RemovalFs,
} from '../lib/worktree-links.js';

function errno(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

let workDir: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-1658-links-'));
  setSymlinkProbeForTests(null);
  vi.mocked(symlinkSync).mockClear();
  vi.mocked(linkSync).mockClear();
  vi.mocked(copyFileSync).mockClear();
});

afterEach(() => {
  fsCalls.symlinkSync = null;
  fsCalls.linkSync = null;
  fsCalls.copyFileSync = null;
  resetHostPlatformForTests();
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('createWorktreeLink on POSIX', () => {
  it('makes the same symlinkSync calls as before Windows support', () => {
    const source = path.join(workDir, 'src.env');
    fs.writeFileSync(source, 'A=1');
    const sourceDir = path.join(workDir, 'data');
    fs.mkdirSync(sourceDir);

    expect(createWorktreeLink(source, path.join(workDir, 'f'), 'file')).toBe('symlink');
    expect(createWorktreeLink(sourceDir, path.join(workDir, 'd'), 'directory', 'dir')).toBe('symlink');
    expect(createWorktreeLink(path.join(workDir, 'absent'), path.join(workDir, 'dangling'), 'directory')).toBe('symlink');

    expect(vi.mocked(symlinkSync).mock.calls).toEqual([
      [source, path.join(workDir, 'f')],
      [sourceDir, path.join(workDir, 'd'), 'dir'],
      [path.join(workDir, 'absent'), path.join(workDir, 'dangling'), undefined],
    ]);
    expect(fs.lstatSync(path.join(workDir, 'f')).isSymbolicLink()).toBe(true);
    expect(linkSync).not.toHaveBeenCalled();
    expect(copyFileSync).not.toHaveBeenCalled();
  });
});

describe('createWorktreeLink on Windows (seam)', () => {
  const sourceDir = () => path.join(workDir, 'data');
  const sourceFile = () => path.join(workDir, 'src.env');

  beforeEach(() => {
    setHostPlatformForTests('win32');
    fs.mkdirSync(sourceDir());
    fs.writeFileSync(sourceFile(), 'A=1');
  });

  it('uses a symlink when the probe allows it', () => {
    fsCalls.symlinkSync = () => undefined;
    expect(createWorktreeLink(sourceDir(), 'T:/wt/data', 'directory', 'dir')).toBe('symlink');
    expect(createWorktreeLink(sourceFile(), 'T:/wt/.env', 'file')).toBe('symlink');
    expect(vi.mocked(symlinkSync).mock.calls).toEqual([
      [sourceDir(), 'T:/wt/data', 'dir'],
      [sourceFile(), 'T:/wt/.env', 'file'],
    ]);
  });

  it('falls back to a junction for a directory on EPERM, and remembers the probe', () => {
    fsCalls.symlinkSync = (_source, _target, type) => {
      if (type !== 'junction') throw errno('EPERM');
    };
    expect(createWorktreeLink(sourceDir(), 'T:/wt/a', 'directory', 'dir')).toBe('junction');
    expect(createWorktreeLink(sourceDir(), 'T:/wt/b', 'directory', 'dir')).toBe('junction');
    expect(vi.mocked(symlinkSync).mock.calls).toEqual([
      [sourceDir(), 'T:/wt/a', 'dir'],
      [sourceDir(), 'T:/wt/a', 'junction'],
      // Probe remembered: no second symlink attempt.
      [sourceDir(), 'T:/wt/b', 'junction'],
    ]);
  });

  it('gives a missing directory source a junction (dangling link accepted)', () => {
    fsCalls.symlinkSync = (_source, _target, type) => {
      if (type !== 'junction') throw errno('EPERM');
    };
    const absent = path.join(workDir, 'absent');
    expect(createWorktreeLink(absent, 'T:/wt/absent', 'directory')).toBe('junction');
    expect(linkSync).not.toHaveBeenCalled();
  });

  it('links a directory entry whose source is a file as a file', () => {
    fsCalls.symlinkSync = () => { throw errno('EPERM'); };
    fsCalls.linkSync = () => undefined;
    expect(createWorktreeLink(sourceFile(), 'T:/wt/x', 'directory')).toBe('hardlink');
  });

  it('falls back to a hard link for a file on EPERM', () => {
    fsCalls.symlinkSync = () => { throw errno('EPERM'); };
    fsCalls.linkSync = () => undefined;
    expect(createWorktreeLink(sourceFile(), 'T:/wt/.env', 'file')).toBe('hardlink');
    expect(linkSync).toHaveBeenCalledWith(sourceFile(), 'T:/wt/.env');
    expect(copyFileSync).not.toHaveBeenCalled();
  });

  it('copies a file when no hard link is possible (another volume), and reports it', () => {
    fsCalls.symlinkSync = () => { throw errno('EPERM'); };
    fsCalls.linkSync = () => { throw errno('EXDEV'); };
    fsCalls.copyFileSync = () => undefined;
    expect(createWorktreeLink(sourceFile(), 'D:/wt/.env', 'file')).toBe('copy');
    expect(copyFileSync).toHaveBeenCalledWith(sourceFile(), 'D:/wt/.env');
  });

  it('throws a symlink failure that is not a permission refusal', () => {
    fsCalls.symlinkSync = () => { throw errno('EEXIST'); };
    expect(() => createWorktreeLink(sourceFile(), 'T:/wt/.env', 'file')).toThrow('EEXIST');
    expect(linkSync).not.toHaveBeenCalled();
  });

  it('throws a hard-link failure that a copy would not answer', () => {
    fsCalls.symlinkSync = () => { throw errno('EPERM'); };
    fsCalls.linkSync = () => { throw errno('ENOENT'); };
    expect(() => createWorktreeLink(sourceFile(), 'T:/wt/.env', 'file')).toThrow('ENOENT');
    expect(copyFileSync).not.toHaveBeenCalled();
  });
});

/** An in-memory tree for removal: directories, files and link entries. */
type Node = { kind: 'dir'; children: Map<string, Node> } | { kind: 'file' } | { kind: 'link' };

/** Removal joins with the host separator; the in-memory tree records `/` paths. */
const slashes = (p: string) => p.replace(/\\/g, '/');

function memoryFs(root: Map<string, Node>) {
  const calls: string[] = [];
  const find = (p: string): { parent: Map<string, Node>; name: string; node: Node | undefined } => {
    const parts = slashes(p).split('/').filter(Boolean);
    let parent = root;
    for (const part of parts.slice(0, -1)) {
      const node = parent.get(part);
      if (!node || node.kind !== 'dir') throw errno('ENOENT');
      parent = node.children;
    }
    const name = parts[parts.length - 1];
    return { parent, name, node: parent.get(name) };
  };
  const ops: RemovalFs = {
    async lstat(p) {
      calls.push(`lstat ${slashes(p)}`);
      const { node } = find(p);
      if (!node) throw errno('ENOENT');
      return { isDirectory: () => node.kind === 'dir', isSymbolicLink: () => node.kind === 'link' };
    },
    async readdir(p) {
      calls.push(`readdir ${slashes(p)}`);
      const { node } = find(p);
      if (!node || node.kind !== 'dir') throw errno('ENOTDIR');
      return [...node.children.keys()];
    },
    async rmdir(p) {
      calls.push(`rmdir ${slashes(p)}`);
      const { parent, name, node } = find(p);
      if (node?.kind === 'dir' && node.children.size > 0) throw errno('ENOTEMPTY');
      parent.delete(name);
    },
    async unlink(p) {
      calls.push(`unlink ${slashes(p)}`);
      const { parent, name } = find(p);
      parent.delete(name);
    },
    async chmod(p) {
      calls.push(`chmod ${slashes(p)}`);
    },
  };
  return { ops, calls, find };
}

function tree(entries: Record<string, Node>): Map<string, Node> {
  return new Map(Object.entries(entries));
}
const dir = (entries: Record<string, Node> = {}): Node => ({ kind: 'dir', children: tree(entries) });
const file = (): Node => ({ kind: 'file' });
const link = (): Node => ({ kind: 'link' });

describe('removeWorktreeDirectory (seam win32, injected fs)', () => {
  beforeEach(() => setHostPlatformForTests('win32'));

  it('unlinks a junction entry and never reads or deletes behind it', async () => {
    const root = tree({ wt: dir({ src: dir({ 'a.ts': file() }), data: link(), '.env': link() }) });
    const { ops, calls } = memoryFs(root);
    await removeWorktreeDirectory('/wt', { fs: ops, sleep: async () => undefined });
    expect(root.has('wt')).toBe(false);
    expect(calls).toContain('unlink /wt/data');
    expect(calls.some((c) => c.startsWith('readdir /wt/data'))).toBe(false);
    expect(calls.some((c) => c.startsWith('rmdir /wt/data'))).toBe(false);
  });

  it('removes a link entry with rmdir when unlink refuses a directory link', async () => {
    const root = tree({ wt: dir({ data: link() }) });
    const { ops, calls } = memoryFs(root);
    const unlink = ops.unlink;
    ops.unlink = async (p) => {
      if (slashes(p) === '/wt/data') {
        calls.push(`unlink ${slashes(p)}`);
        throw errno('EPERM');
      }
      return unlink(p);
    };
    await removeWorktreeDirectory('/wt', { fs: ops, sleep: async () => undefined });
    expect(calls).toContain('rmdir /wt/data');
    expect(root.has('wt')).toBe(false);
  });

  it('makes a read-only file writable before unlinking it', async () => {
    const root = tree({ wt: dir({ 'pack.idx': file() }) });
    const { ops, calls } = memoryFs(root);
    const unlink = ops.unlink;
    let refused = false;
    ops.unlink = async (p) => {
      if (!refused) {
        refused = true;
        throw errno('EPERM');
      }
      return unlink(p);
    };
    await removeWorktreeDirectory('/wt', { fs: ops, sleep: async () => undefined });
    expect(calls).toContain('chmod /wt/pack.idx');
    expect(root.has('wt')).toBe(false);
  });

  it('retries a busy entry with backoff until the handle is released', async () => {
    const root = tree({ wt: dir({ 'held.log': file() }) });
    const { ops } = memoryFs(root);
    const unlink = ops.unlink;
    let busy = 2;
    ops.unlink = async (p) => {
      if (busy > 0) {
        busy--;
        throw errno('EBUSY');
      }
      return unlink(p);
    };
    const waits: number[] = [];
    await removeWorktreeDirectory('/wt', { fs: ops, sleep: async (ms) => { waits.push(ms); } });
    expect(waits).toEqual([100, 200]);
    expect(root.has('wt')).toBe(false);
  });

  it('retries a directory left non-empty by a pending delete', async () => {
    const root = tree({ wt: dir({ sub: dir() }) });
    const { ops } = memoryFs(root);
    const rmdir = ops.rmdir;
    let pending = 1;
    ops.rmdir = async (p) => {
      if (slashes(p) === '/wt' && pending > 0) {
        pending--;
        throw errno('ENOTEMPTY');
      }
      return rmdir(p);
    };
    await removeWorktreeDirectory('/wt', { fs: ops, sleep: async () => undefined });
    expect(root.has('wt')).toBe(false);
  });

  it('names the blocking path after the retries run out', async () => {
    const root = tree({ wt: dir({ node_modules: dir({ 'addon.node': file() }) }) });
    const { ops } = memoryFs(root);
    ops.unlink = async () => { throw errno('EBUSY'); };
    const waits: number[] = [];
    const removal = removeWorktreeDirectory('/wt', {
      fs: ops,
      retryDelaysMs: [1, 2, 3],
      sleep: async (ms) => { waits.push(ms); },
    });
    const error = await removal.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorktreeRemovalError);
    expect(slashes((error as WorktreeRemovalError).path)).toBe('/wt/node_modules/addon.node');
    expect((error as WorktreeRemovalError).code).toBe('EBUSY');
    // The leaf's own retries only: the error is final, not retried by its parents.
    expect(waits).toEqual([1, 2, 3]);
  });

  it('does not retry a failure that waiting cannot fix', async () => {
    const root = tree({ wt: dir({ f: file() }) });
    const { ops } = memoryFs(root);
    ops.unlink = async () => { throw errno('EIO'); };
    const sleep = vi.fn(async () => undefined);
    const error = await removeWorktreeDirectory('/wt', { fs: ops, sleep }).catch((e: unknown) => e);
    expect(slashes((error as WorktreeRemovalError).path)).toBe('/wt/f');
    expect((error as WorktreeRemovalError).code).toBe('EIO');
    expect(sleep).not.toHaveBeenCalled();
  });

  it('is a no-op when the worktree is already gone', async () => {
    const { ops, calls } = memoryFs(tree({}));
    await removeWorktreeDirectory('/wt', { fs: ops });
    expect(calls).toEqual(['lstat /wt']);
  });
});

describe('removeWorktreeDirectory on a real tree', () => {
  it('removes the worktree and leaves a linked directory target intact', async () => {
    const target = path.join(workDir, 'workspace-data');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'keep.txt'), 'keep');
    const worktree = path.join(workDir, 'wt');
    fs.mkdirSync(path.join(worktree, 'src'), { recursive: true });
    fs.writeFileSync(path.join(worktree, 'src', 'a.ts'), 'x');
    fs.symlinkSync(target, path.join(worktree, 'data'), 'dir');

    await removeWorktreeDirectory(worktree);

    expect(fs.existsSync(worktree)).toBe(false);
    expect(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8')).toBe('keep');
  });
});
