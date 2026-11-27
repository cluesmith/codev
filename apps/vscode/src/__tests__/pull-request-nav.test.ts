/**
 * #2008 — next / previous / first file in a pull-request diff.
 *
 * The active tab's `codev-diff:` URIs identify the PR document (a PR diff is
 * never in the builder-only diff-inject registry). Navigation steps through the
 * PR's files in the VISIBLE order (depth-first tree order in tree mode, raw git
 * order in flat mode), wraps at the ends, opens each file through
 * `openPullRequestFileDiff` as a reused preview tab, and never opens a builder
 * diff. A deleted file (an empty placeholder on the head side) still resolves.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BuilderFileChange, PullRequestDiffResult } from '../views/builder-diff-cache.js';

const state = vi.hoisted(() => ({ input: undefined as unknown, activeUri: undefined as unknown }));
const setStatusBarMessage = vi.fn();

vi.mock('vscode', () => {
  class TabInputTextDiff { constructor(public original: unknown, public modified: unknown) {} }
  return {
    TabInputTextDiff,
    EventEmitter: class {
      event = (): { dispose(): void } => ({ dispose() {} });
      fire(): void {}
      dispose(): void {}
    },
    Uri: { file: (fsPath: string) => ({ fsPath }) },
    window: {
      get tabGroups() { return { activeTabGroup: { activeTab: state.input === undefined ? undefined : { input: state.input } } }; },
      get activeTextEditor() {
        if (state.activeUri === undefined) { return undefined; }
        return { document: { uri: state.activeUri } };
      },
      setStatusBarMessage: (...args: unknown[]) => setStatusBarMessage(...args),
    },
  };
});

const openPullRequestFileDiff = vi.hoisted(() => vi.fn(async () => {}));
const openBuilderFileDiff = vi.hoisted(() => vi.fn(async () => {}));
const viewAsTree = vi.hoisted(() => ({ on: true }));
vi.mock('../commands/view-diff.js', () => ({ openPullRequestFileDiff, openBuilderFileDiff }));
vi.mock('../builder-lookup.js', () => ({ builderWithWorktree: vi.fn() }));
vi.mock('../builders-config.js', () => ({ readBuildersFileViewAsTree: () => viewAsTree.on }));

const vscode = await import('vscode');
const { encodeDiffQuery, DIFF_SCHEME } = await import('../diff-query.js');
const {
  navigateDiff, navigateDiffToFirst, recordPullRequestNavPosition, recordDiffNavPosition,
  peekDiffNavPosition, resetDiffNavState, activePullRequestDocument,
} = await import('../commands/diff-nav.js');

const HEAD = 'h'.repeat(40);
const BASE = 'b'.repeat(40);

function mk(relPath: string): BuilderFileChange {
  return {
    change: { status: 'M', oldPath: null, path: relPath },
    plan: { resourcePath: relPath, left: { kind: 'base', path: relPath }, right: { kind: 'head', path: relPath } },
  };
}

/** Git order; in tree mode `src/a.ts` sorts after the folders-first tree puts `src/` before `z.md`. */
const files = [mk('z.md'), mk('src/a.ts'), mk('src/b.ts')];

function prUri(path: string, side: 'base' | 'head', extra: object = {}) {
  return { scheme: DIFF_SCHEME, query: encodeDiffQuery({ wt: '/repo', ref: side === 'head' ? HEAD : BASE, path, pr: '7', side, ...extra }) };
}

/** Show the per-file PR diff of `path` in the active tab. */
function showPrDiff(path: string, extra: object = {}): void {
  const TabInputTextDiff = (vscode as unknown as { TabInputTextDiff: new (o: unknown, m: unknown) => object }).TabInputTextDiff;
  state.input = new TabInputTextDiff(prUri(path, 'base'), prUri(path, 'head', extra));
  state.activeUri = prUri(path, 'head', extra);
}

function deps(result: PullRequestDiffResult = { headSha: HEAD, baseRef: BASE, baseRefName: 'main', files }) {
  return {
    context: {} as never,
    overviewCache: { getData: () => undefined } as never,
    diffCache: { getPullRequestDiff: vi.fn(async () => result) } as never,
    pullRequests: { repo: () => '/repo', loadPR: vi.fn(async () => null) },
  };
}

