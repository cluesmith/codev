import * as vscode from 'vscode';
import { uppercaseAreaName } from '@cluesmith/codev-core/area-grouping';

export type AreaGroupKind = 'backlog' | 'builder';

/**
 * Shared base for area-group header rows in the Backlog and Builders
 * trees. The `kind` discriminator drives both the stable `id` prefix
 * (so VSCode persists per-group expansion across cache ticks) and the
 * `contextValue` (so per-view context menus can scope cleanly).
 *
 * Concrete subclasses (`BacklogGroupTreeItem`, `BuilderGroupTreeItem`)
 * are thin tags around this base — they exist so each view's
 * onDidExpand/Collapse handler can scope to its own groups via
 * `instanceof` rather than discriminating on a string field.
 *
 * `groupName` is the group's key — an `area/*` value for the Backlog view and
 * (since #952) either an `area/*` value or a lifecycle stage for the Builders
 * view, depending on its active grouping axis. `groupName`, `id`, and
 * `contextValue` all use the raw wire value so expansion-state persistence and
 * `groupName === ...` matchers in the per-view providers keep working. Only the
 * human-visible label is passed through `uppercaseAreaName`, matching VSCode's
 * own container-label convention (EXPLORER, SOURCE CONTROL, etc.).
 */
export class AreaGroupTreeItem extends vscode.TreeItem {
  constructor(
    public readonly groupName: string,
    public readonly kind: AreaGroupKind,
    count: number,
    collapsibleState: vscode.TreeItemCollapsibleState,
  ) {
    super(`${uppercaseAreaName(groupName)} (${count})`, collapsibleState);
    this.id = `${kind}-group:${groupName}`;
    this.contextValue = `group-${kind}`;
  }
}
