/**
 * Host-path helpers for native Windows support (Spec 1658, Phase 10).
 *
 * Each helper keeps the POSIX behavior it replaces and adds the Windows form
 * (backslash separators, drive letters, case-insensitive comparison) behind
 * the platform seam, so a test can exercise the Windows branch on any host.
 */

import { homedir } from 'node:os';
import { isWindows } from './platform.js';

/**
 * Expand a leading `~` to the home directory: `~` alone, `~/...`, and on
 * Windows `~\...`. Anything else (including `~user`) is returned unchanged.
 */
export function expandHomePath(input: string, home: string = homedir()): string {
  if (input === '~') {
    return home;
  }
  if (input.startsWith('~/')) {
    return home + input.slice(1);
  }
  if (isWindows() && input.startsWith('~\\')) {
    return home + input.slice(1);
  }
  return input;
}

/** True when `input` ends with a path separator of the host (`/`, and `\` on Windows). */
export function endsWithHostSeparator(input: string): boolean {
  if (input.endsWith('/')) {
    return true;
  }
  return isWindows() && input.endsWith('\\');
}

/**
 * The last segment of a host path, split on `/` (and `\` on Windows). An
 * input ending in a separator yields `''`, as `split('/').pop()` did.
 */
export function lastPathSegment(input: string): string {
  let segments: string[];
  if (isWindows()) {
    segments = input.split(/[\\/]/);
  } else {
    segments = input.split('/');
  }
  return segments.pop() ?? '';
}

/** Windows comparison form: one separator, no trailing separator, lower case. */
function windowsComparable(input: string): string {
  return input.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

/**
 * True when `candidate` lies strictly under `dir`. POSIX compares bytes with
 * a `/` boundary, as the call sites did. Windows treats `\` and `/` alike and
 * compares case-insensitively, as NTFS paths do by default.
 */
export function isHostPathUnder(candidate: string, dir: string): boolean {
  if (isWindows()) {
    return windowsComparable(candidate).startsWith(windowsComparable(dir) + '\\');
  }
  return candidate.startsWith(dir + '/');
}

/** True when `candidate` is `dir` itself or lies under it (see `isHostPathUnder`). */
export function isHostPathAtOrUnder(candidate: string, dir: string): boolean {
  if (isWindows()) {
    if (windowsComparable(candidate) === windowsComparable(dir)) {
      return true;
    }
    return isHostPathUnder(candidate, dir);
  }
  return candidate === dir || isHostPathUnder(candidate, dir);
}
