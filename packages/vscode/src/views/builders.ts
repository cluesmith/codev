import * as vscode from 'vscode';
import type { OverviewBuilder } from '@cluesmith/codev-types';
import type { OverviewCache } from './overview-data.js';
import { BuilderTreeItem } from './builder-tree-item.js';
import { BuilderFileTreeItem } from './builder-file-tree-item.js';
import type { BuilderDiffCache } from './builder-diff-cache.js';

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

  constructor(
    private cache: OverviewCache,
    private readonly diffCache: BuilderDiffCache,
  ) {
    cache.onDidChange(() => this.changeEmitter.fire());
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    // Second level: a builder's changed files. VSCode only calls this for
    // an *expanded* builder, so collapsed builders cost no git.
    if (element instanceof BuilderTreeItem) {
      return this.fileChildren(element.builderId);
    }
    // File rows are leaves.
    if (element instanceof BuilderFileTreeItem) {
      return [];
    }
    // Root: the builder list.
    const data = this.cache.getData();
    if (!data) { return []; }

    return orderForDisplay(data.builders).map(b => {
      const isBlocked = !!b.blocked;
      const waitTime = isBlocked && b.blockedSince ? ` [${timeSince(b.blockedSince)}]` : '';
      const phaseLabel = isBlocked
        ? `blocked on ${b.blocked}${waitTime}`
        : `[${b.phase}]`;
      const item = new BuilderTreeItem(b.id, `#${b.issueId ?? b.id} ${b.issueTitle ?? ''} ${phaseLabel}`);
      // Expandable so the second-level changed-files list can hang off it.
      // The row keeps its open-terminal command (single click); the chevron
      // toggles the file list.
      item.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
      item.tooltip = `Protocol: ${b.protocol} | Mode: ${b.mode} | Progress: ${b.progress}%`;
      // contextValue encodes both blocked-state and protocol so menus can
      // scope by either (e.g., inline Approve only on blocked-builder-*).
      item.contextValue = isBlocked
        ? `blocked-builder-${b.protocol || 'unknown'}`
        : `builder-${b.protocol || 'unknown'}`;
      // 'circle-filled' (a solid status dot, like VSCode's running-process /
      // port indicators) reads as "this is live" — unlike 'play', which
      // looks like a button you press to start it.
      item.iconPath = isBlocked
        ? new vscode.ThemeIcon('bell', new vscode.ThemeColor('notificationsWarningIcon.foreground'))
        : new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('testing.iconPassed'));
      item.command = {
        command: 'codev.openBuilderById',
        title: 'Open Builder Terminal',
        arguments: [b.id],
      };
      return item;
    });
  }

  /** Changed-file rows for one builder (or a single placeholder row). */
  private async fileChildren(builderId: string): Promise<vscode.TreeItem[]> {
    const builder = this.cache.getData()?.builders.find(b => b.id === builderId);
    if (!builder?.worktreePath) {
      return [placeholder('No worktree on record')];
    }

    const result = await this.diffCache.getDiff(builderId, builder.worktreePath);
    if (result.error) {
      const row = placeholder('Diff unavailable');
      row.tooltip = result.error;
      return [row];
    }
    if (result.files.length === 0) {
      return [placeholder('No changes yet')];
    }
    return result.files.map(
      f => new BuilderFileTreeItem(builderId, builder.worktreePath, result.baseRef, f.change, f.plan),
    );
  }
}

/** Non-clickable informational leaf (no worktree / no changes / error). */
function placeholder(label: string): vscode.TreeItem {
  const item = new vscode.TreeItem(label);
  item.contextValue = 'builder-file-none';
  item.iconPath = new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('disabledForeground'));
  return item;
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
