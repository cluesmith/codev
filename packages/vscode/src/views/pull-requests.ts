import * as vscode from 'vscode';
import type { OverviewCache } from './overview-data.js';
import { sortPendingPRs } from './pull-requests-sort.js';

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
      const item = new vscode.TreeItem(`#${pr.id} ${pr.title}${draft}${author} (${pr.reviewStatus})`);
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
