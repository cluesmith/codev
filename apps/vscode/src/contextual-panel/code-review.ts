/**
 * Pure projection for the contextual panel's Code Review body (#1559): the shown builder's pending
 * review-comment queue, its sent-but-unconfirmed comments (#1562), and its files-to-review.
 *
 * EXTENSION-LOCAL by design (unlike the Attention projection in `codev-sdk/builder-helpers`): the
 * queue is a worktree file owned by this extension's `ReviewQueueStore`, and the file list comes from
 * the extension's diff-inject registry — neither is overview wire data another client could share.
 * No `vscode` import, so it is unit-tested directly.
 */

import { formatCommentRef, type PendingComment, type SentComment } from '../review-queue/queue.js';

/** One queued comment as the panel shows it. */
export interface CodeReviewComment {
  id: string;
  /** Repo-relative path of the commented file. */
  file: string;
  /** `path:L42-L58` / `path:L42` / bare `path` for a whole-file comment. */
  ref: string;
  body: string;
}

/** One file in the builder's review set, with how many queued comments anchor to it. */
export interface CodeReviewFile {
  relPath: string;
  commentCount: number;
}

/** A comment Submit Review placed in the builder's prompt, awaiting delivery confirmation. */
export interface CodeReviewSentComment extends CodeReviewComment {
  sentAt: string;
}

export interface CodeReviewSummary {
  /** Still pending (not yet submitted), in queue order. */
  comments: CodeReviewComment[];
  /** Submitted but not confirmed delivered; the next Submit Review offers Re-send / Mark Delivered. */
  sent: CodeReviewSentComment[];
  files: CodeReviewFile[];
  isEmpty: boolean;
}

/**
 * Project a builder's queue state and the relPaths of its open diff session into the panel payload.
 *
 * Comments keep queue (creation) order. Files keep diff-session order, deduplicated, followed by any
 * file a pending comment anchors to that the session does not list (e.g. the diff was closed and
 * reopened per-file), so every pending comment's file is represented. File counts are pending-only:
 * sent comments are already out of the reviewer's hands.
 */
export function deriveCodeReview(
  queue: { comments: readonly PendingComment[]; sent: readonly SentComment[] },
  diffRelPaths: readonly string[],
): CodeReviewSummary {
  const { comments, sent } = queue;
  const counts = new Map<string, number>();
  for (const comment of comments) {
    counts.set(comment.file, (counts.get(comment.file) ?? 0) + 1);
  }

  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const relPath of [...diffRelPaths, ...comments.map((c) => c.file)]) {
    if (relPath.length > 0 && !seen.has(relPath)) {
      seen.add(relPath);
      ordered.push(relPath);
    }
  }

  return {
    comments: comments.map(toPanelComment),
    sent: sent.map((c) => ({ ...toPanelComment(c), sentAt: c.sentAt })),
    files: ordered.map((relPath) => ({ relPath, commentCount: counts.get(relPath) ?? 0 })),
    isEmpty: comments.length === 0 && sent.length === 0 && ordered.length === 0,
  };
}

function toPanelComment(c: PendingComment): CodeReviewComment {
  return { id: c.id, file: c.file, ref: formatCommentRef(c.file, c.lineRange), body: c.body };
}
