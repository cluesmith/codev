/**
 * Codev Builder Review — structured review comments on builder-diff files via
 * VSCode's Comments API (#1037).
 *
 * The reviewer composes a comment in an inline thread (mounted by the
 * comment-mode codelens, the gutter "+", or the context-menu action), submits
 * it into the per-builder pending queue (`ReviewQueueStore`), and later
 * flushes the whole queue to the builder PTY via Submit Review. This surface
 * never touches #789's forward flow: a forward click reaches the PTY directly
 * and never appears here.
 *
 * Thread lifecycle (plan decision 6): a queued comment renders as a visible
 * thread exactly while its file is registered in the active diff-inject
 * session. The reconciler diffs (registered files × queue) against mounted
 * threads on every registry or queue change, so reload → re-open diff
 * re-mounts, submit/delete disposes, and edits from another window update in
 * place. Edit/delete mirror the plan-review controller's #1055 pattern.
 */

import * as vscode from 'vscode';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  getDiffInjectEntry,
  getDiffInjectEntries,
  onDidChangeDiffInjectRegistry,
  getDiffCodelensMode,
  COMMENT_FOR_BUILDER_COMMAND,
} from '../diff-inject-codelens.js';
import { buildBuilderFileRef, buildBuilderRangeRef } from '../diff-inject-ref.js';
import { planThreadReconcile, deriveWorktreePath, clampAnchorLines, type RegisteredFile } from '../review-queue/reconcile.js';
import type { ReviewQueueStore } from '../review-queue/store.js';
import type { LineRange, PendingComment } from '../review-queue/queue.js';
import type { OverviewCache } from '../views/overview-data.js';

const CONTROLLER_ID = 'codev-builder-review';

/** contextValue on threads/comments — matched by the `comments/*` menu `when` clauses. */
const PENDING_CONTEXT = 'pending-builder-comment';

/** Fallback end column when the document isn't open to measure the last
 *  line's length — far past any real line; the editor clamps to content. */
const LAST_COLUMN = 1 << 20;

/** A mounted queued comment. Carries its queue identity for edit/delete. */
class BuilderReviewComment implements vscode.Comment {
  public parent?: vscode.CommentThread;
  public savedBody: string;
  public mode = vscode.CommentMode.Preview;
  public contextValue = PENDING_CONTEXT;
  constructor(
    public body: vscode.MarkdownString,
    public author: vscode.CommentAuthorInformation,
    public readonly commentId: string,
    public readonly builderId: string,
  ) {
    this.savedBody = body.value;
  }
}

function bodyText(body: string | vscode.MarkdownString): string {
  if (typeof body === 'string') { return body; }
  return body.value;
}

// TEMPORARY dev-approval diagnostic (#1552): trace deck-dial composer events to a
// dedicated output channel so the exact behaviour of a dial press can be captured
// (View → Output → "Codev Feedback Debug"). The `dial-diag-v1` marker also proves
// the running build includes this code. REMOVE before the PR.
const feedbackDbg = vscode.window.createOutputChannel('Codev Feedback Debug');
export function logFeedbackDebug(msg: string): void {
  feedbackDbg.appendLine(`[dial-diag-v1] ${msg}`);
}

/**
 * VS Code built-ins that drive the FOCUSED native comment reply box (#1552),
 * so the deck feedback gestures can submit / cancel an open composer.
 *
 * `editor.action.submitComment` is the submit id (the `editor.*` id — NOTE:
 * `workbench.action.submitComment` does NOT exist; it would be a silent no-op).
 * It only acts on a FOCUSED comment editor, so submit is gated on that focus via
 * `isCommentInputFocused()`. Cancel does NOT use `workbench.action.hideComment`
 * (proven via #1552 diagnostics NOT to discard the box); it closes the focused
 * comment-input editor instead — see `cancelActiveBuilderComposer`.
 */
const SUBMIT_FOCUSED_COMMENT = 'editor.action.submitComment';

/**
 * Whether a builder-review comment box is currently open — tracked here, in the
 * composer's owner, so the deck feedback router (#1552) can drive it. Set true
 * when we open a box; cleared when it submits or cancels.
 *
 * A native Escape dismissal is NOT observable via the stable comment API, so
 * this flag can stale-stick `true`. The router treats that as cancel-biased: a
 * stale flag can only cost a submit no-op or an extra open, never a phantom
 * submit (SUBMIT runs the built-in, which no-ops when no comment editor is
 * focused). Both executors clear the flag, so it self-heals on the next gesture.
 */
