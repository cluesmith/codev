import * as vscode from 'vscode';
import type { OverviewCache } from './overview-cache.js';

export class BuildersProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
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

    return data.builders.map(b => {
      const phase = b.blocked ? `[${b.blocked}] blocked` : `[${b.phase}]`;
      const item = new vscode.TreeItem(`#${b.issueId ?? b.id} ${b.issueTitle ?? ''} ${phase}`);
      item.tooltip = `Protocol: ${b.protocol} | Mode: ${b.mode} | Progress: ${b.progress}%`;
      item.contextValue = 'builder';
      item.iconPath = b.blocked
        ? new vscode.ThemeIcon('debug-pause', new vscode.ThemeColor('testing.iconFailed'))
        : new vscode.ThemeIcon('play', new vscode.ThemeColor('testing.iconPassed'));
      return item;
    });
  }
}
