/**
 * Pure projection for the contextual panel's Code Review body (#1559): the shown builder's pending
 * review-comment queue plus its files-to-review.
 *
 * EXTENSION-LOCAL by design (unlike the Attention projection in `codev-sdk/builder-helpers`): the
 * queue is a worktree file owned by this extension's `ReviewQueueStore`, and the file list comes from
 * the extension's diff-inject registry — neither is overview wire data another client could share.
 * No `vscode` import, so it is unit-tested directly.
 */

import { formatCommentRef, type PendingComment } from '../review-queue/queue.js';

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

export interface CodeReviewSummary {
  comments: CodeReviewComment[];
  files: CodeReviewFile[];
  isEmpty: boolean;
}

/**
 * Project a builder's queue and the relPaths of its open diff session into the panel payload.
 *
 * Entries already marked `status: 'sent'` (#1562 adds that field) are not pending and are skipped,
 * so both the current and the status-carrying queue shapes project correctly.
 *
 * Comments keep queue (creation) order. Files keep diff-session order, deduplicated, followed by any
 * commented file the session does not list (e.g. the diff was closed and reopened per-file), so every
 * comment's file is always represented.
 */
export function deriveCodeReview(queue: readonly PendingComment[], diffRelPaths: readonly string[]): CodeReviewSummary {
  const comments = queue.filter(isUnsent);
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
    comments: comments.map((c) => ({ id: c.id, file: c.file, ref: formatCommentRef(c.file, c.lineRange), body: c.body })),
    files: ordered.map((relPath) => ({ relPath, commentCount: counts.get(relPath) ?? 0 })),
    isEmpty: comments.length === 0 && ordered.length === 0,
  };
}

/** True unless the entry carries #1562's `status: 'sent'` (read loosely; the field may not exist yet). */
function isUnsent(comment: PendingComment): boolean {
  return (comment as { status?: unknown }).status !== 'sent';
}
