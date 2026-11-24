import * as vscode from 'vscode';
import { resolveAgentName } from '@cluesmith/codev-sdk/agent-names';
import type { OverviewCache } from './overview-data.js';
import type { BuilderTreeItem } from './builder-tree-item.js';
import type { BuilderFileTreeItem } from './builder-file-tree-item.js';
import type { BuilderDiffCache } from './builder-diff-cache.js';
import {
  type BuilderGrouping,
  type BuildersGroupBy,
  stageGrouping,
  areaGrouping,
  architectGrouping,
} from './builder-grouping.js';
import { ArchitectTreeBuilder, type AgentTarget } from './architect-tree.js';

// The row building moved to `architect-tree.ts` (Spec 1963) so the Cockpit can reuse it per
// workspace. Re-exported so existing importers of this module keep working unchanged.
export {
  orderForDisplay,
  partitionArchitectGroups,
  findParentNode,
  AccordionRowIds,
  type AgentTarget,
} from './architect-tree.js';

/**
 * Does a cycle entry address the currently-focused agent terminal (#1563)? The
 * agent-cycle commands use this to find their starting position in the roster.
 *
 * Architect names compare directly. Builder ids need a TOLERANT match: the roster
 * carries the sidebar's bare `OverviewBuilder.id`, while `TerminalManager` reports
 * the terminal's Tower-canonical id (`getActiveBuilderId`) — the two id spaces
 * `resolveAgentName` bridges via a tail-match. A plain `===` never matches those, so
 * the cycle would collapse to index 0 the moment focus sat on any builder (the bug
 * this guards). Tried both directions so it holds whichever id is the canonical
 * (longer) one.
 */
export function agentTargetIsFocused(
  t: AgentTarget,
  activeBuilderId: string | null,
  activeArchitectName: string | null,
): boolean {
  if (t.kind === 'architect') {
    return activeArchitectName !== null && t.name === activeArchitectName;
  }
  if (!activeBuilderId) { return false; }
  // Each `resolveAgentName` call passes a one-element candidate list, so the helper's
  // multi-match ambiguity return can't fire here — we only ask "does THIS id tail-match
  // that one?". `findIndex` then takes the first roster entry that matches, which is
  // unambiguous for the bare numeric / `<protocol>-<n>` ids builders carry (a `563`
  // that tail-matches both `pir-1563` and `air-563` doesn't arise in one workspace).
  return resolveAgentName(t.id, [{ id: activeBuilderId }]).builder !== null
    || resolveAgentName(activeBuilderId, [{ id: t.id }]).builder !== null;
}

/**
 * The order in which the agent-cycle command (`codev.focusNext/PreviousAgentTerminal`,
 * #1563) attempts targets: starting from the focused agent's neighbor in `direction`
 * and walking with wrap-around, each roster entry exactly once. Empty when the roster
 * is empty, or when its only agent is the focused one (nothing to cycle to) — the
 * command shows a status-bar hint then. A `currentIndex` of −1 (nothing focused) starts
 * at the first entry going forward, the last going back, whatever the roster size, so
 * a lone agent that isn't focused is opened rather than hinted at (#1748). The command
 * opens the first attempt that succeeds, so an entry that fails to open is simply the
 * one tried before the next — the walk can't wedge on it
 * (the focused agent itself is the final attempt, a no-op re-show if all others fail).
 * Pure and vscode-free, so the walk arithmetic is unit-testable without the extension.
 */
export function agentCycleAttemptOrder(
  order: readonly AgentTarget[],
  currentIndex: number,
  direction: 1 | -1,
): AgentTarget[] {
  if (order.length === 0) { return []; }
  if (order.length === 1 && currentIndex !== -1) { return []; }
  const attempts: AgentTarget[] = [];
  let index = currentIndex;
  for (let step = 0; step < order.length; step++) {
    if (index !== -1) {
      index = (index + direction + order.length) % order.length;
    } else if (direction === 1) {
      index = 0;
    } else {
      index = order.length - 1;
    }
    attempts.push(order[index]);
  }
  return attempts;
}

/**
 * Unified Builders view, with a switchable grouping axis (`codev.buildersGroupBy`,
 * #952), toggled via the title-bar button:
 *
 *  - **stage** (default — the action axis): groups are canonical lifecycle stages
 *    `SPECIFY → PLAN → IMPLEMENT → REVIEW → PR → VERIFIED` (+ trailing `UNKNOWN`),
 *    so the tree answers "where do I need to act?" — every builder at plan-approval
 *    is one group, everything waiting on a merge another. Each protocol's phase ids
 *    fold into this closed set via `groupByStage`, capping the tree at seven groups.
 *    Empty stages are hidden. Stage is *time-varying* — a builder relocates between
 *    groups as it advances. The row prefix carries the complementary axis: `[<area>]`.
 *  - **area** (the domain axis): groups are `area/*` labels (`groupByArea`), matching
 *    the Backlog tree's model and the pre-#952 behavior. The row prefix carries the
 *    complementary axis: `[<phase>]`. A single-`Uncategorized` result flattens to
 *    root rows (zero regression for unlabeled repos).
 *
 * In both modes blocked builders sort to the top with a gate icon and wait-time
 * suffix; active builders below.
 *
 * Group expand/collapse state is **not** persisted (#913): groups always render
 * Expanded on a fresh session, and VSCode's native per-id in-session memory
 * keeps any group the user collapses during the session collapsed until reload.
 * (Backlog still persists its group state — different lifecycle.)
 */
