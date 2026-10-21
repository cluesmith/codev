/**
 * Issue identifiers (#1740): bare numbers (GitHub, GitLab, Gitea) or tracker
 * keys (Jira, Linear): `ENG-123`.
 *
 * The key grammar is Jira's project-key rule (a letter, then letters, digits or
 * underscores), a dash, then digits. It is a superset of Linear's team keys.
 * This is the one home for it on the codev side; the VS Code extension carries
 * a twinned copy (apps/vscode/src/issue-id.ts) that must stay in sync.
 */

/** Regex source for an issue key, unanchored, for embedding in larger patterns. */
export const ISSUE_KEY_SOURCE = '[A-Za-z][A-Za-z0-9_]*-\\d+';

/** The canonical (upper-case) spelling of a key: what spawn records and artifacts are named by. */
export const CANONICAL_KEY_SOURCE = '[A-Z][A-Z0-9_]*-\\d+';

const ISSUE_KEY = new RegExp(`^${ISSUE_KEY_SOURCE}$`);

/** True for a tracker key such as `ENG-123` (any case); false for a bare number. */
export function isIssueKey(value: string): boolean {
  return ISSUE_KEY.test(value);
}

/**
 * Canonical spelling of an issue id: keys upper-cased (trackers spell them that
 * way, and worktrees, branches and porch state are keyed by the exact string),
 * everything else unchanged.
 */
export function canonicalIssueId(value: string): string {
  if (isIssueKey(value)) return value.toUpperCase();
  return value;
}

/**
 * Parse a CLI issue argument: a positive integer, or a key (canonicalized).
 * Returns undefined for anything else.
 */
export function parseIssueArg(value: string): number | string | undefined {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const parsed = parseInt(trimmed, 10);
    if (parsed > 0) return parsed;
    return undefined;
  }
  if (isIssueKey(trimmed)) return trimmed.toUpperCase();
  return undefined;
}

/**
 * Whether two issue ids name the same issue: keys compare case-insensitively,
 * so a builder recorded as `eng-123` before canonicalization still matches.
 */
export function sameIssueId(a: number | string | undefined, b: number | string | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  return String(a).toUpperCase() === String(b).toUpperCase();
}

/** How an issue id reads in prose: `#42` for a number, `ENG-123` for a key (never `#ENG-123`). */
export function issueRef(id: number | string): string {
  const text = String(id);
  if (isIssueKey(text)) return canonicalIssueId(text);
  return `#${text}`;
}
