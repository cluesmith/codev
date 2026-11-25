/**
 * Issue-id helpers for the Work view (#1740): ids are bare numbers (GitHub,
 * GitLab, Gitea) or tracker keys (Jira, Linear: `ENG-123`).
 *
 * Sync note: `CANONICAL_KEY_SOURCE` twins the codev-side constant in
 * packages/codev/src/lib/issue-id.ts; `issue-id-parity.test.ts` (packages/codev)
 * fails if they drift. `issueRef` mirrors apps/vscode/src/issue-id.ts.
 */

/** The canonical (upper-case) key spelling. Twin of the codev-side CANONICAL_KEY_SOURCE (parity-tested). */
export const CANONICAL_KEY_SOURCE = '[A-Z][A-Z0-9_]*-\\d+';

const CANONICAL_KEY = new RegExp(`^${CANONICAL_KEY_SOURCE}$`);

/**
 * How an issue id reads in labels: `#42` for numbers (and any non-key id, as
 * before), `ENG-123` for a canonical tracker key, which is never written with
 * a `#`.
 */
export function issueRef(id: string): string {
  if (CANONICAL_KEY.test(id)) { return id; }
  return `#${id}`;
}
