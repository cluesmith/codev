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
 * This is a leaf module (imports only node builtins and the leaf platform seam)
 * so both the data layer (state.ts, db/consolidate.ts) and the server layer
 * (servers/tower-utils.ts and its importers) can share it without a dependency
 * cycle — the reason the data layer previously kept an inline copy rather than
 * importing from the server-layer tower-utils.
 */

import { realpathSync } from 'node:fs';
import { resolve, win32 } from 'node:path';
import { isWindows } from '../../lib/platform.js';

/** The filesystem calls canonicalization uses; injectable for tests. */
export interface WorkspacePathOps {
  realpath: (p: string) => string;
  realpathNative: (p: string) => string;
}

const defaultOps: WorkspacePathOps = {
  realpath: (p) => realpathSync(p),
  realpathNative: (p) => realpathSync.native(p),
};

/**
 * The plain Win32 form of a path: `\\?\C:\x` to `C:\x`, `\\?\UNC\srv\share` to
 * `\\srv\share`, then `c:\x` to `C:\x`. Any other shape is unchanged.
 */
function plainWindowsSpelling(p: string): string {
  let result = p;
  if (result.startsWith('\\\\?\\UNC\\')) {
    result = '\\\\' + result.slice('\\\\?\\UNC\\'.length);
  } else if (/^\\\\\?\\[A-Za-z]:/.test(result)) {
    result = result.slice('\\\\?\\'.length);
  }
  if (/^[a-z]:/.test(result)) {
    result = result[0].toUpperCase() + result.slice(1);
  }
  return result;
}

/**
 * Native answers this process has already seen, by the case-folded lexical form
 * of the input. A directory canonicalized once keeps that answer for the life of
 * the process, so a later transient failure of `realpathSync.native` (a busy or
 * briefly offline share, an antivirus lock) cannot give it a second key in a
 * long-lived Tower. Only successful native answers are cached.
 */
const nativeAnswers = new Map<string, string>();

/** Test-only: forget cached native answers. */
export function resetWorkspacePathCacheForTests(): void {
  nativeAnswers.clear();
}

/**
 * Windows canonical form: the OS's on-disk spelling when the path exists
 * (`realpathSync.native`: true case for every component, 8.3 names expanded,
 * subst and mapped drives resolved to their targets), else an earlier native
 * answer for the same case-folded path, else Node's JS realpath, else
 * `win32.resolve`. Every branch returns the plain Win32 spelling with an
 * upper-case drive letter.
 */
function canonicalWindowsPath(workspacePath: string, ops: WorkspacePathOps): string {
  const folded = win32.resolve(workspacePath).toLowerCase();
  try {
    const answer = plainWindowsSpelling(ops.realpathNative(workspacePath));
    nativeAnswers.set(folded, answer);
    return answer;
  } catch {
    const earlier = nativeAnswers.get(folded);
    if (earlier !== undefined) {
      return earlier;
    }
  }
  try {
    return plainWindowsSpelling(ops.realpath(workspacePath));
  } catch {
    return plainWindowsSpelling(win32.resolve(workspacePath));
  }
}

/** {@link normalizeWorkspacePath} with injectable filesystem calls (tests). */
export function normalizeWorkspacePathWith(workspacePath: string, ops: WorkspacePathOps): string {
  if (isWindows()) {
    return canonicalWindowsPath(workspacePath, ops);
  }
  try {
    return ops.realpath(workspacePath);
  } catch {
    // Path doesn't exist yet — normalize without realpath.
    return resolve(workspacePath);
  }
}

export function normalizeWorkspacePath(workspacePath: string): string {
  return normalizeWorkspacePathWith(workspacePath, defaultOps);
}

/**
 * The key for a workspace in an in-memory map or a stored row. Windows: the
 * canonical path for a drive-letter or UNC path, so any spelling of the directory
 * finds the same entry; any other shape as given. POSIX: the path exactly as given
 * (unchanged behaviour; see #1870).
 */
export function workspaceKey(workspacePath: string): string {
  if (isWindows() && isWindowsAbsolute(workspacePath)) {
    return normalizeWorkspacePath(workspacePath);
  }
  return workspacePath;
}

/**
 * A drive-letter (`C:\x`, `c:/x`) or UNC (`\\srv\share`) path. Only these name a
 * workspace on Windows; anything else (a driveless `/x`, a relative path) is not
 * a spelling Codev produces there, so `workspaceKey` keeps it as given rather
 * than inventing a new key for it from the current drive.
 */
function isWindowsAbsolute(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]{2}[^\\/]/.test(p);
}
