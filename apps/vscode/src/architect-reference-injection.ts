import { issueRef } from './issue-id.js';

/**
 * Pure helper that builds the text injected into the architect terminal
 * by the `codev.referenceIssueInArchitect` command (issue #808).
 *
 * Lives outside `extension.ts` so it can be unit-tested directly without
 * mocking the `vscode` module — same precedent as `prune-builder-terminals.ts`.
 *
 * - Title present → `#<id> "<title>" ` (quoted; trailing space). A tracker
 *   key reads `ENG-123`, without the `#` (#1740).
 * - Title missing/empty → `#<id> ` (preserves pre-#808 behaviour as the
 *   fallback when the source arg isn't a BacklogTreeItem, e.g. the
 *   row-click path that passes only the id string).
 * - Embedded `"` in the title is escaped to `\"` so the quoted span stays
 *   well-formed for any downstream parser. Backslashes are left as-is —
 *   issue titles with literal `\` are vanishingly rare and double-escaping
 *   would diverge from the visible row label.
 */
export function buildArchitectReferenceInjection(issueId: string, title: string | undefined): string {
  if (!title) { return `${issueRef(issueId)} `; }
  const escaped = title.replace(/"/g, '\\"');
  return `${issueRef(issueId)} "${escaped}" `;
}
