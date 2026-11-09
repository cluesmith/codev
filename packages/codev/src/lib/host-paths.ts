/**
 * Host-path helpers for native Windows support (Spec 1658, Phase 10).
 *
 * Thin entry points over the host paths capability (`platform/host-paths.ts`),
 * kept so their call sites do not change (Spec 1658, Amendment 2).
 */

import { homedir } from 'node:os';
import { hostPaths } from './platform/host-paths.js';

/**
 * Expand a leading `~` to the home directory: `~` alone, `~/...`, and on
 * Windows `~\...`. Anything else (including `~user`) is returned unchanged.
 */
export function expandHomePath(input: string, home: string = homedir()): string {
  return hostPaths().expandHome(input, home);
}

/** True when `input` ends with a path separator of the host (`/`, and `\` on Windows). */
export function endsWithHostSeparator(input: string): boolean {
  return hostPaths().endsWithSeparator(input);
}

/**
 * The last segment of a host path, split on `/` (and `\` on Windows). An
 * input ending in a separator yields `''`, as `split('/').pop()` did.
 */
export function lastPathSegment(input: string): string {
  return hostPaths().lastSegment(input);
}

/**
 * True when `candidate` lies strictly under `dir`. POSIX compares bytes with
 * a `/` boundary, as the call sites did. Windows treats `\` and `/` alike and
 * compares case-insensitively, as NTFS paths do by default.
 */
export function isHostPathUnder(candidate: string, dir: string): boolean {
  return hostPaths().isUnder(candidate, dir);
}

/** True when `candidate` is `dir` itself or lies under it (see `isHostPathUnder`). */
export function isHostPathAtOrUnder(candidate: string, dir: string): boolean {
  return hostPaths().isAtOrUnder(candidate, dir);
}
