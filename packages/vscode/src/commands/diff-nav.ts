/**
 * Cross-file navigation in a Codev diff review (#1060).
 *
 * `codev.diffNextFile` / `codev.diffPreviousFile` walk a builder's changed-file
 * list top-to-bottom, opening each file's per-file diff — the keyboard
 * equivalent of clicking the next file row in the Builders sidebar (GitHub PR
 * review's `j` / `k`).
 *
 * The mechanic reuses already-shipped pieces rather than VS Code multi-diff
 * internals:
 *   - The ordered list comes from `BuilderDiffCache.getDiff` — the same source
 *     (and 15s TTL cache) that backs the sidebar's changed-file rows, in
 *     `git diff --name-status` order.
 *   - The current position is read from the active editor via the diff-inject
 *     registry (`getDiffInjectEntry`), which both View Diff and the per-file
 *     diff already populate with `{ builderId, relPath }`. So "where am I" is
 *     just the file the diff editor is showing — no stored pointer to drift.
 *   - The target file opens through the shared `openBuilderFileDiff` helper,
 *     with `{ preview: true }` so a walk reuses one tab.
 *
 * A module-level "last navigated position" is the only retained state — a
 * fallback for when the active editor isn't a tracked diff file (e.g. the user
 * focused a terminal between keypresses).
 */

import * as vscode from 'vscode';
import type { OverviewCache } from '../views/overview-data.js';
import type { BuilderDiffCache, BuilderFileChange } from '../views/builder-diff-cache.js';
import { getDiffInjectEntry } from '../diff-inject-codelens.js';
import { buildFilePathTree, flattenTreeOrder } from '../views/file-path-tree.js';
import { openBuilderFileDiff } from './view-diff.js';
import { builderWithWorktree } from '../builder-lookup.js';
import { readBuildersFileViewAsTree } from '../builders-config.js';

// ── Pure helpers (no vscode/git dependency — unit-tested directly) ──────────

/** Navigation order: changed-file rel-paths in list (git `--name-status`) order. */
export function orderedRelPaths(files: BuilderFileChange[]): string[] {
  return files.map(f => f.plan.resourcePath);
}

/**
 * The changed files in the order the user is looking at them, so cross-file
 * navigation steps top-to-bottom through the *visible* list:
 *  - **tree mode**: the folder-tree's depth-first display order (a folder's
 *    whole subtree before its next sibling), via `flattenTreeOrder` — matches
 *    the Builders tree rows (#1066 review feedback).
 *  - **flat-list mode**: the raw `result.files` (git `--name-status`) order,
 *    which is exactly what the flat list renders.
 */
export function navigationOrder(files: BuilderFileChange[], viewAsTree: boolean): BuilderFileChange[] {
  return viewAsTree ? flattenTreeOrder(buildFilePathTree(files)) : files;
}

/**
 * Step `index` by `direction` within `[0, count)`, wrapping around at the ends:
 * stepping forward past the last file returns to the first, and stepping back
 * before the first returns to the last. This matches VSCode's built-in diff
 * change (hunk) navigation, which also wraps, so file and hunk stepping behave
 * consistently (#1066 review). A single-file list wraps to itself.
 */
export function computeNavTarget(
  index: number,
  count: number,
  direction: 1 | -1,
): { index: number } {
  // `((x % n) + n) % n` keeps the result in `[0, count)` for negative steps too.
  return { index: ((index + direction) % count + count) % count };
}

/** Index of `relPath` in the file list, or -1 if absent / undefined. */
export function indexOfRelPath(files: BuilderFileChange[], relPath: string | undefined): number {
  if (relPath === undefined) { return -1; }
  return files.findIndex(f => f.plan.resourcePath === relPath);
}

// ── Command implementation ──────────────────────────────────────────────────

interface NavDeps {
  context: vscode.ExtensionContext;
  overviewCache: OverviewCache;
  diffCache: BuilderDiffCache;
}

/**
 * The last builder-diff file opened — by navigation OR by a direct open (sidebar
 * click / View Diff, via `recordDiffNavPosition`). Used to resolve "where am I"
 * when the active editor can't be matched through the diff-inject registry.
 *
 * That fallback is load-bearing for DELETED / BINARY files: their right side is
 * a `codev-diff:` placeholder, not a `file:` document, so `registerFileInjectSession`
 * never records them and `getDiffInjectEntry` can't resolve them. Seeding this on
 * every open means navigation can still *start* from a deleted/binary file
 * (otherwise next/prev would bail with "open a builder file diff first").
 *
 * Module-level by design: navigation is a singleton gesture.
 */
let lastPosition: { builderId: string; relPath: string } | undefined;

function flash(message: string): void {
  vscode.window.setStatusBarMessage(`Codev: ${message}`, 4000);
}

