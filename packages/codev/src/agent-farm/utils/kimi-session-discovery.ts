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

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
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
  /**
   * v2's `archived` flag. Load-bearing for resume: kimi excludes archived
   * sessions from the cwd listing `-c` continues from, so treating one as
   * resumable makes `kimi -c` silently start a FRESH, roleless session — the
   * #929 hazard the crash path exists to avoid (CMAP 2026-08-09, codex #1).
   */
  archived: boolean;
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

/** Modification time in epoch ms, or -Infinity when it can't be read (ranks oldest). */
function mtimeOrNegInf(p: string): number {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return -Infinity;
  }
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
      archived: parsed.archived === true,
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
 * Would `kimi -c` actually continue this session?
 *
 * Existing on disk is NOT enough. Kimi lists a cwd's sessions before continuing
 * one, and that listing drops archived sessions and ids it does not recognize —
 * so a session we call resumable but kimi skips sends `-c` down its
 * nothing-to-continue path, which does not fail: it starts a FRESH session that
 * never saw `--agent-file`, i.e. a silently roleless builder (#929 class).
 *
 * Both filters therefore err toward "not resumable", whose fallback is the
 * role-carrying fresh launch — always safe. Deliberately NOT folded into
 * {@link iterateSessionDirs}: {@link inspectKimiStoreLayout} must keep seeing
 * unrecognized ids, because reporting that drift is its entire job.
 */
function isResumable(sessionId: string, state: KimiSessionState): boolean {
  return sessionId.startsWith('session_') && !state.archived;
}

/**
 * Return the session id of the most recent Kimi session whose recorded working
 * directory is exactly `absolutePath` (realpath-tolerant) and that kimi would
 * actually continue (see {@link isResumable}), or null when none exists.
 * "Most recent" = max `updatedAt`; sessions with an unparseable timestamp rank
 * oldest.
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
    if (!isResumable(sessionId, state)) continue;
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
  // Same resumability filter discovery applies: an archived (or unrecognizably
  // named) session exists on disk but is not one `kimi -c` will continue, and
  // claiming ownership of it would hand the caller a resume that silently
  // becomes a roleless fresh session.
  return state !== null && sameDir(state.cwd, cwd) && isResumable(sessionId, state);
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
  // "Some session still matches" is too weak a health signal for a store that
  // migrates: after a rename the OLD sessions keep matching forever and hide every
  // new one, so the probe would report ok through exactly the migration it exists
  // to catch (CMAP 2026-08-09, codex #5). So track the newest conforming session
  // against the newest non-conforming one and report drift only when the bad one is
  // STRICTLY newer — a tie (same timestamp, or no timestamps at all) reports ok,
  // because a doctor warning that depends on directory-iteration order would be
  // worse than the blind spot it closes.
  let newestGood = -Infinity;
  let newestBad = -Infinity;
  let newestBadReason: string | null = null;
  for (const { sessionId, sessionDir } of iterateSessionDirs(home)) {
    sawSessionDir = true;
    const state = readStateJson(sessionDir);
    // The id `-S` accepts is the directory basename; 0.33.0+ prefixes it.
    const goodId = sessionId.startsWith('session_');
    // Directory mtime, for EVERY session — not `updatedAt`. A session whose
    // state.json no longer parses has no `updatedAt` to offer, and mixing the two
    // would compare a kimi timestamp against a filesystem one, which is how the
    // drifted session always wins. One signal, same units, available for all.
    const recency = mtimeOrNegInf(sessionDir);
    if (state !== null && goodId) {
      sampled++;
      if (recency > newestGood) newestGood = recency;
      continue;
    }
    if (state === null) {
      if (recency > newestBad) {
        newestBad = recency;
        newestBadReason = `state.json for "${sessionId}" no longer parses into a working-directory field`;
      }
      continue;
    }
    badId ??= sessionId;
    if (recency > newestBad) {
      newestBad = recency;
      newestBadReason = `session id "${sessionId}" is no longer "session_<uuid>"`;
    }
  }
  if (!sawSessionDir) return { status: 'empty' };
  if (sampled > 0) {
    if (newestBad > newestGood && newestBadReason) {
      return {
        status: 'drifted',
        reason: `the most recently written session no longer matches the shape this integration reads — ${newestBadReason}; older sessions still match, which is what a store migration looks like`,
      };
    }
    return { status: 'ok', sampled };
  }
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
  // Same recency rule as the store probe, and the same conservative tie-break:
  // after a scheme change kimi's OLD records keep agreeing forever, so "any record
  // matches" would report healthy through the exact migration this probe exists to
  // catch. Drift is reported only when the newest DISAGREEING record is strictly
  // newer than every agreeing one.
  let newestAgreeing = -Infinity;
  let newestMismatchTime = -Infinity;
  let newestMismatch: string | null = null;
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
      const agrees = basename(kimiTrustRecordPath(root, opts)) === name;
      const mtime = mtimeOrNegInf(join(dir, name));
      if (agrees) {
        matched++;
        if (mtime > newestAgreeing) newestAgreeing = mtime;
      } else {
        mismatchExample ??= name;
        if (mtime > newestMismatchTime) {
          newestMismatchTime = mtime;
          newestMismatch = name;
        }
      }
    }
  } catch {
    return { status: 'empty' };
  }

  if (!sawRecord) return { status: 'empty' };
  if (newestMismatch && newestMismatchTime > newestAgreeing) {
    return {
      status: 'drifted',
      reason: `the most recently written workspace-trust record ("${newestMismatch}") does not match the derived "wd_<name>_<sha256(root)[:12]>" scheme, though older records still do — that is what a naming-scheme change looks like, and it means pre-recording trust for new builder worktrees has already stopped working`,
    };
  }
  if (matched > 0) return { status: 'ok', sampled: matched };
  return {
    status: 'drifted',
    reason: `workspace-trust record names no longer match the derived "wd_<name>_<sha256(root)[:12]>" scheme (found "${mismatchExample}") — pre-recording trust for new builder worktrees will silently stop working, and unattended builders will stall on the "Trust this folder?" dialog`,
  };
}

/**
 * Project-level MCP config files kimi's folder trust actually gates.
 *
 * Trust decides ONE thing: whether kimi loads MCP servers defined by the folder itself. These
 * are the two paths it reads them from, so their presence is what turns "pre-record trust" from
 * a convenience into a capability grant.
 *
 * Deliberately a literal list rather than a glob: a wrong answer here fails in the unsafe
 * direction (we pre-trust a worktree that ships servers), so the list should grow only from a
 * documented kimi surface, never from a guess about where config *might* live.
 */
const KIMI_PROJECT_MCP_FILES = ['.mcp.json', join('.kimi-code', 'mcp.json')] as const;

/**
 * Why {@link ensureKimiWorkspaceTrust} did or did not write a trust record.
 *
 * A structured result rather than a boolean because the caller has to be able to LOG which
 * refusal happened — "no record was written" covers a deliberate security refusal, an
 * already-trusted worktree, and a failed write, and an operator debugging a builder stalled on
 * the trust dialog needs to know which of the three they are looking at.
 */
export type KimiTrustDecision =
  /** A record was written; kimi will open on a composer instead of the dialog. */
  | { wrote: true }
  /**
   * No record was written. `reason` is which of the four cases applies:
   *
   *  - `not-opted-in` — the default. Pre-writing trust is off unless `.codev/config.json` sets
   *    `harnessOptions.kimi.autoTrustWorkspace`.
   *  - `project-mcp-config` — the worktree ships project-level MCP config, so trusting it grants
   *    "load these servers". Refused even when opted in: this is the one case where the trust
   *    decision is load-bearing, so it is the one case a human has to make.
   *  - `already-trusted` — idempotent no-op, an existing record is never rewritten.
   *  - `write-failed` — the store was unwritable. Fail-soft; never aborts a spawn.
   */
  | {
      wrote: false;
      reason: 'not-opted-in' | 'project-mcp-config' | 'already-trusted' | 'write-failed';
      /** Human-readable specifics for the log line (e.g. which MCP file was found). */
      detail?: string;
    };

/** Options for {@link ensureKimiWorkspaceTrust}. */
export interface KimiTrustOpts extends KimiDiscoveryOpts {
  /**
   * Has the operator explicitly opted this workspace into automatic trust
   * (`harnessOptions.kimi.autoTrustWorkspace` in `.codev/config.json`)?
   *
   * Defaults to **false**, and the default is the point: absent configuration must mean "do not
   * grant anything", not "grant it quietly". A missing/omitted option and an explicit `false`
   * are the same answer.
   */
  autoTrustWorkspace?: boolean;
}

/**
 * The first project-level MCP config present in `root`, or null.
 *
 * Existence only — the file is never read or parsed. An unreadable or malformed `.mcp.json` is
 * still a folder that is trying to define servers, and a parse error must not be the thing that
 * decides we may trust it.
 */
function projectMcpConfigIn(root: string): string | null {
  for (const rel of KIMI_PROJECT_MCP_FILES) {
    try {
      if (existsSync(join(root, rel))) return rel;
    } catch {
      // An unstattable path is not evidence of absence, but it is not evidence of presence
      // either; keep looking and let the remaining checks decide.
    }
  }
  return null;
}

/**
 * Pre-record workspace trust for a builder worktree (Issue #1201), if — and only if — both
 * safety conditions hold.
 *
 * WHY THIS EXISTS. kimi 0.33.0 added a startup "Trust this folder?" dialog, and a builder
 * worktree is always a brand-new directory. The dialog renders BEFORE any composer, its only
 * non-trusting option **exits kimi**, and there is no flag, env var, or config key to suppress
 * it (audited against 0.34.0). So an unattended builder would sit on the dialog forever — its
 * task message held by the render gate (correctly: no composer marker) until a human typed into
 * the terminal. That defeats autonomous spawning outright.
 *
 * WHY IT IS NEVERTHELESS GATED (Issue #1620, the #1328 class). The original argument was that
 * trust grants strictly less than `--yolo`, which the builder already runs with. That is true of
 * *tool execution* and false of the thing trust actually controls: whether kimi loads MCP servers
 * **defined by the folder**. Auto-approving tool calls and permitting a checkout to introduce new
 * tool-providing processes are separate boundaries, and spawning a builder onto a contributor
 * branch is a normal flow in this repository. So:
 *
 *   1. **Opt-in required** (`autoTrustWorkspace`, default false). Silence grants nothing.
 *   2. **Refused outright when the worktree ships project-level MCP config**, opt-in or not —
 *      the one case where the decision has teeth is the one case a human makes.
 *
 * On any refusal the dialog simply appears: kimi shows it, the render gate classifies
 * `no-composer-marker` and HOLDS the task message (never misdelivers it), and because that detail
 * is in the escalation class the hold surfaces through the mailbox's liveness telemetry rather
 * than hanging silently. The caller is expected to log the returned reason.
 *
 * CONSEQUENCE, worth stating plainly: a repository that ships a root `.mcp.json` hits rule 2 on
 * every Kimi builder worktree, so unattended Kimi spawning does not work there until a human
 * trusts the folder once. That is the intended posture, not an oversight.
 *
 * Idempotent (an existing record is left alone) and fail-soft (a write error is reported, never
 * thrown) — a failure here must degrade to the CLI's normal behavior, never abort a spawn.
 */
export function ensureKimiWorkspaceTrust(root: string, opts?: KimiTrustOpts): KimiTrustDecision {
  // Order matters: the security refusal is evaluated BEFORE the opt-in, so the log tells the
  // operator the strongest true reason. Someone who has opted in and still sees no record needs
  // to hear "this worktree ships MCP config", not "you did not opt in" — which would be false.
  const mcp = projectMcpConfigIn(root);
  if (mcp !== null) {
    return {
      wrote: false,
      reason: 'project-mcp-config',
      detail:
        `${root} contains ${mcp}; kimi's folder trust is exactly what gates loading ` +
        `project-defined MCP servers, so this decision is left to a human. kimi will show its ` +
        `"Trust this folder?" dialog and the builder's task will be HELD (not lost) until then.`,
    };
  }

  if (opts?.autoTrustWorkspace !== true) {
    return {
      wrote: false,
      reason: 'not-opted-in',
      detail:
        'automatic workspace trust is off by default; set harnessOptions.kimi.autoTrustWorkspace ' +
        'to true in .codev/config.json to pre-record trust for builder worktrees Codev creates.',
    };
  }

  let file: string;
  try {
    file = kimiTrustRecordPath(root, opts);
    if (existsSync(file)) return { wrote: false, reason: 'already-trusted' };
  } catch (err) {
    return { wrote: false, reason: 'write-failed', detail: String(err) };
  }

  try {
    mkdirSync(join(getKimiHome(opts), 'workspace-trust'), { recursive: true });
    writeFileSync(file, JSON.stringify({ root, trustedAt: Date.now() }));
    return { wrote: true };
  } catch (err) {
    return { wrote: false, reason: 'write-failed', detail: String(err) };
  }
}