export class BuildersProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  // One grouping strategy per axis; `active()` picks the one matching the
  // `codev.buildersGroupBy` setting. Strategies no longer own a collapse-state
  // store (#913 dropped Builders-view group persistence).
  private readonly groupings: Record<BuildersGroupBy, BuilderGrouping>;
  // The rows themselves: built by the same `ArchitectTreeBuilder` the Cockpit
  // uses (Spec 1963), unscoped so every id is the one this view always had.
  private readonly tree: ArchitectTreeBuilder;

  constructor(
    cache: OverviewCache,
    diffCache: BuilderDiffCache,
  ) {
    this.groupings = {
      stage: stageGrouping(),
      area: areaGrouping(),
      architect: architectGrouping(),
    };
    this.tree = new ArchitectTreeBuilder({
      mode: 'act',
      scope: '',
      getData: () => cache.getData(),
      grouping: () => this.active(),
      diffCache,
    });
    cache.onDidChange(() => this.changeEmitter.fire());
  }

  /**
   * Accordion (#913): collapse every builder row except the one just expanded,
   * without touching group headers. The open row keeps its exact id (so VSCode
   * keeps it expanded); every other row is re-versioned to a fresh, never-seen
   * id, which VSCode renders with the provider's default `Collapsed` state.
   * Group headers carry no version suffix, so the accordion can't touch them.
   */
  collapseBuildersExcept(item: BuilderTreeItem): void {
    this.tree.keepOnlyOpen(item);
    this.changeEmitter.fire();
  }

  /**
   * The grouping strategy for the active axis, read from the
   * `codev.buildersGroupBy` setting (#952, extended to a third `architect` axis
   * in #1104). Defaults to `stage` — the action axis. Changed via the single
   * Agents title-bar group-by button: one of three `agentsCycleGroupFrom*`
   * commands is shown at a time (keyed off the current axis) and displays the
   * NEXT axis's icon/title, so clicking it advances the grouping. All per-axis
   * behavior (bucketing, row prefix,
   * flatten rule) lives on the returned strategy, so callers never branch on the
   * mode themselves. An unknown value falls back to `stage`.
   */
  private active(): BuilderGrouping {
    const mode = vscode.workspace
      .getConfiguration('codev')
      .get<BuildersGroupBy>('buildersGroupBy', 'stage');
    return this.groupings[mode] ?? this.groupings.stage;
  }

  /**
   * Force a re-render. Used by config-change listeners (e.g. the
   * file-view-as-tree toggle) that aren't reflected in the overview
   * cache but need the tree to redraw with the new setting applied.
   */
  refresh(): void {
    this.changeEmitter.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getParent(element: vscode.TreeItem): vscode.ProviderResult<vscode.TreeItem> {
    return this.tree.getParent(element);
  }

  getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    return this.tree.getChildren(element);
  }

  /** The changed-file row for `(builderId, relPath)`, for the active-file reveal (#1066). */
  findFileItem(builderId: string, relPath: string): Promise<BuilderFileTreeItem | undefined> {
    return this.tree.findFileItem(builderId, relPath);
  }

  /** The agent-cycle roster in render order (#1563). */
  agentCycleOrder(): AgentTarget[] {
    return this.tree.agentCycleOrder();
  }

  /** The row to select when the agent cycle lands on `target` (#1563). */
  revealTargetForAgent(target: AgentTarget): vscode.TreeItem | undefined {
    return this.tree.revealTargetForAgent(target);
  }
}

/**
 * The accordion's "is one builder already held open" guard (#913). Decides
 * whether an `onDidExpandElement` should collapse the other rows, and suppresses
 * the re-fire that `reveal({expand:true})` triggers for the row just opened.
 *
 * Resetting the guard on every toggle (`setEnabled`) is load-bearing: without
 * it, disabling the accordion, opening a second builder, then re-enabling would
 * leave the previously-open builder still recorded as open — so re-expanding it
 * would be skipped by the guard and the other rows would never collapse. After
 * a toggle the next expand of *any* builder, including the previously-open one,
 * must collapse the rest.
 */
export class AccordionGate {
  private openBuilderId: string | undefined;

  constructor(private enabled: boolean) {}

  /**
   * True if expanding `builderId` should collapse the other builder rows.
   * Returns false when the accordion is off or when this builder is already the
   * open one (the re-fire guard).
   */
  shouldCollapseOthers(builderId: string): boolean {
    if (!this.enabled) { return false; }
    if (builderId === this.openBuilderId) { return false; }
    this.openBuilderId = builderId;
    return true;
  }

  /** React to a config toggle; clears the open-builder guard either way. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.openBuilderId = undefined;
  }
}

/**
 * Injected effects for {@link runBuilderRowClick}, so the on/off branch is
 * unit-testable without a live terminal manager or tree view.
 */
export interface BuilderRowClickEffects {
  /** Open (or focus) the builder's terminal. Always runs on a row click. */
  openTerminal: () => unknown;
  /** Expand + reveal the row in the tree. Runs only when the setting is on. */
  expandRow: () => PromiseLike<unknown>;
}

/**
 * A single click on a builder row (#1743): always open the terminal, and expand
 * the row only when `codev.buildersClickExpands` is on (the default — behavior
 * unchanged). When off, the row's expand state is left untouched and only the
 * chevron toggles it. The expand runs via `reveal({expand:true})`, which fires
 * `onDidExpandElement` and lets the accordion collapse peers; the click setting
 * does not touch that chevron path. `expandRow` errors are swallowed — benign
 * when the row is gone mid-cleanup.
 */
export async function runBuilderRowClick(
  clickExpands: boolean,
  effects: BuilderRowClickEffects,
): Promise<void> {
  await effects.openTerminal();
  if (!clickExpands) { return; }
  try {
    await effects.expandRow();
  } catch {
    // Benign if the row is no longer present (e.g. mid-cleanup).
  }
}
