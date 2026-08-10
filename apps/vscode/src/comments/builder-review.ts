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
  getDiffCodelensMode,
  getDiffInjectEntry,
  getDiffInjectEntries,
  onDidChangeDiffInjectRegistry,
  COMMENT_FOR_BUILDER_COMMAND,
} from '../diff-inject-codelens.js';
import { planThreadReconcile, deriveWorktreePath, type RegisteredFile } from '../review-queue/reconcile.js';
import type { ReviewQueueStore } from '../review-queue/store.js';
import type { LineRange, PendingComment } from '../review-queue/queue.js';
import type { OverviewCache } from '../views/overview-data.js';

const CONTROLLER_ID = 'codev-builder-review';

/** contextValue on threads/comments — matched by the `comments/*` menu `when` clauses. */
const PENDING_CONTEXT = 'pending-builder-comment';

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
  const controller = vscode.comments.createCommentController(
    CONTROLLER_ID,
    'Codev Builder Review',
  );
  controller.options = {
    prompt: 'Comment for builder',
    placeHolder: 'Type review feedback for the builder, then Queue Comment',
  };
  context.subscriptions.push(controller);

  // Gutter "+" on registered builder-diff files, comment mode only — in
  // forward mode the comment surface recedes so the two modes stay distinct.
  controller.commentingRangeProvider = {
    provideCommentingRanges(document) {
      if (getDiffCodelensMode() !== 'comment') { return []; }
      if (!getDiffInjectEntry(document.uri.fsPath)) { return []; }
      const lastLine = Math.max(0, document.lineCount - 1);
      return [new vscode.Range(0, 0, lastLine, 0)];
    },
  };

  /** Mounted threads keyed by queued-comment id. */
  const mounted = new Map<string, vscode.CommentThread>();
  /**
   * Set when the file-level lens opened the input: the next submit on this
   * file anchored at line 1 records `lineRange: null` (whole-file comment)
   * instead of a misleading L1 ref. Short-lived — cleared on every new input
   * open and every submit, with a time cap for abandoned inputs.
   */
  let pendingWholeFile: { fsPath: string; at: number } | null = null;
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

  /** Anchor line for a queued comment, clamped to the open document if any. */
  function anchorLine(fsPath: string, range: LineRange | null): number {
    let line = 0;
    if (range) { line = Math.max(range.start - 1, 0); }
    const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === fsPath);
    if (doc) { line = Math.min(line, Math.max(doc.lineCount - 1, 0)); }
    return line;
  }

  function mountQueuedComment(fsPath: string, builderId: string, comment: PendingComment): void {
    const line = anchorLine(fsPath, comment.lineRange);
    const thread = controller.createCommentThread(
      vscode.Uri.file(fsPath),
      new vscode.Range(line, 0, line, 0),
      [],
    );
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
   * `workbench.action.addComment` ("Add Comment on Current Selection") — the
   * same path the gutter "+" takes. A programmatically created thread renders
   * expanded but does NOT focus its input (the stable API has no
   * `CommentThread.reveal`), forcing a second click into the textbox; the
   * built-in command both creates the thread (our range provider covers the
   * file) and focuses the input. The thread's range comes from the selection,
   * so the lens range is selected first; the eventual submit reads it back
   * from `thread.range`.
   */
  async function openCommentInput(fsPath: string, range: LineRange | null): Promise<void> {
    let editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.fsPath !== fsPath) {
      editor = vscode.window.visibleTextEditors.find(e => e.document.uri.fsPath === fsPath);
    }
    if (!editor) { return; }
    const lastLine = Math.max(editor.document.lineCount - 1, 0);
    let startLine = 0;
    let endLine = 0;
    if (range) {
      startLine = Math.min(Math.max(range.start - 1, 0), lastLine);
      endLine = Math.min(Math.max(range.end - 1, startLine), lastLine);
    }
    editor.selection = new vscode.Selection(startLine, 0, endLine, 0);
    editor.revealRange(new vscode.Range(startLine, 0, endLine, 0));
    pendingWholeFile = null;
    if (!range) { pendingWholeFile = { fsPath, at: Date.now() }; }
    await vscode.commands.executeCommand('workbench.action.addComment');
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
    pendingWholeFile = null;
    await vscode.commands.executeCommand('workbench.action.addComment');
  });

  // Submit button on an input thread → queue the comment. The input thread is
  // disposed; the reconciler re-creates the canonical thread from the queue.
  reg('codev.submitBuilderComment', async (reply: vscode.CommentReply) => {
    const thread = reply.thread;
    const entry = getDiffInjectEntry(thread.uri.fsPath);
    if (!entry || !registerEntryWorktree(entry)) {
      vscode.window.showWarningMessage('Codev: This file is not part of an active builder diff');
      return;
    }
    let lineRange: LineRange | null = threadLineRange(thread);
    // File-level lens flow: the input was opened at line 1 purely as a mount
    // point; record the comment as whole-file. The 30s cap keeps a marker from
    // an abandoned input from reclassifying a genuine line-1 comment later.
    if (
      pendingWholeFile &&
      pendingWholeFile.fsPath === thread.uri.fsPath &&
      Date.now() - pendingWholeFile.at < 30_000 &&
      lineRange.start === 1 && lineRange.end === 1
    ) {
      lineRange = null;
    }
    pendingWholeFile = null;
    const comment: PendingComment = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      file: entry.relPath,
      lineRange,
      body: reply.text,
    };
    thread.dispose();
    await store.add(entry.builderId, comment);
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
    onDidChangeDiffInjectRegistry(() => { reconcile(); }),
    store.onDidChangeQueue(() => { reconcile(); }),
    new vscode.Disposable(() => {
      for (const thread of mounted.values()) { thread.dispose(); }
      mounted.clear();
    }),
  );
  reconcile();
}
