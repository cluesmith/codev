import * as vscode from 'vscode';
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { OverviewBuilder } from '@cluesmith/codev-types';
import { isIdleWaiting } from '@cluesmith/codev-core/builder-helpers';
import { UNCATEGORIZED_AREA } from '@cluesmith/codev-core/constants';
import type { OverviewCache } from './overview-data.js';
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
  // Accordion state (#913). VSCode has no "collapse this row" API and never
  // forgets a row id it has seen expanded, so the only way to force a builder
  // row collapsed is to render it under an id VSCode hasn't seen. `gen` is a
  // monotonic id allocator: every builder except the open one renders as
  // `<id>#<gen>`; `collapseBuildersExcept` bumps `gen` so all those rows get
  // fresh (never-expanded) ids and snap shut. The open builder is pinned to
  // `openGen` so its row id is stable and it stays expanded. Group headers
  // never carry the suffix, so the accordion can't touch them.
  private gen = 0;
  private openBuilderId: string | undefined;
  private openGen = 0;

  constructor(
    private cache: OverviewCache,
    private readonly diffCache: BuilderDiffCache,
  ) {
    this.groupings = {
      stage: stageGrouping(),
      area: areaGrouping(),
    };
    cache.onDidChange(() => this.changeEmitter.fire());
  }

  /**
   * Accordion (#913): collapse every builder row except the one just expanded,
   * without touching group headers. Pins the clicked builder as the open one
   * (its row id stays put across the re-render, so VSCode keeps it expanded),
   * then bumps the generation so every *other* builder row re-renders under a
   * fresh id and VSCode applies the provider's default `Collapsed` state.
   *
   * `openGen` is pinned from the clicked element's own rendered id rather than
   * the current `gen`, so a render that landed between the last bump and this
   * click can't leave the open row pointing at a stale generation.
   */
  collapseBuildersExcept(item: BuilderTreeItem): void {
    this.openBuilderId = item.builderId;
    this.openGen = generationOf(item.id) ?? this.gen;
    this.gen += 1;
    this.changeEmitter.fire();
  }

  /**
   * The grouping strategy for the active axis, read from the
   * `codev.buildersGroupBy` setting (#952). Defaults to `stage` — the action
   * axis. Toggled via the Builders title-bar button (`codev.groupBuildersByArea`
   * / `codev.groupBuildersByPhase`). All per-axis behavior (bucketing, expansion
   * store, row prefix, flatten rule) lives on the returned strategy, so callers
   * never branch on the mode themselves.
   */
  private active(): BuilderGrouping {
    const mode = vscode.workspace
      .getConfiguration('codev')
      .get<BuildersGroupBy>('buildersGroupBy', 'stage');
    return this.groupings[mode === 'area' ? 'area' : 'stage'];
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

  // The accordion's `reveal(builderItem)` needs the parent chain.
  // Builders nested under a group return their cached group; everything
  // else (group rows themselves, file/folder rows, builders in the
  // single-Uncategorized flatten case) is treated as a root by VSCode.
  getParent(element: vscode.TreeItem): vscode.TreeItem | undefined {
    if (element instanceof BuilderTreeItem) {
      return this.groupParentByBuilderId.get(element.builderId);
    }
    return undefined;
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
    // Root: group headers, or the single-Uncategorized flatten case (area mode).
    return this.rootChildren();
  }

  private rootChildren(): vscode.TreeItem[] {
    const data = this.cache.getData();
    if (!data) {
      this.groupParentByBuilderId.clear();
      return [];
    }

    const now = Date.now();
    const grouping = this.active();
    const ordered = orderForDisplay(data.builders, now);
    const groups = grouping.group(ordered);

    // A repo that doesn't use `area/*` labels yields a single `Uncategorized`
    // group; in area mode its header adds no information, so flatten to root rows
    // — zero visual regression for unlabeled repos. Stage mode opts out of this
    // (the stage axis always applies; every builder has a stage).
    if (grouping.flattenLoneUncategorized && groups.length === 1 && groups[0].key === UNCATEGORIZED_AREA) {
      this.groupParentByBuilderId.clear();
      return groups[0].items.map(b => this.makeBuilderRow(b, now));
    }

    // Groups always render Expanded (#913) — no persisted state. VSCode's
    // native per-id memory keeps a user-collapsed group collapsed for the
    // rest of the session; on a fresh session this default applies again.
    this.groupParentByBuilderId.clear();
    return groups.map(g => {
      const groupItem = new BuilderGroupTreeItem(
        g.key,
        g.items.length,
        vscode.TreeItemCollapsibleState.Expanded,
        rollupGroupState(g.items, now),
      );
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
    const group = this.active().group(ordered).find(g => g.key === key);
    if (!group) { return []; }

    return group.items.map(b => this.makeBuilderRow(b, now));
  }

  private makeBuilderRow(b: OverviewBuilder, now: number): BuilderTreeItem {
    const isBlocked = !!b.blocked;
    const isIdle = !isBlocked && isIdleWaiting(b, now);
    const item = new BuilderTreeItem(b.id, builderRowLabel(b, isIdle, now, this.active().rowPrefix(b)));
    // Generation-suffixed id (#913). The base is `b.id` (stable, not the
    // churning label) so VSCode preserves a row's expansion across the frequent
    // overview-poll refreshes. The `#<gen>` suffix is the accordion lever: the
    // open builder is pinned to `openGen` (id stays put → stays expanded), every
    // other builder uses the current `gen`, so a bump in `collapseBuildersExcept`
    // hands them never-seen ids and VSCode renders them with the default
    // Collapsed state. Group ids carry no suffix, so the accordion can't touch
    // them.
    const generation = b.id === this.openBuilderId ? this.openGen : this.gen;
    item.id = `${b.id}#${generation}`;
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
    const builder = this.cache.getData()?.builders.find(b => b.id === builderId);
    if (!builder?.worktreePath) {
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
    return vscode.workspace
      .getConfiguration('codev')
      .get<boolean>('buildersFileViewAsTree', true);
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
 * Parse the generation suffix off a builder row id (`<builderId>#<gen>`),
 * returning the numeric generation or `undefined` if the id carries none.
 * Used by the accordion to pin the just-clicked builder to the generation its
 * row was actually rendered with, immune to a render landing between the last
 * bump and the click (#913).
 */
export function generationOf(id: string | undefined): number | undefined {
  if (!id) { return undefined; }
  const hash = id.lastIndexOf('#');
  if (hash === -1) { return undefined; }
  const suffix = id.slice(hash + 1);
  // Guard the empty suffix (`Number('')` is 0) and any non-numeric tail.
  if (suffix === '') { return undefined; }
  const gen = Number(suffix);
  return Number.isInteger(gen) ? gen : undefined;
}

/** Non-clickable informational leaf (no worktree / no changes / error). */
function placeholder(label: string): vscode.TreeItem {
  const item = new vscode.TreeItem(label);
  item.contextValue = 'builder-file-none';
  item.iconPath = new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('disabledForeground'));
  return item;
}
