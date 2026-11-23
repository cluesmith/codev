/**
 * Spec 1951 — git plumbing against real repositories: live tips, the ref-neutral fetch,
 * ancestry, and `:(glob)` pathspec filters.
 */

import { spawn as realSpawn, spawnSync, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  atLeast,
  changedFiles,
  ensureCommits,
  gitVersion,
  hasCommit,
  isAncestor,
  liveTip,
  mergeBase,
  numstat,
  parseGitVersion,
  pathspecArgs,
  remoteDefaultBranch,
  resolveCommit,
  type GitVersion,
} from '../git-facts.js';
import { createRunner, type Runner, type SpawnFn } from '../runner.js';
import { DEFAULT_NOT_FOR_READING, DEFAULT_WATCH } from '../settings.js';
import { createFixture, snapshotRepoState, type Fixture } from './helpers/git-fixture.js';
import { createStubBin } from './helpers/stub-bin.js';

const isWindows = process.platform === 'win32';

let fx: Fixture;
let runner: Runner;
let version: GitVersion;

function runnerIn(cwd: string, extraEnv: Record<string, string> = {}): Runner {
  return createRunner({ cwd, workspaceRoot: cwd, env: { ...fx.env, ...extraEnv }, timeoutMs: 20_000 });
}

/** Push a commit to `branch` on origin from a second clone; the main clone never sees it. */
function pushFromElsewhere(branch: string, files: Record<string, string>): string {
  const other = fs.existsSync(path.join(fx.root, 'other')) ? path.join(fx.root, 'other') : fx.clone('other');
  fx.git(other, 'fetch', '-q', 'origin');
  fx.git(other, 'checkout', '-q', '-B', branch, 'origin/main');
  const sha = fx.commit(other, files, `on ${branch}`);
  fx.git(other, 'push', '-q', '-f', 'origin', `${branch}`);
  return sha;
}

beforeEach(async () => {
  fx = createFixture();
  runner = runnerIn(fx.main);
  version = await gitVersion(runner);
});

afterEach(() => {
  fx.cleanup();
});

describe('Spec 1951 — git version', () => {
  it('parses the installed version', () => {
    expect(version.major).toBeGreaterThanOrEqual(2);
    expect(parseGitVersion('git version 2.39.3 (Apple Git-146)')).toMatchObject({ major: 2, minor: 39, patch: 3 });
    expect(parseGitVersion('git version 2.45.windows.1')).toMatchObject({ major: 2, minor: 45, patch: 0 });
    expect(parseGitVersion('nonsense')).toBeNull();
  });

  it('compares against a minimum', () => {
    const v = (major: number, minor: number): GitVersion => ({ major, minor, patch: 0, text: '' });
    expect(atLeast(v(2, 38), { major: 2, minor: 38 })).toBe(true);
    expect(atLeast(v(2, 37), { major: 2, minor: 38 })).toBe(false);
    expect(atLeast(v(3, 0), { major: 2, minor: 38 })).toBe(true);
  });
});

describe('Spec 1951 — live tips', () => {
  it('reads the live tip from origin without updating the remote-tracking ref', async () => {
    const stale = fx.git(fx.main, 'rev-parse', 'refs/remotes/origin/main').trim();
    const live = pushFromElsewhere('main', { 'later.txt': 'later\n' });
    expect(await liveTip(runner, 'main')).toEqual({ ok: true, value: live });
    expect(fx.git(fx.main, 'rev-parse', 'refs/remotes/origin/main').trim()).toBe(stale);
  });

  it('reports a branch origin does not have as null', async () => {
    expect(await liveTip(runner, 'no-such-branch')).toEqual({ ok: true, value: null });
  });

  it('reports a failure by name', async () => {
    fx.git(fx.main, 'remote', 'set-url', 'origin', path.join(fx.root, 'missing.git'));
    const tip = await liveTip(runner, 'main');
    expect(tip.ok).toBe(false);
    if (!tip.ok) expect(tip.reason).toMatch(/^ls-remote failed/);
  });

  it('reports an ls-remote past the time limit as timed out', async () => {
    const hanging = (() => {
      const child = new EventEmitter() as ChildProcess;
      child.stdout = new EventEmitter() as ChildProcess['stdout'];
      child.stderr = new EventEmitter() as ChildProcess['stderr'];
      child.kill = (() => true) as ChildProcess['kill'];
      return child;
    }) as SpawnFn;
    const slow = createRunner({ cwd: fx.main, workspaceRoot: fx.main, spawn: hanging, timeoutMs: 50 });
    expect(await liveTip(slow, 'main')).toEqual({ ok: false, reason: 'ls-remote timed out after 50ms' });
  });

  it("reads origin's default branch", async () => {
    expect(await remoteDefaultBranch(runner)).toEqual({ ok: true, value: 'main' });
  });
});

