/**
 * Builder identity by worktree path: the one row lookup shared by `afx send`'s
 * `detectCurrentBuilderId` and Tower's lifecycle ingestion (Spec 1595).
 *
 * A builder worktree lives at `<workspace>/.builders/<dir>/`. The owning
 * workspace is the prefix before the LAST `/.builders/` (a nested worktree
 * resolves the inner builder), and the builder's `global.db` row is found among
 * that workspace's rows by worktree path, with a tail-segment fallback for
 * legacy rows that recorded a different absolute prefix.
 *
 * Both sides of the worktree comparison go through `normalizeWorkspacePath`, so a
 * path spelled differently from the stored one (a symlink, a trailing slash, a
 * relative segment; #1809) still matches the same row.
 *
 * Leaf module: node builtins and the path normalizer only.
 */

import { join } from 'node:path';
import { normalizeWorkspacePath } from './workspace-path.js';

/** A builder worktree path split into its owning workspace and directory name. */
export interface BuilderWorktreeRef {
  workspacePath: string;
  worktreeDirName: string;
}

/** The builder row columns the matcher reads. */
export interface BuilderWorktreeRow {
  id: string;
  worktree: string;
}

/**
 * Split `path` at its last `/.builders/<dir>` segment, or `null` when the path
 * is not inside a builder worktree. Greedy `.+` so a nested worktree resolves
 * the INNER builder.
 */
export function parseBuilderWorktreePath(path: string): BuilderWorktreeRef | null {
  const match = path.match(/^(.+)\/\.builders\/([^/]+)/);
  if (!match) return null;
  return { workspacePath: match[1], worktreeDirName: match[2] };
}

/**
 * The row in `rows` (one workspace's builders) that owns `ref`'s worktree: an
 * exact match on the normalized worktree path first, then the legacy
 * tail-segment match. `undefined` when no row matches.
 */
export function matchBuilderRow<T extends BuilderWorktreeRow>(
  rows: readonly T[],
  ref: BuilderWorktreeRef,
): T | undefined {
  const canonicalWorktree = normalizeWorkspacePath(join(ref.workspacePath, '.builders', ref.worktreeDirName));
  const exact = rows.find(r => normalizeWorkspacePath(r.worktree) === canonicalWorktree);
  if (exact) return exact;
  return rows.find(r => r.worktree.split('/').pop() === ref.worktreeDirName);
}
