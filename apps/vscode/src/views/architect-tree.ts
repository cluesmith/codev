import * as vscode from 'vscode';
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { OverviewBuilder, OverviewData } from '@cluesmith/codev-types';
import { UNCATEGORIZED_AREA } from '@cluesmith/codev-sdk/constants';
import { deriveAttention, type AttentionSummary } from '@cluesmith/codev-sdk/builder-helpers';
import { builderWithWorktree, type OverviewBuilderWithWorktree } from '../builder-lookup.js';
import { readBuildersFileViewAsTree } from '../builders-config.js';
import { BuilderGroupTreeItem, BuilderTreeItem, IdleArchitectsGroupTreeItem } from './builder-tree-item.js';
import { BuilderFileTreeItem } from './builder-file-tree-item.js';
import { BuilderFolderTreeItem } from './builder-folder-tree-item.js';
import { buildFilePathTree, findParentNode, type FilePathNode } from './file-path-tree.js';

export { findParentNode };
import type { BuilderDiffCache } from './builder-diff-cache.js';
import { architectGrouping, type BuilderGroup, type BuilderGrouping } from './builder-grouping.js';
import {
  builderRowLabel,
  builderRowTooltip,
  classifyBuilderRow,
  gateIconFor,
  rollupGroupState,
  BUILDER_STATE_GLYPH,
  type BuilderState,
} from './builder-row.js';
import { OPEN_WORKSPACE_COMMAND, type WorkspaceTarget } from './tower.js';
import { describeWait } from './attention-format.js';

/**
 * Builder state → `contextValue` family prefix. Drives menu `when`-clause
 * scoping (Approve Gate inline only on `blocked-builder-*`; the rest apply to
 * all three families). Keyed by the same `BuilderState` the icon uses so a
 * row's menu and glyph never disagree.
 */
const CONTEXT_FAMILY: Record<BuilderState, 'blocked-builder' | 'awaiting-builder' | 'builder'> = {
  blocked: 'blocked-builder',
  'needs-input': 'awaiting-builder',
  idle: 'awaiting-builder',
  dead: 'awaiting-builder',
  active: 'builder',
};

/**
 * `contextValue`s of navigate-only rows (another workspace's architects, builders and Decisions
 * entry, Spec 1963). Deliberately outside every builder/architect menu's `viewItem` pattern, so none
 * of this window's row menus can attach to a row that does not belong to this window.
 */
export const REMOTE_CONTEXT = {
  architect: 'cockpit-remote-architect',
  builder: 'cockpit-remote-builder',
  idleArchitects: 'cockpit-remote-idle-architects',
  decisions: 'cockpit-remote-decisions',
} as const;

/**
 * Order builders for the Builders tree: three buckets, top-down.
 *  1. **blocked** (formal gate awaiting approval) — longest-waiting first.
 *  2. **waiting** (`classifyBuilderRow`: needs-input, idle or dead, from the
 *      served agent state or, without one, PTY silence past the threshold).
 *  3. **active** — everything else; overview order.
 * Blocked rows with no `blockedSince` sort last within the blocked group
 * (we don't pretend to know their wait time). Waiting and active
 * rows preserve Tower's source order within each bucket.
 */
export function orderForDisplay(builders: OverviewBuilder[], now: number = Date.now()): OverviewBuilder[] {
  const ms = (iso: string | null) => iso ? new Date(iso).getTime() : Infinity;
  const blocked = builders
    .filter(b => b.blocked)
    .sort((a, b) => ms(a.blockedSince) - ms(b.blockedSince));
  const rest = builders.filter(b => !b.blocked);
  const waiting = rest.filter(b => classifyBuilderRow(b, now) !== 'active');
  const active = rest.filter(b => classifyBuilderRow(b, now) === 'active');
  return [...blocked, ...waiting, ...active];
}

/**
 * One entry in the agent-terminal cycle (`codev.focusNext/PreviousAgentTerminal`,
 * #1563): either an architect (addressed by name) or a builder (addressed by id) —
 * the two openable agent kinds the Agents tree renders. Non-agent rows (group
 * headers on the stage/area axes, changed-file rows) and non-agent terminals (the
 * dev PTY, shells) are never `AgentTarget`s.
 */
export type AgentTarget =
  | { kind: 'architect'; name: string }
  | { kind: 'builder'; id: string };

/**
 * Split architect-axis groups into the top-level rows and the idle siblings, in
 * render order — the single ordering rule shared by `architectRootRows` (which
 * builds tree rows) and `agentCycleOrder` (which builds the cycle roster), so the
 * two cannot drift (the shared-function lesson, #818). `groups` arrives from
 * `architectGrouping` already `main`-first then alphabetical; `topLevel` keeps that
 * order (`main` and every populated sibling), and the idle siblings (zero builders,
 * not `main`) are peeled off to be rendered/cycled last.
 */
export function partitionArchitectGroups(
  groups: BuilderGroup[],
): { topLevel: BuilderGroup[]; idleSiblings: BuilderGroup[] } {
  const topLevel: BuilderGroup[] = [];
  const idleSiblings: BuilderGroup[] = [];
  for (const g of groups) {
    if (g.key !== 'main' && g.items.length === 0) {
      idleSiblings.push(g);
    } else {
      topLevel.push(g);
    }
  }
  return { topLevel, idleSiblings };
}

