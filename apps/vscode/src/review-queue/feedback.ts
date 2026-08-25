/**
 * Mode-neutral review feedback (#1410, #1552): the Stream Deck diff dials and
 * Scroll dial press a single `feedback-*` verb, and this module turns each
 * chunk (whole file / hunk-under-cursor / selection) into an **authoring**
 * gesture — it opens the native inline comment reply box at the anchor, the
 * same surface as spec/plan comment authoring, so the reviewer types or
 * dictates the actual comment. There is no promptless path: a gesture never
 * stamps a placeholder body or force-forwards a bare ref (#1552 removed the old
 * promptless deck default).
 *
 * The queue-vs-forward decision does NOT live here: every gesture opens the
 * same reply box (via `COMMENT_FOR_BUILDER_COMMAND`), and the reviewer's Submit
 * is what enqueues (comment mode) or forwards ref + prose (forward mode), per
 * `codev.diffCodelensMode` — see `comments/builder-review.ts`. So the deck
 * still never infers the mode, and both branches derive their anchor from the
 * SAME resolvers here.
 *
 * The feedback always targets the builder whose diff is FOCUSED (the anchor is
 * read from the active editor), never a separately-selected builder — a review
 * comment must attach to the file in front of the reviewer. When no builder
 * diff is focused, the gesture surfaces a clear message instead of a silent
 * no-op, so a dial press over the wrong editor is legible.
 */

import * as vscode from 'vscode';
import {
  getDiffInjectEntry,
  COMMENT_FOR_BUILDER_COMMAND,
  type DiffInjectSessionEntry,
} from '../diff-inject-codelens.js';
import { resolvePressCursorRef } from '../commands/press-cursor-ref.js';
import type { LineRange } from './queue.js';

/** Where a feedback gesture points: the owning diff entry + range (null = whole file). */
interface Anchor {
  entry: DiffInjectSessionEntry;
  lineRange: LineRange | null;
}

/** The active editor's tracked builder-diff entry, or undefined when the focused
 *  editor isn't a builder diff (a plain source file, the base side, or none). */
function activeEntry(): DiffInjectSessionEntry | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) { return undefined; }
  return getDiffInjectEntry(editor.document.uri.fsPath);
}

/** Whole-file anchor. */
function fileAnchor(): Anchor | undefined {
  const entry = activeEntry();
  return entry ? { entry, lineRange: null } : undefined;
}

/** The changed hunk under the cursor (mirrors `codev.forwardCurrentHunkToBuilder`).
 *  Resolves through the shared press helper (#1534): fresh single-file re-parse
 *  with hunk → symbol → file precedence (hunk-first, so a hunk press keeps the
 *  tight changed range), so a cursor on a deletion-only change or outside any
 *  recorded range anchors the enclosing symbol / whole file with an honest note
 *  instead of the old (misleading, when the cursor sat in green) error. */
async function hunkAnchor(): Promise<Anchor | undefined> {
  const editor = vscode.window.activeTextEditor;
  const entry = activeEntry();
  if (!editor || !entry) { return undefined; }
  const cursorLine = editor.selection.active.line + 1; // 1-based new-side
  const resolved = await resolvePressCursorRef(entry, editor.document.uri, cursorLine);
  if (resolved.kind === 'file') {
    vscode.window.setStatusBarMessage(
      'Codev: no changed lines at the cursor — using the whole file (reopen the diff if it looks stale)', 3000);
    return { entry, lineRange: null };
  }
  return { entry, lineRange: { start: resolved.range.start, end: resolved.range.end } };
}

/** The selection range, or the cursor line when the selection is empty (mirrors
 *  `codev.forwardSelectionToBuilder`). */
function selectionAnchor(): Anchor | undefined {
  const editor = vscode.window.activeTextEditor;
  const entry = activeEntry();
  if (!editor || !entry) { return undefined; }
  const sel = editor.selection;
  let start = sel.start.line + 1;
  let end = sel.end.line + 1;
  if (sel.isEmpty) {
    start = sel.active.line + 1;
    end = start;
  } else if (sel.end.character === 0 && sel.end.line > sel.start.line) {
    // A selection ending at column 0 of a line doesn't include that line.
    end = sel.end.line;
  }
  return { entry, lineRange: { start, end } };
}

/** Open the native comment reply box at the anchor so the reviewer authors the
 *  comment (#1552). No anchor means no builder diff is focused — surface that
 *  rather than doing nothing, so a dial press lands somewhere legible. */
async function route(anchor: Anchor | undefined): Promise<void> {
  if (!anchor) {
    vscode.window.showWarningMessage('Codev: focus a builder diff first to flag it for review');
    return;
  }
  const { entry, lineRange } = anchor;
  // The same authoring entry point the comment codelens uses: it creates AND
  // focuses the reply box at the anchor (the active editor is `entry.fsPath`,
  // since the anchor was read from it). Submit delivers per the current mode.
  await vscode.commands.executeCommand(
    COMMENT_FOR_BUILDER_COMMAND, entry.builderId, entry.fsPath, entry.relPath, lineRange);
}

export const feedbackFile = (): Promise<void> => route(fileAnchor());
export const feedbackHunk = async (): Promise<void> => route(await hunkAnchor());
export const feedbackSelection = (): Promise<void> => route(selectionAnchor());
