/**
 * Issue identifiers in the extension (#1740): bare numbers (GitHub, GitLab,
 * Gitea) or tracker keys (Jira, Linear: `ENG-123`).
 *
 * Sync note: the key grammar twins `ISSUE_KEY_SOURCE` / `CANONICAL_KEY_SOURCE`
 * in packages/codev/src/lib/issue-id.ts (a letter, then letters, digits or
 * underscores, a dash, digits). `issue-id-parity.test.ts` (packages/codev)
 * fails if the copies drift. Every other extension pattern derives from these.
 *
 * vscode-free so it is unit-testable from the vitest harness.
 */

import type { OverviewData } from '@cluesmith/codev-types';

/** Regex source for a key, unanchored. Twin of the codev-side ISSUE_KEY_SOURCE (parity-tested). */
export const ISSUE_KEY_SOURCE = '[A-Za-z][A-Za-z0-9_]*-\\d+';

/** The canonical (upper-case) spelling. Twin of the codev-side CANONICAL_KEY_SOURCE (parity-tested). */
export const CANONICAL_KEY_SOURCE = '[A-Z][A-Z0-9_]*-\\d+';

const ISSUE_KEY = new RegExp(`^${ISSUE_KEY_SOURCE}$`);
const CANONICAL_KEY = new RegExp(`^${CANONICAL_KEY_SOURCE}$`);

/** True for a tracker key such as `ENG-123` (any case). */
export function isIssueKey(value: string): boolean {
  return ISSUE_KEY.test(value);
}

/**
 * Whether a surface should accept key-shaped issue ids, from Tower's
 * `issueIdKind` (#1740):
 *
 * - `'key'` → yes; `'number'` → no (GitHub/GitLab/Gitea stay numeric-only).
 * - Unknown (older Tower, hand-overridden issue concepts, overview not yet
 *   loaded):
 *   - an `explicit` action (the user typed an id into Open Issue by ID) accepts
 *     keys: the worst case is a "could not open" toast, never a valid Jira key
 *     rejected as invalid;
 *   - a `passive` surface (rows offered unasked in the backlog search) offers
 *     keys only when the loaded backlog's ids are keys, so a numeric workspace
 *     never sees a "View Issue UTF-8" row.
 */
export function acceptsIssueKeys(
  data: Pick<OverviewData, 'issueIdKind' | 'backlog'> | null | undefined,
  surface: 'explicit' | 'passive',
): boolean {
  if (data?.issueIdKind === 'key') { return true; }
  if (data?.issueIdKind === 'number') { return false; }
  if (surface === 'explicit') { return true; }
  return !!data?.backlog?.some(item => isIssueKey(item.id));
}

/**
 * How an issue id reads in labels and messages: `#42` for numbers (and any
 * non-key id, as before), `ENG-123` for a canonical tracker key, which is
 * never written with a `#`.
 */
export function issueRef(id: string): string {
  if (CANONICAL_KEY.test(id)) { return id; }
  return `#${id}`;
}

/**
 * The id part of a terminal role id, for matching against overview builders:
 * `builder-pir-eng-123` → `eng-123`, `builder-spir-126` → `126`. Splitting on
 * the last `-` instead would turn a key into its digits and match the wrong
 * builder (#1740).
 */
export function roleShortId(roleId: string): string {
  const m = roleId.match(/^builder-[a-z]+-(.+)$/i);
  if (m) { return m[1]; }
  return roleId.split('-').pop() ?? roleId;
}
