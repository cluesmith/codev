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
