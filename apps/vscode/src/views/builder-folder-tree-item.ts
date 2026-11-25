import * as vscode from 'vscode';
import type { FilePathNode } from './file-path-tree.js';

/**
 * Intermediate folder row in tree-mode rendering of a builder's
 * changed files. Carries everything the file-row constructor downstream
 * needs (`worktreePath`, `baseRef`) so `BuildersProvider.getChildren`
 * can materialise children without re-fetching from the diff cache.
 *
 * Expanded by default — mirrors VSCode SCM, where the file-tree opens
 * out under each repository. A stable `id` (`<builderId>::folder::<fullPath>`)
 * lets VSCode persist user expand/collapse across the overview-poll
 * refreshes; without it the tree would reset on every tick. `scope` (the tree
 * builder that made the row, `''` in the Agents view) prefixes that id.
 */
export class BuilderFolderTreeItem extends vscode.TreeItem {
  constructor(
    public readonly builderId: string,
    public readonly worktreePath: string,
    public readonly baseRef: string,
    public readonly node: FilePathNode,
    public readonly scope: string = '',
  ) {
    super(node.name, vscode.TreeItemCollapsibleState.Expanded);
    this.id = `${scope}${builderId}::folder::${node.fullPath}`;
    this.iconPath = vscode.ThemeIcon.Folder;
    this.contextValue = 'builder-file-folder';
    // No `command` — folder rows have no click action.
  }
}
