/**
 * Host paths capability (Spec 1658, Amendment 2, phase A2-2).
 *
 * How the host spells, compares and splits paths: workspace canonicalization
 * and keys, home expansion, separators, builder-worktree segments. Shared code
 * asks `hostPaths()` instead of choosing a platform. The POSIX implementation
 * is the macOS/Linux code each call site carried, moved verbatim; the Windows
 * implementation treats `\` as a separator, compares case-insensitively and
 * canonicalizes to the on-disk spelling (finding M6).
 *
 * Leaf module, like the workspace-path helpers it backs: it imports only node
 * builtins and the platform seam, so the data layer and the server layer can
 * both use it without a dependency cycle.
 */

import type { BuilderWorktreeRef } from '../../agent-farm/utils/builder-worktree-identity.js';
import { isWindows } from '../platform.js';
import { posixHostPaths } from './host-paths.posix.js';
import { windowsHostPaths } from './host-paths.windows.js';

/** The filesystem calls canonicalization uses; injectable for tests. */
export interface WorkspacePathOps {
  realpath: (p: string) => string;
  realpathNative: (p: string) => string;
}

export interface HostPaths {
  /** The canonical workspace path (normalizeWorkspacePath). */
  canonicalize(path: string, ops: WorkspacePathOps): string;
  /** The key for a workspace in a map or a stored row (workspaceKey). POSIX: the path as given. */
  key(path: string): string;
  /** Expand a leading `~` to `home`. */
  expandHome(input: string, home: string): string;
  /** True when `input` ends with a host separator. */
  endsWithSeparator(input: string): boolean;
  /** The last segment of a host path (`''` after a trailing separator). */
  lastSegment(input: string): string;
  /** True when `candidate` lies strictly under `dir`. */
  isUnder(candidate: string, dir: string): boolean;
  /** True when `candidate` is `dir` or lies under it. */
  isAtOrUnder(candidate: string, dir: string): boolean;
  /** A path with `/` separators (the form templates and project matchers are written in). */
  toForwardSlashes(path: string): string;
  /** Split `path` at its last `/.builders/<dir>` segment, or null outside a builder worktree. */
  splitBuilderWorktree(path: string): BuilderWorktreeRef | null;
  /** Whether `path` contains a `/.builders/` segment. */
  hasBuildersSegment(path: string): boolean;
  /** Index of the final `/.builders/` marker in `path` (either separator on Windows), or -1. */
  lastBuildersMarkerIndex(path: string): number;
  /** The workspace of a cwd that is a builder worktree root (notifications), or null. */
  workspaceOfBuilderCwd(cwd: string): string | null;
  /** Whether `value` is an absolute path inside a builder worktree (send's identity env). */
  isAbsoluteBuilderWorktree(value: string): boolean;
  /** Whether two paths name the same directory (architect shellper identity). */
  sameDirectory(a: string, b: string): boolean;
  /** A file path in the form the file-tab registry compares (canvas relay). */
  canonicalFilePath(raw: string): string;
}

/** The host's path implementation. */
export function hostPaths(): HostPaths {
  if (isWindows()) {
    return windowsHostPaths;
  }
  return posixHostPaths;
}