let composerOpen = false;

/** True when the focused editor IS a native comment reply box. VS Code makes the
 *  in-progress comment input the active editor as a `commentinput-…` document
 *  (observed via #1552 diagnostics); detecting it is more reliable than our own
 *  flag, and it means submit/cancel run ONLY while the box is actually focused —
 *  which is exactly when the built-ins (editor.action.submitComment /
 *  closeActiveEditor) act on it. */
function isCommentInputFocused(): boolean {
  const uri = vscode.window.activeTextEditor?.document.uri;
  if (!uri) { return false; }
  return uri.scheme === 'comment' || uri.fsPath.includes('commentinput');
}

/** True while a builder-review comment box is open (the deck router reads this).
 *  Union of our tracked flag and the live focused-comment-input signal, so a
 *  stale flag can never strand the box (#1552). */
export function isBuilderComposerOpen(): boolean {
  return composerOpen || isCommentInputFocused();
}

/**
 * Submit the focused composer via VS Code's built-in (#1552). The built-in is a
 * no-op when no comment editor is focused, so a stale `composerOpen` can never
 * resurrect cancelled prose. Our `codev.submitBuilderComment` handler also
 * clears the flag on a real submit; clearing here self-heals the no-op case.
 */
export async function submitActiveBuilderComposer(): Promise<void> {
  logFeedbackDebug(`submitActiveBuilderComposer → exec ${SUBMIT_FOCUSED_COMMENT} (composerOpen was ${composerOpen})`);
  await vscode.commands.executeCommand(SUBMIT_FOCUSED_COMMENT);
  composerOpen = false;
}

/** Discard the focused in-progress composer (#1552), leaving nothing queued or
 *  forwarded. `workbench.action.hideComment` was proven (via #1552 diagnostics)
 *  NOT to discard the box; instead we close the focused comment-input editor,
 *  which the box IS. This is GATED on the commentinput check so it can never
 *  close a real file editor by mistake. */
export async function cancelActiveBuilderComposer(): Promise<void> {
  const onCommentInput = isCommentInputFocused();
  logFeedbackDebug(`cancelActiveBuilderComposer → onCommentInput=${onCommentInput} (composerOpen was ${composerOpen})`);
  if (onCommentInput) {
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  }
  composerOpen = false;
}

/** The 1-based inclusive range a thread's anchor denotes. */
function threadLineRange(thread: vscode.CommentThread): LineRange {
  const range = thread.range;
  if (!range) { return { start: 1, end: 1 }; }
  return { start: range.start.line + 1, end: range.end.line + 1 };
}

