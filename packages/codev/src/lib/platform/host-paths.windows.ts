/**
 * Host paths on native Windows (Spec 1658, Amendment 2, phase A2-2).
 *
 * `\` is a separator, comparisons are case-insensitive as NTFS paths are by
 * default, and a workspace path canonicalizes to the OS's on-disk spelling
 * with an upper-case drive letter (finding M6). Each method is the Windows
 * branch its call site used to carry. See `host-paths.ts` for the contract.
 * Leaf module: node builtins and the platform-neutral helpers below only.
 */

import { existsSync, realpathSync } from 'node:fs';
import * as path from 'node:path';
import { win32 } from 'node:path';
import type { HostPaths, WorkspacePathOps } from './host-paths.js';

const defaultOps: WorkspacePathOps = {
  realpath: (p) => realpathSync(p),
  realpathNative: (p) => realpathSync.native(p),
};

/**
 * Compare two Windows paths the way the filesystem does: separators and `.`
 * segments normalized, case-insensitive. Uses `path.win32` explicitly so the
 * comparison is the same when a test forces the platform seam on a POSIX host.
 */
export function sameWindowsPath(a: string, b: string): boolean {
  return win32.resolve(a).toLowerCase() === win32.resolve(b).toLowerCase();
}

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
export function resetWindowsPathCacheForTests(): void {
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

/**
 * A drive-letter (`C:\x`, `c:/x`) or UNC (`\\srv\share`) path. Only these name a
 * workspace on Windows; anything else (a driveless `/x`, a relative path) is not
 * a spelling Codev produces there, so `key` keeps it as given rather than
 * inventing a new key for it from the current drive.
 */
function isWindowsAbsolute(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]{2}[^\\/]/.test(p);
}

/** The canonical path for a drive-letter or UNC path, so any spelling finds the same entry. */
function key(workspacePath: string): string {
  if (isWindowsAbsolute(workspacePath)) {
    return canonicalWindowsPath(workspacePath, defaultOps);
  }
  return workspacePath;
}

/** Windows comparison form: one separator, no trailing separator, lower case. */
function windowsComparable(input: string): string {
  return input.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

function isUnder(candidate: string, dir: string): boolean {
  return windowsComparable(candidate).startsWith(windowsComparable(dir) + '\\');
}

function splitBuilderWorktree(p: string): { workspacePath: string; worktreeDirName: string } | null {
  const match = p.match(/^(.+)[\\/]\.builders[\\/]([^\\/]+)/);
  if (!match) return null;
  return { workspacePath: match[1], worktreeDirName: match[2] };
}

export const windowsHostPaths: HostPaths = Object.freeze<HostPaths>({
  canonicalize: canonicalWindowsPath,

  key,

  expandHome(input, home) {
    if (input === '~') {
      return home;
    }
    if (input.startsWith('~/')) {
      return home + input.slice(1);
    }
    if (input.startsWith('~\\')) {
      return home + input.slice(1);
    }
    return input;
  },

  endsWithSeparator(input) {
    if (input.endsWith('/')) {
      return true;
    }
    return input.endsWith('\\');
  },

  lastSegment(input) {
    return input.split(/[\\/]/).pop() ?? '';
  },

  isUnder,

  isAtOrUnder(candidate, dir) {
    if (windowsComparable(candidate) === windowsComparable(dir)) {
      return true;
    }
    return isUnder(candidate, dir);
  },

  toForwardSlashes(p) {
    return p.split('\\').join('/');
  },

  splitBuilderWorktree,

  hasBuildersSegment(p) {
    return /[\\/]\.builders[\\/]/.test(p);
  },

  lastBuildersMarkerIndex(p) {
    // Normalize the separators for the search only; callers slice the path as spelled.
    return p.replace(/\\/g, '/').lastIndexOf('/.builders/');
  },

  workspaceOfBuilderCwd(cwd) {
    // A native Windows cwd separates with `\` (or a mix).
    const builderMatch = cwd.match(/^(.+)[\\/].builders[\\/][^\\/]+$/);
    if (builderMatch) {
      return builderMatch[1];
    }
    return null;
  },

  isAbsoluteBuilderWorktree(value) {
    // The spawn env carries a native path (`C:\repo\.builders\<id>`), so the
    // drive or UNC root and either separator are accepted.
    return win32.isAbsolute(value) && splitBuilderWorktree(value) !== null;
  },

  sameDirectory: sameWindowsPath,

  canonicalFilePath(raw) {
    // Finding M6: the VS Code host (`c:\`) and the CLI controller (`C:\`) spell
    // one directory differently, so both sides compare the canonical spelling.
    if (existsSync(raw)) {
      return key(raw);
    }
    return path.join(key(path.dirname(raw)), path.basename(raw));
  },
});
