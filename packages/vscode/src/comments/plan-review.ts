/**
 * Codev Plan Review — inline comments on plan/spec files via VSCode's
 * Comments API.
 *
 * Hover any line in `codev/plans/*.md` or `codev/specs/*.md` → a "+" appears
 * in the gutter → click → comment input field opens inline → submit → the
 * comment is written into the file as `<!-- REVIEW(@<author>): <text> -->`
 * on the next line.
 *
 * The HTML-comment serialization re-uses the existing REVIEW convention
 * (codev/protocols/.../review.md, review-decorations.ts highlighting,
 * Codev: Add Review Comment palette command). Builders read REVIEW
 * markers when they re-read the plan and address them inline — no new
 * storage layer, no separate protocol surface to teach.
 *
 * Existing inline REVIEW comments in a file render as collapsed comment
 * threads when the file opens, so reviewers see prior notes as comment
 * UI rather than raw HTML.
 */

import * as vscode from 'vscode';

/**
 * Matches the canonical inline form. Capture groups:
 *   [1] — author (the name inside @...)
 *   [2] — comment body text
 *
 * Tolerant of whitespace; mirrors the regex shape used elsewhere
 * (review-decorations.ts, snippets/review.json).
 */
const REVIEW_COMMENT_PATTERN = /<!--\s*REVIEW\s*\(@([^)]+)\)\s*:\s*([\s\S]*?)\s*-->/g;

const ELIGIBLE_PATH_REGEX = /\/codev\/(plans|specs)\//;

const CONTROLLER_ID = 'codev-review';

/** Tracks threads we created per document URI so we can refresh on edit. */
const threadsByDoc = new Map<string, vscode.CommentThread[]>();

export function activateReviewComments(context: vscode.ExtensionContext): void {
  const controller = vscode.comments.createCommentController(
    CONTROLLER_ID,
    'Codev Plan Review',
  );
  context.subscriptions.push(controller);

  // Where the "+" appears. We accept any line in eligible files.
  controller.commentingRangeProvider = {
    provideCommentingRanges(document) {
      if (!isEligibleDocument(document)) { return []; }
      const lastLine = Math.max(0, document.lineCount - 1);
      return [new vscode.Range(0, 0, lastLine, 0)];
    },
  };

  function refreshDoc(document: vscode.TextDocument): void {
    if (!isEligibleDocument(document)) { return; }

    // Tear down stale threads so we re-create from the current text.
    const key = document.uri.toString();
    const existing = threadsByDoc.get(key) ?? [];
    for (const t of existing) { t.dispose(); }

    const text = document.getText();
    const fresh: vscode.CommentThread[] = [];
    let match: RegExpExecArray | null;
    REVIEW_COMMENT_PATTERN.lastIndex = 0;
    while ((match = REVIEW_COMMENT_PATTERN.exec(text)) !== null) {
      const startPos = document.positionAt(match.index);
      const thread = controller.createCommentThread(
        document.uri,
        new vscode.Range(startPos, startPos),
        [
          {
            body: new vscode.MarkdownString(match[2]),
            mode: vscode.CommentMode.Preview,
            author: { name: match[1] },
            // contextValue is matched in the comment-context menu's `when`
            // clause so the delete button only shows on inline-sourced
            // comments (not on new in-progress threads).
            contextValue: 'inline-review',
          },
        ],
      );
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      thread.canReply = false;
      thread.contextValue = 'inline-review';
      fresh.push(thread);
    }
    threadsByDoc.set(key, fresh);
  }

  // Render for already-open documents.
  for (const doc of vscode.workspace.textDocuments) { refreshDoc(doc); }

  // Refresh on open/change/close.
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(refreshDoc),
    vscode.workspace.onDidChangeTextDocument(e => refreshDoc(e.document)),
    vscode.workspace.onDidCloseTextDocument(doc => {
      const key = doc.uri.toString();
      const threads = threadsByDoc.get(key);
      if (threads) {
        for (const t of threads) { t.dispose(); }
        threadsByDoc.delete(key);
      }
    }),
  );

  // Command: submit a new review comment from an empty thread.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'codev.submitReviewComment',
      async (reply: vscode.CommentReply) => {
        await submitReviewComment(reply);
      },
    ),
  );

  // Command: delete an inline review comment (removes the `<!-- REVIEW... -->`
  // line from the file).
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'codev.deleteReviewComment',
      async (thread: vscode.CommentThread) => {
        await deleteReviewCommentByThread(thread);
      },
    ),
  );
}

async function submitReviewComment(reply: vscode.CommentReply): Promise<void> {
  const thread = reply.thread;
  if (!thread.range) { return; }
  const document = await vscode.workspace.openTextDocument(thread.uri);
  const line = thread.range.start.line;
  const indent = document.lineAt(line).text.match(/^\s*/)?.[0] ?? '';
  // Normalize whitespace — review markers are single-line by convention,
  // and review-decorations.ts assumes the marker fits one line.
  const body = reply.text.replace(/\s+/g, ' ').trim();
  // Author hardcoded to "architect" to match the existing
  // `codev.addReviewComment` palette command (commands/review.ts) and the
  // review.json snippet — same on-disk format from every entry point.
  const commentLine = `${indent}<!-- REVIEW(@architect): ${body} -->`;

  const edit = new vscode.WorkspaceEdit();
  edit.insert(thread.uri, new vscode.Position(line + 1, 0), commentLine + '\n');
  await vscode.workspace.applyEdit(edit);
  await document.save();

  // The change event fires refreshDoc, which disposes the in-progress
  // thread (it's currently in threadsByDoc as a placeholder) and re-creates
  // the canonical thread from the new inline marker.
  thread.dispose();
}

async function deleteReviewCommentByThread(thread: vscode.CommentThread): Promise<void> {
  if (!thread.range) { return; }
  const document = await vscode.workspace.openTextDocument(thread.uri);
  const line = thread.range.start.line;
  if (line >= document.lineCount) { return; }

  // Re-confirm the line is a REVIEW marker (it could have been edited
  // out manually between the user clicking the menu and this handler).
  const lineText = document.lineAt(line).text;
  if (!/^\s*<!--\s*REVIEW\s*\(@[^)]+\)\s*:.*-->/.test(lineText)) { return; }

  const edit = new vscode.WorkspaceEdit();
  // Delete the whole line including its trailing newline.
  const end = line + 1 < document.lineCount
    ? new vscode.Position(line + 1, 0)
    : new vscode.Position(line, lineText.length);
  edit.delete(thread.uri, new vscode.Range(new vscode.Position(line, 0), end));
  await vscode.workspace.applyEdit(edit);
  await document.save();
}

function isEligibleDocument(doc: vscode.TextDocument): boolean {
  if (doc.languageId !== 'markdown') { return false; }
  const fsPath = doc.uri.fsPath.replace(/\\/g, '/');
  return ELIGIBLE_PATH_REGEX.test(fsPath);
}
