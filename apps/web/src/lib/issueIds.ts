/**
 * Issue-id helpers for the dashboard (#1740): ids are bare numbers (GitHub,
 * GitLab, Gitea) or tracker keys (Jira, Linear: `ENG-123`).
 *
 * Sync note: `CANONICAL_KEY_SOURCE` twins the codev-side constant in
 * packages/codev/src/lib/issue-id.ts; `issue-id-parity.test.ts` (packages/codev)
 * fails if they drift. `issueRef` mirrors apps/vscode/src/issue-id.ts.
 */

import type { Builder, OverviewBuilder } from './api.js';

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

/**
 * The terminal tab for an overview builder. The overview's `roleId` is the
 * terminal's id, so an exact (case-insensitive) match comes first. The older
 * substring match is the fallback for a Tower that sends no roleId; it compares
 * case-insensitively because terminal ids are lower-case while tracker keys
 * arrive upper-case (`ENG-123` vs `builder-pir-eng-123`).
 */
export function findBuilderTab(builder: OverviewBuilder, tabs: Builder[] | undefined): Builder | undefined {
  if (!tabs) { return undefined; }
  const role = builder.roleId?.toLowerCase();
  if (role) {
    const exact = tabs.find(t => t.id?.toLowerCase() === role);
    if (exact) { return exact; }
  }
  const needle = (builder.issueId ?? builder.id).toLowerCase();
  return tabs.find(t => t.name?.toLowerCase().includes(needle) || t.id?.toLowerCase().includes(needle));
}
