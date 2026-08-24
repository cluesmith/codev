/**
 * Mode-neutral review feedback (#1410): the Stream Deck diff dials and Scroll
 * dial press a single `feedback-*` verb, and this module routes each chunk
 * (whole file / hunk-under-cursor / selection) EITHER as an immediate PTY
 * forward OR into the per-builder pending-comment queue, following the
 * workspace's `codev.diffCodelensMode` setting — so the deck never infers the
 * mode. Both branches derive their anchor from the SAME resolver, so a given
 * dial press references the same file/range in either mode.
 *
 * The queue branch mutates ONLY through `ReviewQueueStore` (the queue's single
 * source of truth, #1037): the status bar, inline threads, and Tower's
 * per-builder queued-feedback count all reflect a deck-driven enqueue for free.
 *
 * The feedback always targets the builder whose diff is FOCUSED (the diff-inject
 * entry's owner), never a separately-selected builder — a review comment must
 * attach to the file in front of the reviewer.
 */

import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import {
  getDiffInjectEntry,
  getDiffCodelensMode,
  type DiffInjectSessionEntry,
} from '../diff-inject-codelens.js';
import { buildBuilderFileRef, buildBuilderRangeRef } from '../diff-inject-ref.js';
import { resolvePressCursorRef } from '../commands/press-cursor-ref.js';
import { deriveWorktreePath } from './reconcile.js';
import type { LineRange } from './queue.js';
import type { ReviewQueueStore } from './store.js';

/** Body attached to a chunk flagged from the deck — a dial press carries no
 *  typed prose, so the comment's file + range are its substance. */
const DECK_FLAG_BODY = 'Flagged for review from Stream Deck.';

export interface FeedbackDeps {
  store: ReviewQueueStore;
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

/** Route one anchor per the workspace mode: forward now (PTY) or enqueue. */
async function route(deps: FeedbackDeps, anchor: Anchor | undefined): Promise<void> {
  if (!anchor) { return; }
  const { entry, lineRange } = anchor;
  if (getDiffCodelensMode() === 'forward') {
    // Immediate: the same low-level inject the forward CodeLens / commands use.
    const ref = lineRange
      ? buildBuilderRangeRef(entry.relPath, lineRange.start, lineRange.end)
      : buildBuilderFileRef(entry.relPath);
    await vscode.commands.executeCommand('codev.forwardToBuilder', entry.builderId, ref);
    return;
  }
  // Queue: register the builder's worktree from the diff entry (derived, never
  // guessed) so the write lands in the right worktree even when nothing has been
  // queued this session, then mutate through the store.
  if (!deps.store.getWorktreePath(entry.builderId)) {
    const worktree = deriveWorktreePath(entry.fsPath, entry.relPath, path.sep);
    if (!worktree) {
      vscode.window.showWarningMessage('Codev: could not locate the builder worktree for this diff');
      return;
    }
    deps.store.registerWorktree(entry.builderId, worktree);
  }
  await deps.store.add(entry.builderId, {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    file: entry.relPath,
    lineRange,
    body: DECK_FLAG_BODY,
  });
}

export const feedbackFile = (deps: FeedbackDeps): Promise<void> => route(deps, fileAnchor());
export const feedbackHunk = async (deps: FeedbackDeps): Promise<void> => route(deps, await hunkAnchor());
export const feedbackSelection = (deps: FeedbackDeps): Promise<void> => route(deps, selectionAnchor());
