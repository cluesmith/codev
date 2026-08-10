/**
 * Pure planning logic for mounting queued review comments as visible comment
 * threads in the builder diff (#1037, plan decision 6). No `vscode` import —
 * `comments/builder-review.ts` executes the returned plan against the real
 * Comments API.
 *
 * A queued comment is visible exactly when its file is in the active
 * diff-inject session for its builder (i.e. the reviewer has that builder's
 * diff open). Comments for unopened files stay queued but invisible; threads
 * whose comment left the queue (submitted / deleted) or whose file left the
 * session are disposed.
 */

import type { LineRange, PendingComment } from './queue.js';

/** The subset of a diff-inject session entry the planner needs. */
export interface RegisteredFile {
  fsPath: string;
  builderId: string;
  relPath: string;
}

/** A thread to create: the comment plus where it mounts. */
export interface ThreadPlanEntry {
  comment: PendingComment;
  builderId: string;
  fsPath: string;
}

export interface ThreadReconcilePlan {
  toCreate: ThreadPlanEntry[];
  /** Comment ids whose mounted thread must be disposed. */
  toDispose: string[];
}

/**
 * Diff the desired thread set (registered files × queued comments) against the
 * currently mounted comment ids.
 */
export function planThreadReconcile(
  registered: readonly RegisteredFile[],
  queues: ReadonlyMap<string, readonly PendingComment[]>,
  mountedIds: ReadonlySet<string>,
): ThreadReconcilePlan {
  const desired = new Map<string, ThreadPlanEntry>();
  for (const file of registered) {
    const comments = queues.get(file.builderId) ?? [];
    for (const comment of comments) {
      if (comment.file === file.relPath) {
        desired.set(comment.id, { comment, builderId: file.builderId, fsPath: file.fsPath });
      }
    }
  }
  const toCreate: ThreadPlanEntry[] = [];
  for (const [id, entry] of desired) {
    if (!mountedIds.has(id)) { toCreate.push(entry); }
  }
  const toDispose: string[] = [];
  for (const id of mountedIds) {
    if (!desired.has(id)) { toDispose.push(id); }
  }
  return { toCreate, toDispose };
}

/**
 * Clamp a queued comment's 1-based inclusive anchor range to 0-based line
 * indices within a document of `lineCount` lines (undefined = document not
 * open, no upper clamp). Queued anchors go stale as the builder keeps
 * committing — a range past the current end of file must still mount, on the
 * last line, rather than throw or vanish.
 */
export function clampAnchorLines(
  range: LineRange,
  lineCount: number | undefined,
): { startLine: number; endLine: number } {
  let startLine = Math.max(range.start - 1, 0);
  let endLine = Math.max(range.end - 1, startLine);
  if (lineCount !== undefined) {
    const lastLine = Math.max(lineCount - 1, 0);
    startLine = Math.min(startLine, lastLine);
    endLine = Math.min(endLine, lastLine);
  }
  return { startLine, endLine };
}

/**
 * Recover a worktree root from a diff-inject entry: `fsPath` is always
 * `join(worktreePath, relPath)` (see `view-diff.ts`), so stripping the
 * relative suffix yields the worktree. Returns null when the suffix doesn't
 * match (defensive — never guess a root to write state under).
 */
export function deriveWorktreePath(fsPath: string, relPath: string, sep: string): string | null {
  const suffix = sep + relPath.split('/').join(sep);
  if (!fsPath.endsWith(suffix)) { return null; }
  return fsPath.slice(0, fsPath.length - suffix.length);
}
