/**
 * #2008 — the Pull Requests view: rows expand into the PR's changed files.
 *
 *  - a PR row is collapsible with NO click command (a click toggles expansion;
 *    the browser open is the explicit inline action), and keeps a stable id;
 *  - collapsed rows cost nothing: listing the rows makes no diff/forge call;
 *  - children follow the view-as-tree setting (flat list vs folder tree);
 *  - every failure is a visible row, the too-large row opens the browser;
 *  - `getParent` / `findFileItem` back `reveal`;
 *  - hidden refs are pruned once a PR is no longer open, never on a failed PR list.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OverviewData, OverviewPR } from '@cluesmith/codev-types';
import type { BuilderFileChange, PullRequestDiffResult } from '../views/builder-diff-cache.js';

const configValues: Record<string, unknown> = {};
const prune = vi.hoisted(() => vi.fn(async () => [] as string[]));

vi.mock('vscode', () => {
  class FakeEventEmitter<T> {
    private listeners: Array<(e: T) => void> = [];
    readonly event = (listener: (e: T) => void): { dispose: () => void } => {
      this.listeners.push(listener);
      return { dispose: () => { this.listeners = this.listeners.filter((l) => l !== listener); } };
    };
    fire = vi.fn((e: T) => { this.listeners.forEach((l) => l(e)); });
  }
  class TreeItem {
    id?: string;
    tooltip?: string;
    description?: string;
    resourceUri?: unknown;
    contextValue?: string;
    iconPath?: unknown;
    command?: unknown;
    constructor(public label: string, public collapsibleState?: number) {}
  }
  class ThemeIcon {
    static readonly Folder = new ThemeIcon('folder');
    constructor(public id: string, public color?: unknown) {}
  }
  return {
    EventEmitter: FakeEventEmitter,
    TreeItem,
    ThemeIcon,
    ThemeColor: class { constructor(public id: string) {} },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    Uri: {
      from: (parts: object) => ({ ...parts, toString: () => JSON.stringify(parts) }),
      parse: (value: string) => ({ value }),
    },
    workspace: {
      getConfiguration: () => ({
        get: (key: string, def: unknown) => (key in configValues ? configValues[key] : def),
      }),
    },
  };
});

vi.mock('../pr-refs.js', () => ({ prunePullRequestRefs: prune }));

const { PullRequestsProvider, PullRequestTreeItem, pullRequestFailureRow } = await import('../views/pull-requests.js');
const { PullRequestFileTreeItem, PullRequestFolderTreeItem } = await import('../views/pull-request-file-tree-item.js');

function mk(relPath: string): BuilderFileChange {
  return {
    change: { status: 'M', oldPath: null, path: relPath },
    plan: { resourcePath: relPath, left: { kind: 'base', path: relPath }, right: { kind: 'head', path: relPath } },
  };
}

function pr(id: string): OverviewPR {
  return {
    id, title: `PR ${id}`, url: `https://forge.example/pr/${id}`, reviewStatus: 'REVIEW_REQUIRED',
    linkedIssue: null, createdAt: '2026-01-01T00:00:00Z', author: 'someone', reviewRequests: [], isDraft: false,
  };
}

function overview(prs: OverviewPR[], errors?: OverviewData['errors']) {
  let data = { builders: [], backlog: [], pendingPRs: prs, recentlyClosed: [], errors } as unknown as OverviewData;
  const listeners: Array<() => void> = [];
  return {
    cache: {
      getData: () => data,
      onDidChange: (l: () => void) => { listeners.push(l); return { dispose() {} }; },
    } as never,
    update(next: OverviewPR[], nextErrors?: OverviewData['errors']) {
      data = { ...data, pendingPRs: next, errors: nextErrors } as OverviewData;
      listeners.forEach(l => l());
    },
  };
}

function okResult(files: BuilderFileChange[]): PullRequestDiffResult {
  return { headSha: 'h'.repeat(40), baseRef: 'b'.repeat(40), baseRefName: 'main', files };
}

function fakeDiffCache(result: PullRequestDiffResult) {
  return {
    getPullRequestDiff: vi.fn(async () => result),
    peekPullRequestDiff: vi.fn(() => result),
    retainPullRequests: vi.fn(),
  };
}

function provider(prs: OverviewPR[], result: PullRequestDiffResult, errors?: OverviewData['errors']) {
  const ov = overview(prs, errors);
  const diffCache = fakeDiffCache(result);
  const loadPR = vi.fn(async () => null);
  const p = new PullRequestsProvider(ov.cache, { diffCache: diffCache as never, repo: () => '/repo', loadPR });
  return { p, ov, diffCache, loadPR };
}

beforeEach(() => {
  for (const k of Object.keys(configValues)) { delete configValues[k]; }
  prune.mockClear();
});

describe('PR rows', () => {
  it('are collapsible, have no click command, a stable id, and cost no diff or forge call', async () => {
    const { p, diffCache, loadPR } = provider([pr('7')], okResult([mk('a.ts')]));
    const rows = await p.getChildren();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toBeInstanceOf(PullRequestTreeItem);
    expect(row.collapsibleState).toBe(1);
    expect(row.command).toBeUndefined();
    expect(row.id).toBe('pr:7');
    expect(row.contextValue).toBe('pull-request');
    expect((row as InstanceType<typeof PullRequestTreeItem>).prUrl).toBe('https://forge.example/pr/7');
    expect(diffCache.getPullRequestDiff).not.toHaveBeenCalled();
    expect(loadPR).not.toHaveBeenCalled();
  });
});

describe('PR changed files', () => {
  const files = [mk('README.md'), mk('src/a/x.ts'), mk('src/a/y.ts')];

  it('renders a flat list when view-as-tree is off', async () => {
    configValues['buildersFileViewAsTree'] = false;
    const { p } = provider([pr('7')], okResult(files));
    const [row] = await p.getChildren();
    const children = await p.getChildren(row);
    expect(children.map(c => c.label)).toEqual(['README.md', 'x.ts', 'y.ts']);
    const file = children[1] as InstanceType<typeof PullRequestFileTreeItem>;
    expect(file).toBeInstanceOf(PullRequestFileTreeItem);
    expect(file.id).toBe('pr:7::src/a/x.ts');
    expect(file.contextValue).toBe('pull-request-file');
    expect(file.command).toMatchObject({ command: 'codev.openPullRequestFileDiff' });
    expect(file.target).toEqual({ prId: '7', repo: '/repo', baseRef: 'b'.repeat(40), headSha: 'h'.repeat(40) });
  });

  it('renders a folder tree when view-as-tree is on (the default)', async () => {
    const { p } = provider([pr('7')], okResult(files));
    const [row] = await p.getChildren();
    const top = await p.getChildren(row);
    const folder = top.find(c => c instanceof PullRequestFolderTreeItem)!;
    expect(folder.label).toBe('src/a');
    expect(folder.contextValue).toBe('pull-request-file-folder');
    expect((await p.getChildren(folder)).map(c => c.label)).toEqual(['x.ts', 'y.ts']);
  });

  it('shows a row when there are no changes', async () => {
    const { p } = provider([pr('7')], okResult([]));
    const [row] = await p.getChildren();
    expect((await p.getChildren(row)).map(c => c.label)).toEqual(['No changed files']);
  });
});

describe('failure rows', () => {
  const base = okResult([]);
  const cases: Array<[PullRequestDiffResult['errorKind'], string]> = [
    ['no-head-commit', 'Diff unavailable: this forge preset does not report the PR head commit'],
    ['forge-unavailable', 'Forge unavailable: could not load PR details'],
    ['fetch-failed', 'Fetch failed: could not fetch the PR head commit'],
    ['base-missing', 'Base branch main not found on origin'],
    ['shallow', 'Shallow clone: run `git fetch --unshallow` to view PR diffs'],
    ['no-merge-base', 'No common history with main'],
  ];
  for (const [kind, label] of cases) {
    it(`${kind} → a visible row with the detail in its tooltip`, async () => {
      const { p } = provider([pr('7')], { ...base, errorKind: kind, error: 'detail' });
      const [row] = await p.getChildren();
      const [child] = await p.getChildren(row);
      expect(child!.label).toBe(label);
      expect(child!.tooltip).toBe('detail');
      expect(child!.collapsibleState).toBeUndefined();
    });
  }

  it('too-large names the count and opens the PR in the browser', () => {
    const row = pullRequestFailureRow({ ...base, errorKind: 'too-large', fileCount: 4200 }, 'https://forge.example/pr/7');
    expect(row.label).toBe('Diff too large to list (4200 files). Click to open in browser');
    expect(row.command).toMatchObject({ command: 'vscode.open', arguments: [{ value: 'https://forge.example/pr/7' }] });
  });
});

describe('reveal support', () => {
  const files = [mk('README.md'), mk('src/a/x.ts'), mk('src/b/z.ts')];

  it('findFileItem returns the row for an open PR, undefined otherwise', async () => {
    const { p } = provider([pr('7')], okResult(files));
    const item = await p.findFileItem('7', 'src/a/x.ts');
    expect(item?.id).toBe('pr:7::src/a/x.ts');
    expect(await p.findFileItem('7', 'nope.ts')).toBeUndefined();
    expect(await p.findFileItem('99', 'src/a/x.ts')).toBeUndefined();
  });

  it('getParent walks folders up to the PR row in tree mode, the PR row in flat mode', async () => {
    const { p } = provider([pr('7')], okResult(files));
    const file = (await p.findFileItem('7', 'src/a/x.ts'))!;
    const folder = p.getParent(file)!;
    expect(folder.id).toBe('pr:7::folder::src/a');
    // `src` holds two folders (a, b), so it stays its own (uncompacted) row.
    const src = p.getParent(folder)!;
    expect(src.id).toBe('pr:7::folder::src');
    expect(p.getParent(src)!.id).toBe('pr:7');
    configValues['buildersFileViewAsTree'] = false;
    expect(p.getParent(file)!.id).toBe('pr:7');
  });
});

describe('hidden-ref pruning', () => {
  it('prunes refs for PRs no longer open, once per distinct open set', async () => {
    const { ov, diffCache } = provider([pr('7'), pr('8')], okResult([]));
    ov.update([pr('7')]);
    expect(prune).toHaveBeenCalledTimes(1);
    expect(prune).toHaveBeenCalledWith('/repo', new Set(['7']));
    expect(diffCache.retainPullRequests).toHaveBeenCalledWith(new Set(['7']));
    ov.update([pr('7')]);
    expect(prune).toHaveBeenCalledTimes(1);
  });

  it('never prunes on a failed PR list (a forge outage is not "every PR closed")', async () => {
    const { ov, diffCache } = provider([pr('7')], okResult([]));
    ov.update([], { prs: 'forge unavailable' });
    expect(prune).not.toHaveBeenCalled();
    expect(diffCache.retainPullRequests).not.toHaveBeenCalled();
  });
});
