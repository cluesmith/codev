import * as vscode from 'vscode';
import { AreaGroupTreeItem } from './area-group-tree-item.js';
import { BUILDER_STATE_GLYPH, worstBuilderState, type GroupRollup } from './builder-row.js';

/**
 * TreeItem subclass that carries a builder id as a typed field.
 *
 * Why: VSCode passes the tree item itself (not its `command.arguments`)
 * to commands invoked from `view/item/context` menus. Builder-scoped
 * commands (codev.openWorktreeWindow, codev.runWorktreeDev,
 * codev.stopWorktreeDev, codev.viewPlanFile, codev.approveGate, etc.)
 * need to know which builder was right-clicked, so the views construct
 * builder rows with this class and the command handlers narrow via
 * `instanceof BuilderTreeItem` to read `.builderId` safely.
 *
 * Used by views/builders.ts.
 */
export class BuilderTreeItem extends vscode.TreeItem {
  constructor(
    public readonly builderId: string,
    label: string,
  ) {
    super(label);
  }
}

/**
 * Group header in the Builders tree. Thin subclass of `AreaGroupTreeItem` so the
 * per-view expand/collapse handler in `extension.ts` can scope to builder groups
 * via `instanceof` (distinct from `BacklogGroupTreeItem`, which uses the same base).
 *
 * `groupName` is whatever key the active grouping strategy produced (#952): a
 * lifecycle stage in stage mode, an `area/*` value in area mode. The header is
 * axis-agnostic — it just renders the name and the state rollup.
 *
 * Carries a worst-of-three roll-up icon (#926) over the group's
 * `{ blocked, idle, active }` counts (from `rollupGroupState`), reusing the
 * builder-row vocabulary: any blocked → yellow `bell`; else any idle → blue
 * `comment-discussion`; else green `circle-filled`. This is a *state* rollup,
 * orthogonal to the group the header names: the label says which group, the icon
 * says whether anyone in it needs attention. The blocked case uses a GENERIC
 * `bell` (not the row's gate-specific `gateIconFor` shape) because a group can
 * hold builders at different gates — the yellow color is the group-level "needs
 * attention" signal. The triple is spelled out in the tooltip. Set here in the
 * subclass, not the shared base, because the Backlog view rolls up differently.
 */
export class BuilderGroupTreeItem extends AreaGroupTreeItem {
  constructor(
    groupName: string,
    count: number,
    collapsibleState: vscode.TreeItemCollapsibleState,
    rollup: GroupRollup,
  ) {
    super(groupName, 'builder', count, collapsibleState);
    // An empty rollup means a childless group — only the architect axis produces
    // one (a registered architect with no builders, Issue 1174). Short-circuit
    // the worst-of tri-state, which would read all-zero as green `active`, and
    // use a neutral idle glyph instead (never the yellow "needs attention" bell).
    if (rollup.blocked + rollup.idle + rollup.active === 0) {
      this.iconPath = new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('disabledForeground'));
      this.tooltip = 'No builders';
      return;
    }
    const { icon, color } = BUILDER_STATE_GLYPH[worstBuilderState(rollup)];
    this.iconPath = new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));
    this.tooltip = `${rollup.blocked} blocked · ${rollup.idle} waiting · ${rollup.active} active`;
  }
}
