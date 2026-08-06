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
  /** Codelens-supplied ranges for in-progress input threads (null = whole file). */
  const pendingRanges = new Map<vscode.CommentThread, LineRange | null>();
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

  /** Open an empty input thread at the given anchor (codelens / context menu). */
  function mountInputThread(fsPath: string, range: LineRange | null): void {
    const line = anchorLine(fsPath, range);
    const thread = controller.createCommentThread(
      vscode.Uri.file(fsPath),
      new vscode.Range(line, 0, line, 0),
      [],
    );
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    thread.canReply = true;
    pendingRanges.set(thread, range);
  }

  const reg = (id: string, fn: (...args: never[]) => unknown): void => {
    // eslint-disable-next-line no-restricted-syntax -- CLI-independent commands (local queue state), no regCli guard wanted (#791)
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  };

  // Comment-mode codelens entry point. Args match the lens descriptors built
  // in diff-inject-codelens.ts.
  reg(COMMENT_FOR_BUILDER_COMMAND, (
    _builderId: string,
    fsPath: string,
    _relPath: string,
    range: LineRange | null,
  ) => {
    mountInputThread(fsPath, range);
  });

  // Context-menu entry: selection if present, else the cursor line. Available
  // in both modes (the menu always shows both actions).
  reg('codev.commentSelectionForBuilder', () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { return; }
    const entry = getDiffInjectEntry(editor.document.uri.fsPath);
    if (!entry) { return; }
    const sel = editor.selection;
    let start = sel.start.line + 1;
    let end = sel.end.line + 1;
    if (sel.isEmpty) {
      start = editor.selection.active.line + 1;
      end = start;
    } else if (sel.end.character === 0 && sel.end.line > sel.start.line) {
      // A selection ending at column 0 of a line doesn't include that line.
      end = sel.end.line;
    }
    mountInputThread(entry.fsPath, { start, end });
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
    if (pendingRanges.has(thread)) {
      lineRange = pendingRanges.get(thread)!;
    }
    const comment: PendingComment = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      file: entry.relPath,
      lineRange,
      body: reply.text,
    };
    pendingRanges.delete(thread);
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
