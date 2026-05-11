import * as vscode from 'vscode';
import type { OverviewCache } from './overview-data.js';

export class NeedsAttentionProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
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

    const items: vscode.TreeItem[] = [];

    // Blocked builders
    for (const b of data.builders.filter(b => b.blocked)) {
      const waitTime = b.blockedSince
        ? `(${timeSince(b.blockedSince)})`
        : '';
      const item = new vscode.TreeItem(`#${b.issueId ?? b.id} — blocked on ${b.blocked} ${waitTime}`);
      item.iconPath = new vscode.ThemeIcon('bell', new vscode.ThemeColor('notificationsWarningIcon.foreground'));
      item.contextValue = 'blocked-builder';
      item.command = {
        command: 'codev.openBuilderById',
        title: 'Open Builder Terminal',
        arguments: [b.id],
      };
      items.push(item);
    }

    // PRs needing review
    for (const pr of data.pendingPRs.filter(p => p.reviewStatus === 'review_required')) {
      const item = new vscode.TreeItem(`PR #${pr.id} — ready for review`);
      item.iconPath = new vscode.ThemeIcon('git-pull-request');
      item.contextValue = 'pr-needs-review';
      items.push(item);
    }

    return items;
  }
}

function timeSince(isoDate: string): string {
  const ms = Date.now() - new Date(isoDate).getTime();
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) { return `${minutes}m`; }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) { return `${hours}h`; }
  return `${Math.floor(hours / 24)}d`;
}
