import * as vscode from 'vscode';
import type { OverviewCache } from './overview-data.js';

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

    return data.pendingPRs.map(pr => {
      const author = pr.author ? ` @${pr.author}` : '';
      const item = new vscode.TreeItem(`#${pr.id} ${pr.title}${author} (${pr.reviewStatus})`);
      item.tooltip = pr.url;
      item.contextValue = 'pull-request';
      item.iconPath = new vscode.ThemeIcon('git-pull-request');
      item.command = {
        command: 'vscode.open',
        title: 'Open in Browser',
        arguments: [vscode.Uri.parse(pr.url)],
      };
      return item;
    });
  }
}
