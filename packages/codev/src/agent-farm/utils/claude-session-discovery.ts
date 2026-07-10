// Discover the most-recent Claude conversation session for a given working
// directory by inspecting Claude Code's on-disk session store.
//
// Claude Code automatically persists every interactive session to
//   ~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl
// where the encoding replaces both '/' and '.' in the absolute path with '-'.
// We use the newest jsonl by mtime as a stand-in for "the last conversation
// that ran in this directory" so reviving a dead builder can resume via
// `claude --resume <uuid>` without any spawn-time bookkeeping.
//
// This is intentionally a heuristic — multiple jsonl files in the same
// directory mean multiple past sessions, and we pick the most recent. For
// builder worktrees (Agent-Farm-managed paths, effectively private cwds) that
// almost always means the right one. Architect launch no longer uses discovery
// at all (Issue #1145): it resumes solely from the session id stored on the
// workspace-scoped architect row, after verifySessionOwnership (below)
// confirms the session still exists on disk.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const JSONL_EXT = '.jsonl';

/**
 * Encode an absolute path to the directory name Claude uses under
 * ~/.claude/projects/. The scheme is: replace every '/' and '.' with '-'.
 *
 * Example: '/Users/x/repos/foo/.builders/pir-1' → '-Users-x-repos-foo--builders-pir-1'
 */
export function encodeClaudeProjectDir(absolutePath: string): string {
  return absolutePath.replace(/[/.]/g, '-');
}

export function getClaudeProjectDir(absolutePath: string): string {
  return join(homedir(), '.claude', 'projects', encodeClaudeProjectDir(absolutePath));
}

/** Canonicalize a path for comparison; fall back to the input when realpath fails. */
function realpathOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Return the session UUID of the most-recently-modified jsonl in the Claude
 * project dir for the given cwd, or null if none exists.
 *
 * `opts.homeDir` lets tests pin the home directory; otherwise resolves via
 * `os.homedir()`.
 */
export function findLatestSessionId(
  absolutePath: string,
  opts?: { homeDir?: string },
): string | null {
  const home = opts?.homeDir ?? homedir();
  const dir = join(home, '.claude', 'projects', encodeClaudeProjectDir(absolutePath));
  if (!existsSync(dir)) return null;

  let bestName: string | null = null;
  let bestMtime = -Infinity;

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(JSONL_EXT)) continue;
    const fullPath = join(dir, entry.name);
    try {
      const mtime = statSync(fullPath).mtimeMs;
      if (mtime > bestMtime) {
        bestMtime = mtime;
        bestName = entry.name;
      }
    } catch {
      // stat failed (race with deletion, permissions) — skip
    }
  }

  if (!bestName) return null;
  return bestName.slice(0, -JSONL_EXT.length);
}

/**
 * Verify that a stored session id still has a session file on disk for
 * `absolutePath` (Issue #1145). Stored ids are minted by us and persisted
 * keyed by workspace path, so existence is the meaningful check: a row can
 * outlive its jsonl (`workspace stop` preserves rows; ~/.claude gets pruned
 * independently), and resuming a deleted session bakes a broken `--resume`
 * into a shellper restart loop (the #929 crash-loop class). A failed check
 * degrades to a fresh spawn.
 */
export function verifySessionOwnership(
  absolutePath: string,
  sessionId: string,
  opts?: { homeDir?: string },
): boolean {
  const home = opts?.homeDir ?? homedir();
  // Claude keys the store dir by its process cwd, which the OS may report in
  // physical (symlink-resolved) form — e.g. /tmp/ws vs /private/tmp/ws on
  // macOS. Accept the session under either encoding of the same directory.
  const candidateDirs = new Set([
    encodeClaudeProjectDir(absolutePath),
    encodeClaudeProjectDir(realpathOrSelf(absolutePath)),
  ]);
  for (const dir of candidateDirs) {
    if (existsSync(join(home, '.claude', 'projects', dir, `${sessionId}${JSONL_EXT}`))) {
      return true;
    }
  }
  return false;
}
