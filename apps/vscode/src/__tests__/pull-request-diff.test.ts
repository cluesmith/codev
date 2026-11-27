/**
 * #2008 — the pull-request diff source, end to end below the editor:
 *
 *  - `planResources(…, 'head')` plans a PR's right side from the head commit,
 *    and the default (`'file'`) builder plan is unchanged;
 *  - `diffUrisForChange` marks every PR side URI with PR id + side, and
 *    `decodePullRequestDiffUri` recovers (PR, commit, path, side) — the lane-2
 *    anchoring requirement — while builder URIs decode to nothing;
 *  - `BuilderDiffCache.getPullRequestDiff` against a REAL git fixture: the file
 *    list is merge-base ↔ head (statuses, rename source, binary), decorations
 *    register and are pruned, every failure kind is a distinct result, a head
 *    move is picked up after invalidation, and `openPullRequestFileDiff`
 *    registers nothing in the builder-only diff-inject registry.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { PRView } from '@cluesmith/codev-types';
import { createPullRequestGitFixture, git, type PullRequestGitFixture } from './pr-git-fixture.js';

const executed = vi.hoisted(() => [] as unknown[][]);

vi.mock('vscode', () => {
  class FakeEventEmitter<T> {
    private listeners: Array<(e: T) => void> = [];
    readonly event = (listener: (e: T) => void): { dispose: () => void } => {
      this.listeners.push(listener);
      return { dispose: () => { this.listeners = this.listeners.filter((l) => l !== listener); } };
    };
    fire(e: T): void { this.listeners.forEach((l) => l(e)); }
    dispose(): void {}
  }
  interface Parts { scheme: string; path: string; query?: string; fsPath?: string }
  const make = (parts: Parts) => ({
    ...parts,
    query: parts.query ?? '',
    fsPath: parts.fsPath ?? parts.path,
    toString: () => `${parts.scheme}:${parts.path}?${parts.query ?? ''}`,
  });
  class TreeItem {
    id?: string;
    tooltip?: string;
    description?: string;
    resourceUri?: unknown;
    contextValue?: string;
    command?: unknown;
    constructor(public label: string, public collapsibleState?: number) {}
  }
  return {
    EventEmitter: FakeEventEmitter,
    TreeItem,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ThemeIcon: class { static readonly Folder = {}; constructor(public id: string) {} },
    Uri: {
      from: (parts: Parts) => make(parts),
      file: (fsPath: string) => make({ scheme: 'file', path: fsPath, fsPath }),
    },
    commands: { executeCommand: async (...args: unknown[]) => { executed.push(args); } },
    window: {},
    workspace: { getConfiguration: () => ({ get: (_k: string, d: unknown) => d }) },
  };
});

const { planResources, diffUrisForChange, openPullRequestFileDiff } = await import('../commands/view-diff.js');
const { decodePullRequestDiffUri, decodeDiffQuery } = await import('../diff-query.js');
const { BuilderDiffCache, PULL_REQUEST_MAX_FILES } = await import('../views/builder-diff-cache.js');
const { pullRequestFileResourceUri } = await import('../views/pull-request-file-tree-item.js');
const { getDiffInjectEntry } = await import('../diff-inject-codelens.js');

let fx: PullRequestGitFixture;

beforeAll(() => { fx = createPullRequestGitFixture(); });
afterAll(() => { fx.dispose(); });

function view(overrides: Partial<PRView> = {}): PRView {
  return {
    title: 't', body: '', state: 'OPEN', author: { login: 'someone' },
    baseRefName: 'main', headRefName: 'feature', additions: 0, deletions: 0,
    headRefOid: fx.headSha,
    ...overrides,
  };
}

describe('planResources with a head-commit right side', () => {
  const changes = [
    { status: 'M' as const, oldPath: null, path: 'm.ts' },
    { status: 'A' as const, oldPath: null, path: 'a.ts' },
    { status: 'D' as const, oldPath: null, path: 'd.ts' },
    { status: 'R' as const, oldPath: 'old.ts', path: 'new.ts' },
    { status: 'M' as const, oldPath: null, path: 'img.png' },
  ];

  it('plans every non-placeholder right side from the head commit', () => {
    const plans = planResources(changes, new Set(['img.png']), 'head');
    expect(plans.map(p => [p.left.kind, p.right.kind])).toEqual([
      ['base', 'head'], ['empty', 'head'], ['base', 'empty'], ['base', 'head'], ['binary', 'binary'],
    ]);
    expect(plans[3]!.left.path).toBe('old.ts');
  });

  it('leaves the builder plan (default) unchanged', () => {
    expect(planResources(changes, new Set(['img.png'])).map(p => p.right.kind))
      .toEqual(['file', 'file', 'empty', 'file', 'binary']);
  });
});

describe('PR document identity in the diff URIs', () => {
  const ctx = { wt: '/repo', ref: 'b'.repeat(40), headRef: 'h'.repeat(40), prId: '42' };

  it('marks both sides with the PR, commit, path and side', () => {
    const [plan] = planResources([{ status: 'R', oldPath: 'old.ts', path: 'new.ts' }], new Set(), 'head');
    const { left, right } = diffUrisForChange(plan!, ctx);
    expect(left.scheme).toBe('codev-diff');
    expect(right.scheme).toBe('codev-diff');
    expect(decodePullRequestDiffUri(left)).toEqual({ prId: '42', relPath: 'old.ts', sha: ctx.ref, side: 'base' });
    expect(decodePullRequestDiffUri(right)).toEqual({ prId: '42', relPath: 'new.ts', sha: ctx.headRef, side: 'head' });
  });

  it('marks deleted/added placeholders too, so every PR document is identifiable', () => {
    const [deleted, added] = planResources([
      { status: 'D', oldPath: null, path: 'gone.ts' },
      { status: 'A', oldPath: null, path: 'fresh.ts' },
    ], new Set(), 'head');
    expect(decodePullRequestDiffUri(diffUrisForChange(deleted!, ctx).right)).toMatchObject({ prId: '42', relPath: 'gone.ts', side: 'head' });
    expect(decodePullRequestDiffUri(diffUrisForChange(added!, ctx).left)).toMatchObject({ prId: '42', relPath: 'fresh.ts', side: 'base' });
  });

  it('keeps builder URIs free of PR fields, and they decode to no PR document', () => {
    const [plan] = planResources([{ status: 'M', oldPath: null, path: 'x.ts' }], new Set());
    const { left, right } = diffUrisForChange(plan!, { wt: '/wt', ref: 'abc' });
    expect(decodeDiffQuery(left.query)).toEqual({ wt: '/wt', ref: 'abc', path: 'x.ts' });
    expect(decodePullRequestDiffUri(left)).toBeUndefined();
    expect(right.scheme).toBe('file');
    expect(decodePullRequestDiffUri(right)).toBeUndefined();
  });

  it('rejects malformed or non-diff URIs', () => {
    expect(decodePullRequestDiffUri(undefined)).toBeUndefined();
    expect(decodePullRequestDiffUri({ scheme: 'codev-diff', query: '{not json' } as never)).toBeUndefined();
    expect(decodePullRequestDiffUri({ scheme: 'codev-diff', query: JSON.stringify({ wt: '', ref: '', path: 'p', pr: '1' }) } as never)).toBeUndefined();
  });
});

describe('BuilderDiffCache.getPullRequestDiff (real git)', () => {
  it('lists merge-base ↔ head with statuses, rename source and binary, and decorates the rows', async () => {
    const repo = fx.clone();
    const cache = new BuilderDiffCache();
    const fired: unknown[][] = [];
    cache.onDidChangeDecorations(uris => fired.push(uris));

    const result = await cache.getPullRequestDiff({ prId: '7', repo }, async () => view());

    expect(result.errorKind).toBeUndefined();
    expect(result.headSha).toBe(fx.headSha);
    expect(result.baseRef).toBe(fx.forkPoint);
    const byPath = new Map(result.files.map(f => [f.change.path, f]));
    expect([...byPath.keys()].sort()).toEqual(['a.txt', 'b.txt', 'c.txt', 'img.bin', 'new.txt']);
    expect(byPath.has('later-on-main.txt')).toBe(false);
    expect(byPath.get('a.txt')!.change.status).toBe('M');
    expect(byPath.get('b.txt')!.change.status).toBe('D');
    expect(byPath.get('c.txt')!.change.status).toBe('A');
    expect(byPath.get('new.txt')!.change).toMatchObject({ status: 'R', oldPath: 'old.txt' });
    expect(byPath.get('img.bin')!.plan.right.kind).toBe('binary');
    expect(byPath.get('a.txt')!.plan.right).toEqual({ kind: 'head', path: 'a.txt' });

    expect(cache.decorationFor(pullRequestFileResourceUri(repo, '7', 'c.txt') as never)).toBe('A');
    expect(fired.length).toBe(1);

    // The head commit's blob is readable from the main checkout (what the content provider runs).
    expect(git(repo, 'show', `${result.headSha}:c.txt`)).toBe('new file');
    // And the checkout itself is untouched.
    expect(git(repo, 'status', '--porcelain')).toBe('');

    cache.retainPullRequests(new Set());
    expect(cache.decorationFor(pullRequestFileResourceUri(repo, '7', 'c.txt') as never)).toBeUndefined();
  });

  it('serves a cached result without another forge read, and re-reads after invalidation', async () => {
    const repo = fx.clone();
    const cache = new BuilderDiffCache();
    const loadPR = vi.fn(async () => view());
    await cache.getPullRequestDiff({ prId: '7', repo }, loadPR);
    await cache.getPullRequestDiff({ prId: '7', repo }, loadPR);
    expect(loadPR).toHaveBeenCalledTimes(1);
    cache.invalidatePullRequest('7');
    await cache.getPullRequestDiff({ prId: '7', repo }, loadPR);
    expect(loadPR).toHaveBeenCalledTimes(2);
  });

  it('shares one load between concurrent expansions', async () => {
    const repo = fx.clone();
    const cache = new BuilderDiffCache();
    const loadPR = vi.fn(async () => view());
    const [a, b] = await Promise.all([
      cache.getPullRequestDiff({ prId: '7', repo }, loadPR),
      cache.getPullRequestDiff({ prId: '7', repo }, loadPR),
    ]);
    expect(loadPR).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it('follows a moved head on the next read', async () => {
    const repo = fx.clone();
    const cache = new BuilderDiffCache();
    const first = await cache.getPullRequestDiff({ prId: '7', repo }, async () => view());
    // A second push to the PR moves its head; the next read (after the TTL, or a refresh) follows it.
    cache.invalidatePullRequest('7');
    const second = await cache.getPullRequestDiff({ prId: '7', repo }, async () => view({ headRefOid: fx.movedHeadSha }));
    expect(second.headSha).toBe(fx.movedHeadSha);
    expect(git(repo, 'rev-parse', 'refs/codev/pr/7/head')).toBe(fx.movedHeadSha);
    expect(second.files.map(f => f.change.path)).toContain('d.txt');
    expect(first.files.map(f => f.change.path)).not.toContain('d.txt');
    // The first result keeps its own commits, so a diff opened from it is never swapped.
    expect(first.headSha).toBe(fx.headSha);
  });

  it('turns each failure into its own kind', async () => {
    const repo = fx.clone();
    const cache = new BuilderDiffCache();
    const kind = async (id: string, load: () => Promise<PRView | null>) =>
      (await cache.getPullRequestDiff({ prId: id, repo }, load)).errorKind;

    expect(await kind('1', async () => null)).toBe('forge-unavailable');
    expect(await kind('2', async () => { throw new Error('tower down'); })).toBe('forge-unavailable');
    // No head commit from this forge preset → no guessing from the branch name.
    expect(await kind('3', async () => view({ headRefOid: undefined }))).toBe('no-head-commit');
    expect(await kind('4', async () => view({ headRefOid: 'abc123' }))).toBe('no-head-commit');
    expect(await kind('5', async () => view({ baseRefName: 'no-such-branch' }))).toBe('base-missing');
    expect(await kind('6', async () => view({ headRefOid: '2'.repeat(40) }))).toBe('fetch-failed');
    expect(await kind('8', async () => view())).toBeUndefined();
    expect(PULL_REQUEST_MAX_FILES).toBe(3000);
  });
});

describe('openPullRequestFileDiff', () => {
  it('opens a read-only codev-diff ↔ codev-diff diff and registers nothing builder-only', async () => {
    executed.length = 0;
    const [plan] = planResources([{ status: 'M', oldPath: null, path: 'a.txt' }], new Set(), 'head');
    await openPullRequestFileDiff({ repo: '/repo', prId: '7', baseRef: 'b'.repeat(40), headSha: 'c'.repeat(40), plan: plan! });

    expect(executed).toHaveLength(1);
    const [command, left, right, title] = executed[0] as [string, { scheme: string; fsPath: string }, { scheme: string; fsPath: string }, string];
    expect(command).toBe('vscode.diff');
    expect(left.scheme).toBe('codev-diff');
    expect(right.scheme).toBe('codev-diff');
    expect(title).toBe('a.txt (PR #7)');
    // Builder-only surfaces (lenses, comment ranges, review queue) key off this registry.
    expect(getDiffInjectEntry(right.fsPath)).toBeUndefined();
    expect(getDiffInjectEntry('/repo/a.txt')).toBeUndefined();
  });
});
