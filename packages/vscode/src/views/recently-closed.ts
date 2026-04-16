import * as vscode from 'vscode';
import type { OverviewCache } from './overview-cache.js';

export class RecentlyClosedProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
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

    return data.recentlyClosed.map(item => {
      const ti = new vscode.TreeItem(`#${item.id} ${item.title} (${item.type})`);
      ti.tooltip = item.url;
      ti.contextValue = 'recently-closed';
      ti.iconPath = new vscode.ThemeIcon('check');
      if (item.prUrl) {
        ti.command = {
          command: 'vscode.open',
          title: 'Open PR',
          arguments: [vscode.Uri.parse(item.prUrl)],
        };
      }
      return ti;
    });
  }
}
