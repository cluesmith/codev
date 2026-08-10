/**
 * Pure helpers for the per-builder pending review-comment queue (#1037). No
 * `vscode` import, same precedent as `diff-inject-ref.ts`, so the schema,
 * packaging, and exclude-block logic are unit-tested directly.
 *
 * The queue is the structured counterpart to #789's fire-and-forget PTY
 * injection: comments composed in inline threads accumulate here and reach the
 * builder only via a batched Submit Review. The two surfaces never merge
 * state: nothing in this module is touched by the forward flow.
 *
 * On-disk location: `<worktree>/.codev/pending-comments.json`, one file per
 * builder, living inside the builder's worktree so it survives reloads,
 * cannot mix with another builder's queue, and is removed with the worktree
 * by `afx cleanup`.
 */

/** 1-based inclusive line range a comment is anchored to. */
export interface LineRange {
  start: number;
  end: number;
}

export interface PendingComment {
  /** Stable identity (crypto.randomUUID) used for edit/remove and thread keys. */
  id: string;
  /** ISO timestamp; also the queue's ordering key (creation order, no reorder). */
  createdAt: string;
  /** Repo-relative path of the commented file. */
  file: string;
  /** Anchor range; null means the comment is about the whole file. */
  lineRange: LineRange | null;
  /** Markdown body as typed in the comment thread. */
  body: string;
}

/** On-disk shape of `<worktree>/.codev/pending-comments.json`. */
export interface PendingCommentsFile {
  version: 1;
  builderId: string;
  comments: PendingComment[];
}

/** Queue file path relative to the builder's worktree root. */
export const QUEUE_FILE_RELPATH = '.codev/pending-comments.json';

/**
 * Parse a queue file's raw bytes into its comment list. Tolerant by design:
 * corrupt JSON, a wrong top-level shape, or malformed entries read as an
 * empty/partial list rather than throwing, and unknown fields are ignored
 * (so a future field like `diffContext` can appear without a version bump).
 * The caller never rewrites the file on a failed parse — only the next
 * mutation writes, so bad bytes are preserved for inspection until then.
 */
export function parseQueueFile(raw: string): PendingComment[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof data !== 'object' || data === null) { return []; }
  const comments = (data as { comments?: unknown }).comments;
  if (!Array.isArray(comments)) { return []; }
  return comments.filter(isValidComment);
}

function isValidComment(value: unknown): value is PendingComment {
  if (typeof value !== 'object' || value === null) { return false; }
  const c = value as Record<string, unknown>;
  if (typeof c.id !== 'string' || c.id === '') { return false; }
  if (typeof c.createdAt !== 'string') { return false; }
  if (typeof c.file !== 'string' || c.file === '') { return false; }
  if (typeof c.body !== 'string') { return false; }
  if (c.lineRange === null || c.lineRange === undefined) { return true; }
  const r = c.lineRange as Record<string, unknown>;
  return typeof r.start === 'number' && typeof r.end === 'number';
}

export function serializeQueueFile(builderId: string, comments: PendingComment[]): string {
  const file: PendingCommentsFile = { version: 1, builderId, comments };
  return JSON.stringify(file, null, 2) + '\n';
}

// ── Queue mutations (immutable — return a new list) ─────────────────────

export function addComment(comments: PendingComment[], comment: PendingComment): PendingComment[] {
  return [...comments, comment];
}

export function editComment(comments: PendingComment[], id: string, body: string): PendingComment[] {
  return comments.map(c => {
    if (c.id === id) { return { ...c, body }; }
    return c;
  });
}

export function removeComments(comments: PendingComment[], ids: readonly string[]): PendingComment[] {
  const gone = new Set(ids);
  return comments.filter(c => !gone.has(c.id));
}

// ── Submit packaging ────────────────────────────────────────────────────

/** `path:L42-L58`, `path:L42` for a single line, or bare `path` for whole-file. */
export function formatCommentRef(file: string, range: LineRange | null): string {
  if (!range) { return file; }
  if (range.start === range.end) { return `${file}:L${range.start}`; }
  return `${file}:L${range.start}-L${range.end}`;
}

/**
 * Package the queue into the single batched message written to the builder's
 * prompt buffer (plan decision 2): a count header, then one `###` section per
 * comment in creation order. The caller wraps it for the PTY with
 * `wrapBracketedPaste` — this function returns plain markdown.
 */
export function buildSubmitMessage(comments: readonly PendingComment[]): string {
  let noun = 'comments';
  if (comments.length === 1) { noun = 'comment'; }
  const sections = comments.map(
    c => `### ${formatCommentRef(c.file, c.lineRange)}\n${c.body.trim()}`,
  );
  return `Review feedback (${comments.length} ${noun}):\n\n${sections.join('\n\n')}\n`;
}

/**
 * Wrap a multi-line message in bracketed-paste escapes so the builder's REPL
 * treats it as pasted buffer content instead of typed keys — a raw `\n` on the
 * PTY's stdin acts as Enter and would submit the prompt mid-message. Inner
 * newlines become `\r` to match what a terminal emulator emits when pasting
 * (xterm.js converts `\n` to `\r` on paste; Claude Code's REPL expects that
 * form inside a paste block).
 */
export function wrapBracketedPaste(text: string): string {
  return `\x1b[200~${text.replace(/\r?\n/g, '\r')}\x1b[201~`;
}

// ── git info/exclude managed block (plan decision 8) ────────────────────

/**
 * The managed ignore block appended to `$GIT_COMMON_DIR/info/exclude` when the
 * first queue file is created. `info/exclude` lives in the shared common dir,
 * so one write covers every worktree of the repo without a committed
 * `.gitignore` change in adopter repos. The `.builder-*` family glob also
 * silences the spawn scaffolding files (`.builder-prompt.txt`,
 * `.builder-role.md`, `.builder-session-id`, `.builder-start.sh`); it does NOT
 * match the `.builders/` directory (the glob requires a dash after "builder").
 */
export const EXCLUDE_BLOCK_LINES = [
  '# codev: builder worktree local state (managed block)',
  '.builder-*',
  QUEUE_FILE_RELPATH,
] as const;

/**
 * Merge the managed block into an existing `info/exclude` content. Returns the
 * new content to write, or null when the block (keyed on the queue-file line)
 * is already present — the idempotence check, so repeated queue writes never
 * duplicate the block.
 */
export function mergeExcludeBlock(existing: string): string | null {
  const present = existing
    .split('\n')
    .some(line => line.trim() === QUEUE_FILE_RELPATH);
  if (present) { return null; }
  let prefix = existing;
  if (prefix !== '' && !prefix.endsWith('\n')) { prefix += '\n'; }
  return prefix + EXCLUDE_BLOCK_LINES.join('\n') + '\n';
}