/** What an `ArchitectTreeBuilder` needs whatever its mode. */
interface ArchitectTreeCommonOptions {
  /** The overview the rows are built from (read on every render, never cached across one). */
  getData(): OverviewData | null;
  /**
   * Prefix for every row id, so two builders over different workspaces never collide. `''` for
   * the Agents view, which keeps every id byte-identical to the pre-refactor provider's.
   */
  scope: string;
  /**
   * Show the Tower view's attention signals on the rows they concern, from `deriveAttention` over
   * `getData()`: *N held* / *N queued* in builder-row descriptions, and an architect at a prompt
   * or with its agent dead as its row's wait text and glyph (Spec 1595). Off for the Agents view,
   * whose rows carry neither.
   */
  attention?: boolean;
}

/** Rows that act in this window: open terminals, expand to changed files, carry the source menus. */
export interface ArchitectTreeActOptions extends ArchitectTreeCommonOptions {
  mode: 'act';
  /** The grouping axis. The Agents view passes its active axis; the Cockpit, the architect axis. */
  grouping(): BuilderGrouping;
  diffCache: BuilderDiffCache;
}

/**
 * Rows of a workspace this window does not own: they show state and navigate to that workspace's
 * window. Always on the architect axis.
 */
export interface ArchitectTreeNavigateOptions extends ArchitectTreeCommonOptions {
  mode: 'navigate';
  /** The workspace a click opens (read per render, so a relabelled workspace stays current). */
  target(): WorkspaceTarget;
}

export type ArchitectTreeOptions = ArchitectTreeActOptions | ArchitectTreeNavigateOptions;

/**
 * Builds the Agents tree's rows — architect / stage / area group headers, builder rows, the
 * *Idle Architects* roll-up and changed-file children — for one workspace (Spec 1963).
 *
 * The Agents view holds one (scope `''`, mode `act`). The Cockpit holds one per active workspace,
 * scoped by workspace so ids never collide: this window's workspace acts, every other workspace
 * navigates. Per-view state — accordion row-id versioning and the builder → group parent map —
 * lives here, so each view (and each workspace inside the Cockpit) owns its own.
 *
 * Every row carries `scope`, so a caller holding several builders can route `getChildren` /
 * `getParent` and command handlers to the builder that made the row.
 */
export class ArchitectTreeBuilder {
  // Populated each time `rootRows()` returns groups; consulted by `getParent`
  // so the accordion's `reveal(builderItem)` can walk the parent chain in
  // grouping mode. Empty in the single-`Uncategorized` flatten case (area
  // mode only — builders are root again), so `getParent` returns `undefined`
  // and the accordion works unchanged on that branch.
  private readonly groupParentByBuilderId = new Map<string, BuilderGroupTreeItem>();
  // Accordion row-id versioning (#913) — see AccordionRowIds.
  private readonly rowIds: AccordionRowIds;
  // The architect axis, for navigate mode (which has no `grouping` option).
  private readonly architectAxis = architectGrouping();
  // `attention`: the summary and per-builder counts, derived once per overview object.
  private attentionCache: { data: OverviewData; summary: AttentionSummary; counts: Map<string, { held: number; queued: number }> } | null = null;

  constructor(private readonly options: ArchitectTreeOptions) {
    this.rowIds = new AccordionRowIds(options.scope);
  }

  get scope(): string {
    return this.options.scope;
  }

  get mode(): ArchitectTreeOptions['mode'] {
    return this.options.mode;
  }

  /**
   * Accordion (#913): hold `item` open at its exact id and re-version every
   * other builder row to a fresh, never-seen id, which VSCode renders with the
   * default `Collapsed` state. Group headers carry no version suffix, so the
   * accordion can't touch them. The caller fires its view's change event.
   */
  keepOnlyOpen(item: BuilderTreeItem): void {
    this.rowIds.keepOnly(item.builderId, item.id);
  }

  private grouping(): BuilderGrouping {
    if (this.options.mode === 'act') { return this.options.grouping(); }
    return this.architectAxis;
  }

  /** The active axis's groups over `data`, in display order. */
  private groupsOf(data: OverviewData, now: number): BuilderGroup[] {
    // The registered-architect roster (live sessions, main-first) — sourced from
    // the overview the builder already reads, no second fetch. Only the
    // architect axis consumes it, to emit a header for every architect including
    // childless ones (Issue 1174); the other axes ignore the arg. Guard `??` for
    // a pre-roster overview payload so `.map` never throws.
    const roster = (data.architects ?? []).map(a => a.name);
    return this.grouping().group(orderForDisplay(data.builders, now), roster);
  }

