/**
 * What a Work or Decisions webview may make the host do outside it (Spec 1963). A path or URL
 * from a webview is untrusted:
 * - a file opens only when its canonical (symlink-resolved) location is inside the workspace;
 * - a URL opens in the user's browser only when its scheme is `http:` or `https:`.
 *
 * Containment is decided by `path.relative` between canonical paths, never by a string prefix, so
 * `/ws-other` is not inside `/ws`, and on Windows the drive-letter case and `\` / `/` spellings are
 * normalised by the same calls. No `vscode` import.
 */

import { promises as fsp } from 'node:fs';
import * as path from 'node:path';

/**
 * Whether `target` is `root` or lies below it. Both must already be canonical (`fs.realpath`).
 * `pathImpl` is the platform's `path` (`path.win32` in the Windows table tests).
 */
export function isWithin(root: string, target: string, pathImpl: path.PlatformPath = path): boolean {
  const relative = pathImpl.relative(root, target);
  if (relative === '') { return true; }
  if (pathImpl.isAbsolute(relative)) { return false; }
  return relative !== '..' && !relative.startsWith(`..${pathImpl.sep}`);
}

/** Where a requested workspace file is, or why it may not be opened. */
export type WorkspaceFileResolution =
  | { ok: true; path: string }
  | { ok: false; reason: 'outside-workspace' | 'not-found' };

/**
 * The canonical path of `requested` when it is inside the workspace at `root`. A relative
 * `requested` is resolved against the workspace. Both the workspace and the target go through
 * `fs.realpath`, so a symlink (or a Windows junction) that leads outside is refused, and a path that
 * does not exist is `not-found`.
 */
export async function resolveWorkspaceFile(root: string, requested: string): Promise<WorkspaceFileResolution> {
  let canonicalRoot: string;
  let canonicalTarget: string;
  try {
    canonicalRoot = await fsp.realpath(root);
    canonicalTarget = await fsp.realpath(path.resolve(canonicalRoot, requested));
  } catch {
    return { ok: false, reason: 'not-found' };
  }
  if (!isWithin(canonicalRoot, canonicalTarget)) { return { ok: false, reason: 'outside-workspace' }; }
  return { ok: true, path: canonicalTarget };
}

/** Whether a URL from a webview may be opened in the user's browser: `http:` or `https:` only. */
export function isAllowedExternalUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}
