import * as vscode from 'vscode';

/**
 * TreeItem subclass that carries a backlog issue's id and URL as typed fields.
 *
 * Why: VSCode passes the tree item itself (not its `command.arguments`)
 * to commands invoked from `view/item/context` menus. The backlog
 * context-menu commands (codev.spawnBuilder, codev.openBacklogIssue,
 * codev.copyBacklogIssueNumber) need to know which issue was
 * right-clicked, so BacklogProvider constructs rows with this class and
 * the command handlers narrow via `instanceof BacklogTreeItem` to read
 * `.issueId` / `.issueUrl` safely.
 *
 * Used by views/backlog.ts.
 */
export class BacklogTreeItem extends vscode.TreeItem {
  constructor(
    public readonly issueId: string,
    public readonly issueUrl: string,
    label: string,
  ) {
    super(label);
  }
}

/**
 * TreeItem subclass for an area group header in the backlog tree.
 *
 * Carries the canonical area name (e.g. `'vscode'`, `'cross-cutting'`,
 * `'Uncategorized'`) so the expand/collapse persistence handler can key
 * the workspaceState map by area name regardless of the rendered label
 * (which includes the count suffix). `id` is set from the area name so
 * VSCode reuses the same TreeItem identity across refreshes — letting
 * the user's collapse choice survive `OverviewCache` ticks.
 */
export class BacklogGroupTreeItem extends vscode.TreeItem {
  constructor(
    public readonly areaName: string,
    count: number,
    collapsibleState: vscode.TreeItemCollapsibleState,
  ) {
    super(`${areaName} (${count})`, collapsibleState);
    this.id = `backlog-group:${areaName}`;
    this.contextValue = 'backlog-group';
  }
}
