// Discover Kimi Code CLI sessions for a given working directory by inspecting
// Kimi's on-disk session store, and record the workspace trust the pinned-TUI
// launch shape depends on.
//
// ⚠ UNDOCUMENTED SURFACE. Kimi's command reference
// (https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command.html)
// documents the KIMI_CODE_HOME env var but NOT the layouts beneath it.
// Everything below is observed behavior, re-verified against kimi 0.34.0:
//
//   <kimi-home>/sessions/wd_<basename>_<12hex>/session_<uuid>/state.json
//     v2 (0.33.0+): { id: "session_<uuid>", version: 2, cwd, createdAt,
//                     updatedAt, archived, agents, custom, lastTurnReason }
//     v1 (<= 0.32): { createdAt, updatedAt, workDir, lastPrompt?, title, ... }
//
//   <kimi-home>/workspace-trust/wd_<basename-lowercased>_<sha256(root)[:12]>
//     { root, trustedAt }
//
// Kimi releases weekly and 0.33.0 renamed `workDir` → `cwd` and turned the
// timestamps from ISO strings into epoch milliseconds — a rename that silently
// nulled EVERY session parse (seed id-capture, ownership, resume). So the
// readers below accept both shapes, and `inspectKimiStoreLayout` asserts the
// load-bearing fields explicitly so the NEXT rename fails loudly in
// `codev doctor` instead of degrading to a roleless fresh spawn.
//
// Every function here is fail-soft: missing dirs, unreadable files, and
// malformed JSON yield null/false, never a throw.
//
// The intentionally omitted surface: `session_index.jsonl` (a global id →
// dir/cwd index). The directory scan below is the ground truth the index
// mirrors; reading only the tree keeps us on one undocumented surface, not two.

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

