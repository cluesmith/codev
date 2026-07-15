import * as vscode from 'vscode';
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { OverviewBuilder } from '@cluesmith/codev-types';
import { isIdleWaiting } from '@cluesmith/codev-core/builder-helpers';
import { UNCATEGORIZED_AREA } from '@cluesmith/codev-core/constants';
import type { OverviewCache } from './overview-data.js';
import { builderWithWorktree, type OverviewBuilderWithWorktree } from '../builder-lookup.js';
import { readBuildersFileViewAsTree } from '../builders-config.js';
import { BuilderGroupTreeItem, BuilderTreeItem } from './builder-tree-item.js';
import { BuilderFileTreeItem } from './builder-file-tree-item.js';
import { BuilderFolderTreeItem } from './builder-folder-tree-item.js';
import { buildFilePathTree, type FilePathNode } from './file-path-tree.js';
import type { BuilderDiffCache } from './builder-diff-cache.js';
import {
  type BuilderGrouping,
  type BuildersGroupBy,
  stageGrouping,
  areaGrouping,
  architectGrouping,
} from './builder-grouping.js';
import {
  builderRowLabel,
  gateIconFor,
  rollupGroupState,
  BUILDER_STATE_GLYPH,
  type BuilderState,
} from './builder-row.js';

/**
 * Builder state → `contextValue` family prefix. Drives menu `when`-clause
 * scoping (Approve Gate inline only on `blocked-builder-*`; the rest apply to
 * all three families). Keyed by the same `BuilderState` the icon uses so a
 * row's menu and glyph never disagree.
 */
const CONTEXT_FAMILY: Record<BuilderState, 'blocked-builder' | 'awaiting-builder' | 'builder'> = {
  blocked: 'blocked-builder',
  idle: 'awaiting-builder',
  active: 'builder',
};

/**
 * Order builders for the Builders tree: three buckets, top-down.
 *  1. **blocked** (formal gate awaiting approval) — longest-waiting first.
 *  2. **idle waiting** (`isIdleWaiting`) — agent silent past the threshold,
 *      likely paused at a clarifying question.
 *  3. **active** — everything else; overview order.
 * Blocked rows with no `blockedSince` sort last within the blocked group
 * (we don't pretend to know their wait time). Idle-waiting and active
 * rows preserve Tower's source order within each bucket.
 */
