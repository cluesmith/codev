import * as vscode from 'vscode';
import type { OverviewBacklogItem } from '@cluesmith/codev-types';
import type { OverviewCache } from './overview-data.js';
import { BacklogTreeItem } from './backlog-tree-item.js';

/**
 * Backlog view: open GitHub issues with no PR yet. Issues assigned to the
 * current user (auto-detected via OverviewData.currentUser) sort to the
 * top with an `account` icon; the rest keep `issues`. Order within each
 * group preserves Tower's order. Mirrors how BuildersProvider sorts
 * blocked-first above active within a single view — no separator rows.
 *
 * Row click starts work: it invokes codev.spawnBuilder with the issue
 * number pre-filled (protocol-pick only). Browser / copy actions live in
 * the right-click context menu (see package.json view/item/context).
 */
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

    const me = data.currentUser?.toLowerCase();
    const isMine = (item: OverviewBacklogItem) =>
      !!me && !!item.assignees?.some(a => a.toLowerCase() === me);

    const mine = data.backlog.filter(isMine);
    const rest = data.backlog.filter(item => !isMine(item));

    return [...mine, ...rest].map(item => {
      const assigned = mine.includes(item);
      const author = item.author ? ` @${item.author}` : '';
      const ti = new BacklogTreeItem(item.id, item.url, `#${item.id} ${item.title}${author}`);
      ti.tooltip = item.url;
      ti.contextValue = 'backlog-item';
      ti.iconPath = new vscode.ThemeIcon(assigned ? 'account' : 'issues');
      if (assigned) { ti.description = 'assigned to you'; }
      ti.command = {
        command: 'codev.spawnBuilder',
        title: 'Spawn Builder',
        arguments: [item.id],
      };
      return ti;
    });
  }
}
