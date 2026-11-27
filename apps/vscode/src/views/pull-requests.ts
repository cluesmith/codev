import * as vscode from 'vscode';
import type { OverviewPR, PRView } from '@cluesmith/codev-types';
import type { OverviewCache } from './overview-data.js';
import { sortPendingPRs } from './pull-requests-sort.js';
import type { BuilderDiffCache, PullRequestDiffResult } from './builder-diff-cache.js';
import { buildFilePathTree, findParentNode } from './file-path-tree.js';
import {
  PullRequestFileTreeItem,
  PullRequestFolderTreeItem,
  pullRequestNodeItem,
  pullRequestRowId,
  type PullRequestDiffTarget,
} from './pull-request-file-tree-item.js';
import { readBuildersFileViewAsTree } from '../builders-config.js';
import { prunePullRequestRefs } from '../pr-refs.js';

/**
 * TreeItem subclass that carries a PR's id and title as typed fields.
 *
 * Why: VSCode passes the tree item itself to commands invoked from
 * `view/item/context` menus. The `codev.referencePRInArchitect` and
 * `codev.openPullRequestInBrowser` commands read `.prId`, `.prTitle` and
 * `.prUrl` via `instanceof PullRequestTreeItem`.
 *
 * The row expands into the PR's changed files (#2008), so a click toggles
 * expansion; opening the PR in the browser is the row's inline action.
 */
export class PullRequestTreeItem extends vscode.TreeItem {
  constructor(
    public readonly prId: string,
    public readonly prTitle: string,
    label: string,
    public readonly prUrl: string = '',
  ) {
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
    // Stable id: keeps expansion across overview refreshes and lets `reveal`
    // locate the row again.
    this.id = pullRequestRowId(prId);
  }
}

function prRow(pr: OverviewPR): PullRequestTreeItem {
  const author = pr.author ? ` @${pr.author}` : '';
  const draft = pr.isDraft ? ' (draft)' : '';
  const item = new PullRequestTreeItem(
    pr.id,
    pr.title,
    `#${pr.id} ${pr.title}${draft}${author} (${pr.reviewStatus})`,
    pr.url,
  );
  item.tooltip = pr.url;
  item.contextValue = 'pull-request';
  item.iconPath = new vscode.ThemeIcon(pr.isDraft ? 'git-pull-request-draft' : 'git-pull-request');
  return item;
}

/** A non-expandable informational row under a PR (empty list or a failure). */
function infoRow(label: string, tooltip?: string, command?: vscode.Command): vscode.TreeItem {
  const item = new vscode.TreeItem(label);
  item.contextValue = 'pull-request-file-none';
  item.iconPath = new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('disabledForeground'));
  if (tooltip) { item.tooltip = tooltip; }
  if (command) { item.command = command; }
  return item;
}

/**
 * The visible row for a PR whose files can't be listed. Every failure is a row
 * the reader can see (with the detail in its tooltip), never an empty node.
 */
export function pullRequestFailureRow(result: PullRequestDiffResult, prUrl: string): vscode.TreeItem {
  const detail = result.error;
  switch (result.errorKind) {
    case 'no-head-commit':
      return infoRow('Diff unavailable: this forge preset does not report the PR head commit', detail);
    case 'forge-unavailable':
      return infoRow('Forge unavailable: could not load PR details', detail);
    case 'fetch-failed':
      return infoRow('Fetch failed: could not fetch the PR head commit', detail);
    case 'base-missing':
      return infoRow(`Base branch ${result.baseRefName} not found on origin`, detail);
    case 'shallow':
      return infoRow('Shallow clone: run `git fetch --unshallow` to view PR diffs', detail);
    case 'no-merge-base':
      return infoRow(`No common history with ${result.baseRefName}`, detail);
    case 'too-large': {
      let command: vscode.Command | undefined;
      if (prUrl) {
        command = { command: 'vscode.open', title: 'Open in Browser', arguments: [vscode.Uri.parse(prUrl)] };
      }
      return infoRow(`Diff too large to list (${result.fileCount ?? 0} files). Click to open in browser`, detail, command);
    }
    default:
      return infoRow('Diff unavailable', detail);
  }
}

export interface PullRequestsProviderDeps {
  diffCache: BuilderDiffCache;
  /** The main checkout the PR refs live in, or undefined when not connected. */
  repo: () => string | undefined;
  /** Forge read of one PR (Tower `GET /api/pr`). */
  loadPR: (prId: string) => Promise<PRView | null>;
}

