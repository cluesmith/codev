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
import { lastPathSegment } from '../../lib/host-paths.js';
import { isWindows } from '../../lib/platform.js';

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
 * the INNER builder. On Windows `\` is a separator too, so a native path such as
 * `C:\repo\.builders\bugfix-42` splits the same way.
 */
export function parseBuilderWorktreePath(path: string): BuilderWorktreeRef | null {
  let match: RegExpMatchArray | null;
  if (isWindows()) {
    match = path.match(/^(.+)[\\/]\.builders[\\/]([^\\/]+)/);
  } else {
    match = path.match(/^(.+)\/\.builders\/([^/]+)/);
  }
  if (!match) return null;
  return { workspacePath: match[1], worktreeDirName: match[2] };
}

/**
 * Whether `path` contains a `/.builders/` segment, i.e. names a builder worktree
 * or something inside one. On Windows `\` counts as a separator too.
 */
export function containsBuildersSegment(path: string): boolean {
  if (isWindows()) {
    return /[\\/]\.builders[\\/]/.test(path);
  }
  return path.includes('/.builders/');
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
  return rows.find(r => lastPathSegment(r.worktree) === ref.worktreeDirName);
}