  /**
   * The children of `element`, or the root rows when it is `undefined`. `element` must be a row
   * this builder made (same `scope`); anything else is a routing bug and throws.
   */
  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (element === undefined) {
      return this.rootRows();
    }
    this.assertOwnRow(element);
    // Second level: a builder's changed files. VSCode only calls this for
    // an *expanded* builder, so collapsed builders cost no git. Navigate-mode
    // builder rows are leaves.
    if (element instanceof BuilderTreeItem) {
      if (this.options.mode !== 'act') { return []; }
      return this.fileChildren(element.builderId);
    }
    // Folder rows (tree-mode only) expand to their child folders/files.
    if (element instanceof BuilderFolderTreeItem) {
      return element.node.children!.map(child =>
        materialiseNode(element.builderId, element.worktreePath, element.baseRef, child, this.scope),
      );
    }
    // File rows are leaves.
    if (element instanceof BuilderFileTreeItem) {
      return [];
    }
    // The Idle Architects container (architect axis, Issue 1182) expands to the
    // individual idle-sibling architect rows.
    if (element instanceof IdleArchitectsGroupTreeItem) {
      return this.idleArchitectRows(Date.now());
    }
    // Group rows expand to their builders.
    if (element instanceof BuilderGroupTreeItem) {
      return this.rowsForGroup(element.groupName);
    }
    // Placeholders are leaves, so VSCode never asks for their children.
    throw new Error(`ArchitectTreeBuilder: no children for unrecognised row '${String(element.label)}'`);
  }

  /**
   * Throw when `element` is a row another builder made. A host holding several
   * builders (the Cockpit) routes each row by its `scope`; a row that reaches the
   * wrong builder would otherwise render that builder's rows, or answer another
   * workspace's parent, without any sign of the mistake.
   */
  private assertOwnRow(element: vscode.TreeItem): void {
    const scope = (element as { scope?: unknown }).scope;
    if (typeof scope === 'string' && scope !== this.scope) {
      throw new Error(`ArchitectTreeBuilder '${this.scope}': row of scope '${scope}' routed here`);
    }
  }

  // The accordion's `reveal(builderItem)` and the active-file sync's
  // `reveal(fileItem)` (#1066) both need the parent chain.
  //  - Builder rows return their cached group (or undefined in the
  //    single-Uncategorized flatten case — VSCode treats them as roots).
  //  - File / folder rows reconstruct their chain: file → folder(s) (tree
  //    mode) → builder → group. Async because tree-mode reconstruction reads
  //    the (cached) diff to rebuild the folder hierarchy; VSCode's `getParent`
  //    accepts a Thenable.
  //  - Group rows themselves are roots, except an idle sibling folded into the
  //    Idle Architects container.
  // A root answer (`undefined`) is root *within this builder*: a host that nests
  // the builder's rows under its own nodes bridges from there.
  getParent(element: vscode.TreeItem): vscode.ProviderResult<vscode.TreeItem> {
    this.assertOwnRow(element);
    if (element instanceof BuilderTreeItem) {
      // The group map is filled when the root rows render. A host that nests these
      // rows under a node VS Code has not expanded yet (the Cockpit's workspace row)
      // asks before that render, so build the root rows now rather than answer
      // "root" for a builder that sits under an architect.
      if (!this.groupParentByBuilderId.has(element.builderId)) { this.rootRows(); }
      return this.groupParentByBuilderId.get(element.builderId);
    }
    if (element instanceof BuilderFileTreeItem || element instanceof BuilderFolderTreeItem) {
      return this.parentForFileNode(element);
    }
    if (element instanceof BuilderGroupTreeItem) {
      // An idle-sibling architect header is rendered INSIDE the collapsed "Idle
      // Architects" container (#1182), not at root, so return that container as its
      // parent — otherwise `reveal` treats the header as a root, never expands the
      // container, and can't select the row (#1563). Top-level headers (main,
      // populated siblings, a lone idle sibling) have no parent.
      return this.idleArchitectsContainerParent(element.groupName);
    }
    // Other group rows (the container itself, etc.) are roots.
    return undefined;
  }

  /**
   * The "Idle Architects" container that renders `architectName` as a child, or
   * `undefined` when the architect is not a folded idle sibling (wrong axis, fewer
   * than two idle siblings so it renders top-level, or a populated / `main`
   * architect). The returned container carries the stable `idle-architects-group`
   * id, so `reveal` matches the rendered container and expands it (#1563).
   */
  private idleArchitectsContainerParent(architectName: string): IdleArchitectsGroupTreeItem | undefined {
    const data = this.options.getData();
    if (!data) { return undefined; }
    if (this.grouping().id !== 'architect') { return undefined; }
    const { idleSiblings } = partitionArchitectGroups(this.groupsOf(data, Date.now()));
    // Fewer than two idle siblings → the lone one renders as its own top-level row.
    if (idleSiblings.length < 2) { return undefined; }
    if (!idleSiblings.some(g => g.key === architectName)) { return undefined; }
    return this.makeIdleContainer(idleSiblings.length);
  }

  /**
   * The builder with this id, but only if it has a worktree on record — the
   * shared precondition for the changed-file methods (`fileChildren`,
   * `parentForFileNode`, `findFileItem`). The return type narrows
   * `worktreePath` to a non-null `string`, so callers can pass it to
   * `diffCache.getDiff` without re-guarding.
   */
  private builderWithWorktree(builderId: string): OverviewBuilderWithWorktree | undefined {
    return builderWithWorktree(this.options.getData(), builderId);
  }

  /**
   * Reconstruct the parent of a file or folder row so `reveal` can build the
   * chain up to the root (#1066). Reconstruction (not a getChildren-populated
   * map) is required because `reveal` walks parents while the subtree is still
   * collapsed — `getChildren` for a file only runs once its builder is expanded.
   *
   *  - **Flat-list mode**: a file's parent is the builder row directly.
   *  - **Tree mode**: rebuild the compacted folder tree (same `buildFilePathTree`
   *    the rows were rendered from, off the 15s-TTL diff cache) and return the
   *    enclosing folder row, or the builder row when the node sits at top level.
   *
   * The reconstructed builder row carries the current accordion-versioned id
   * (`makeBuilderRow` → `rowIds.idFor`), and folder rows carry the same
   * `<scope><builderId>::folder::<fullPath>` id `materialiseNode` produces, so the
   * chain matches what `getChildren` renders.
   */
  private async parentForFileNode(
    element: BuilderFileTreeItem | BuilderFolderTreeItem,
  ): Promise<vscode.TreeItem | undefined> {
    if (this.options.mode !== 'act') { return undefined; }
    const builderId = element.builderId;
    const builder = this.builderWithWorktree(builderId);
    if (!builder) { return undefined; }
    const builderRow = this.makeBuilderRow(builder, Date.now());

    if (!readBuildersFileViewAsTree()) {
      // Flat list: folders don't exist here, so any file's parent is the builder.
      return builderRow;
    }

    const result = await this.options.diffCache.getDiff(builderId, builder.worktreePath);
    if (result.error) { return builderRow; }
    const targetPath = element instanceof BuilderFolderTreeItem
      ? element.node.fullPath
      : element.plan.resourcePath;
    const parentNode = findParentNode(buildFilePathTree(result.files), targetPath);
    if (!parentNode) {
      // Top-level node: parent is the builder row.
      return builderRow;
    }
    return new BuilderFolderTreeItem(builderId, builder.worktreePath, result.baseRef, parentNode, this.scope);
  }

  /**
   * Build the `BuilderFileTreeItem` matching `(builderId, relPath)` so the
   * active-file sync can hand it to the view's `reveal` (#1066). Returns
   * `undefined` if the builder or file is no longer present, or in navigate
   * mode (no changed-file rows). The constructed item's id matches the rendered
   * row, so `reveal` + `getParent` locate and highlight the correct row (incl.
   * the right builder when two builders share a relative path).
   */
  async findFileItem(builderId: string, relPath: string): Promise<BuilderFileTreeItem | undefined> {
    if (this.options.mode !== 'act') { return undefined; }
    const builder = this.builderWithWorktree(builderId);
    if (!builder) { return undefined; }
    const result = await this.options.diffCache.getDiff(builderId, builder.worktreePath);
    if (result.error) { return undefined; }
    const file = result.files.find(f => f.plan.resourcePath === relPath);
    if (!file) { return undefined; }
    return new BuilderFileTreeItem(builderId, builder.worktreePath, result.baseRef, file.change, file.plan, this.scope);
  }

  /** Root rows for the active axis. Resets the builder → group parent map. */
  rootRows(): vscode.TreeItem[] {
    this.groupParentByBuilderId.clear();

    const data = this.options.getData();
    if (!data) {
      return [];
    }

    const now = Date.now();
    const grouping = this.grouping();
    const groups = this.groupsOf(data, now);

    // A repo that doesn't use `area/*` labels yields a single `Uncategorized`
    // group; in area mode its header adds no information, so flatten to root rows
    // — zero visual regression for unlabeled repos. Stage and architect modes
    // opt out of this (their lone group always carries information).
    if (grouping.flattenLoneUncategorized && groups.length === 1 && groups[0].key === UNCATEGORIZED_AREA) {
      return groups[0].items.map(b => this.makeBuilderRow(b, now));
    }

    // The architect axis rolls idle siblings into an "Idle Architects" container
    // (Issue 1182), so it renders through its own method. Stage/area render every
    // group as its own header.
    if (grouping.id === 'architect') {
      return this.architectRootRows(groups, now);
    }
    // Populated groups render Expanded (#913) — no persisted state. VSCode's
    // native per-id memory keeps a user-collapsed group collapsed for the
    // rest of the session; on a fresh session this default applies again.
    // Stage/area groups always hold ≥1 builder (no empty groups on these axes),
    // so they never carry a command — they name no launchable entity.
    return groups.map(g => this.makeGroupRow(g, now, false));
  }

  /**
   * Root rows for the architect axis (Issue 1182). `main` and every populated
   * sibling render as their own top-level group (unchanged from #1174); idle
   * siblings (zero builders, not `main`) roll up under a single collapsed
   * "Idle Architects" container — but only when ≥ 2 are idle. A lone idle
   * sibling keeps its own row (the group would save no space for one row and
   * only adds a click). Ordering: `main` first, then populated siblings, then
   * the idle container / lone idle sibling at the bottom — "primary work first,
   * roster second."
   *
   * `groups` arrives from `architectGrouping` already ordered `main`-first then
   * the rest alphabetically. Iterating it preserves that order for the rows that
   * stay top-level; the idle siblings are peeled off and re-emitted last.
   *
   * `main` is always its own row regardless of builder count: it is the
   * always-present workspace home base (created by `launchInstance` on any
   * workspace; every sibling is opt-in via `add-architect`), so burying it
   * behind a chevron is a bad trade for one row of vertical space.
   */
  private architectRootRows(groups: BuilderGroup[], now: number): vscode.TreeItem[] {
    const { topLevel, idleSiblings } = partitionArchitectGroups(groups);
    const rows: vscode.TreeItem[] = topLevel.map(g => this.makeGroupRow(g, now, true));
    if (idleSiblings.length >= 2) {
      rows.push(this.makeIdleContainer(idleSiblings.length));
    } else {
      // 0 → nothing; 1 → the lone idle sibling renders as its own top-level row.
      for (const g of idleSiblings) {
        rows.push(this.makeGroupRow(g, now, true));
      }
    }
    return rows;
  }

  /**
   * The agent-terminal cycle roster (#1563), flattened top-to-bottom in the SAME
   * order the tree renders, so `codev.focusNext/PreviousAgentTerminal` mirror
   * the sidebar exactly and stay grouping-aware. Built from the same primitives the
   * renderer uses — `orderForDisplay` + the active grouping strategy — so there is no
   * parallel ordering to drift (#818).
   *
   * The roster is axis-dependent, matching what each axis actually renders:
   *  - **stage / area** (incl. the lone-`Uncategorized` flatten): only builder rows
   *    are agents; architects render no rows on these axes, so they are not cycled.
   *  - **architect**: architect headers are first-class agents (their rows carry the
   *    open-terminal command), interleaved with their builders in top-level order via
   *    the shared `partitionArchitectGroups`; idle siblings (zero builders) render —
   *    and so cycle — last.
   *
   * Non-agent terminals (the dev PTY, shells) are never in the roster because only
   * architects and builders appear here. Empty in navigate mode: the cycle opens
   * terminals through this window's `TerminalManager`, and another workspace's
   * agents are not there.
   */
  agentCycleOrder(): AgentTarget[] {
    if (this.options.mode !== 'act') { return []; }
    const data = this.options.getData();
    if (!data) { return []; }
    const groups = this.groupsOf(data, Date.now());

    if (this.grouping().id !== 'architect') {
      return groups.flatMap(g => g.items.map((b): AgentTarget => ({ kind: 'builder', id: b.id })));
    }

    // Emit each architect header followed by its builders, in render order:
    // top-level groups first, then the idle siblings last (the "Idle Architects"
    // container at the bottom). Idle siblings carry zero builders by construction, so
    // the inner loop is simply empty for them — no separate pass needed.
    const { topLevel, idleSiblings } = partitionArchitectGroups(groups);
    const architectOrder = [...topLevel, ...idleSiblings];
    const targets: AgentTarget[] = [];
    for (const g of architectOrder) {
      targets.push({ kind: 'architect', name: g.key });
      for (const b of g.items) { targets.push({ kind: 'builder', id: b.id }); }
    }
    return targets;
  }

  /**
   * The tree item to `reveal({ select: true })` so the sidebar selection follows the
   * agent-cycle commands (#1563) the same way a row click highlights the clicked row.
   * Returns `undefined` when the agent is no longer in the overview, and always in
   * navigate mode: the cycle walks this window's agents, which navigate rows are not.
   *
   *  - **builder**: the same versioned row `makeBuilderRow` renders, so `reveal` matches
   *    it by id and expands its group ancestor to bring it into view.
   *  - **architect**: a header carrying the stable `builder-group:<name>` id, which
   *    matches the rendered architect header. For an idle-sibling architect folded into
   *    the "Idle Architects" container, `getParent` returns that container (via
   *    `idleArchitectsContainerParent`), so `reveal` expands the container and selects
   *    the row rather than leaving it hidden.
   */
  revealTargetForAgent(target: AgentTarget): vscode.TreeItem | undefined {
    if (this.options.mode !== 'act') { return undefined; }
    const data = this.options.getData();
    if (!data) { return undefined; }
    if (target.kind === 'builder') {
      const builder = data.builders.find(b => b.id === target.id);
      if (!builder) { return undefined; }
      return this.makeBuilderRow(builder, Date.now());
    }
    // Architect header: only the id is consulted by `reveal`, so the count / state
    // passed here are placeholders — they never render.
    return new BuilderGroupTreeItem(
      target.name, 0, vscode.TreeItemCollapsibleState.None, { blocked: 0, idle: 0, active: 0 }, this.scope);
  }

  /**
   * The individual idle-sibling architect rows shown when the "Idle Architects"
   * container is expanded (Issue 1182). Each is a childless
   * `BuilderGroupTreeItem` — the same leaf-like `(0)` row #1174 renders at top
   * level — carrying its own click command, so clicking a name inside the group
   * opens that architect's terminal (or, navigating, its workspace). Recomputed
   * from the overview (not cached from `rootRows`) so it stays correct across
   * overview ticks; harmlessly returns `[]` if the axis is no longer `architect`.
   */
  private idleArchitectRows(now: number): vscode.TreeItem[] {
    const data = this.options.getData();
    if (!data) { return []; }
    if (this.grouping().id !== 'architect') { return []; }
    return this.groupsOf(data, now)
      .filter(g => g.key !== 'main' && g.items.length === 0)
      .map(g => this.makeGroupRow(g, now, true));
  }

  /** The "Idle Architects (N)" container (Issue 1182). */
  private makeIdleContainer(count: number): IdleArchitectsGroupTreeItem {
    const container = new IdleArchitectsGroupTreeItem(count, this.scope);
    if (this.options.mode === 'navigate') {
      container.contextValue = REMOTE_CONTEXT.idleArchitects;
    }
    return container;
  }

  /**
   * Build one group header row. `isArchitectAxis` headers get a
   * click-to-open-terminal `command` (#1108): the architect is first-class in
   * this mode, so its header matches the builder-row affordance (row click opens
   * the terminal; the chevron still toggles expand/collapse — VSCode routes the
   * two gestures independently). A childless architect group (Issue 1174) has no
   * builders to expand into, so it renders as a leaf-like row (`None`) rather
   * than an empty accordion; the command still fires on the row body. Populated
   * groups render Expanded (#913). Stage/area headers stay command-less
   * containers. Registers each builder's parent group for `getParent`.
   *
   * A scoped (Cockpit) architect row names `main` vs a sibling in its
   * `contextValue`, so a menu entry can tell them apart. A navigate-mode
   * architect row opens its workspace's window instead of a terminal.
   */
  private makeGroupRow(g: BuilderGroup, now: number, isArchitectAxis: boolean): BuilderGroupTreeItem {
    let collapsibleState: vscode.TreeItemCollapsibleState;
    if (g.items.length === 0) {
      collapsibleState = vscode.TreeItemCollapsibleState.None;
    } else {
      collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
    }
    const groupItem = new BuilderGroupTreeItem(
      g.key,
      g.items.length,
      collapsibleState,
      rollupGroupState(g.items, now),
      this.scope,
    );
    if (this.options.mode === 'navigate') {
      const target = this.options.target();
      groupItem.contextValue = REMOTE_CONTEXT.architect;
      groupItem.tooltip = navigateTooltip(String(groupItem.tooltip ?? ''), target);
      groupItem.command = openWorkspaceCommand(target);
    } else if (isArchitectAxis) {
      // The `g.key` (architect name; null owners folded into `main` by
      // architectGrouping) is the optional name arg `codev.openArchitectTerminal`
      // already accepts; it warns gracefully on a stale owner not in the roster.
      groupItem.command = {
        command: 'codev.openArchitectTerminal',
        title: 'Open Architect Terminal',
        arguments: [g.key],
      };
      if (this.scope !== '') {
        groupItem.contextValue = g.key === 'main' ? 'cockpit-architect-main' : 'cockpit-architect-sibling';
      }
    }
    this.applyArchitectAttention(groupItem, g.key);
    for (const b of g.items) {
      this.groupParentByBuilderId.set(b.id, groupItem);
    }
    return groupItem;
  }

  /**
   * With `attention` on, an architect at a prompt or with its agent dead shows it on its own row:
   * the wait text (the Tower view's attention-row text) as the description and its glyph as the
   * icon. Only architect-axis rows name an architect, so other axes' headers never match.
   */
  private applyArchitectAttention(row: BuilderGroupTreeItem, architectName: string): void {
    if (this.grouping().id !== 'architect') { return; }
    const summary = this.attentionSummary();
    if (!summary) { return; }
    const waiting = summary.architects.find(a => a.architect === architectName);
    if (!waiting) { return; }
    const glance = describeWait(waiting.state, waiting.since);
    row.description = glance.text;
    if (glance.color) {
      row.iconPath = new vscode.ThemeIcon(glance.icon, new vscode.ThemeColor(glance.color));
    } else {
      row.iconPath = new vscode.ThemeIcon(glance.icon);
    }
  }

  private rowsForGroup(key: string): vscode.TreeItem[] {
    const data = this.options.getData();
    if (!data) { return []; }

    const now = Date.now();
    const group = this.groupsOf(data, now).find(g => g.key === key);
    if (!group) { return []; }

    return group.items.map(b => this.makeBuilderRow(b, now));
  }

  private makeBuilderRow(b: OverviewBuilder, now: number): BuilderTreeItem {
    // Classify once; the state drives the label, the tooltip, the contextValue
    // family (menu scoping) and the icon.
    const state = classifyBuilderRow(b, now);
    const item = new BuilderTreeItem(b.id, builderRowLabel(b, state, now, this.grouping().rowPrefix(b)), this.scope);
    // Versioned id (#913). The base `b.id` is stable (not the churning label) so
    // VSCode preserves a row's expansion across the frequent overview-poll
    // refreshes; the `#<version>` suffix is the accordion lever (see
    // AccordionRowIds). Group ids carry no suffix, so the accordion can't touch
    // them.
    item.id = this.rowIds.idFor(b.id);
    // Icon: the shared per-state glyph (single source of truth in
    // builder-row.ts). A blocked row overrides the shape with the gate-specific
    // `gateIconFor` codicon while keeping the shared warning color.
    const { icon, color } = BUILDER_STATE_GLYPH[state];
    let iconName = icon;
    if (state === 'blocked') { iconName = gateIconFor(b.blockedGate); }
    item.iconPath = new vscode.ThemeIcon(iconName, new vscode.ThemeColor(color));
    const counts = this.attentionCountsText(b.id);
    if (counts) { item.description = counts; }

    if (this.options.mode === 'navigate') {
      // Another workspace's builder: a leaf (no changed files) whose click opens
      // that workspace's window, where the row is fully actionable.
      const target = this.options.target();
      item.collapsibleState = vscode.TreeItemCollapsibleState.None;
      item.tooltip = navigateTooltip(builderRowTooltip(b, state), target);
      item.contextValue = REMOTE_CONTEXT.builder;
      item.command = openWorkspaceCommand(target);
      return item;
    }

    // Expandable so the second-level changed-files list can hang off it.
    // The row keeps its open-terminal command (single click); the chevron
    // toggles the file list.
    item.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
    // A plain string, never a MarkdownString: the needs-input summary renders literally (SC19).
    item.tooltip = builderRowTooltip(b, state);
    // contextValue encodes the row's state-family + protocol so menus
    // can scope by either (Approve Gate inline only on
    // blocked-builder-*; everything else applies to all three
    // families). The optional `-review` suffix signals that the
    // builder has committed a review file on disk — the
    // `codev.viewReviewFile` menu entry's `when` clause keys off it so
    // PIR rows hide the entry until the review phase produces the file.
    const protocol = b.protocol || 'unknown';
    const reviewSuffix = builderHasReviewFile(b) ? '-review' : '';
    item.contextValue = `${CONTEXT_FAMILY[state]}-${protocol}${reviewSuffix}`;
    // The row click runs `codev.openBuilderRow` — a wrapper that opens the
    // builder terminal and, when `codev.buildersClickExpands` is on (the
    // default), also expands the row (the file list). Pass the item itself so
    // the handler can call the view's `reveal(...)` against this row. Other
    // callers (terminal-link clicks, etc.) still use `codev.openBuilderById`
    // directly with just the id and don't trigger expansion.
    item.command = {
      command: 'codev.openBuilderRow',
      title: 'Open Builder Terminal',
      arguments: [item],
    };
    return item;
  }

  /**
   * The attention summary of `getData()` when `attention` is on, else `undefined`. Derived once per
   * overview object, with the per-builder held / queued counts alongside.
   */
  private attentionOf(): { summary: AttentionSummary; counts: Map<string, { held: number; queued: number }> } | undefined {
    if (!this.options.attention) { return undefined; }
    const data = this.options.getData();
    if (!data) { return undefined; }
    if (this.attentionCache?.data !== data) {
      const summary = deriveAttention(data);
      const counts = new Map<string, { held: number; queued: number }>();
      const entry = (id: string) => {
        let found = counts.get(id);
        if (!found) {
          found = { held: 0, queued: 0 };
          counts.set(id, found);
        }
        return found;
      };
      for (const item of summary.heldMail) { entry(item.builderId).held = item.count; }
      for (const item of summary.queuedFeedback) { entry(item.builderId).queued = item.count; }
      this.attentionCache = { data, summary, counts };
    }
    return this.attentionCache;
  }

  private attentionSummary(): AttentionSummary | undefined {
    return this.attentionOf()?.summary;
  }

  /**
   * `N held · N queued` for a builder row when `attention` is on, or `undefined`
   * when it is off or the builder has neither. The counts are the Tower view's
   * own (`deriveAttention`).
   */
  private attentionCountsText(builderId: string): string | undefined {
    const attention = this.attentionOf();
    if (!attention) { return undefined; }
    const found = attention.counts.get(builderId);
    if (!found) { return undefined; }
    const parts: string[] = [];
    if (found.held > 0) { parts.push(`${found.held} held`); }
    if (found.queued > 0) { parts.push(`${found.queued} queued`); }
    return parts.join(' · ');
  }

  /**
   * Changed-file rows for one builder, rendered as a flat list or a
   * folder tree depending on the `codev.buildersFileViewAsTree` setting.
   * The diff data and the leaf shape (BuilderFileTreeItem) are identical
   * in both modes — only the grouping around the leaves differs.
   */
  private async fileChildren(builderId: string): Promise<vscode.TreeItem[]> {
    if (this.options.mode !== 'act') { return []; }
    const builder = this.builderWithWorktree(builderId);
    if (!builder) {
      return [placeholder('No worktree on record')];
    }

    const result = await this.options.diffCache.getDiff(builderId, builder.worktreePath);
    if (result.error) {
      const row = placeholder('Diff unavailable');
      row.tooltip = result.error;
      return [row];
    }
    if (result.files.length === 0) {
      return [placeholder('No changes yet')];
    }

    if (readBuildersFileViewAsTree()) {
      // Tree mode: group by folder, compact single-child folder chains.
      // Top-level nodes may be folders or root-level files (e.g. README).
      return buildFilePathTree(result.files).map(node =>
        materialiseNode(builderId, builder.worktreePath, result.baseRef, node, this.scope),
      );
    }
    // List mode (today's behaviour): flat, one row per changed file.
    return result.files.map(
      f => new BuilderFileTreeItem(builderId, builder.worktreePath, result.baseRef, f.change, f.plan, this.scope),
    );
  }
}