export class PullRequestsProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  /** The open-PR set last used to prune hidden refs, so an unchanged poll costs no git. */
  private lastPrunedKey: string | undefined;

  constructor(private cache: OverviewCache, private readonly deps?: PullRequestsProviderDeps) {
    cache.onDidChange(() => {
      this.pruneClosed();
      this.changeEmitter.fire();
    });
  }

  /** Redraw (e.g. the view-as-tree setting changed). */
  refresh(): void {
    this.changeEmitter.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (!element) { return this.prRows(); }
    if (element instanceof PullRequestTreeItem) {
      return this.fileChildren(element);
    }
    if (element instanceof PullRequestFolderTreeItem) {
      return (element.node.children ?? []).map(node => pullRequestNodeItem(element.target, node));
    }
    return [];
  }

  /**
   * Parent of a PR file/folder row — needed for `TreeView.reveal`. The PR row
   * in flat-list mode or for a top-level node; otherwise the enclosing folder,
   * rebuilt from the cached file list (no git, no forge call).
   */
  getParent(element: vscode.TreeItem): vscode.TreeItem | undefined {
    if (!(element instanceof PullRequestFileTreeItem) && !(element instanceof PullRequestFolderTreeItem)) {
      return undefined;
    }
    const { target } = element;
    const row = this.prRowFor(target.prId);
    if (!readBuildersFileViewAsTree()) { return row; }
    const result = this.deps?.diffCache.peekPullRequestDiff(target.prId);
    if (!result) { return row; }
    let targetPath: string;
    if (element instanceof PullRequestFolderTreeItem) {
      targetPath = element.node.fullPath;
    } else {
      targetPath = element.plan.resourcePath;
    }
    const parentNode = findParentNode(buildFilePathTree(result.files), targetPath);
    if (!parentNode) { return row; }
    return new PullRequestFolderTreeItem(target, parentNode);
  }

  /**
   * The file row for `(prId, relPath)` at the PR's current head, so the view can
   * `reveal` the row matching the active PR diff. Undefined when the PR is gone,
   * its list isn't loaded, or the file isn't in it.
   */
  async findFileItem(prId: string, relPath: string): Promise<PullRequestFileTreeItem | undefined> {
    const pr = this.openPR(prId);
    const repo = this.deps?.repo();
    if (!pr || !repo || !this.deps) { return undefined; }
    const result = await this.deps.diffCache.getPullRequestDiff({ prId, repo }, () => this.deps!.loadPR(prId));
    if (result.errorKind) { return undefined; }
    const file = result.files.find(f => f.plan.resourcePath === relPath);
    if (!file) { return undefined; }
    return new PullRequestFileTreeItem(targetOf(prId, repo, result), file.change, file.plan);
  }

  private prRows(): vscode.TreeItem[] {
    const data = this.cache.getData();
    if (!data) { return []; }
    return sortPendingPRs(data.pendingPRs, data.currentUser).map(prRow);
  }

  private openPR(prId: string): OverviewPR | undefined {
    return this.cache.getData()?.pendingPRs.find(pr => pr.id === prId);
  }

  private prRowFor(prId: string): PullRequestTreeItem | undefined {
    const pr = this.openPR(prId);
    if (!pr) { return undefined; }
    return prRow(pr);
  }

  /** Children of an expanded PR row. Only an expanded row reaches here: collapsed rows cost nothing. */
  private async fileChildren(row: PullRequestTreeItem): Promise<vscode.TreeItem[]> {
    const repo = this.deps?.repo();
    if (!this.deps || !repo) {
      return [infoRow('Not connected to Tower')];
    }
    const deps = this.deps;
    const result = await deps.diffCache.getPullRequestDiff(
      { prId: row.prId, repo },
      () => deps.loadPR(row.prId),
    );
    if (result.errorKind) {
      return [pullRequestFailureRow(result, row.prUrl)];
    }
    if (result.files.length === 0) {
      return [infoRow('No changed files')];
    }
    const target = targetOf(row.prId, repo, result);
    if (readBuildersFileViewAsTree()) {
      return buildFilePathTree(result.files).map(node => pullRequestNodeItem(target, node));
    }
    return result.files.map(f => new PullRequestFileTreeItem(target, f.change, f.plan));
  }

  /**
   * Once a PR is no longer open, drop its cached list and its hidden refs.
   * Runs only on a successful PR list: a forge outage (`errors.prs`) must never
   * read as "every PR closed".
   */
  private pruneClosed(): void {
    const data = this.cache.getData();
    const repo = this.deps?.repo();
    if (!data || !repo || !this.deps || data.errors?.prs) { return; }
    const openIds = new Set(data.pendingPRs.map(pr => pr.id));
    this.deps.diffCache.retainPullRequests(openIds);
    const key = `${repo}\0${[...openIds].sort().join(',')}`;
    if (key === this.lastPrunedKey) { return; }
    this.lastPrunedKey = key;
    prunePullRequestRefs(repo, openIds).catch(() => {
      // Pruning is best-effort; refs under refs/codev/pr/ are inert if left behind.
    });
  }
}

function targetOf(prId: string, repo: string, result: PullRequestDiffResult): PullRequestDiffTarget {
  return { prId, repo, baseRef: result.baseRef, headSha: result.headSha };
}
