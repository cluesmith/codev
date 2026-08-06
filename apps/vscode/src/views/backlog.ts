import * as vscode from 'vscode';
import type { OverviewBacklogItem } from '@cluesmith/codev-types';
import { UNCATEGORIZED_AREA } from '@cluesmith/codev-sdk/constants';
import { groupByArea } from '@cluesmith/codev-sdk/area-grouping';
import type { OverviewCache } from './overview-data.js';
import { BacklogGroupTreeItem, BacklogTreeItem } from './backlog-tree-item.js';
import { AreaGroupExpansionStore } from './area-group-expansion.js';
import { activeBuilderCountByArea, filterMine, spawnableBacklog } from './backlog-filter.js';
import { recencyPrefix, relativeAge } from './backlog-recency.js';

// Re-export so existing call sites (extension.ts, src/test/backlog.test.ts)
// keep their import path. The definition lives in `backlog-filter.ts` so
// vitest helpers can share the primitive without pulling in `vscode`.
export { spawnableBacklog };

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
  ) {
    this.expansion = new AreaGroupExpansionStore(workspaceState, 'codev.backlogGroupExpansion');
    cache.onDidChange(() => this.changeEmitter.fire());
  }

  /**
   * Force a re-render. Used by the `codev.backlogShowAll` config-change
   * listener — the cache hasn't changed, but the filter mode has, so
   * the tree needs to redraw.
   */
  refresh(): void {
    this.changeEmitter.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    if (element instanceof BacklogGroupTreeItem) {
      return this.rowsForGroup(element.groupName);
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

    // Empty mine-only state: the user has the filter on, we know who
    // they are, and nothing matched. Show a single non-clickable
    // placeholder pointing at the toggle — silent empty view is the
    // confusing failure mode the issue called out.
    if (items.length === 0 && !readBacklogShowAll() && !!data.currentUser) {
      const placeholder = new vscode.TreeItem(
        '(no backlog items assigned to you — click the eye icon to see all)',
      );
      placeholder.contextValue = 'backlog-empty';
      return [placeholder];
    }

    const groups = groupByArea(items, i => i.area);

    // Degenerate case: a repo that doesn't use `area/*` labels yields a
    // single `Uncategorized` group containing every issue. Rendering its
    // header would add no information — collapse to flat rows so the
    // backlog looks the same as it did before grouping shipped.
    if (groups.length === 1 && groups[0].area === UNCATEGORIZED_AREA) {
      return groups[0].items.map(item => this.makeRow(item, data));
    }

    const expansion = this.expansion.read();
    const activeByArea = activeBuilderCountByArea(data.builders);
    return groups.map(g => {
      const expanded = expansion[g.area] ?? true;
      const state = expanded
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed;
      return new BacklogGroupTreeItem(g.area, g.items.length, state, activeByArea.get(g.area) ?? 0);
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

  private makeRow(
    item: OverviewBacklogItem,
    data: NonNullable<ReturnType<OverviewCache['getData']>>,
  ): BacklogTreeItem {
    const me = data.currentUser?.toLowerCase();
    const assigned = !!me && !!item.assignees?.some(a => a.toLowerCase() === me);
    const author = item.author ? ` @${item.author}` : '';
    // Render-time "now": items aging past the 24h window lose `[new]` on the
    // next refresh, no persistent state (#930). The `[new]` prefix leads the
    // row (before the issue number) and coexists with the assignment icon
    // (following #810).
    const now = Date.now();
    const prefix = recencyPrefix(item.createdAt, now);
    const ti = new BacklogTreeItem(item.id, item.url, item.title, `${prefix}#${item.id} ${item.title}${author}`);
    const age = relativeAge(item.createdAt, now);
    ti.tooltip = age ? `${item.url}\nCreated ${age}` : item.url;
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
   * behavior so within-group ordering matches the old flat list.
   *
   * If `codev.backlogShowAll` is off and `currentUser` is known, the
   * list is further filtered down to items assigned to the current
   * user. When `currentUser` is unavailable, `filterMine` is a no-op so
   * the view stays useful even when gh can't tell us who the user is.
   */
  private orderedSpawnable(data: NonNullable<ReturnType<OverviewCache['getData']>>): OverviewBacklogItem[] {
    const me = data.currentUser?.toLowerCase();
    const isMine = (item: OverviewBacklogItem) =>
      !!me && !!item.assignees?.some(a => a.toLowerCase() === me);

    let items = spawnableBacklog(data.backlog);
    if (!readBacklogShowAll()) {
      items = filterMine(items, data.currentUser);
    }
    const mine = items.filter(isMine);
    const rest = items.filter(item => !isMine(item));
    return [...mine, ...rest];
  }
}

function readBacklogShowAll(): boolean {
  return vscode.workspace.getConfiguration('codev').get<boolean>('backlogShowAll', false);
}
