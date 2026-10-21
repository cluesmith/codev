// The decisions file on disk (Spec 1819): where it is, whether it may be touched,
// and how a ruling replaces it.
//
// The path comes from `dashboard.decisionsFile` (workspace-relative), never from a
// request. Every read and write canonicalizes it — symlinks followed — and refuses a
// target outside the canonical workspace root. Writes go through one serializer per
// canonical path and replace the file by renaming a fully written, fsynced temporary
// file over it, so a crash leaves the old file or the new one, never a truncated one.

import crypto from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../../../lib/config.js';
import { KeyedSerializer } from '../write-queue.js';

export const DEFAULT_DECISIONS_FILE = 'codev/state/pending-decisions.md';

/** How long the state flag may reuse a workspace's configured path. */
export const CONFIGURED_PATH_MEMO_MS = 5_000;

export type DecisionsLog = (level: 'INFO' | 'ERROR' | 'WARN', message: string) => void;

export type ResolvedDecisionsPath =
  | {
      inside: true;
      /** The symlink-resolved file the route reads and replaces. */
      canonicalPath: string;
      /** The configured path, relative to the workspace root, for display. */
      displayPath: string;
      /** Whether a regular file is there. */
      exists: boolean;
    }
  | { inside: false; displayPath: string; canonicalPath: string };

type ConfiguredPathOutcome = { ok: true; path: string } | { ok: false; error: Error };

const configuredPathMemo = new Map<string, { at: number; outcome: ConfiguredPathOutcome }>();

/** At most one write per canonical decisions file runs at a time. */
export const decisionsWriteQueue = new KeyedSerializer();

function readConfiguredPath(workspacePath: string): ConfiguredPathOutcome {
  try {
    const value: unknown = loadConfig(workspacePath).dashboard?.decisionsFile;
    if (value === undefined) return { ok: true, path: DEFAULT_DECISIONS_FILE };
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`dashboard.decisionsFile must be a non-empty string, got ${JSON.stringify(value)}`);
    }
    if (path.isAbsolute(value)) {
      throw new Error(`dashboard.decisionsFile must be relative to the workspace root, got ${JSON.stringify(value)}`);
    }
    return { ok: true, path: value };
  } catch (err) {
    return { ok: false, error: err as Error };
  }
}

/**
 * The workspace's configured decisions path (relative to its root). `fresh` reads the
 * config now — the routes always do; otherwise a result up to
 * {@link CONFIGURED_PATH_MEMO_MS} old is reused, because the state flag is polled every
 * second by every open dashboard. The memo holds only the configured path (or the
 * config error), never the decisions file's content. Throws the config error.
 */
export function configuredDecisionsPath(workspacePath: string, { fresh }: { fresh: boolean }): string {
  const memo = configuredPathMemo.get(workspacePath);
  let outcome: ConfiguredPathOutcome;
  if (!fresh && memo && Date.now() - memo.at < CONFIGURED_PATH_MEMO_MS) {
    outcome = memo.outcome;
  } else {
    outcome = readConfiguredPath(workspacePath);
    configuredPathMemo.set(workspacePath, { at: Date.now(), outcome });
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.path;
}

/** Canonicalize a path that may not exist: realpath its nearest existing ancestor. */
async function canonicalize(target: string): Promise<string> {
  const missing: string[] = [];
  let existing = target;
  for (;;) {
    try {
      return path.join(await fsp.realpath(existing), ...missing);
    } catch (err) {
      const parent = path.dirname(existing);
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT' || parent === existing) throw err;
      missing.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * Resolve the configured path against the workspace root. Both are canonicalized
 * (symlinks followed; a missing target through its nearest existing ancestor), and a
 * canonical target outside the canonical root is reported as `inside: false`.
 */
export async function resolveDecisionsPath(workspacePath: string, configuredPath: string): Promise<ResolvedDecisionsPath> {
  const root = await fsp.realpath(workspacePath);
  const target = path.resolve(root, configuredPath);
  const displayPath = path.relative(root, target).split(path.sep).join('/');
  const canonicalPath = await canonicalize(target);
  if (!isInside(root, canonicalPath)) return { inside: false, displayPath, canonicalPath };
  const stat = await fsp.stat(canonicalPath).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  return { inside: true, canonicalPath, displayPath, exists: stat?.isFile() ?? false };
}

/** The last presence-check error logged per workspace, so a poll logs it once, not every second. */
const loggedPresenceError = new Map<string, string>();

/**
 * Whether the Decisions tab should show: the configured file exists inside the
 * workspace. Uses the memoized configured path. A config error is logged and reads as
 * false — it must never fail the state response; the decisions routes report it in full.
 */
export async function decisionsFilePresent(workspacePath: string, log: DecisionsLog): Promise<boolean> {
  try {
    const resolved = await resolveDecisionsPath(workspacePath, configuredDecisionsPath(workspacePath, { fresh: false }));
    loggedPresenceError.delete(workspacePath);
    return resolved.inside && resolved.exists;
  } catch (err) {
    const message = (err as Error).message;
    if (loggedPresenceError.get(workspacePath) !== message) {
      loggedPresenceError.set(workspacePath, message);
      log('WARN', `Decisions tab hidden for ${workspacePath}: ${message}`);
    }
    return false;
  }
}

/**
 * Replace `target` with `text`: write a temporary file in the same directory with the
 * target's permissions, fsync it, and rename it over the target. The temporary file is
 * removed if any step fails, leaving the target untouched. `target` must be the
 * canonical path, so a symlink pointing at it is left in place.
 */
export async function writeFileAtomic(target: string, text: string): Promise<void> {
  const mode = (await fsp.stat(target)).mode & 0o7777;
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${crypto.randomUUID()}.tmp`);
  try {
    const handle = await fsp.open(temp, 'wx', mode);
    try {
      await handle.writeFile(text, 'utf8');
      await handle.chmod(mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsp.rename(temp, target);
  } catch (err) {
    await fsp.rm(temp, { force: true });
    throw err;
  }
}
