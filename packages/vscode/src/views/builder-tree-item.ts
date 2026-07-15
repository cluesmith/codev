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

/**
 * Container header that rolls up idle **sibling** architects (never `main`) under
 * the architect axis (Issue 1182). Emitted only when ≥ 2 siblings are idle (zero
 * builders); a lone idle sibling keeps its own top-level row. Without this, a
 * workspace running several quiet siblings (reviewer, demos, ide, …) accumulates
 * childless rows (each ~22px) that push actual builder work below the fold — the
 * proportion cost the childless-visible fix (#1174) traded for never losing a row
 * mid-session. `main` is exempt: it is the always-present workspace home base, so
 * burying it behind a chevron is a bad trade for one row of space.
 *
 * Distinct from `BuilderGroupTreeItem` (which names one architect and opens its
 * terminal): this is a pure meta-container of N architects, so it binds NO
 * command — a header click only toggles expansion. Its children are the
 * individual idle-architect rows, each a childless `BuilderGroupTreeItem` that
 * still opens its own terminal. Default `Collapsed`; VSCode persists per-id
 * expansion off the stable `id`, so a user who expands it stays expanded until
 * they collapse. The rollup glyph is the same neutral idle glyph a childless
 * architect carries — idle architects have no builders, so there is no
 * attention state to roll up.
 */
export class IdleArchitectsGroupTreeItem extends vscode.TreeItem {
  constructor(count: number) {
    super(`Idle Architects (${count})`, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = 'idle-architects-group';
    this.contextValue = 'group-idle-architects';
    this.iconPath = new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('disabledForeground'));
    this.tooltip = `${count} idle architects · no builders attached`;
  }
}