describe('Spec 1951 — ensureCommits (the ref-neutral fetch)', () => {
  it('fetches a missing commit and moves no ref or tag, writes no FETCH_HEAD, leaves index and status alone', async () => {
    const sha = pushFromElsewhere('feature', { 'feature.txt': 'feature\n' });
    const other = path.join(fx.root, 'other');
    fx.git(other, 'tag', 'v1', sha);
    fx.git(other, 'tag', '-a', 'v1-annotated', '-m', 'annotated', sha);
    fx.git(other, 'push', '-q', 'origin', 'v1', 'v1-annotated');
    expect(await hasCommit(runner, sha)).toBe(false);
    const before = snapshotRepoState(fx, fx.main);
    expect(before.fetchHead).toEqual({ worktree: null, common: null });

    const result = await ensureCommits(runner, [sha], version);

    expect(result.get(sha)).toBeNull();
    expect(await hasCommit(runner, sha)).toBe(true);
    expect(snapshotRepoState(fx, fx.main)).toEqual(before);
  });

  it('does not fetch a commit that is already present', async () => {
    const head = fx.git(fx.main, 'rev-parse', 'HEAD').trim();
    const spawned: string[][] = [];
    const recording = createRunner({
      cwd: fx.main,
      workspaceRoot: fx.main,
      env: fx.env,
      spawn: ((command, args, options) => {
        spawned.push([...args]);
        return realSpawn(command, args, options);
      }) as SpawnFn,
    });
    expect((await ensureCommits(recording, [head], version)).get(head)).toBeNull();
    expect(spawned.some((args) => args.includes('fetch'))).toBe(false);
  });

  it('reports a commit origin cannot provide', async () => {
    const ghost = 'f'.repeat(40);
    const result = await ensureCommits(runner, [ghost], version);
    expect(result.get(ghost)).toMatch(/^fffffff not available locally \(/);
  });

  it('does not fetch on a git too old for the ref-neutral form', async () => {
    const ghost = 'e'.repeat(40);
    const old: GitVersion = { major: 2, minor: 28, patch: 0, text: 'git version 2.28.0' };
    const result = await ensureCommits(runner, [ghost], old);
    expect(result.get(ghost)).toBe('eeeeeee not available locally (git 2.28.0 cannot fetch without moving a ref; needs 2.29)');
  });
});

describe('Spec 1951 — ensureCommits from a linked worktree', () => {
  it('writes no FETCH_HEAD in the worktree or the common directory', async () => {
    const worktree = fx.addWorktree('spir-1', 'builder/spir-1');
    const sha = pushFromElsewhere('feature', { 'w.txt': 'w\n' });
    const before = snapshotRepoState(fx, worktree);
    const inWorktree = runnerIn(worktree);
    expect((await ensureCommits(inWorktree, [sha], version)).get(sha)).toBeNull();
    expect(snapshotRepoState(fx, worktree)).toEqual(before);
  });
});

describe('Spec 1951 — ancestry', () => {
  it('finds the merge base and ancestry', async () => {
    const base = fx.git(fx.main, 'rev-parse', 'HEAD').trim();
    fx.git(fx.main, 'checkout', '-q', '-b', 'topic');
    const topic = fx.commit(fx.main, { 'topic.txt': 'x\n' }, 'topic');
    fx.git(fx.main, 'checkout', '-q', 'main');
    const mainTip = fx.commit(fx.main, { 'main.txt': 'y\n' }, 'main');
    expect(await mergeBase(runner, topic, mainTip)).toBe(base);
    expect(await isAncestor(runner, base, topic)).toBe(true);
    expect(await isAncestor(runner, topic, mainTip)).toBe(false);
    expect(await resolveCommit(runner, 'topic')).toBe(topic);
    expect(await resolveCommit(runner, 'no-such-ref')).toBeNull();
  });
});

describe('Spec 1951 — pathspec filters', () => {
  let from: string;
  let to: string;

  beforeEach(() => {
    from = fx.git(fx.main, 'rev-parse', 'HEAD').trim();
    to = fx.commit(
      fx.main,
      {
        'CLAUDE.md': 'a\n',
        'sub/CLAUDE.md': 'b\n',
        '.codev/config.json': '{}\n',
        'codev/roles/architect.md': 'r\n',
        'codev/projects/1-x/status.yaml': 's\n',
        'codev/state/x_thread.md': 't\n',
        'pnpm-lock.yaml': 'l\n',
        'packages/a/pnpm-lock.yaml': 'l\n',
        'src/app.ts': 'one\ntwo\n',
        'image.bin': '\u0000\u0001\u0002',
      },
      'many',
    );
  });

  it('an empty include list matches nothing and runs no git', async () => {
    const spawn = vi.fn<SpawnFn>();
    const spied = createRunner({ cwd: fx.main, workspaceRoot: fx.main, spawn });
    expect(pathspecArgs({ include: [] })).toBeNull();
    expect(await changedFiles(spied, from, to, { include: [] })).toEqual([]);
    expect(await numstat(spied, from, to, { include: [] })).toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('an empty exclude list returns every changed file', async () => {
    expect(pathspecArgs({ exclude: [] })).toEqual([]);
    expect(await changedFiles(runner, from, to, { exclude: [] })).toHaveLength(10);
    expect(await changedFiles(runner, from, to)).toHaveLength(10);
  });

  it('the default watch globs match as documented', async () => {
    expect(await changedFiles(runner, from, to, { include: DEFAULT_WATCH })).toEqual([
      '.codev/config.json',
      'CLAUDE.md',
      'codev/roles/architect.md',
    ]);
  });

  it('the default not-for-reading globs exclude porch state, thread logs and lockfiles, root and nested', async () => {
    expect(await changedFiles(runner, from, to, { exclude: DEFAULT_NOT_FOR_READING })).toEqual([
      '.codev/config.json',
      'CLAUDE.md',
      'codev/roles/architect.md',
      'image.bin',
      'src/app.ts',
      'sub/CLAUDE.md',
    ]);
  });

  it('anchors patterns at the repository root whatever directory git runs in', async () => {
    const fromSub = runnerIn(path.join(fx.main, 'sub'));
    expect(await changedFiles(fromSub, from, to, { include: ['CLAUDE.md'] })).toEqual(['CLAUDE.md']);
    expect(await changedFiles(fromSub, from, to, { include: ['**/pnpm-lock.yaml'] })).toEqual(['packages/a/pnpm-lock.yaml', 'pnpm-lock.yaml']);
  });

  it('counts lines per file, and marks binary files', async () => {
    const stats = await numstat(runner, from, to, { include: ['src/**', 'image.bin'] });
    expect(stats).toEqual([
      { path: 'image.bin', additions: 0, deletions: 0, binary: true },
      { path: 'src/app.ts', additions: 2, deletions: 0, binary: false },
    ]);
  });

  it('shows a rename as a delete plus an add, so a file moved away from a watched path is seen', async () => {
    fx.git(fx.main, 'mv', 'CLAUDE.md', 'NOTES.md');
    fx.git(fx.main, 'commit', '-q', '-m', 'rename');
    const renamed = fx.git(fx.main, 'rev-parse', 'HEAD').trim();
    expect(await changedFiles(runner, to, renamed, { include: DEFAULT_WATCH })).toEqual(['CLAUDE.md']);
  });
});

describe.skipIf(isWindows)('Spec 1951 — every git call the plumbing makes is read-only (stub PATH recorder)', () => {
  it('records the fetch and the reads, with no violation', async () => {
    const stubs = createStubBin(path.join(fx.root, 'stub-bin'));
    const sha = pushFromElsewhere('feature', { 'f.txt': 'f\n' });
    const restore = stubs.install();
    try {
      const stubbed = runnerIn(fx.main);
      expect((await ensureCommits(stubbed, [sha], version)).get(sha)).toBeNull();
      await liveTip(stubbed, 'main');
      await changedFiles(stubbed, 'HEAD', sha, { exclude: DEFAULT_NOT_FOR_READING });
    } finally {
      restore();
    }
    expect(stubs.violations()).toEqual([]);
    const calls = stubs.gitCalls();
    expect(calls.some((c) => c.includes('fetch --no-write-fetch-head --refmap='))).toBe(true);
    expect(calls.some((c) => c.startsWith('ls-remote origin refs/heads/main'))).toBe(true);
  });

  it('the stub catches a write made outside the runner', async () => {
    const stubs = createStubBin(path.join(fx.root, 'stub-bin'));
    const restore = stubs.install();
    try {
      spawnSync('git', ['update-ref', 'refs/heads/x', 'HEAD'], { cwd: fx.main, env: { ...process.env, ...fx.env } });
    } finally {
      restore();
    }
    expect(stubs.violations()).toHaveLength(1);
    expect(fx.git(fx.main, 'for-each-ref', 'refs/heads/x')).toBe('');
  });
});
