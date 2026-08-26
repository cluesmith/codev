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
 * Deck composer parity (#1552, mirroring the artifact-canvas composer #1425):
 * VS Code is the *diff-mode owner*, so it interprets the SAME verbs contextually
 * — while a builder-review comment box is open, the deck drives it. The FILE
 * dial is the dedicated cancel (the canvas Headings dial's composer-cancel);
 * every OTHER open dial is open-or-submit, so whichever dial the reviewer opened
 * with — hunk or selection — a second press submits:
 *
 *   - hunk press      → open-or-submit  (open a hunk comment; press again to SUBMIT)
 *   - selection press → open-or-submit  (open a selection comment; press again to SUBMIT)
 *   - file press      → cancel-when-open (dismiss the open box; otherwise open a
 *                                        whole-file comment)
 *
 * The queue-vs-forward decision is separate and lives in the reply box's Submit
 * (see `comments/builder-review.ts`): the box enqueues (comment mode) or forwards
 * ref + prose (forward mode) per `codev.diffCodelensMode`. So the deck never
 * infers either the composer action or the delivery mode; both are owned VS
 * Code-side.
 *
 * The feedback always targets the builder whose diff is FOCUSED (the anchor is
 * read from the active editor), never a separately-selected builder — a review
 * comment must attach to the file in front of the reviewer. When no builder
 * diff is focused, an OPEN gesture surfaces a clear message instead of a silent
 * no-op, so a dial press over the wrong editor is legible.
 */

import * as vscode from 'vscode';
import {
  getDiffInjectEntry,
  COMMENT_FOR_BUILDER_COMMAND,
  type DiffInjectSessionEntry,
} from '../diff-inject-codelens.js';
import {
  isBuilderComposerOpen,
  submitActiveBuilderComposer,
  cancelActiveBuilderComposer,
} from '../comments/builder-review.js';
import { resolvePressCursorRef } from '../commands/press-cursor-ref.js';
import type { LineRange } from './queue.js';

/** The three feedback gestures, one per Stream Deck axis. */
export type FeedbackAxis = 'file' | 'hunk' | 'selection';

/** What a feedback gesture does, given the axis and whether a composer box is
 *  already open. A discriminated union so the caller dispatches exhaustively. */
export type FeedbackAction =
  | { kind: 'open'; axis: FeedbackAxis }
  | { kind: 'submit' }
  | { kind: 'cancel' }
  | { kind: 'noop' };

/**
 * Pure composer state machine (#1552, modeled on `decideApprovalRelay`): given
 * the gesture's axis and whether a builder-review comment box is currently open,
 * decide what the press does. No `vscode`, so the four branches are unit-tested
 * directly — including the self-heal edge below.
 *
 * With NO box open, every axis simply opens a comment at that axis. With a box
 * open, the FILE dial cancels (the canvas Headings dial's role) and every other
 * dial submits, so whichever dial opened the box — hunk or selection — a second
 * press submits. No open runs while a box is open, so threads never stack.
 *
 * CANCEL-BIASED / never a phantom submit: this function only *names* the action;
 * the SUBMIT action is executed via VS Code's built-in submit-comment, which is
 * a no-op when no comment editor is focused. So if `composerOpen` is stale (a
 * native Escape dismissed the box without notifying us), a press decides
 * `submit` but the built-in no-ops — cancelled text is never resurrected — and
 * the caller then clears the flag, so the next press opens. A stale flag can
 * cost a no-op or an extra open, never a phantom submit.
 */
export function decideFeedbackAction(axis: FeedbackAxis, composerOpen: boolean): FeedbackAction {
  if (!composerOpen) { return { kind: 'open', axis }; }
  if (axis === 'file') { return { kind: 'cancel' }; }
  return { kind: 'submit' }; // hunk or selection: open-or-submit
}

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

/** Resolve the anchor for an OPEN gesture (only the open branch needs one). */
async function resolveAnchor(axis: FeedbackAxis): Promise<Anchor | undefined> {
  if (axis === 'file') { return fileAnchor(); }
  if (axis === 'hunk') { return hunkAnchor(); }
  return selectionAnchor();
}

/** Run one feedback gesture: drive the open composer (submit/cancel), or open the
 *  native comment reply box at the anchor for the reviewer to author. */
async function gesture(axis: FeedbackAxis): Promise<void> {
  const action = decideFeedbackAction(axis, isBuilderComposerOpen());
  if (action.kind === 'submit') { await submitActiveBuilderComposer(); return; }
  if (action.kind === 'cancel') { await cancelActiveBuilderComposer(); return; }
  if (action.kind === 'noop') { return; }
  const anchor = await resolveAnchor(axis);
  if (!anchor) {
    vscode.window.showWarningMessage('Codev: focus a builder diff first to flag it for review');
    return;
  }
  const { entry, lineRange } = anchor;
  // The same authoring entry point the comment codelens uses: it creates AND
  // focuses the reply box at the anchor (the active editor is `entry.fsPath`,
  // since the anchor was read from it) and marks the composer open. Submit
  // delivers per the current mode.
  await vscode.commands.executeCommand(
    COMMENT_FOR_BUILDER_COMMAND, entry.builderId, entry.fsPath, entry.relPath, lineRange);
}

export const feedbackFile = (): Promise<void> => gesture('file');
export const feedbackHunk = (): Promise<void> => gesture('hunk');
export const feedbackSelection = (): Promise<void> => gesture('selection');
