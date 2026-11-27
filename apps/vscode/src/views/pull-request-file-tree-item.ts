import * as vscode from 'vscode';
import type { ChangeEntry, ResourcePlan } from '../commands/view-diff.js';
import { BUILDER_FILE_SCHEME, ChangedFileTreeItem } from './builder-file-tree-item.js';
import { applyChangedFolderRow } from './builder-folder-tree-item.js';
import type { FilePathNode } from './file-path-tree.js';

/**
 * Changed-file rows under a pull request in the Pull Requests view (#2008).
 *
 * Same presentation as a builder's changed-file rows (`ChangedFileTreeItem`:
 * file-type icon, status-letter decoration, rename source), but a PR row
 * carries no builder linkage: its `contextValue` is `pull-request-file`, so
 * none of the `builder-file` menus apply, and its click opens a read-only
 * two-commit diff via `codev.openPullRequestFileDiff`.
 */

/** Everything a PR file row needs to open its diff: the repo and both commits. */
export interface PullRequestDiffTarget {
  prId: string;
  /** The main checkout the hidden refs live in. */
  repo: string;
  /** Merge-base of the PR's base branch and its head (the left side). */
  baseRef: string;
  /** The PR's head commit (the right side). */
  headSha: string;
}

/**
 * The `resourceUri` for a PR changed-file row. Same scheme and synthetic-path
 * shape as `builderFileResourceUri` (so the built-in Git decorator stays off
 * the row, #799), with a `pr=` query that keeps it distinct from any builder's
 * row for the same path — the decoration map is keyed by `uri.toString()`.
 */
export function pullRequestFileResourceUri(repo: string, prId: string, rel: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: BUILDER_FILE_SCHEME,
    path: '/' + rel,
    query: `pr=${encodeURIComponent(prId)}&repo=${encodeURIComponent(repo)}`,
  });
}

/** Tree id of a PR row. File and folder ids hang off it. */
export function pullRequestRowId(prId: string): string {
  return `pr:${prId}`;
}

export class PullRequestFileTreeItem extends ChangedFileTreeItem {
  constructor(
    public readonly target: PullRequestDiffTarget,
    change: ChangeEntry,
    plan: ResourcePlan,
  ) {
    super(change, plan, {
      id: `${pullRequestRowId(target.prId)}::${plan.resourcePath}`,
      resourceUri: pullRequestFileResourceUri(target.repo, target.prId, plan.resourcePath),
      contextValue: 'pull-request-file',
    });
    this.command = {
      command: 'codev.openPullRequestFileDiff',
      title: 'Open Diff',
      arguments: [this],
    };
  }
}

/** Folder row in tree-mode rendering of a PR's changed files. Expanded by default, like builders'. */
export class PullRequestFolderTreeItem extends vscode.TreeItem {
  constructor(
    public readonly target: PullRequestDiffTarget,
    public readonly node: FilePathNode,
  ) {
    super(node.name, vscode.TreeItemCollapsibleState.Expanded);
    applyChangedFolderRow(this, `${pullRequestRowId(target.prId)}::folder::${node.fullPath}`, 'pull-request-file-folder');
  }
}

/** Materialise one `FilePathNode` as a PR folder or file row. */
export function pullRequestNodeItem(target: PullRequestDiffTarget, node: FilePathNode): vscode.TreeItem {
  if (node.children) {
    return new PullRequestFolderTreeItem(target, node);
  }
  return new PullRequestFileTreeItem(target, node.file!.change, node.file!.plan);
}