/** The click command of a navigate-only row: open its workspace (the Tower view's action). */
export function openWorkspaceCommand(target: WorkspaceTarget): vscode.Command {
  return { command: OPEN_WORKSPACE_COMMAND, title: 'Open Workspace', arguments: [target] };
}

/** A navigate-only row's tooltip: what the row shows, then which workspace a click opens. */
export function navigateTooltip(base: string, target: WorkspaceTarget): string {
  const where = `In workspace ${target.name}. Click to open its window, where this row can act.`;
  if (base === '') { return where; }
  return `${base}\n${where}`;
}

/**
 * Render one tree-mode node as either a folder row (if it has children)
 * or a file row (if it carries a leaf). Folders carry the worktreePath
 * + baseRef forward so the renderer can construct file children on
 * subsequent expansion without re-fetching from the diff cache.
 */
function materialiseNode(
  builderId: string,
  worktreePath: string,
  baseRef: string,
  node: FilePathNode,
  scope: string,
): vscode.TreeItem {
  if (node.children) {
    return new BuilderFolderTreeItem(builderId, worktreePath, baseRef, node, scope);
  }
  // Leaf: must have a file (folder-without-children shouldn't be reachable
  // from buildFilePathTree, but the type allows it — guard defensively).
  if (!node.file) {
    return placeholder(node.name);
  }
  return new BuilderFileTreeItem(builderId, worktreePath, baseRef, node.file.change, node.file.plan, scope);
}


