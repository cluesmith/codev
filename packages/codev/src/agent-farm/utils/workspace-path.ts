/**
 * Workspace-path canonicalization (single source of truth).
 *
 * The `workspace_path` column keys the architect and builders tables. Writers
 * and readers MUST agree on its exact form, so every callsite normalizes through
 * this one helper: the symlink-dereferenced real path when it exists on disk,
 * else `path.resolve` for not-yet-existing paths (fresh installs).
 *
 * Windows (Spec 1658, finding M6): paths are case-insensitive there, but every
 * key is an exact string, so one directory reached as `c:\repo` (VS Code's
 * `uri.fsPath` lower-cases the drive letter) and `C:\repo` (Git Bash hands Node
 * an upper-case drive) split into two workspaces. On Windows the helper asks the
 * OS for the on-disk spelling (`realpathSync.native`), and whatever fallback
 * answers, the drive letter is upper-cased, so a failed native call can never
 * key the same directory differently from a successful one by drive case alone.
 * POSIX is unchanged (macOS is tracked separately in #1870).
 *
 * This is a leaf module (imports only node builtins and the leaf host-paths capability)
 * so both the data layer (state.ts, db/consolidate.ts) and the server layer
 * (servers/tower-utils.ts and its importers) can share it without a dependency
 * cycle — the reason the data layer previously kept an inline copy rather than
 * importing from the server-layer tower-utils.
 */

import { hostPaths, type WorkspacePathOps } from '../../lib/platform/host-paths.js';
import { defaultWorkspacePathOps, resetWindowsPathCacheForTests } from '../../lib/platform/host-paths.windows.js';

export type { WorkspacePathOps };

/** Test-only: forget the Windows canonicalization cache. */
export function resetWorkspacePathCacheForTests(): void {
  resetWindowsPathCacheForTests();
}

/** {@link normalizeWorkspacePath} with injectable filesystem calls (tests). */
export function normalizeWorkspacePathWith(workspacePath: string, ops: WorkspacePathOps): string {
  return hostPaths().canonicalize(workspacePath, ops);
}

export function normalizeWorkspacePath(workspacePath: string): string {
  return normalizeWorkspacePathWith(workspacePath, defaultWorkspacePathOps);
}

/**
 * The key for a workspace in an in-memory map or a stored row. Windows: the
 * canonical path for a drive-letter or UNC path, so any spelling of the directory
 * finds the same entry; any other shape as given. POSIX: the path exactly as given
 * (unchanged behaviour; see #1870).
 */
export function workspaceKey(workspacePath: string): string {
  return hostPaths().key(workspacePath);
}
