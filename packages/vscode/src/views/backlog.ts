import * as vscode from 'vscode';
import type { OverviewCache } from './overview-cache.js';

export class BacklogProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
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

    return data.backlog.map(item => {
      const author = item.author ? ` @${item.author}` : '';
      const ti = new vscode.TreeItem(`#${item.id} ${item.title}${author}`);
      ti.tooltip = item.url;
      ti.contextValue = 'backlog-item';
      ti.iconPath = new vscode.ThemeIcon('issues');
      ti.command = {
        command: 'vscode.open',
        title: 'Open in Browser',
        arguments: [vscode.Uri.parse(item.url)],
      };
      return ti;
    });
  }
}