/** Resolved navigation context: the ordered file list plus where we are in it. */
interface DiffContext {
  ordered: BuilderFileChange[];
  builderId: string;
  worktreePath: string;
  baseRef: string;
  currentIdx: number;
}

/**
 * Resolve the builder's ordered changed-file list and the current position
 * within it (steps 1-3 shared by every navigation gesture). Flashes and returns
 * undefined when there's nothing to navigate.
 */
async function resolveDiffContext(deps: NavDeps): Promise<DiffContext | undefined> {
  // 1. Resolve the current builder + file from the active editor, falling back
  //    to the last navigated position.
  const activeFsPath = vscode.window.activeTextEditor?.document.uri.fsPath;
  const entry = activeFsPath ? getDiffInjectEntry(activeFsPath) : undefined;
  const current = entry
    ? { builderId: entry.builderId, relPath: entry.relPath }
    : lastPosition;
  if (!current) {
    flash('open a builder file diff first');
    return undefined;
  }

  // 2. Resolve the worktree path for that builder (synchronous overview read).
  const builder = builderWithWorktree(deps.overviewCache.getData(), current.builderId);
  if (!builder) {
    flash(`no worktree on record for ${current.builderId}`);
    return undefined;
  }
  const worktreePath = builder.worktreePath;

  // 3. Load the builder's ordered changed-file list (cached), then reorder it to
  //    match what the user sees in the Builders tree (#1066): depth-first tree
  //    order in tree-view mode, raw git order in flat-list mode.
  const result = await deps.diffCache.getDiff(current.builderId, worktreePath);
  if (result.error || result.files.length === 0) {
    flash('no changed files to navigate');
    return undefined;
  }
  const ordered = navigationOrder(result.files, readBuildersFileViewAsTree());
  return {
    ordered,
    builderId: current.builderId,
    worktreePath,
    baseRef: result.baseRef,
    currentIdx: indexOfRelPath(ordered, current.relPath),
  };
}

/** Open the diff for `ordered[index]` as a reused preview tab and anchor there. */
async function openDiffAt(deps: NavDeps, ctx: DiffContext, index: number): Promise<void> {
  const target = ctx.ordered[index]!;
  await openBuilderFileDiff(
    deps.context,
    { worktreePath: ctx.worktreePath, baseRef: ctx.baseRef, builderId: ctx.builderId, plan: target.plan },
    { preview: true },
  );
  recordDiffNavPosition(ctx.builderId, target.plan.resourcePath);
}

export async function navigateDiff(direction: 1 | -1, deps: NavDeps): Promise<void> {
  const ctx = await resolveDiffContext(deps);
  if (!ctx) { return; }
  // Bail if the current file isn't in this list (can't step relative to nothing).
  if (ctx.currentIdx < 0) {
    flash('current file is not in this diff');
    return;
  }
  // Step, wrapping around at the ends (consistent with the built-in hunk
  // navigation, which also wraps).
  const { index } = computeNavTarget(ctx.currentIdx, ctx.ordered.length, direction);
  await openDiffAt(deps, ctx, index);
}

/**
 * Jump to the FIRST file in the builder's changed-file list (#1060 completion:
 * the "reset to start" gesture, e.g. a controller dial press). Unlike stepping,
 * this doesn't need the current file to be in the list; any resolvable builder
 * is enough.
 */
export async function navigateDiffToFirst(deps: NavDeps): Promise<void> {
  const ctx = await resolveDiffContext(deps);
  if (!ctx) { return; }
  await openDiffAt(deps, ctx, 0);
}

/**
 * Jump to the FIRST hunk of the active diff editor: move to the top, then step
 * to the first change. Uses VS Code's built-in compare-editor change navigation
 * (no stable "first change" command exists). A no-op outside a diff editor.
 */
export async function diffFirstHunk(): Promise<void> {
  // Guard on the diff-inject registry so this is a true no-op outside a tracked
  // diff: otherwise `cursorTop` would jump the caret in whatever plain editor
  // happens to be focused.
  const editor = vscode.window.activeTextEditor;
  if (!editor || !getDiffInjectEntry(editor.document.uri.fsPath)) { return; }
  await vscode.commands.executeCommand('cursorTop');
  await vscode.commands.executeCommand('workbench.action.compareEditor.nextChange');
}

/**
 * Record the currently-shown builder-diff file as the navigation anchor. Called
 * by `navigateDiff` after each step AND by the `codev.openBuilderFileDiff`
 * command after a direct open, so a subsequent next/prev resolves even when the
 * active editor isn't in the diff-inject registry (deleted / binary files).
 */
export function recordDiffNavPosition(builderId: string, relPath: string): void {
  lastPosition = { builderId, relPath };
}

/** Read the retained navigation anchor — for tests. */
export function peekDiffNavPosition(): { builderId: string; relPath: string } | undefined {
  return lastPosition;
}

/** Reset retained navigation state — for tests. */
export function resetDiffNavState(): void {
  lastPosition = undefined;
}