export function activateBuilderReviewComments(
  context: vscode.ExtensionContext,
  store: ReviewQueueStore,
  overviewCache: OverviewCache,
): void {
  // Reset composer state on (re)activation, so a reload never starts thinking a
  // box is open (#1552).
  composerOpen = false;
  const controller = vscode.comments.createCommentController(
    CONTROLLER_ID,
    'Codev Builder Review',
  );
  controller.options = {
    prompt: 'Comment for builder',
    placeHolder: 'Type review feedback for the builder, then Queue Comment',
  };
  context.subscriptions.push(controller);

  // Gutter "+" on registered builder-diff files, in BOTH codelens modes. The
  // ranges must not depend on the mode: `workbench.action.addComment` (which
  // backs the codelens, gutter, AND the always-visible context-menu action)
  // validates against these ranges, so a comment-mode-only provider breaks
  // `Codev: Comment for Builder` from the context menu whenever the editor is
  // in forward mode — the default. The codelens stays the mode-distinct
  // surface. `enableFileComments` lets the command create a range-less file
  // comment (the file-level lens flow).
  const rangeProvider: vscode.CommentingRangeProvider = {
    provideCommentingRanges(document) {
      if (!getDiffInjectEntry(document.uri.fsPath)) { return []; }
      const lastLine = Math.max(0, document.lineCount - 1);
      return { enableFileComments: true, ranges: [new vscode.Range(0, 0, lastLine, 0)] };
    },
  };
  controller.commentingRangeProvider = rangeProvider;

  // VS Code caches each document's commenting ranges and only re-queries on
  // its own triggers — none of which fire when the diff-inject registry
  // registers a file AFTER its editor opened (openBuilderFileDiff opens the
  // diff first; same ordering as the #789 context-key fix). Re-assigning the
  // provider goes through the extension-host setter, which calls
  // `$updateCommentingRanges` and makes the editor recompute — without this,
  // the gutter "+" is missing and `workbench.action.addComment` rejects with
  // "cursor must be within a commenting range" on a freshly opened diff.
  const refreshCommentingRanges = (): void => {
    controller.commentingRangeProvider = rangeProvider;
  };

  /** Mounted threads keyed by queued-comment id. */
  const mounted = new Map<string, vscode.CommentThread>();
  /** Builders whose queue file has been loaded from disk this session. */
  const loaded = new Set<string>();

  function author(): vscode.CommentAuthorInformation {
    return { name: overviewCache.getData()?.currentUser ?? 'architect' };
  }

  /** Register the entry's worktree with the store (derived, never guessed). */
  function registerEntryWorktree(entry: RegisteredFile): boolean {
    if (store.getWorktreePath(entry.builderId)) { return true; }
    const worktree = deriveWorktreePath(entry.fsPath, entry.relPath, path.sep);
    if (!worktree) { return false; }
    store.registerWorktree(entry.builderId, worktree);
    return true;
  }

  /**
   * A queued comment's full anchor range (0-based, clamped to the open
   * document if any). The thread must span the WHOLE recorded range, not just
   * its first line — the widget renders after the range's last line, so a
   * start-line-only thread would visually cut through the commented lines.
   * The range ends at the last line's content end, NOT column 0 of that line:
   * a column-0 end covers zero characters of the last line, so the comment
   * range highlight would skip it (paint 129 but not 130 of a 129-130 span).
   */
  function anchorRange(fsPath: string, range: LineRange): vscode.Range {
    const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === fsPath);
    const { startLine, endLine } = clampAnchorLines(range, doc?.lineCount);
    let endColumn = LAST_COLUMN;
    if (doc) { endColumn = doc.lineAt(endLine).text.length; }
    return new vscode.Range(startLine, 0, endLine, endColumn);
  }

  function mountQueuedComment(fsPath: string, builderId: string, comment: PendingComment): void {
    let range = new vscode.Range(0, 0, 0, 0);
    if (comment.lineRange) { range = anchorRange(fsPath, comment.lineRange); }
    const thread = controller.createCommentThread(vscode.Uri.file(fsPath), range, []);
    if (!comment.lineRange) {
      // Whole-file comment: render as a range-less file comment (the factory
      // signature requires a Range, but the property accepts undefined).
      thread.range = undefined;
    }
    const rendered = new BuilderReviewComment(
      new vscode.MarkdownString(comment.body),
      author(),
      comment.id,
      builderId,
    );
    rendered.parent = thread;
    thread.comments = [rendered];
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    thread.canReply = false;
    thread.contextValue = PENDING_CONTEXT;
    thread.label = 'Pending review comment';
    mounted.set(comment.id, thread);
  }

  /**
   * Diff desired vs mounted threads and apply. Also refreshes the body of an
   * already-mounted comment when it changed underneath (an edit from another
   * window arriving via the store's file watcher).
   */
  async function reconcile(): Promise<void> {
    const entries = getDiffInjectEntries();
    const queues = new Map<string, PendingComment[]>();
    for (const entry of entries) {
      if (queues.has(entry.builderId)) { continue; }
      if (!registerEntryWorktree(entry)) { continue; }
      if (!loaded.has(entry.builderId)) {
        loaded.add(entry.builderId);
        await store.load(entry.builderId);
      }
      queues.set(entry.builderId, store.getComments(entry.builderId));
    }

    const plan = planThreadReconcile(entries, queues, new Set(mounted.keys()));
    for (const id of plan.toDispose) {
      mounted.get(id)?.dispose();
      mounted.delete(id);
    }
    for (const { comment, builderId, fsPath } of plan.toCreate) {
      mountQueuedComment(fsPath, builderId, comment);
    }

    // In-place body refresh for surviving threads.
    for (const [builderId, comments] of queues) {
      for (const comment of comments) {
        const thread = mounted.get(comment.id);
        if (!thread) { continue; }
        const rendered = thread.comments[0] as BuilderReviewComment | undefined;
        if (!rendered || rendered.builderId !== builderId) { continue; }
        if (rendered.mode === vscode.CommentMode.Editing) { continue; }
        if (bodyText(rendered.body) !== comment.body) {
          rendered.body = new vscode.MarkdownString(comment.body);
          rendered.savedBody = comment.body;
          thread.comments = [...thread.comments];
        }
      }
    }
  }

  /**
   * Open the comment input at the given anchor via VS Code's own
   * `workbench.action.addComment` — the same path the gutter "+" takes. A
   * programmatically created thread renders expanded but does NOT focus its
   * input (the stable API has no `CommentThread.reveal`), forcing a second
   * click into the textbox; the built-in command both creates the thread (our
   * range provider covers the file) and focuses the input.
   *
   * The command takes an explicit args object — `range` (1-based editor-core
   * coordinates) or `fileComment` — so the anchor is passed directly instead
   * of mutating the editor selection (which flashed a highlight). A
   * `fileComment` thread materializes with `thread.range === undefined`,
   * which the submit handler records as a whole-file comment.
   */
  async function openCommentInput(fsPath: string, range: LineRange | null): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.fsPath !== fsPath) {
      logFeedbackDebug(`openCommentInput GUARD FAILED: activeEditor=${editor?.document.uri.fsPath ?? 'none'} wanted=${fsPath} → composer NOT opened`);
      return;
    }
    // A box is about to open and take focus — mark the composer open so the deck
    // feedback gestures drive it (submit/cancel) instead of stacking threads (#1552).
    composerOpen = true;
    logFeedbackDebug(`openCommentInput → composerOpen=true (${range ? `range ${range.start}-${range.end}` : 'file'})`);
    if (range) {
      // endColumn spans the last line's content (clamped by the editor);
      // ending at column 1 would exclude the last line from the range
      // highlight entirely.
      let endColumn = LAST_COLUMN;
      const endLine = Math.min(Math.max(range.end - 1, 0), editor.document.lineCount - 1);
      if (endLine >= 0) { endColumn = editor.document.lineAt(endLine).text.length + 1; }
      await vscode.commands.executeCommand('workbench.action.addComment', {
        range: {
          startLineNumber: range.start,
          startColumn: 1,
          endLineNumber: range.end,
          endColumn,
        },
      });
      return;
    }
    await vscode.commands.executeCommand('workbench.action.addComment', { fileComment: true });
  }

  const reg = (id: string, fn: (...args: never[]) => unknown): void => {
    // eslint-disable-next-line no-restricted-syntax -- CLI-independent commands (local queue state), no regCli guard wanted (#791)
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  };

  // Comment-mode codelens entry point. Args match the lens descriptors built
  // in diff-inject-codelens.ts.
  reg(COMMENT_FOR_BUILDER_COMMAND, async (
    _builderId: string,
    fsPath: string,
    _relPath: string,
    range: LineRange | null,
  ) => {
    await openCommentInput(fsPath, range);
  });

  // Context-menu entry: the user's own selection (or cursor line) is already
  // what `workbench.action.addComment` consumes, so no selection surgery is
  // needed here. Available in both modes (the menu always shows both actions).
  reg('codev.commentSelectionForBuilder', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { return; }
    if (!getDiffInjectEntry(editor.document.uri.fsPath)) { return; }
    await vscode.commands.executeCommand('workbench.action.addComment');
  });

  // Submit button on an input thread → deliver the authored comment. The diff
  // codelens mode decides delivery (#1552): forward mode injects the ref +
  // prose into the builder PTY now (the #789 forward path every forward verb
  // uses), comment mode enqueues it for the batched Submit Review. This is the
  // SINGLE authoring surface for both — so the gutter "+", the context-menu
  // action, the comment codelens, and the deck flag gestures all deliver per
  // the current mode (owner-approved at the #1552 plan gate). The input thread
  // is disposed either way; in comment mode the reconciler re-creates the
  // canonical thread from the queue.
  reg('codev.submitBuilderComment', async (reply: vscode.CommentReply) => {
    const thread = reply.thread;
    logFeedbackDebug(`codev.submitBuilderComment FIRED (mode=${getDiffCodelensMode()}, textLen=${reply.text?.length ?? 0})`);
    // Any Submit — empty or not — ends the composer, so the next deck gesture
    // opens a fresh box rather than trying to drive a closed one (#1552).
    composerOpen = false;
    // Empty / whitespace submit leaves nothing behind: no queue entry, no
    // forward, no orphan thread. (Escape/Cancel already disposes the in-progress
    // thread; this covers a Submit with a blank body.)
    const body = reply.text.trim();
    if (!body) { thread.dispose(); return; }
    const entry = getDiffInjectEntry(thread.uri.fsPath);
    if (!entry) {
      vscode.window.showWarningMessage('Codev: This file is not part of an active builder diff');
      return;
    }
    // A range-less thread is a file comment (the file-level lens flow).
    let lineRange: LineRange | null = null;
    if (thread.range) { lineRange = threadLineRange(thread); }

    if (getDiffCodelensMode() === 'forward') {
      const ref = lineRange
        ? buildBuilderRangeRef(entry.relPath, lineRange.start, lineRange.end)
        : buildBuilderFileRef(entry.relPath);
      // The ref carries a trailing space, so `ref + body` reads "<ref> <prose>".
      thread.dispose();
      await vscode.commands.executeCommand('codev.forwardToBuilder', entry.builderId, ref + body);
      return;
    }

    if (!registerEntryWorktree(entry)) {
      vscode.window.showWarningMessage('Codev: This file is not part of an active builder diff');
      return;
    }
    const comment: PendingComment = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      file: entry.relPath,
      lineRange,
      body,
    };
    thread.dispose();
    await store.add(entry.builderId, comment);
  });

  // Cancel button on an input thread → discard the in-progress box, leaving
  // nothing queued or forwarded (#1552). VS Code hands us the thread, so a click
  // disposes it directly (no dependency on a built-in). This is the VISIBLE
  // counterpart to the deck Files-dial cancel and to the canvas composer's
  // explicit Cancel — the box was missing a labelled discard next to Submit.
  reg('codev.cancelBuilderComment', (reply: vscode.CommentReply) => {
    composerOpen = false;
    reply.thread.dispose();
  });

  // Edit flow (#1055 pattern): flip to VS Code's inline edit surface;
  // reassigning `thread.comments` is required for a re-render.
  reg('codev.startEditBuilderComment', (comment: BuilderReviewComment) => {
    const thread = comment.parent;
    if (!thread) { return; }
    comment.savedBody = bodyText(comment.body);
    comment.mode = vscode.CommentMode.Editing;
    thread.comments = [...thread.comments];
  });

  reg('codev.cancelEditBuilderComment', (comment: BuilderReviewComment) => {
    const thread = comment.parent;
    if (!thread) { return; }
    comment.body = new vscode.MarkdownString(comment.savedBody);
    comment.mode = vscode.CommentMode.Preview;
    thread.comments = [...thread.comments];
  });

  reg('codev.saveEditBuilderComment', async (comment: BuilderReviewComment) => {
    const thread = comment.parent;
    if (!thread) { return; }
    const newBody = bodyText(comment.body);
    comment.mode = vscode.CommentMode.Preview;
    comment.savedBody = newBody;
    thread.comments = [...thread.comments];
    await store.edit(comment.builderId, comment.commentId, newBody);
  });

  // Delete from the thread title bar: drop from the queue; the store event
  // drives the reconciler, which disposes the thread.
  reg('codev.deleteBuilderComment', async (thread: vscode.CommentThread) => {
    const rendered = thread.comments[0] as BuilderReviewComment | undefined;
    if (!rendered) {
      thread.dispose();
      return;
    }
    await store.remove(rendered.builderId, [rendered.commentId]);
  });

  context.subscriptions.push(
    onDidChangeDiffInjectRegistry(() => {
      refreshCommentingRanges();
      reconcile();
    }),
    store.onDidChangeQueue(() => { reconcile(); }),
    new vscode.Disposable(() => {
      for (const thread of mounted.values()) { thread.dispose(); }
      mounted.clear();
    }),
  );
  reconcile();
}
