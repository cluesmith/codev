/**
 * The `codev-diff:` document identity: the JSON query every diff side URI
 * carries, and the parser that recovers a pull-request document from it.
 *
 * Kept apart from `commands/view-diff.ts` (which runs git) so navigation,
 * auto-reveal and the context-key sync can recognise a PR diff without pulling
 * in the git layer. Pure apart from the `Uri` type.
 */

import type * as vscode from 'vscode';

export const DIFF_SCHEME = 'codev-diff';

/** Context key: true when the active tab is a pull-request diff (#2008). Scopes the file-navigation keybindings. */
export const PULL_REQUEST_DIFF_CONTEXT_KEY = 'codev.activeTabIsPullRequestDiff';

/** Which side of a two-commit (pull request) diff a document is. */
export type DiffSide = 'base' | 'head';

export interface DiffQuery {
  /** Repository the blob is read from: a builder worktree, or the main checkout for a PR. */
  wt: string;
  /** Commit (or ref) the blob is read at. */
  ref: string;
  path: string;
  empty?: true;
  binary?: true;
  /**
   * Pull request id. Present only on PR diff documents, so a PR document's
   * identity (PR, commit, path, side) is recoverable from its URI alone.
   * Builder diff URIs never carry it.
   */
  pr?: string;
  /** PR documents only: the merge-base (`base`) or head-commit (`head`) side. */
  side?: DiffSide;
}

export function encodeDiffQuery(q: DiffQuery): string {
  return JSON.stringify(q);
}

export function decodeDiffQuery(query: string): DiffQuery {
  return JSON.parse(query) as DiffQuery;
}

/** A PR diff document's identity, as recovered from its URI. */
export interface PullRequestDiffDocument {
  prId: string;
  relPath: string;
  /** The commit the side shows; empty for an empty/binary placeholder side. */
  sha: string;
  side: DiffSide;
}

/**
 * The PR document a URI names, or undefined for anything else (a builder diff
 * side, a `file:` document, a malformed query).
 */
export function decodePullRequestDiffUri(uri: vscode.Uri | undefined): PullRequestDiffDocument | undefined {
  if (!uri || uri.scheme !== DIFF_SCHEME) { return undefined; }
  let q: DiffQuery;
  try {
    q = decodeDiffQuery(uri.query);
  } catch {
    return undefined;
  }
  if (typeof q.pr !== 'string' || q.pr === '' || (q.side !== 'base' && q.side !== 'head')) {
    return undefined;
  }
  return { prId: q.pr, relPath: q.path, sha: q.ref, side: q.side };
}
