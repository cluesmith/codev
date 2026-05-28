import * as vscode from 'vscode';
import type { OverviewBacklogItem } from '@cluesmith/codev-types';
import { UNCATEGORIZED_AREA } from '@cluesmith/codev-core/constants';
import { formatAreaForDisplay, groupByArea } from '@cluesmith/codev-core/area-grouping';
import type { OverviewCache } from './overview-data.js';
import { BacklogGroupTreeItem, BacklogTreeItem } from './backlog-tree-item.js';
import { AreaGroupExpansionStore } from './area-group-expansion.js';
import type { SearchState } from './search-state.js';
import type { SearchCounts } from './search-view.js';

/**
 * Backlog rows the user can act on — exclude issues that already have an
 * active builder. Mirrors the dashboard's BacklogList
 * (`items.filter(i => !i.hasBuilder)`) so the extension and web show the
 * same "available work" set and you can't double-spawn from the Backlog.
 */
export function spawnableBacklog(items: OverviewBacklogItem[]): OverviewBacklogItem[] {
  return items.filter(i => !i.hasBuilder);
}

/**
 * Backlog view: open GitHub issues with no PR yet, grouped by `area/*`
 * label. Group ordering: alphabetical specific areas, then `Uncategorized`
 * last. Within each group, items assigned to the current user
 * (auto-detected via OverviewData.currentUser) sort to the top with an
 * `account` icon; the rest keep `issues`. Order within those two segments
 * preserves Tower's order.
 *
 * Row click starts work: it invokes codev.viewBacklogIssue with the
 * issue number pre-filled. Browser / copy / spawn actions live in the
 * right-click context menu (see package.json view/item/context).
 *
 * Group expand/collapse state persists per area name via
 * `workspaceState` under `codev.backlogGroupExpansion`. Default for
 * any group the user hasn't touched: expanded.
 */
export class BacklogProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  readonly expansion: AreaGroupExpansionStore;

  constructor(
    private readonly cache: OverviewCache,
    workspaceState: vscode.Memento,
    private readonly searchState: SearchState,
  ) {
    this.expansion = new AreaGroupExpansionStore(workspaceState, 'codev.backlogGroupExpansion');
    cache.onDidChange(() => this.changeEmitter.fire());
    searchState.onDidChange(() => this.changeEmitter.fire());
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    if (element instanceof BacklogGroupTreeItem) {
      return this.rowsForGroup(element.areaName);
    }
    if (element) {
      return [];
    }
    return this.rootChildren();
  }

  private rootChildren(): vscode.TreeItem[] {
    const data = this.cache.getData();
    if (!data) { return []; }

    const items = this.orderedSpawnable(data);
    const groups = groupByArea(items, i => i.area);

    // Degenerate case: a repo that doesn't use `area/*` labels yields a
    // single `Uncategorized` group containing every issue. Rendering its
    // header would add no information — collapse to flat rows so the
    // backlog looks the same as it did before grouping shipped.
    if (groups.length === 1 && groups[0].area === UNCATEGORIZED_AREA) {
      return groups[0].items.map(item => this.makeRow(item, data));
    }

    const expansion = this.expansion.read();
    return groups.map(g => {
      const expanded = expansion[g.area] ?? true;
      const state = expanded
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed;
      return new BacklogGroupTreeItem(g.area, g.items.length, state);
    });
  }

  private rowsForGroup(areaName: string): vscode.TreeItem[] {
    const data = this.cache.getData();
    if (!data) { return []; }

    const items = this.orderedSpawnable(data);
    const group = groupByArea(items, i => i.area).find(g => g.area === areaName);
    if (!group) { return []; }

    return group.items.map(item => this.makeRow(item, data));
  }

  /**
   * Current row counts under the active filter — `shown` is the post-
   * filter count, `total` is the full spawnable backlog size. Consumed by
   * the search webview's summary line and by `extension.ts` for the
   * `(N of M)` title suffix and the no-match `.message` banner.
   */
  getCounts(): SearchCounts {
    const data = this.cache.getData();
    if (!data) {return { total: 0, shown: 0 };}
    const all = spawnableBacklog(data.backlog);
    if (this.searchState.query.trim() === '') {
      return { total: all.length, shown: all.length };
    }
    return { total: all.length, shown: all.filter(i => this.itemMatches(i)).length };
  }

  private itemMatches(item: OverviewBacklogItem): boolean {
    return this.searchState.matches([
      item.id,
      item.title,
      item.area,
      formatAreaForDisplay(item.area),
      ...item.labels,
      ...(item.assignees ?? []),
      item.author,
    ]);
  }

  private makeRow(
    item: OverviewBacklogItem,
    data: NonNullable<ReturnType<OverviewCache['getData']>>,
  ): BacklogTreeItem {
    const me = data.currentUser?.toLowerCase();
    const assigned = !!me && !!item.assignees?.some(a => a.toLowerCase() === me);
    const author = item.author ? ` @${item.author}` : '';
    const ti = new BacklogTreeItem(item.id, item.url, `#${item.id} ${item.title}${author}`);
    ti.tooltip = item.url;
    ti.contextValue = 'backlog-item';
    ti.iconPath = new vscode.ThemeIcon(assigned ? 'account' : 'issues');
    if (assigned) { ti.description = 'assigned to you'; }
    ti.command = {
      command: 'codev.viewBacklogIssue',
      title: 'View Issue',
      arguments: [item.id],
    };
    return ti;
  }

  /**
   * Spawnable items in display order (mine-first, then rest), preserving
   * Tower's order within each segment. Identical to the pre-grouping
   * behavior so within-group ordering matches the old flat list. The
   * active search filter (if any) is applied here — by intersecting at
   * this single chokepoint, both root-level group counts and the
   * per-group rows stay consistent without duplicate filter logic.
   */
  private orderedSpawnable(data: NonNullable<ReturnType<OverviewCache['getData']>>): OverviewBacklogItem[] {
    const me = data.currentUser?.toLowerCase();
    const isMine = (item: OverviewBacklogItem) =>
      !!me && !!item.assignees?.some(a => a.toLowerCase() === me);

    const items = spawnableBacklog(data.backlog).filter(i => this.itemMatches(i));
    const mine = items.filter(isMine);
    const rest = items.filter(item => !isMine(item));
    return [...mine, ...rest];
  }
}