export function orderForDisplay(builders: OverviewBuilder[], now: number = Date.now()): OverviewBuilder[] {
  const ms = (iso: string | null) => iso ? new Date(iso).getTime() : Infinity;
  const blocked = builders
    .filter(b => b.blocked)
    .sort((a, b) => ms(a.blockedSince) - ms(b.blockedSince));
  const idleWaiting = builders.filter(b => !b.blocked && isIdleWaiting(b, now));
  const active = builders.filter(b => !b.blocked && !isIdleWaiting(b, now));
  return [...blocked, ...idleWaiting, ...active];
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
  // Populated each time `rootChildren()` returns groups; consulted by
  // `getParent` so the accordion's `reveal(builderItem)` can walk the
  // parent chain in grouping mode. Empty in the single-`Uncategorized`
  // flatten case (area mode only — builders are root again), so `getParent`
  // returns `undefined` and the accordion works unchanged on that branch.
  private groupParentByBuilderId = new Map<string, BuilderGroupTreeItem>();
  // Accordion row-id versioning (#913) — see AccordionRowIds.
  private readonly rowIds = new AccordionRowIds();

  constructor(
    private cache: OverviewCache,
    private readonly diffCache: BuilderDiffCache,
  ) {
    this.groupings = {
      stage: stageGrouping(),
      area: areaGrouping(),
      architect: architectGrouping(),
    };
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
    this.rowIds.keepOnly(item.builderId, item.id);
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

  // The accordion's `reveal(builderItem)` and the active-file sync's
  // `reveal(fileItem)` (#1066) both need the parent chain.
  //  - Builder rows return their cached group (or undefined in the
  //    single-Uncategorized flatten case — VSCode treats them as roots).
  //  - File / folder rows reconstruct their chain: file → folder(s) (tree
  //    mode) → builder → group. Async because tree-mode reconstruction reads
  //    the (cached) diff to rebuild the folder hierarchy; VSCode's `getParent`
  //    accepts a Thenable.
  //  - Group rows themselves are roots.
  getParent(element: vscode.TreeItem): vscode.ProviderResult<vscode.TreeItem> {
    if (element instanceof BuilderTreeItem) {
      // Builder → its group node (or undefined in the lone-Uncategorized flatten
      // case — VSCode treats those builders as roots).
      return this.groupParentByBuilderId.get(element.builderId);
    }
    if (element instanceof BuilderFileTreeItem || element instanceof BuilderFolderTreeItem) {
      return this.parentForFileNode(element);
    }
    // Group rows are roots.
    return undefined;
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
   * `<builderId>::folder::<fullPath>` id `materialiseNode` produces, so the
   * chain matches what `getChildren` renders.
   */
  /**
   * The builder with this id, but only if it has a worktree on record — the
   * shared precondition for the changed-file methods (`fileChildren`,
   * `parentForFileNode`, `findFileItem`). The return type narrows
   * `worktreePath` to a non-null `string`, so callers can pass it to
   * `diffCache.getDiff` without re-guarding.
   */
  private builderWithWorktree(builderId: string): OverviewBuilderWithWorktree | undefined {
    return builderWithWorktree(this.cache.getData(), builderId);
  }

  private async parentForFileNode(
    element: BuilderFileTreeItem | BuilderFolderTreeItem,
  ): Promise<vscode.TreeItem | undefined> {
    const builderId = element.builderId;
    const builder = this.builderWithWorktree(builderId);
    if (!builder) { return undefined; }
    const builderRow = this.makeBuilderRow(builder, Date.now());

    if (!this.viewAsTree()) {
      // Flat list: folders don't exist here, so any file's parent is the builder.
      return builderRow;
    }

    const result = await this.diffCache.getDiff(builderId, builder.worktreePath);
    if (result.error) { return builderRow; }
    const targetPath = element instanceof BuilderFolderTreeItem
      ? element.node.fullPath
      : element.plan.resourcePath;
    const parentNode = findParentNode(buildFilePathTree(result.files), targetPath);
    if (!parentNode) {
      // Top-level node: parent is the builder row.
      return builderRow;
    }
    return new BuilderFolderTreeItem(builderId, builder.worktreePath, result.baseRef, parentNode);
  }

  /**
   * Build the `BuilderFileTreeItem` matching `(builderId, relPath)` so the
   * active-file sync can hand it to `buildersView.reveal` (#1066). Returns
   * `undefined` if the builder or file is no longer present. The constructed
   * item's id matches the rendered row, so `reveal` + `getParent` locate and
   * highlight the correct row (incl. the right builder when two builders share
   * a relative path).
   */
  async findFileItem(builderId: string, relPath: string): Promise<BuilderFileTreeItem | undefined> {
    const builder = this.builderWithWorktree(builderId);
    if (!builder) { return undefined; }
    const result = await this.diffCache.getDiff(builderId, builder.worktreePath);
    if (result.error) { return undefined; }
    const file = result.files.find(f => f.plan.resourcePath === relPath);
    if (!file) { return undefined; }
    return new BuilderFileTreeItem(builderId, builder.worktreePath, result.baseRef, file.change, file.plan);
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    // Second level: a builder's changed files. VSCode only calls this for
    // an *expanded* builder, so collapsed builders cost no git.
    if (element instanceof BuilderTreeItem) {
      return this.fileChildren(element.builderId);
    }
    // Folder rows (tree-mode only) expand to their child folders/files.
    if (element instanceof BuilderFolderTreeItem) {
      return element.node.children!.map(child =>
        materialiseNode(element.builderId, element.worktreePath, element.baseRef, child),
      );
    }
    // File rows are leaves.
    if (element instanceof BuilderFileTreeItem) {
      return [];
    }
    // Group rows expand to their builders.
    if (element instanceof BuilderGroupTreeItem) {
      return this.rowsForGroup(element.groupName);
    }
    // Root: group headers (one per active-axis group), or the lone-Uncategorized
    // flatten case (area mode, unlabeled repos).
    return this.rootChildren();
  }

  private rootChildren(): vscode.TreeItem[] {
    this.groupParentByBuilderId.clear();

    const data = this.cache.getData();
    if (!data) {
      return [];
    }

    const now = Date.now();
    const grouping = this.active();
    // The registered-architect roster (live sessions, main-first) — sourced from
    // the overview cache the provider already holds, no second fetch. Only the
    // architect axis consumes it, to emit a header for every architect including
    // childless ones (Issue 1174); the other axes ignore the arg. Guard `??` for
    // a pre-roster overview payload so `.map` never throws.
    const roster = (data.architects ?? []).map(a => a.name);
    const groups = grouping.group(orderForDisplay(data.builders, now), roster);

    // A repo that doesn't use `area/*` labels yields a single `Uncategorized`
    // group; in area mode its header adds no information, so flatten to root rows
    // — zero visual regression for unlabeled repos. Stage and architect modes
    // opt out of this (their lone group always carries information).
    if (grouping.flattenLoneUncategorized && groups.length === 1 && groups[0].key === UNCATEGORIZED_AREA) {
      return groups[0].items.map(b => this.makeBuilderRow(b, now));
    }

    // Populated groups render Expanded (#913) — no persisted state. VSCode's
    // native per-id memory keeps a user-collapsed group collapsed for the
    // rest of the session; on a fresh session this default applies again.
    // Childless architect groups (Issue 1174) render as leaf-like rows (`None`).
    //
    // Architect-axis headers get a click-to-open-terminal `command` (#1108):
    // the architect is first-class in this mode, so its header should match the
    // builder-row affordance (row click opens the terminal; the chevron still
    // toggles expand/collapse — VSCode routes the two gestures independently).
    // Stage/area headers stay pure containers — they name no launchable entity.
    // The `g.key` (architect name; null owners folded into `main` by
    // architectGrouping) is the optional name arg `codev.openArchitectTerminal`
    // already accepts; it warns gracefully on a stale owner not in the roster.
    const isArchitectAxis = grouping.id === 'architect';
    return groups.map(g => {
      // A childless architect group (Issue 1174) has no builders to expand into,
      // so render it as a leaf-like row (`None`) rather than an empty accordion.
      // The click-to-open-terminal command below still fires on the row body.
      // Populated groups stay Expanded (#913). Only the architect axis ever
      // yields an empty group; stage/area groups always hold ≥1 builder.
      const collapsibleState = g.items.length === 0
        ? vscode.TreeItemCollapsibleState.None
        : vscode.TreeItemCollapsibleState.Expanded;
      const groupItem = new BuilderGroupTreeItem(
        g.key,
        g.items.length,
        collapsibleState,
        rollupGroupState(g.items, now),
      );
      if (isArchitectAxis) {
        groupItem.command = {
          command: 'codev.openArchitectTerminal',
          title: 'Open Architect Terminal',
          arguments: [g.key],
        };
      }
      for (const b of g.items) {
        this.groupParentByBuilderId.set(b.id, groupItem);
      }
      return groupItem;
    });
  }

  private rowsForGroup(key: string): vscode.TreeItem[] {
    const data = this.cache.getData();
    if (!data) { return []; }

    const now = Date.now();
    const ordered = orderForDisplay(data.builders, now);
    const roster = (data.architects ?? []).map(a => a.name);
    const group = this.active().group(ordered, roster).find(g => g.key === key);
    if (!group) { return []; }

    return group.items.map(b => this.makeBuilderRow(b, now));
  }

  private makeBuilderRow(b: OverviewBuilder, now: number): BuilderTreeItem {
    const isBlocked = !!b.blocked;
    const isIdle = !isBlocked && isIdleWaiting(b, now);
    const item = new BuilderTreeItem(b.id, builderRowLabel(b, isIdle, now, this.active().rowPrefix(b)));
    // Versioned id (#913). The base `b.id` is stable (not the churning label) so
    // VSCode preserves a row's expansion across the frequent overview-poll
    // refreshes; the `#<version>` suffix is the accordion lever (see
    // AccordionRowIds). Group ids carry no suffix, so the accordion can't touch
    // them.
    item.id = this.rowIds.idFor(b.id);
    // Expandable so the second-level changed-files list can hang off it.
    // The row keeps its open-terminal command (single click); the chevron
    // toggles the file list.
    item.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
    item.tooltip = `Protocol: ${b.protocol} | Mode: ${b.mode} | Progress: ${b.progress}%`;
    // contextValue encodes the row's state-family + protocol so menus
    // can scope by either (Approve Gate inline only on
    // blocked-builder-*; everything else applies to all three
    // families). The optional `-review` suffix signals that the
    // builder has committed a review file on disk — the
    // `codev.viewReviewFile` menu entry's `when` clause keys off it so
    // PIR rows hide the entry until the review phase produces the file.
    // Classify once (blocked > idle > active); the state drives both the
    // contextValue family (menu scoping) and the icon.
    let state: BuilderState;
    if (isBlocked) {
      state = 'blocked';
    } else if (isIdle) {
      state = 'idle';
    } else {
      state = 'active';
    }
    const protocol = b.protocol || 'unknown';
    const reviewSuffix = builderHasReviewFile(b) ? '-review' : '';
    item.contextValue = `${CONTEXT_FAMILY[state]}-${protocol}${reviewSuffix}`;
    // Icon: the shared per-state glyph (single source of truth in
    // builder-row.ts). A blocked row overrides the shape with the gate-specific
    // `gateIconFor` codicon while keeping the shared warning color.
    const { icon, color } = BUILDER_STATE_GLYPH[state];
    const iconName = isBlocked ? gateIconFor(b.blockedGate) : icon;
    item.iconPath = new vscode.ThemeIcon(iconName, new vscode.ThemeColor(color));
    // The row click runs `codev.openBuilderRow` — a wrapper that opens the
    // builder terminal AND expands the row (so single-click matches what
    // most users expect). Pass the item itself so the handler can call
    // `buildersView.reveal(...)` against this row. Other callers
    // (terminal-link clicks, etc.) still use `codev.openBuilderById`
    // directly with just the id and don't trigger expansion.
    item.command = {
      command: 'codev.openBuilderRow',
      title: 'Open Builder Terminal',
      arguments: [item],
    };
    return item;
  }

  /**
   * Changed-file rows for one builder, rendered as a flat list or a
   * folder tree depending on the `codev.buildersFileViewAsTree` setting.
   * The diff data and the leaf shape (BuilderFileTreeItem) are identical
   * in both modes — only the grouping around the leaves differs.
   */
  private async fileChildren(builderId: string): Promise<vscode.TreeItem[]> {
    const builder = this.builderWithWorktree(builderId);
    if (!builder) {
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

    if (this.viewAsTree()) {
      // Tree mode: group by folder, compact single-child folder chains.
      // Top-level nodes may be folders or root-level files (e.g. README).
      return buildFilePathTree(result.files).map(node =>
        materialiseNode(builderId, builder.worktreePath, result.baseRef, node),
      );
    }
    // List mode (today's behaviour): flat, one row per changed file.
    return result.files.map(
      f => new BuilderFileTreeItem(builderId, builder.worktreePath, result.baseRef, f.change, f.plan),
    );
  }

  /** Read the file-view-as-tree setting; falls back to the spec default. */
  private viewAsTree(): boolean {
    return readBuildersFileViewAsTree();
  }
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
): vscode.TreeItem {
  if (node.children) {
    return new BuilderFolderTreeItem(builderId, worktreePath, baseRef, node);
  }
  // Leaf: must have a file (folder-without-children shouldn't be reachable
  // from buildFilePathTree, but the type allows it — guard defensively).
  if (!node.file) {
    return placeholder(node.name);
  }
  return new BuilderFileTreeItem(builderId, worktreePath, baseRef, node.file.change, node.file.plan);
}

/**
 * Walk a (compacted) file-path tree and return the parent node of the node
 * whose `fullPath` matches `targetPath`, or `undefined` when the target sits at
 * top level (no parent folder) or isn't found. Used by `getParent` to
 * reconstruct a file/folder row's enclosing folder for `reveal` (#1066).
 *
 * Folder fullPaths are compacted (`packages/codev/src`), and a file leaf's
 * `fullPath` equals its `plan.resourcePath` (leaves aren't compacted), so a
 * direct `fullPath` match resolves both row kinds.
 *
 * Returns `undefined` for both "top-level node (no parent folder)" and "not
 * found"; the caller treats both as "parent is the builder row". Recursive
 * calls always pass a defined `parent`, so a node found below the top level
 * never resolves to `undefined`.
 */
export function findParentNode(
  nodes: FilePathNode[],
  targetPath: string,
  parent?: FilePathNode,
): FilePathNode | undefined {
  for (const node of nodes) {
    if (node.fullPath === targetPath) { return parent; }
    if (node.children) {
      const found = findParentNode(node.children, targetPath, node);
      if (found !== undefined) { return found; }
    }
  }
  return undefined;
}

/**
 * Sync-check whether a builder has committed a review file on disk.
 *
 * Mirrors the prefix filter in `commands/view-artifact.ts`: a file
 * counts if it lives in `<worktree>/codev/reviews/`, ends in `.md`, and
 * either starts with `<id>-` or is exactly `<id>.md`. Used by the
 * Builders tree row builder to suffix `contextValue` with `-review` so
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
 * id. Every row id is `<builderId>#<version>`; bumping the version (`keepOnly`)
 * hands every row a fresh — hence collapsed — id, except the one being held
 * open, which keeps the exact id it was clicked at so VSCode keeps it expanded.
 *
 * The open row's id is stored verbatim (not reconstructed from a number), so a
 * render that lands between a bump and the next click can't leave the open row
 * pointing at a stale version.
 */
export class AccordionRowIds {
  private version = 0;
  private openBuilderId: string | undefined;
  private openRowId: string | undefined;

  /** The id to render for `builderId` this pass. */
  idFor(builderId: string): string {
    if (builderId === this.openBuilderId && this.openRowId) {
      return this.openRowId;
    }
    return `${builderId}#${this.version}`;
  }

  /** Hold `builderId` open at its current `rowId`; re-version everyone else. */
  keepOnly(builderId: string, rowId: string | undefined): void {
    this.openBuilderId = builderId;
    this.openRowId = rowId;
    this.version += 1;
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

/** Non-clickable informational leaf (no worktree / no changes / error). */
function placeholder(label: string): vscode.TreeItem {
  const item = new vscode.TreeItem(label);
  item.contextValue = 'builder-file-none';
  item.iconPath = new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('disabledForeground'));
  return item;
}
