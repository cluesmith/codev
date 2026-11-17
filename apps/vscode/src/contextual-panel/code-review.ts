/**
 * Pure projection for the contextual panel's review-queue body (#1559): a builder's pending
 * review comments, its sent-but-unconfirmed comments (#1562), and the files they anchor to. Shown in
 * Code Review mode (a builder diff) and in Builder Inspector mode (that builder's terminal).
 *
 * EXTENSION-LOCAL by design (unlike the Attention projection in `codev-sdk/builder-helpers`): the
 * queue is a worktree file owned by this extension's `ReviewQueueStore`, not overview wire data
 * another client could share. No `vscode` import, so it is unit-tested directly.
 */

import { resolveAgentName } from '@cluesmith/codev-sdk/agent-names';
import { formatCommentRef, type PendingComment, type SentComment } from '../review-queue/queue.js';

/** One queued comment as the panel shows it. */
export interface CodeReviewComment {
  id: string;
  /** Repo-relative path of the commented file. */
  file: string;
  /** 1-based first anchored line; null for a whole-file comment. Where a ref click opens. */
  line: number | null;
  /** `path:L42-L58` / `path:L42` / bare `path` for a whole-file comment. */
  ref: string;
  body: string;
}

/** A comment Submit Review placed in the builder's prompt, awaiting delivery confirmation. */
export interface CodeReviewSentComment extends CodeReviewComment {
  sentAt: string;
}

/** One commented file, with how many pending and sent comments anchor to it. */
export interface CodeReviewFile {
  relPath: string;
  pendingCount: number;
  sentCount: number;
}

export interface CodeReviewSummary {
  /** Still pending (not yet submitted), in queue order. */
  comments: CodeReviewComment[];
  /** Submitted but not confirmed delivered: Re-send or Mark Delivered act on these. */
  sent: CodeReviewSentComment[];
  /** Only files that carry a comment, in first-comment order (pending, then sent). */
  files: CodeReviewFile[];
  isEmpty: boolean;
}

/** Project a builder's queue state into the panel payload. */
export function deriveCodeReview(queue: { comments: readonly PendingComment[]; sent: readonly SentComment[] }): CodeReviewSummary {
  const files = new Map<string, CodeReviewFile>();
  const fileFor = (relPath: string): CodeReviewFile => {
    let file = files.get(relPath);
    if (file === undefined) {
      file = { relPath, pendingCount: 0, sentCount: 0 };
      files.set(relPath, file);
    }
    return file;
  };
  for (const comment of queue.comments) {
    fileFor(comment.file).pendingCount += 1;
  }
  for (const comment of queue.sent) {
    fileFor(comment.file).sentCount += 1;
  }

  return {
    comments: queue.comments.map(toPanelComment),
    sent: queue.sent.map((c) => ({ ...toPanelComment(c), sentAt: c.sentAt })),
    files: [...files.values()],
    isEmpty: queue.comments.length === 0 && queue.sent.length === 0,
  };
}

function toPanelComment(c: PendingComment): CodeReviewComment {
  return { id: c.id, file: c.file, line: c.lineRange?.start ?? null, ref: formatCommentRef(c.file, c.lineRange), body: c.body };
}

/**
 * The review-queue key (the overview builder id, which the diff-inject registry and the store use)
 * for a builder shown by its terminal id. The two are different id spaces (bare overview id vs
 * Tower-canonical terminal id), so this matches with the SDK's `resolveAgentName` (case-insensitive
 * exact, then tail-match) against each builder's canonical `roleId` (or its id when it has none), never
 * a raw `===`. An ambiguous or missing match yields undefined: show no queue rather than the wrong one.
 */
export function queueBuilderIdFor(
  shownId: string,
  builders: ReadonlyArray<{ id: string; roleId: string | null }>,
): string | undefined {
  const candidates = builders.map((b) => ({ id: b.roleId ?? b.id, queueId: b.id }));
  return resolveAgentName(shownId, candidates).builder?.queueId;
}
