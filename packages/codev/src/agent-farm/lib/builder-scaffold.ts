/**
 * The files `afx spawn` writes into a builder worktree that are not the builder's work
 * (Spec 1951). One rule, so `afx cleanup` and `codev check worktree` agree on what is
 * scaffold:
 *
 *   - any root-level `.builder-*` file (the prompt, role, start script, session id, and the
 *     refresh state files, whose names keep that prefix so they classify as scaffold);
 *   - the write guard's hook script and settings (`worktree-write-guard.ts`);
 *   - OpenCode's `opencode.json`, which points the harness at `.builder-role.md`.
 *
 * Only an untracked file is ever scaffold: a change to a tracked file is a real change,
 * whatever its path.
 *
 * Spawn also links files from the main checkout into the worktree (`symlinkConfigFiles`): the
 * root `.env` and `.codev/config.json` always, and every `worktree.symlinks` entry. Each such
 * link points at the same path in the main checkout, so an entry of that shape is scaffold
 * whichever entry made it: removing it loses nothing (`isSpawnMade`).
 *
 * The module reads the file system and never writes to it or spawns anything.
 */

import { lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { GUARD_SCRIPT_RELPATH, GUARD_SETTINGS_RELPATH } from '../utils/worktree-write-guard.js';

/** Worktree-relative path of the OpenCode harness's role-injection file. */
export const OPENCODE_CONFIG_RELPATH = 'opencode.json';

const BUILDER_PREFIX = '.builder-';

/** The scaffold files with fixed paths; `.builder-*` is matched by prefix. */
export const SCAFFOLD_PATHS: readonly string[] = [GUARD_SCRIPT_RELPATH, GUARD_SETTINGS_RELPATH, OPENCODE_CONFIG_RELPATH];

/** Whether a worktree-relative, `/`-separated path of an untracked file is spawn's scaffold. */
export function isBuilderScaffold(path: string): boolean {
  return (path.startsWith(BUILDER_PREFIX) && !path.includes('/')) || SCAFFOLD_PATHS.includes(path);
}

/**
 * The target spawn gives a link at a worktree-relative, `/`-separated `path`: the same path in
 * the main checkout. A link at `path` whose target is this is one spawn made.
 */
export function spawnLinkTarget(mainRoot: string, path: string): string {
  return join(mainRoot, ...path.split('/'));
}

/** A read that worked, or why it did not. */
export type ScaffoldLookup<T> = { ok: true; value: T } | { ok: false; reason: string };

/** A symbolic link: its target as written, where that points, and whether anything is there. */
export interface WorktreeLink {
  target: string;
  resolved: string;
  missing: boolean;
}

/** A real path for comparison (long names, on-disk case on Windows), or null when it does not exist. */
export function realPath(p: string): string | null {
  try {
    const real = realpathSync.native(p);
    return process.platform === 'win32' ? real.toLowerCase() : real;
  } catch {
    return null;
  }
}

/** A path spelled for comparison: its real path, or, when it does not exist, its parent's. */
export function comparablePath(p: string): string {
  const real = realPath(p);
  if (real !== null) return real;
  const parent = realPath(dirname(p));
  const spelled = parent === null ? resolve(p) : join(parent, basename(p));
  return process.platform === 'win32' ? spelled.toLowerCase() : spelled;
}

/** The link at a worktree-relative, `/`-separated path, or null when the path is not a link. */
export function linkAt(worktree: string, rel: string): ScaffoldLookup<WorktreeLink | null> {
  const abs = join(worktree, ...rel.split('/'));
  try {
    if (!lstatSync(abs).isSymbolicLink()) return { ok: true, value: null };
    const target = readlinkSync(abs);
    const resolved = resolve(dirname(abs), target);
    return { ok: true, value: { target, resolved, missing: realPath(resolved) === null } };
  } catch (err) {
    return { ok: false, reason: `could not read ${rel}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Whether the entry at `rel` is one spawn made, so removing it loses nothing. Spawn links each
 * entry to the same path in the main checkout: a symbolic link where it may make one, else, on
 * native Windows, a hard link of that file, else a copy (`createWorktreeLink`). A copy counts
 * only while its bytes still equal the main checkout's file: one that has changed is data.
 * `link` is `linkAt(worktree, rel)`'s value.
 */
export function isSpawnMade(mainRoot: string, worktree: string, rel: string, link: WorktreeLink | null): ScaffoldLookup<boolean> {
  const source = spawnLinkTarget(mainRoot, rel);
  if (link !== null) return { ok: true, value: comparablePath(link.resolved) === comparablePath(source) };
  const abs = join(worktree, ...rel.split('/'));
  try {
    const main = statSync(source, { bigint: true, throwIfNoEntry: false });
    if (main === undefined || !main.isFile()) return { ok: true, value: false };
    const mine = statSync(abs, { bigint: true });
    if (!mine.isFile()) return { ok: true, value: false };
    if (mine.dev === main.dev && mine.ino === main.ino) return { ok: true, value: true };
    if (mine.size !== main.size) return { ok: true, value: false };
    return { ok: true, value: readFileSync(abs).equals(readFileSync(source)) };
  } catch (err) {
    return { ok: false, reason: `could not compare ${rel} with the main checkout's: ${err instanceof Error ? err.message : String(err)}` };
  }
}
