// Discover Kimi Code CLI sessions for a given working directory by inspecting
// Kimi's on-disk session store.
//
// ⚠ UNDOCUMENTED SURFACE. Kimi's command reference
// (https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command.html)
// documents the KIMI_CODE_HOME env var but NOT the store layout beneath it.
// Everything below is observed behavior against kimi 0.27.0 (spike task-Iptx):
//
//   <kimi-home>/sessions/wd_<basename>_<12hex>/session_<uuid>/state.json
//     state.json: { createdAt, updatedAt, workDir, lastPrompt?, title, ... }
//
// `workDir` records the session's exact cwd (stronger than Claude's
// encoded-path store — no encoding ambiguity). Session ids are the
// `session_<uuid>` directory basenames, and match the `session_id` field of
// the `session.resume_hint` stream-json meta line emitted by `kimi -p
// --output-format stream-json`.
//
// Because the layout is undocumented, every function here is fail-soft:
// missing dirs, unreadable files, and malformed JSON yield null/false, never a
// throw. `codev doctor` carries a session-store smoke probe (and a kimi
// >= 0.27.0 version pin) to surface layout drift loudly instead.
//
// The intentionally omitted surface: `session_index.jsonl` (a global id →
// dir/workDir index). The directory scan below is the ground truth the index
// mirrors; reading only the tree keeps us on one undocumented surface, not two.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface KimiSessionState {
  workDir: string;
  updatedAt: string | null;
  lastPrompt: string | null;
}

export interface KimiDiscoveryOpts {
  /** Test seam: overrides both KIMI_CODE_HOME and ~/.kimi-code. */
  kimiHome?: string;
}

/**
 * Resolve the Kimi home directory. KIMI_CODE_HOME is documented (for `kimi
 * doctor`) and honored by the CLI itself, so we honor it too; `opts.kimiHome`
 * lets tests pin a fixture store without touching the environment.
 */
export function getKimiHome(opts?: KimiDiscoveryOpts): string {
  return opts?.kimiHome ?? process.env.KIMI_CODE_HOME ?? join(homedir(), '.kimi-code');
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
 * Two paths refer to the same directory if they match in either logical or
 * physical (symlink-resolved) form — Kimi records its process cwd, which the
 * OS may report physically (e.g. /tmp vs /private/tmp on macOS).
 */
function sameDir(a: string, b: string): boolean {
  if (a === b) return true;
  return realpathOrSelf(a) === realpathOrSelf(b);
}

/** Read and parse a session directory's state.json. Fail-soft: null on any error. */
function readStateJson(sessionDir: string): KimiSessionState | null {
  try {
    const raw = readFileSync(join(sessionDir, 'state.json'), 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.workDir !== 'string') return null;
    return {
      workDir: parsed.workDir,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
      lastPrompt: typeof parsed.lastPrompt === 'string' ? parsed.lastPrompt : null,
    };
  } catch {
    return null;
  }
}

/**
 * Iterate every session directory in the store, yielding
 * { sessionId, sessionDir }. Session dirs live two levels down
 * (sessions/<wd-hash-dir>/<session-dir>); we accept any directory names to
 * stay resilient to hash-scheme changes — state.json parsing is the filter.
 */
function* iterateSessionDirs(kimiHome: string): Generator<{ sessionId: string; sessionDir: string }> {
  const sessionsRoot = join(kimiHome, 'sessions');
  let wdDirs: string[];
  try {
    wdDirs = readdirSync(sessionsRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return;
  }
  for (const wd of wdDirs) {
    let sessionDirs: string[];
    try {
      sessionDirs = readdirSync(join(sessionsRoot, wd), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      continue;
    }
    for (const name of sessionDirs) {
      yield { sessionId: name, sessionDir: join(sessionsRoot, wd, name) };
    }
  }
}

/**
 * Return the session id of the most recent Kimi session whose recorded
 * `workDir` is exactly `absolutePath` (realpath-tolerant), or null when none
 * exists. "Most recent" = max `updatedAt` (ISO timestamp, observed); sessions
 * with an unparseable `updatedAt` rank oldest.
 */
export function findLatestKimiSessionId(
  absolutePath: string,
  opts?: KimiDiscoveryOpts,
): string | null {
  const home = getKimiHome(opts);
  let bestId: string | null = null;
  let bestTime = -Infinity;

  for (const { sessionId, sessionDir } of iterateSessionDirs(home)) {
    const state = readStateJson(sessionDir);
    if (!state || !sameDir(state.workDir, absolutePath)) continue;
    const time = state.updatedAt ? Date.parse(state.updatedAt) : NaN;
    // Unparseable timestamps rank below every real epoch (>= 0) but above the
    // initial -Infinity sentinel, so a lone malformed match is still returned.
    const rank = Number.isNaN(time) ? -1 : time;
    if (rank > bestTime) {
      bestTime = rank;
      bestId = sessionId;
    }
  }
  return bestId;
}

/**
 * Verify that `sessionId` still has a session on disk whose recorded `workDir`
 * is `cwd` (Issue #1145 semantics, Kimi flavor — exact-path match, stronger
 * than Claude's encoded-dir existence check). A stale id (store GC, manual
 * deletion) fails here and callers degrade to a fresh role-injecting spawn
 * instead of baking a fast-failing `kimi -S <dead-id>` into a restart loop.
 */
export function verifyKimiSessionOwnership(
  sessionId: string,
  cwd: string,
  opts?: KimiDiscoveryOpts,
): boolean {
  const state = readKimiSessionState(sessionId, opts);
  return state !== null && sameDir(state.workDir, cwd);
}

/**
 * Read the state.json of a session by id, or null when the session (or a
 * parseable state.json) doesn't exist. Used by the seed-kick verifier
 * (`lastPrompt`/`updatedAt` advance when a message submits — observed) and by
 * doctor's session-store smoke probe.
 */
export function readKimiSessionState(
  sessionId: string,
  opts?: KimiDiscoveryOpts,
): KimiSessionState | null {
  if (!sessionId) return null;
  const home = getKimiHome(opts);
  for (const entry of iterateSessionDirs(home)) {
    if (entry.sessionId === sessionId) {
      return readStateJson(entry.sessionDir);
    }
  }
  return null;
}

/**
 * True when the store root exists but no session directory yields a parseable
 * state.json with a `workDir` — the layout-drift signal doctor's smoke probe
 * warns on. A missing/empty store is NOT drift (fresh install).
 */
export function kimiStoreLayoutLooksDrifted(opts?: KimiDiscoveryOpts): boolean {
  const home = getKimiHome(opts);
  if (!existsSync(join(home, 'sessions'))) return false;
  let sawSessionDir = false;
  for (const { sessionDir } of iterateSessionDirs(home)) {
    sawSessionDir = true;
    if (readStateJson(sessionDir) !== null) return false;
  }
  return sawSessionDir;
}
