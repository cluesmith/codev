import * as vscode from 'vscode';
import type { OverviewCache } from './overview-data.js';
import { sortPendingPRs } from './pull-requests-sort.js';

/**
 * TreeItem subclass that carries a PR's id and title as typed fields.
 *
 * Why: VSCode passes the tree item itself to commands invoked from
 * `view/item/context` menus. The `codev.referencePRInArchitect` command
 * reads `.prId` and `.prTitle` via `instanceof PullRequestTreeItem`.
 */
export class PullRequestTreeItem extends vscode.TreeItem {
  constructor(
    public readonly prId: string,
    public readonly prTitle: string,
    label: string,
  ) {
    super(label);
  }
}

export class PullRequestsProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(private cache: OverviewCache) {
    cache.onDidChange(() => this.changeEmitter.fire());
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): vscode.TreeItem[] {
    const data = this.cache.getData();
    if (!data) { return []; }

    const sorted = sortPendingPRs(data.pendingPRs, data.currentUser);

    return sorted.map(pr => {
      const author = pr.author ? ` @${pr.author}` : '';
      const draft = pr.isDraft ? ' (draft)' : '';
      const item = new PullRequestTreeItem(
        pr.id,
        pr.title,
        `#${pr.id} ${pr.title}${draft}${author} (${pr.reviewStatus})`,
      );
      item.tooltip = pr.url;
      item.contextValue = 'pull-request';
      item.iconPath = new vscode.ThemeIcon(pr.isDraft ? 'git-pull-request-draft' : 'git-pull-request');
      item.command = {
        command: 'vscode.open',
        title: 'Open in Browser',
        arguments: [vscode.Uri.parse(pr.url)],
      };
      return item;
    });
  }
}
