import * as vscode from 'vscode';
import type { OverviewBuilder } from '@cluesmith/codev-types';
import type { OverviewCache } from './overview-data.js';
import { BuilderTreeItem } from './builder-tree-item.js';

/**
 * Order builders for the Builders tree: blocked first with the longest-
 * waiting at the top, then active builders in overview order. Builders
 * with no recorded `blockedSince` sort last within the blocked group
 * (we don't pretend to know their wait time).
 */
function orderForDisplay(builders: OverviewBuilder[]): OverviewBuilder[] {
  const ms = (iso: string | null) => iso ? new Date(iso).getTime() : Infinity;
  const blocked = builders
    .filter(b => b.blocked)
    .sort((a, b) => ms(a.blockedSince) - ms(b.blockedSince));
  const active = builders.filter(b => !b.blocked);
  return [...blocked, ...active];
}

/**
 * Unified Builders view. Blocked builders sort to the top with a bell icon
 * and a wait-time suffix; active builders sit below with a play icon.
 * Replaces the previous split between a Needs Attention tree (blocked only)
 * and a Builders tree (everything) — the duplication caused more noise than
 * the at-a-glance triage was worth.
 */
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

    return orderForDisplay(data.builders).map(b => {
      const isBlocked = !!b.blocked;
      const waitTime = isBlocked && b.blockedSince ? ` [${timeSince(b.blockedSince)}]` : '';
      const phaseLabel = isBlocked
        ? `blocked on ${b.blocked}${waitTime}`
        : `[${b.phase}]`;
      const item = new BuilderTreeItem(b.id, `#${b.issueId ?? b.id} ${b.issueTitle ?? ''} ${phaseLabel}`);
      item.tooltip = `Protocol: ${b.protocol} | Mode: ${b.mode} | Progress: ${b.progress}%`;
      // contextValue encodes both blocked-state and protocol so menus can
      // scope by either (e.g., inline Approve only on blocked-builder-*).
      item.contextValue = isBlocked
        ? `blocked-builder-${b.protocol || 'unknown'}`
        : `builder-${b.protocol || 'unknown'}`;
      item.iconPath = isBlocked
        ? new vscode.ThemeIcon('bell', new vscode.ThemeColor('notificationsWarningIcon.foreground'))
        : new vscode.ThemeIcon('play', new vscode.ThemeColor('testing.iconPassed'));
      item.command = {
        command: 'codev.openBuilderById',
        title: 'Open Builder Terminal',
        arguments: [b.id],
      };
      return item;
    });
  }
}

function timeSince(isoDate: string): string {
  const ms = Date.now() - new Date(isoDate).getTime();
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) { return '<1m'; }
  if (minutes < 60) { return `${minutes}m`; }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) { return `${hours}h`; }
  return `${Math.floor(hours / 24)}d`;
}