/**
 * Sync-check whether a builder has committed a review file on disk.
 *
 * Mirrors the prefix filter in `commands/view-artifact.ts`: a file
 * counts if it lives in `<worktree>/codev/reviews/`, ends in `.md`, and
 * either starts with `<id>-` or is exactly `<id>.md`. Used by the
 * builder-row builder to suffix `contextValue` with `-review` so
 * PIR rows can hide `codev.viewReviewFile` until the review phase emits
 * the file (non-PIR protocols always show the entry — they fall back to
 * the missing-file toast in `view-artifact.ts`).
 *
 * One `readdirSync` per builder per render — the reviews dir is small,
 * local, and only inspected when overview data changes. Cheaper than
 * the diff-cache work the row triggers on expansion.
 */
function builderHasReviewFile(b: OverviewBuilder): boolean {
  if (!b.worktreePath) { return false; }
  const dir = resolve(b.worktreePath, 'codev/reviews');
  if (!existsSync(dir)) { return false; }
  const prefix = `${b.id}-`;
  try {
    return readdirSync(dir).some(
      f => f.endsWith('.md') && (f.startsWith(prefix) || f === `${b.id}.md`),
    );
  } catch {
    return false;
  }
}

/**
 * Builder-row id versioning for the accordion (#913). VSCode has no "collapse
 * this row" API and replays its remembered expand-state for any id it has seen,
 * so the only way to force a row collapsed is to render it under a never-seen
 * id. Every row id is `<prefix><builderId>#<version>`; bumping the version
 * (`keepOnly`) hands every row a fresh — hence collapsed — id, except the one
 * being held open, which keeps the exact id it was clicked at so VSCode keeps it
 * expanded.
 *
 * The open row's id is stored verbatim (not reconstructed from a number), so a
 * render that lands between a bump and the next click can't leave the open row
 * pointing at a stale version. `prefix` is the builder's scope (`''` for the
 * Agents view, so its ids are unchanged).
 */
export class AccordionRowIds {
  private version = 0;
  private openBuilderId: string | undefined;
  private openRowId: string | undefined;

  constructor(private readonly prefix: string = '') {}

  /** The id to render for `builderId` this pass. */
  idFor(builderId: string): string {
    if (builderId === this.openBuilderId && this.openRowId) {
      return this.openRowId;
    }
    return `${this.prefix}${builderId}#${this.version}`;
  }

  /** Hold `builderId` open at its current `rowId`; re-version everyone else. */
  keepOnly(builderId: string, rowId: string | undefined): void {
    this.openBuilderId = builderId;
    this.openRowId = rowId;
    this.version += 1;
  }
}

/** Non-clickable informational leaf (no worktree / no changes / error). */
function placeholder(label: string): vscode.TreeItem {
  const item = new vscode.TreeItem(label);
  item.contextValue = 'builder-file-none';
  item.iconPath = new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('disabledForeground'));
  return item;
}