export interface KimiSessionState {
  /** The session's working directory (`cwd` on v2, `workDir` on v1). */
  cwd: string;
  /** Epoch ms, normalized from either the v2 number or the v1 ISO string. */
  updatedAt: number | null;
  /** Store schema version when present (v2 sessions carry `version: 2`). */
  version: number | null;
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

/**
 * Normalize a Kimi timestamp to epoch ms. 0.33.0 switched `createdAt`/`updatedAt`
 * from ISO strings to numbers; both are accepted so a store holding sessions from
 * either era still ranks correctly.
 */
function parseTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

/** Read and parse a session directory's state.json. Fail-soft: null on any error. */
function readStateJson(sessionDir: string): KimiSessionState | null {
  try {
    const raw = readFileSync(join(sessionDir, 'state.json'), 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // v2 (0.33.0+) records `cwd`; v1 recorded `workDir`. Accepting both is what
    // keeps a mixed-era store readable — and what stopped 0.33.0 from nulling
    // every parse (the hard `workDir` filter this replaces).
    const dir = typeof parsed.cwd === 'string' ? parsed.cwd
      : typeof parsed.workDir === 'string' ? parsed.workDir
      : null;
    if (dir === null) return null;
    return {
      cwd: dir,
      updatedAt: parseTimestamp(parsed.updatedAt),
      version: typeof parsed.version === 'number' ? parsed.version : null,
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
 *
 * The yielded `sessionId` is the directory basename, which is the full
 * `session_<uuid>` form on 0.33.0+ and matches the `id` field of state.json —
 * the form `kimi -S` accepts. The builder launch path no longer uses `-S` (the
 * crash path resumes with the documented cwd-scoped `-c`), but the id is still
 * the store's identity and what {@link inspectKimiStoreLayout} asserts on.
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
 * Return the session id of the most recent Kimi session whose recorded working
 * directory is exactly `absolutePath` (realpath-tolerant), or null when none
 * exists. "Most recent" = max `updatedAt`; sessions with an unparseable
 * timestamp rank oldest.
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
    if (!state || !sameDir(state.cwd, absolutePath)) continue;
    // Unparseable timestamps rank below every real epoch (>= 0) but above the
    // initial -Infinity sentinel, so a lone malformed match is still returned.
    const rank = state.updatedAt ?? -1;
    if (rank > bestTime) {
      bestTime = rank;
      bestId = sessionId;
    }
  }
  return bestId;
}

/**
 * Verify that `sessionId` still has a session on disk whose recorded working
 * directory is `cwd` (Issue #1145 semantics, Kimi flavor — exact-path match,
 * stronger than Claude's encoded-dir existence check). A stale id (store GC,
 * manual deletion) fails here and callers degrade to a fresh role-injecting
 * spawn instead of baking a fast-failing `kimi -S <dead-id>` into a restart loop.
 */
export function verifyKimiSessionOwnership(
  sessionId: string,
  cwd: string,
  opts?: KimiDiscoveryOpts,
): boolean {
  const state = readKimiSessionState(sessionId, opts);
  return state !== null && sameDir(state.cwd, cwd);
}

/**
 * Read the state.json of a session by id, or null when the session (or a
 * parseable state.json) doesn't exist. Used by ownership verification and by
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
 * What a store-layout smoke probe found. `ok` means at least one session parsed
 * AND carried the load-bearing shape; anything else names what drifted so
 * `codev doctor` can say which assumption broke rather than "something changed".
 */
export type KimiStoreLayout =
  | { status: 'ok'; sampled: number }
  | { status: 'empty' }
  | { status: 'drifted'; reason: string };

/**
 * Assert the store shape this integration actually depends on (Issue #1201).
 *
 * Kimi ships weekly and has already renamed the working-directory field once
 * (`workDir` → `cwd`, 0.33.0), which silently nulled every parse. So this probe
 * checks the load-bearing facts EXPLICITLY — a parseable state.json, a
 * working-directory field, and a `session_`-prefixed id matching what `-S`
 * accepts — and names the first one that fails. A missing/empty store is not
 * drift (fresh install).
 */
export function inspectKimiStoreLayout(opts?: KimiDiscoveryOpts): KimiStoreLayout {
  const home = getKimiHome(opts);
  if (!existsSync(join(home, 'sessions'))) return { status: 'empty' };

  let sawSessionDir = false;
  let sampled = 0;
  let badId: string | null = null;
  for (const { sessionId, sessionDir } of iterateSessionDirs(home)) {
    sawSessionDir = true;
    if (readStateJson(sessionDir) === null) continue;
    // The id `-S` accepts is the directory basename; 0.33.0+ prefixes it.
    if (!sessionId.startsWith('session_')) {
      badId ??= sessionId;
      continue;
    }
    sampled++;
  }
  if (!sawSessionDir) return { status: 'empty' };
  if (sampled > 0) return { status: 'ok', sampled };
  if (badId) {
    return {
      status: 'drifted',
      reason: `session ids are no longer "session_<uuid>" (found "${badId}") — "kimi -S <id>" may reject what discovery returns`,
    };
  }
  return {
    status: 'drifted',
    reason: 'no session state.json carries a working-directory field ("cwd", or legacy "workDir") — builder resume and ownership checks will degrade to fresh spawns',
  };
}

/**
 * Path of the workspace-trust record kimi (0.33.0+) keys off for `root`.
 *
 * ⚠ UNDOCUMENTED, derived by observation on 0.34.0 and verified end-to-end
 * (writing this file makes the TUI open on a composer instead of the dialog):
 * `wd_<basename lowercased>_<sha256(root) first 12 hex>`.
 */
export function kimiTrustRecordPath(root: string, opts?: KimiDiscoveryOpts): string {
  const slug = basename(root).toLowerCase();
  const hash = createHash('sha256').update(root).digest('hex').slice(0, 12);
  return join(getKimiHome(opts), 'workspace-trust', `wd_${slug}_${hash}`);
}

/**
 * Smoke-probe the workspace-trust naming scheme (Issue #1201, guardrail 2).
 *
 * {@link ensureKimiWorkspaceTrust} writes a record whose FILENAME we derive from an
 * undocumented hash scheme. If a Kimi update changes that scheme, our pre-write lands
 * at a path kimi no longer reads: the dialog reappears, every unattended builder stalls
 * on it, and nothing in the codebase notices — the write still "succeeds".
 *
 * So this validates our derivation against kimi's OWN records. Every file kimi wrote
 * carries the `root` it was written for, which lets us recompute the expected filename
 * and compare. Agreement on any record proves the scheme still holds; records present
 * but none agreeing is exactly the drift that would strand builders.
 *
 * A missing/empty trust directory is not drift (nothing trusted yet, or kimi < 0.33.0
 * where no dialog exists) — the same fresh-install tolerance the store probe has.
 */
export function inspectKimiTrustLayout(opts?: KimiDiscoveryOpts): KimiStoreLayout {
  const dir = join(getKimiHome(opts), 'workspace-trust');
  if (!existsSync(dir)) return { status: 'empty' };

  let sawRecord = false;
  let matched = 0;
  let mismatchExample: string | null = null;
  try {
    for (const name of readdirSync(dir)) {
      let root: unknown;
      try {
        root = (JSON.parse(readFileSync(join(dir, name), 'utf-8')) as { root?: unknown }).root;
      } catch {
        continue; // unreadable/!JSON — not evidence either way
      }
      if (typeof root !== 'string' || root.length === 0) continue;
      sawRecord = true;
      if (basename(kimiTrustRecordPath(root, opts)) === name) matched++;
      else mismatchExample ??= name;
    }
  } catch {
    return { status: 'empty' };
  }

  if (!sawRecord) return { status: 'empty' };
  if (matched > 0) return { status: 'ok', sampled: matched };
  return {
    status: 'drifted',
    reason: `workspace-trust record names no longer match the derived "wd_<name>_<sha256(root)[:12]>" scheme (found "${mismatchExample}") — pre-recording trust for new builder worktrees will silently stop working, and unattended builders will stall on the "Trust this folder?" dialog`,
  };
}

/**
 * Pre-record workspace trust for a builder worktree (Issue #1201).
 *
 * WHY THIS EXISTS. kimi 0.33.0 added a startup "Trust this folder?" dialog, and
 * a builder worktree is always a brand-new directory. The dialog renders BEFORE
 * any composer, its only non-trusting option **exits kimi**, and there is no
 * flag, env var, or config key to suppress it (audited against 0.34.0). So an
 * unattended builder would sit on the dialog forever — its task message held by
 * the render gate (correctly: no composer marker) until a human typed into the
 * terminal. That defeats autonomous spawning outright.
 *
 * WHY IT IS SAFE. Trust gates exactly one thing — whether project-level MCP
 * servers (`.mcp.json`, `.kimi-code/mcp.json`) are loaded from the folder. It
 * does not gate tool execution or writes. The record is written ONLY for a
 * worktree Codev itself created, for a builder the human explicitly spawned,
 * which already runs with `--yolo` (auto-approved tool calls) — so this grants
 * strictly less than what launching the builder already authorized, and never
 * touches a directory the user did not hand us.
 *
 * Idempotent (an existing record is left alone) and fail-soft: on any error the
 * dialog simply appears, the gate holds the task message, and the mailbox's
 * escalation surfaces it — never a silent misdelivery.
 *
 * @returns true when a record was written, false when one already existed or the
 *          write failed.
 */
export function ensureKimiWorkspaceTrust(root: string, opts?: KimiDiscoveryOpts): boolean {
  try {
    const file = kimiTrustRecordPath(root, opts);
    if (existsSync(file)) return false;
    mkdirSync(join(getKimiHome(opts), 'workspace-trust'), { recursive: true });
    writeFileSync(file, JSON.stringify({ root, trustedAt: Date.now() }));
    return true;
  } catch {
    return false;
  }
}
