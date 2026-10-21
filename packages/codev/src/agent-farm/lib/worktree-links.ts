/**
 * Runnable-worktree links and worktree removal (Spec 1658, Phase 7).
 *
 * Linking: POSIX makes the same `symlinkSync` call it always has. Native
 * Windows creates a symlink only when the account may (Developer Mode or the
 * symlink privilege); otherwise a directory becomes a junction and a file a
 * hard link, or a copy when the hard link cannot be made (another volume, a
 * file system without hard links). A copy does not write through to the
 * workspace root, so callers report it.
 *
 * Removal: a worktree holds links (and on Windows, junctions) into the
 * workspace root. Removal deletes the link entry and never what it points
 * at: every entry is `lstat`ed and a link is unlinked without traversal. On
 * Windows a just-killed session can hold a handle for a moment, so busy
 * entries are retried with backoff; the final failure names the blocking path.
 */

import { copyFileSync, linkSync, statSync, symlinkSync } from 'node:fs';
import { chmod, lstat, readdir, rmdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { isWindows } from '../../lib/platform.js';
import { isUnderTestRunner } from '../../lib/test-env.js';

/** What a worktree entry links to: a single file or a whole directory. */
export type WorktreeEntryKind = 'file' | 'directory';

/** How the link was made. `copy` does not write through to the source. */
export type WorktreeLinkMethod = 'symlink' | 'junction' | 'hardlink' | 'copy';

/**
 * Whether this account may create symlinks on Windows: unknown until the first
 * attempt, which is the probe. Remembered for the rest of the process.
 */
let windowsSymlinksAllowed: boolean | null = null;

/**
 * Set the remembered symlink probe result: `null` forgets it (the next link
 * probes again); `false` makes a real Windows host take the junction and hard
 * link path even where the account may create symlinks.
 */
export function setSymlinkProbeForTests(allowed: boolean | null): void {
  if (!isUnderTestRunner()) {
    throw new Error('setSymlinkProbeForTests is test-only (VITEST or CODEV_TEST_ISOLATION must be set)');
  }
  windowsSymlinksAllowed = allowed;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

/** True when `path` exists and is not a directory. */
function isExistingFile(path: string): boolean {
  try {
    return !statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Try a symlink on Windows. Returns false when the account may not create
 * symlinks (EPERM), remembering that so later links skip the attempt; any
 * other failure is thrown.
 */
function tryWindowsSymlink(source: string, target: string, type: 'file' | 'dir'): boolean {
  if (windowsSymlinksAllowed === false) return false;
  try {
    symlinkSync(source, target, type);
    windowsSymlinksAllowed = true;
    return true;
  } catch (error) {
    if (errorCode(error) !== 'EPERM') throw error;
    windowsSymlinksAllowed = false;
    return false;
  }
}

/** Errors from `linkSync` that mean "no hard link here", answered by a copy. */
const HARDLINK_UNAVAILABLE = new Set(['EXDEV', 'EPERM', 'ENOTSUP', 'EMLINK']);

function linkWindowsFile(source: string, target: string): WorktreeLinkMethod {
  if (tryWindowsSymlink(source, target, 'file')) return 'symlink';
  try {
    linkSync(source, target);
    return 'hardlink';
  } catch (error) {
    if (!HARDLINK_UNAVAILABLE.has(errorCode(error) ?? '')) throw error;
  }
  copyFileSync(source, target);
  return 'copy';
}

/**
 * Link `source` (in the workspace root) to `target` (in the worktree).
 *
 * `posixType` is the `symlinkSync` type argument POSIX passes, kept as given so
 * the POSIX call is the one made before Windows support. On Windows a
 * `directory` entry whose source is an existing file is linked as a file; a
 * missing directory source still gets a junction (a dangling link is accepted,
 * as on POSIX).
 */
export function createWorktreeLink(
  source: string,
  target: string,
  kind: WorktreeEntryKind,
  posixType?: 'dir',
): WorktreeLinkMethod {
  if (!isWindows()) {
    if (kind === 'directory') {
      symlinkSync(source, target, posixType);
    } else {
      symlinkSync(source, target);
    }
    return 'symlink';
  }
  if (kind === 'file' || isExistingFile(source)) return linkWindowsFile(source, target);
  if (tryWindowsSymlink(source, target, 'dir')) return 'symlink';
  symlinkSync(source, target, 'junction');
  return 'junction';
}

// =============================================================================
// Removal
// =============================================================================

/** The file-system calls removal makes; injectable for tests. */
export interface RemovalFs {
  lstat(path: string): Promise<{ isDirectory(): boolean; isSymbolicLink(): boolean }>;
  readdir(path: string): Promise<string[]>;
  rmdir(path: string): Promise<void>;
  unlink(path: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
}

const nodeRemovalFs: RemovalFs = { lstat, readdir, rmdir, unlink, chmod };

export interface RemoveWorktreeOptions {
  fs?: RemovalFs;
  /** Waits between attempts on a busy entry, in milliseconds. */
  retryDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}

/** About 6 seconds in all: long enough for a killed process's handles to close. */
const DEFAULT_RETRY_DELAYS_MS = [100, 200, 400, 800, 1600, 3200];

/** Failures that mean "something still holds this", worth another attempt. */
const BUSY_CODES = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY', 'EACCES']);

/** The final removal failure, naming the entry that could not be removed. */
export class WorktreeRemovalError extends Error {
  constructor(
    readonly path: string,
    readonly code: string | undefined,
  ) {
    let message = `Could not remove ${path} (${code ?? 'unknown error'})`;
    if (BUSY_CODES.has(code ?? '')) message += ': a process may still have it open';
    super(message);
    this.name = 'WorktreeRemovalError';
  }
}

interface RemovalContext {
  fs: RemovalFs;
  delays: readonly number[];
  sleep: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Remove a worktree directory without following any link inside it. A no-op
 * when the path is already gone. Throws `WorktreeRemovalError` naming the
 * first entry that stayed busy through every retry.
 */
export async function removeWorktreeDirectory(path: string, options: RemoveWorktreeOptions = {}): Promise<void> {
  const context: RemovalContext = {
    fs: options.fs ?? nodeRemovalFs,
    delays: options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS,
    sleep: options.sleep ?? defaultSleep,
  };
  await removeEntry(path, context);
}

async function withRetry(path: string, context: RemovalContext, attempt: () => Promise<void>): Promise<void> {
  for (let tries = 0; ; tries++) {
    try {
      await attempt();
      return;
    } catch (error) {
      if (error instanceof WorktreeRemovalError) throw error;
      const code = errorCode(error);
      if (code === 'ENOENT') return;
      if (!BUSY_CODES.has(code ?? '') || tries >= context.delays.length) {
        throw new WorktreeRemovalError(path, code);
      }
      await context.sleep(context.delays[tries]);
    }
  }
}

async function lstatOrNull(path: string, fs: RemovalFs) {
  try {
    return await fs.lstat(path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw new WorktreeRemovalError(path, errorCode(error));
  }
}

async function removeEntry(path: string, context: RemovalContext): Promise<void> {
  const stats = await lstatOrNull(path, context.fs);
  if (stats === null) return;
  if (stats.isSymbolicLink()) {
    // A symlink or junction: delete the entry itself, never its target.
    await withRetry(path, context, () => unlinkLinkEntry(path, context.fs));
    return;
  }
  if (stats.isDirectory()) {
    await withRetry(path, context, async () => {
      for (const child of await context.fs.readdir(path)) {
        await removeEntry(join(path, child), context);
      }
      await context.fs.rmdir(path);
    });
    return;
  }
  await withRetry(path, context, () => unlinkFile(path, context.fs));
}

/**
 * Remove a link entry. A directory symlink or junction on Windows can refuse
 * `unlink`; `rmdir` removes the reparse point without touching its target.
 */
async function unlinkLinkEntry(path: string, fs: RemovalFs): Promise<void> {
  try {
    await fs.unlink(path);
  } catch (error) {
    const code = errorCode(error);
    if (code !== 'EPERM' && code !== 'EISDIR') throw error;
    await fs.rmdir(path);
  }
}

/** Unlink a file; a read-only file (EPERM on Windows) is made writable first. */
async function unlinkFile(path: string, fs: RemovalFs): Promise<void> {
  try {
    await fs.unlink(path);
  } catch (error) {
    if (errorCode(error) !== 'EPERM' || !isWindows()) throw error;
    await fs.chmod(path, 0o666);
    await fs.unlink(path);
  }
}