function openedPath(call = 0): string {
  const args = openPullRequestFileDiff.mock.calls[call] as unknown as [{ plan: { resourcePath: string } }, unknown];
  return args[0].plan.resourcePath;
}

beforeEach(() => {
  state.input = undefined;
  state.activeUri = undefined;
  viewAsTree.on = true;
  openPullRequestFileDiff.mockClear();
  openBuilderFileDiff.mockClear();
  setStatusBarMessage.mockClear();
  resetDiffNavState();
});

describe('activePullRequestDocument', () => {
  it('reads the PR document from the active diff tab, whichever side', () => {
    showPrDiff('src/a.ts');
    expect(activePullRequestDocument()).toEqual({ prId: '7', relPath: 'src/a.ts', sha: HEAD, side: 'head' });
  });

  it('is undefined when nothing PR-shaped is active', () => {
    state.activeUri = { scheme: 'file', fsPath: '/x.ts', query: '' };
    expect(activePullRequestDocument()).toBeUndefined();
  });
});

describe('navigateDiff in a PR diff', () => {
  it('steps in visible tree order (folders first) and opens a PR diff as a preview', async () => {
    showPrDiff('src/b.ts');
    await navigateDiff(1, deps());
    expect(openBuilderFileDiff).not.toHaveBeenCalled();
    expect(openedPath()).toBe('z.md');
    const [target, options] = openPullRequestFileDiff.mock.calls[0] as unknown as [Record<string, unknown>, unknown];
    expect(target).toMatchObject({ repo: '/repo', prId: '7', baseRef: BASE, headSha: HEAD });
    expect(options).toEqual({ preview: true });
    expect(peekDiffNavPosition()).toEqual({ prId: '7', relPath: 'z.md' });
  });

  it('wraps at both ends', async () => {
    showPrDiff('z.md');
    await navigateDiff(1, deps());
    expect(openedPath()).toBe('src/a.ts');
    showPrDiff('src/a.ts');
    await navigateDiff(-1, deps());
    expect(openedPath(1)).toBe('z.md');
  });

  it('follows raw git order in flat-list mode', async () => {
    viewAsTree.on = false;
    showPrDiff('z.md');
    await navigateDiff(1, deps());
    expect(openedPath()).toBe('src/a.ts');
  });

  it('resolves from a deleted file (empty placeholder on the head side)', async () => {
    showPrDiff('src/a.ts', { empty: true, wt: '', ref: '' });
    await navigateDiff(1, deps());
    expect(openedPath()).toBe('src/b.ts');
  });

  it('falls back to the last PR position when the active tab is not a diff', async () => {
    recordPullRequestNavPosition('7', 'src/a.ts');
    await navigateDiff(1, deps());
    expect(openedPath()).toBe('src/b.ts');
  });

  it('first-file jumps to the top of the visible list', async () => {
    showPrDiff('z.md');
    await navigateDiffToFirst(deps());
    expect(openedPath()).toBe('src/a.ts');
  });

  it('flashes, and opens nothing, when the PR list is unavailable', async () => {
    showPrDiff('z.md');
    await navigateDiff(1, deps({ headSha: '', baseRef: '', baseRefName: 'main', files: [], errorKind: 'fetch-failed' }));
    expect(openPullRequestFileDiff).not.toHaveBeenCalled();
    expect(setStatusBarMessage).toHaveBeenCalledWith('Codev: no changed files to navigate', 4000);
  });

  it('a builder position still resolves as a builder (unchanged path)', async () => {
    recordDiffNavPosition('pir-1', 'x.ts');
    await navigateDiff(1, deps());
    expect(openPullRequestFileDiff).not.toHaveBeenCalled();
    // No worktree on record for pir-1 in this double → the builder path's own flash.
    expect(setStatusBarMessage).toHaveBeenCalledWith('Codev: no worktree on record for pir-1', 4000);
  });
});
