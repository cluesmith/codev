/**
 * Utility functions for tower server.
 * Spec 0105: Tower Server Decomposition — Phase 1
 *
 * Contains: rate limiting, path normalization, temp directory detection,
 * workspace name extraction, MIME types, and static file serving.
 */

import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import type { ServerResponse } from 'node:http';
import type { RateLimitEntry } from './tower-types.js';
import crypto from 'node:crypto';
import { loadRolePrompt, type RoleConfig } from '../utils/roles.js';
import { getArchitectHarness } from '../utils/config.js';
import { RetiredHarnessError, type HarnessProvider } from '../utils/harness.js';
import { getArchitectByName, setArchitectSessionId } from '../state.js';
import type { CrashLoopFallback, FreshLaunch, ReconnectRestartOptions } from '../../terminal/session-manager.js';
import { cmdlineHoldsSession } from './architect-session-holder.js';

// ============================================================================
// Rate Limiting
// ============================================================================

const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 10;

const activationRateLimits = new Map<string, RateLimitEntry>();

/**
 * Check if a client has exceeded the rate limit for activations.
 * Returns true if rate limit exceeded, false if allowed.
 */
export function isRateLimited(clientIp: string): boolean {
  const now = Date.now();
  const entry = activationRateLimits.get(clientIp);

  if (!entry || now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
    // New window
    activationRateLimits.set(clientIp, { count: 1, windowStart: now });
    return false;
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    return true;
  }

  entry.count++;
  return false;
}

/**
 * Clean up old rate limit entries.
 */
export function cleanupRateLimits(): void {
  const now = Date.now();
  for (const [ip, entry] of activationRateLimits.entries()) {
    if (now - entry.windowStart >= RATE_LIMIT_WINDOW_MS * 2) {
      activationRateLimits.delete(ip);
    }
  }
}

/**
 * Start periodic cleanup of stale rate limit entries.
 * Returns the interval handle so the orchestrator can clear it on shutdown.
 */
export function startRateLimitCleanup(): ReturnType<typeof setInterval> {
  return setInterval(cleanupRateLimits, 5 * 60 * 1000);
}

// ============================================================================
// Path Utilities
// ============================================================================

// Issue #1118: normalizeWorkspacePath moved to the leaf module utils/workspace-path.ts
// so the data layer (state.ts, db/consolidate.ts) can share it without importing
// the server layer. Re-exported here so existing server-side importers are unchanged.
export { normalizeWorkspacePath } from '../utils/workspace-path.js';

/**
 * Get workspace name from path.
 */
export function getWorkspaceName(workspacePath: string): string {
  return path.basename(workspacePath);
}

// Resolve once at module load: both symlinked and real temp dir paths
const _tmpDir = tmpdir();
const _tmpDirResolved = (() => {
  try {
    return fs.realpathSync(_tmpDir);
  } catch {
    return _tmpDir;
  }
})();

/**
 * Check if a workspace path points to a temp directory.
 */
export function isTempDirectory(workspacePath: string): boolean {
  return (
    workspacePath.startsWith(_tmpDir + '/') ||
    workspacePath.startsWith(_tmpDirResolved + '/') ||
    workspacePath.startsWith('/tmp/') ||
    workspacePath.startsWith('/private/tmp/')
  );
}

// ============================================================================
// Language & MIME Detection
// ============================================================================

/**
 * Get language identifier for syntax highlighting.
 */
export function getLanguageForExt(ext: string): string {
  const langMap: Record<string, string> = {
    js: 'javascript', ts: 'typescript', jsx: 'javascript', tsx: 'typescript',
    py: 'python', sh: 'bash', bash: 'bash', md: 'markdown',
    html: 'markup', css: 'css', json: 'json', yaml: 'yaml', yml: 'yaml',
    rs: 'rust', go: 'go', java: 'java', c: 'c', cpp: 'cpp', h: 'c',
  };
  return langMap[ext] || ext || 'plaintext';
}

/**
 * Get MIME type for a file path (by extension).
 */
export function getMimeTypeForFile(filePath: string): string {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const mimeTypes: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
    pdf: 'application/pdf', txt: 'text/plain',
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

// ============================================================================
// Static File Serving
// ============================================================================

/** MIME types for static file serving */
export const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
};

// ============================================================================
// Architect Role Prompt
// ============================================================================

/**
 * Build architect command args with role prompt injected via harness provider.
 * Writes the role to .architect-role.md in the workspace dir and uses the
 * configured harness to determine the correct CLI args and env vars.
 * Returns args and env for the caller to merge into session creation.
 */
export function buildArchitectArgs(baseArgs: string[], workspacePath: string): { args: string[]; env: Record<string, string> } {
  const codevDir = path.join(workspacePath, 'codev');
  const bundledRolesDir = path.resolve(import.meta.dirname, '../../../skeleton/roles');
  const config: RoleConfig = { codevDir, bundledRolesDir, workspaceRoot: workspacePath };

  // Launch-boundary fail-closed (Issue #1338): this is the shared launch-injection
  // helper every architect launch funnels through (fresh/reconnect/add-architect/
  // no-Tower `afx architect`). A retired architect harness (e.g. gemini) makes
  // getArchitectHarness throw RetiredHarnessError — that throw IS the intended
  // behavior: a retired architect must not launch, and the error's message is the
  // full retirement explanation. Do NOT catch-and-swallow it here; the launch
  // entry points surface it cleanly (launchInstance → {success:false, error},
  // addArchitect → {success:false, error}, the `afx architect` CLI prints
  // .message). The non-launch liveness predicate is handled separately in
  // siblingRegistrationIsLive.
  const harness = getArchitectHarness(workspacePath);

  const role = loadRolePrompt(config, 'architect');
  if (!role) return { args: baseArgs, env: {} };

  const roleFile = path.join(workspacePath, '.architect-role.md');
  fs.writeFileSync(roleFile, role.content);

  const injection = harness.buildRoleInjection(role.content, roleFile);

  return {
    args: [...baseArgs, ...injection.args],
    env: injection.env,
  };
}

/**
 * Issue #1145: true when the stored session may be resumed. Harnesses that
 * expose `session.verifyOwnership` get the final say; ones that don't are
 * trusted (their stored ids are minted by us and have no on-disk store to
 * cross-check). A throwing check counts as "not ours".
 */
function sessionIsOwned(
  harness: HarnessProvider,
  sessionId: string,
  workspacePath: string,
  homeDir?: string,
): boolean {
  const verify = harness.session?.verifyOwnership;
  if (!verify) return true;
  try {
    return verify(sessionId, workspacePath, { homeDir });
  } catch {
    return false;
  }
}

/**
 * Snapshot every running process's command line (argv joined). Used to detect a
 * live holder of a conversation session id (Issue #1224). `ps -A -o args=` is
 * accepted by both BSD (macOS) and coreutils (Linux) `ps`; the empty header
 * (`args=`) yields one command line per line. A missing/failing `ps` throws,
 * which the caller treats as "could not determine" (see `sessionHasLiveHolder`).
 */
function listProcessCommandLines(): string[] {
  const out = execFileSync('ps', ['-ww', '-A', '-o', 'args='], {
    encoding: 'utf-8',
    timeout: 5000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return out.split('\n').filter((line) => line.trim() !== '');
}

/**
 * Issue #1224: true when some live process is already running with `sessionId`
 * as a session-flag argument — a claude child (`--session-id <id>` / `--resume
 * <id>`, incl. the `=`-joined forms) OR a shellper parent whose JSON config
 * carries it (`"--session-id","<id>"`). The shellper-parent form matters because
 * a crash-looping remnant's claude child is dead most of the time; the parent's
 * argv is the durable evidence. Resuming a held id bakes `claude --resume <id>`,
 * which dies instantly with "Session ID is already in use" and crash-loops the
 * shellper forever.
 *
 * The match is anchored to the launch flags (see `sessionIdNeedles`) rather than
 * a bare substring: a session id is short in tests and could otherwise coincide
 * with an unrelated path in the process table.
 *
 * This is the simple boolean guard used on the restart-bake path (mint fresh on
 * any holder). The richer own-vs-foreign classification and mint-or-reclaim
 * policy lives in `architect-session-holder.ts` and is wired into the
 * add-architect / launch paths.
 *
 * On any scan failure (`ps` unavailable/timeout) it returns `false`: this guard
 * is purely additive — it diverts to fresh ONLY on positive evidence of a live
 * holder, and never makes an un-held resume worse than today's behavior. The
 * `list` seam exists for tests.
 */
export function sessionHasLiveHolder(
  sessionId: string,
  opts?: { list?: () => string[] },
): boolean {
  const list = opts?.list ?? listProcessCommandLines;
  try {
    return list().some((cmdline) => cmdlineHoldsSession(cmdline, sessionId));
  } catch {
    return false;
  }
}

/**
 * Issue #1150: decide whether a persisted sibling architect row still deserves
 * a respawn, absent any live-terminal evidence (the caller checks
 * `terminal_sessions` first; this covers the session-artifact half).
 *
 * A row is live when:
 *   1. The harness has no `session` capability (Codex/Gemini): such rows can
 *      never carry resumable-session evidence, and their respawn is always a
 *      fresh spawn, so pruning them would break Spec 786 stop/start
 *      persistence while preventing nothing (no conversation can resurrect).
 *   2. The row's stored session id passes the harness ownership check
 *      (`sessionIsOwned`, which also trusts harnesses lacking
 *      `verifyOwnership`: never prune without positive evidence of staleness).
 *
 * A session-capable harness row with no stored id, or an id whose session
 * artifact is gone, is a dead registration: the reconcile loop prunes it
 * instead of resurrecting a removed architect (the #1150 bug class).
 *
 * Issue #1338: a retired architect harness (e.g. gemini) makes getArchitectHarness
 * throw. This is a Tower-side liveness predicate, NOT a launch, so it must not let
 * that throw escape — an uncaught throw here aborts the whole sibling-reconcile
 * pass (tower-instances.ts) for every architect in the workspace. A retired
 * registration can never launch, so it is by definition not live: catch the
 * retirement and return `false` (the reconcile loop then prunes the dead row).
 * Any other error is a real fault and is rethrown unchanged.
 */
export function siblingRegistrationIsLive(
  workspacePath: string,
  sessionId: string | null,
  opts?: { homeDir?: string },
): boolean {
  let harness: HarnessProvider;
  try {
    harness = getArchitectHarness(workspacePath);
  } catch (err) {
    if (err instanceof RetiredHarnessError) return false;
    throw err;
  }
  if (!harness.session) return true;
  if (!sessionId) return false;
  return sessionIsOwned(harness, sessionId, workspacePath, opts?.homeDir);
}

/**
 * Issue #832: resolve the args/env to launch (or revive) an architect, choosing
 * between resuming its persisted conversation and starting a fresh one. The
 * session mechanics are agent-neutral — they come from the resolved harness's
 * `session` capability, so no agent-specific flags appear here.
 *
 * Decision order:
 *   1. Harness has no `session` capability (e.g. Codex/Gemini today) → plain fresh
 *      spawn, `sessionId: null` (nothing to resume next time).
 *   2. `storedSessionId` present AND the harness confirms the session on disk
 *      belongs to this workspace (Issue #1145: harnesses without a
 *      `verifyOwnership` capability are trusted as-is) → resume it (no role
 *      injection — the saved conversation already holds the role/system
 *      prompt); echo the same id back.
 *   3. Else fresh → generate a new id, pin the session to it (with role injection),
 *      and return it for the caller to persist. A stored id that fails
 *      ownership verification (its jsonl no longer exists) lands here, and
 *      the fresh id the caller persists replaces it.
 *
 * The returned `sessionId` is the value the caller writes onto the architect row,
 * so the column is populated correctly on every spawn.
 *
 * Issue #1149: the resume branch also returns `fallback`, the precomputed
 * fresh-launch variant (role injection + newly minted pinned id). Callers hand
 * it to the shellper layer as the crash-loop escape: the #1145 ownership check
 * above validates existence at bake time only, so a session whose jsonl
 * vanishes after the bake (Claude's transcript GC) or is corrupt (existence
 * passes, resume fails) still fast-fails at runtime; the fallback is what the
 * restart loop degrades to. It cannot be "args minus the resume flag" because
 * the resume branch skips role injection.
 */
export interface ArchitectLaunchFallback {
  args: string[];
  env: Record<string, string>;
  sessionId: string;
}

export function resolveArchitectLaunch(opts: {
  workspacePath: string;
  name: string;
  baseArgs: string[];
  storedSessionId?: string | null;
  /** Test seam: pins the home dir the ownership check resolves the session store under. */
  homeDir?: string;
  /**
   * Issue #1224 test seam: override the live-holder detector. Defaults to
   * scanning the real process table via `sessionHasLiveHolder`.
   */
  hasLiveHolder?: (sessionId: string) => boolean;
  /** Optional logger, so the divert-to-fresh decision (Issue #1224) is diagnosable. */
  log?: (level: 'INFO' | 'WARN' | 'ERROR', message: string) => void;
}): {
  args: string[];
  env: Record<string, string>;
  sessionId: string | null;
  resumed: boolean;
  fallback?: ArchitectLaunchFallback;
} {
  const { workspacePath, baseArgs, storedSessionId, homeDir } = opts;
  const hasLiveHolder = opts.hasLiveHolder ?? sessionHasLiveHolder;
  const harness = getArchitectHarness(workspacePath);

  // 1. No resumable-session support → plain fresh, nothing to persist.
  if (!harness.session) {
    return { ...buildArchitectArgs(baseArgs, workspacePath), sessionId: null, resumed: false };
  }

  // Issue #1149: emergency escape hatch. When the stored id passes the
  // existence check but is unresumable in practice (corrupted transcript),
  // restarting Tower with CODEV_SKIP_RESUME=1 forces every architect to a
  // fresh launch without waiting for the automatic crash-loop fallback.
  const skipResume = process.env['CODEV_SKIP_RESUME'] === '1';

  // 2. Resume the persisted conversation (role injection skipped) — but only
  // when the session still exists on disk for this workspace (Issue #1145: a
  // stored id can outlive its jsonl) AND no live process is currently holding
  // it (Issue #1224). A held id — a stale pre-restart shellper's claude child or
  // an unrelated foreground claude — makes `claude --resume <id>` die with
  // "Session ID is already in use" and crash-loop the shellper forever; the
  // #1145 existence check can't catch it, because a held session's jsonl exists
  // precisely because the holder is writing it. Either failure mints fresh.
  const canResume = !skipResume && storedSessionId
    && sessionIsOwned(harness, storedSessionId, workspacePath, homeDir);
  if (canResume && hasLiveHolder(storedSessionId!)) {
    opts.log?.('WARN', `Architect '${opts.name}' stored session ${storedSessionId!.slice(0, 8)}… is held by a live process; minting a fresh session to avoid a collision crash loop in ${workspacePath}`);
  } else if (canResume) {
    const fallbackSessionId = crypto.randomUUID();
    const fresh = buildArchitectArgs(
      [...baseArgs, ...harness.session.newSessionArgs(fallbackSessionId)],
      workspacePath,
    );
    return {
      args: [...baseArgs, ...harness.session.resumeArgs(storedSessionId)],
      env: {},
      sessionId: storedSessionId,
      resumed: true,
      fallback: { args: fresh.args, env: fresh.env, sessionId: fallbackSessionId },
    };
  }

  // 3. Fresh: mint an id, pin the session to it, persist it via the returned id.
  const sessionId = crypto.randomUUID();
  const built = buildArchitectArgs([...baseArgs, ...harness.session.newSessionArgs(sessionId)], workspacePath);
  return { ...built, sessionId, resumed: false };
}

/**
 * Issue #832: resolve launch args for an architect being auto-restarted by its
 * shellper (claude crash / reconnect). Reads the architect's stored conversation
 * `session_id` from its state.db row and hands it to `resolveArchitectLaunch`, so an
 * in-process crash revives the SAME conversation (the silent-context-loss path)
 * instead of spawning fresh. A legacy row with no stored id resolves to a fresh
 * session (then self-heals on its next cold revival via the spawn-path persist).
 *
 * Unlike the cold-spawn `main` path, there is **no** jsonl-discovery fallback here —
 * the restart sites rely solely on the stored id (matching #830, which never resumed
 * at restart). Both shellper restart-bake sites in `tower-terminals.ts` call this so
 * the read→resolve wiring lives in one tested place. Returns `resolveArchitectLaunch`'s
 * result plus the `storedSessionId` the caller uses for the "Resuming…" log line.
 */
export function resolveArchitectRestart(
  workspacePath: string,
  architectName: string,
  baseArgs: string[],
  opts?: { homeDir?: string; log?: (level: 'INFO' | 'WARN' | 'ERROR', message: string) => void },
): {
  args: string[];
  env: Record<string, string>;
  sessionId: string | null;
  resumed: boolean;
  storedSessionId: string | null;
  fallback?: ArchitectLaunchFallback;
} {
  const storedSessionId = getArchitectByName(workspacePath, architectName)?.sessionId ?? null;
  const resolved = resolveArchitectLaunch({
    workspacePath, name: architectName, baseArgs, storedSessionId, homeDir: opts?.homeDir, log: opts?.log,
    // Issue #1224: never run the live-holder check on the restart-bake path. The
    // holder of this session at bake time is THIS shellper's own child (its argv
    // carries --resume <id>), so a self-detection would bake fresh restart args
    // on every healthy reconnect and lose conversation continuity on the next
    // child crash. Collision-avoidance for a genuinely-held id belongs at the
    // add-architect / main-launch reconcile layer (mint-or-reclaim), and the
    // #1149 crash-loop fallback is the runtime backstop if a baked resume does
    // collide. So resume when owned; do not holder-check here.
    hasLiveHolder: () => false,
  });
  return { ...resolved, storedSessionId };
}

/**
 * Issue #1149: build the crash-loop fallback handed to the shellper layer when
 * an architect launch resumes a stored conversation. If the resumed session
 * fast-fails (the SessionManager detector), the restart loop swaps to this
 * fresh launch and `onApply` repairs the architect row so future bakes resume
 * the replacement conversation instead of relearning the unresumable id.
 *
 * The minted id is persisted rather than NULL: a NULL id would trip #1150's
 * dead-registration pruning for siblings, and #1145's ownership check already
 * defuses a minted id whose jsonl never materializes (next bake degrades to a
 * fresh spawn with zero crash cycles).
 */
export function buildArchitectCrashLoopFallback(opts: {
  workspacePath: string;
  architectName: string;
  storedSessionId: string;
  fallback: ArchitectLaunchFallback;
  baseEnv: Record<string, string>;
  log: (level: 'INFO' | 'ERROR' | 'WARN', message: string) => void;
}): CrashLoopFallback {
  const { workspacePath, architectName, storedSessionId, fallback, baseEnv, log } = opts;
  return {
    args: fallback.args,
    env: { ...baseEnv, ...fallback.env },
    onApply: () => {
      log('WARN', `Architect '${architectName}' resume session ${storedSessionId.slice(0, 8)}… unrecoverable; falling back to a fresh session in ${workspacePath}`);
      try {
        setArchitectSessionId(workspacePath, architectName, fallback.sessionId);
      } catch (err) {
        log('WARN', `Failed to persist replacement session id for architect '${architectName}': ${err instanceof Error ? err.message : err}`);
      }
    },
  };
}

/**
 * Issue #1264: the fresh-launch factory a shellper session uses to rerun the
 * architect's harness after a *clean* exit (double Ctrl-C, `/quit`, `exit`).
 *
 * A clean exit means the user deliberately left that conversation, so the
 * rerun must NOT carry `--resume`: it mints a brand-new conversation, with the
 * role re-injected (which the resume path deliberately skips, since a resumed
 * transcript already contains it).
 *
 * The new id is **persisted to the architect row**, so it becomes the identity
 * a later crash recovers. Without that, an unnatural exit after a clean rerun
 * would resume the conversation the user just walked away from. A persist
 * failure is logged and tolerated rather than fatal — the launch itself is
 * still correct, and the next cold start self-heals.
 *
 * Called once per clean exit (never memoized): each rerun is a genuinely new
 * conversation and needs its own id.
 */
export function buildArchitectFreshLaunch(opts: {
  workspacePath: string;
  architectName: string;
  baseArgs: string[];
  baseEnv: Record<string, string>;
  log: (level: 'INFO' | 'ERROR' | 'WARN', message: string) => void;
}): FreshLaunch {
  const { workspacePath, architectName, baseArgs, baseEnv, log } = opts;
  return {
    next: () => {
      let harness: HarnessProvider;
      try {
        harness = getArchitectHarness(workspacePath);
      } catch (err) {
        // Issue #1338: the architect's configured harness was retired AFTER this
        // session launched (a custom `gemini` harness removed, or a config edit
        // before this clean exit). Two hazards, both handled by failing closed:
        //   1. SessionManager invokes next() with no try/catch (session-manager.ts),
        //      so a raw throw here becomes an uncaught Tower exception.
        //   2. next() can only change the args/env — the launch `command` is
        //      retained by SessionManager. The retained command may itself be the
        //      retired binary (a custom `gemini` command), so returning baseArgs
        //      would still relaunch it (fail-open).
        // Signal STOP: SessionManager ends the session and surfaces the retirement
        // in the pane instead of respawning. Non-retirement errors are real faults,
        // rethrown.
        if (err instanceof RetiredHarnessError) {
          log('WARN', `Architect '${architectName}' harness is retired; not relaunching on clean exit in ${workspacePath}: ${err.message}`);
          return { stop: true };
        }
        throw err;
      }
      // No resumable-session concept for this harness: there is no recovery to
      // disable, so a plain rebuild of the launch args is already "fresh".
      if (!harness.session) {
        const built = buildArchitectArgs(baseArgs, workspacePath);
        return { args: built.args, env: { ...baseEnv, ...built.env } };
      }
      const sessionId = crypto.randomUUID();
      const built = buildArchitectArgs(
        [...baseArgs, ...harness.session.newSessionArgs(sessionId)],
        workspacePath,
      );
      try {
        setArchitectSessionId(workspacePath, architectName, sessionId);
      } catch (err) {
        log('WARN', `Failed to persist fresh session id for architect '${architectName}': ${err instanceof Error ? err.message : err}`);
      }
      log('INFO', `Architect '${architectName}' exited cleanly; rerunning with a fresh session ${sessionId.slice(0, 8)}… in ${workspacePath}`);
      return { args: built.args, env: { ...baseEnv, ...built.env } };
    },
  };
}

/**
 * Issue #832 / #1149 / #1264 / #1338: resolve the shellper auto-restart options for
 * an architect session being reconciled at startup or reconnected on the fly.
 * Consolidates the two previously-duplicated blocks in tower-terminals.ts;
 * `includeFreshLaunch` is the only behavioral difference between them (the startup
 * reconcile path also wires the #1264 clean-exit rerun; the on-the-fly reconnect
 * path does not).
 *
 * Fail-closed retirement (#1338): if the configured harness is retired,
 * `resolveArchitectRestart` throws and this returns `undefined` — the caller
 * reconnects to a live shellper if one exists, but NEVER configures an
 * auto-restart into the retired binary. This replaces the previous fail-OPEN
 * behavior, where the generic catch relaunched `cmdParts[0]` (the retired command
 * itself) with no role injection. Any OTHER harness-resolution error still
 * degrades to the plain configured command so a transient failure can reconnect
 * (identity preserved via `cleanEnv`, Spec 786).
 */
export function buildArchitectReconnectRestartOptions(opts: {
  workspacePath: string;
  architectName: string;
  cmdParts: string[];
  cleanEnv: Record<string, string>;
  includeFreshLaunch: boolean;
  log: (level: 'INFO' | 'WARN' | 'ERROR', message: string) => void;
}): ReconnectRestartOptions | undefined {
  const { workspacePath, architectName, cmdParts, cleanEnv, includeFreshLaunch, log } = opts;
  const command = cmdParts[0];
  const baseArgs = cmdParts.slice(1);
  try {
    // Issue #832: revive the same conversation on auto-restart via the stored id.
    const { args: architectArgs, env: harnessEnv, resumed, storedSessionId, fallback } =
      resolveArchitectRestart(workspacePath, architectName, baseArgs);
    if (resumed && storedSessionId) {
      log('INFO', `Resuming architect '${architectName}' session ${storedSessionId.slice(0, 8)}… on shellper restart in ${workspacePath}`);
    }
    const restartOptions: ReconnectRestartOptions = {
      command,
      args: architectArgs,
      cwd: workspacePath,
      env: { ...cleanEnv, ...harnessEnv },
      restartDelay: 2000,
      maxRestarts: 50,
    };
    // Issue #1264: a clean exit reruns the harness fresh (no --resume). Built from
    // the ORIGINAL baseArgs, never `architectArgs` — the latter may carry --resume.
    if (includeFreshLaunch) {
      restartOptions.freshLaunch = buildArchitectFreshLaunch({
        workspacePath, architectName, baseArgs, baseEnv: cleanEnv, log,
      });
    }
    // Issue #1149: degrade a fast-failing resume to a fresh launch.
    if (resumed && storedSessionId && fallback) {
      restartOptions.crashLoopFallback = buildArchitectCrashLoopFallback({
        workspacePath, architectName, storedSessionId, fallback, baseEnv: cleanEnv, log,
      });
    }
    return restartOptions;
  } catch (err) {
    if (err instanceof RetiredHarnessError) {
      // Fail closed: do NOT relaunch the retired command. The session reconnects
      // to its existing process if alive, but no auto-restart into the retired
      // harness is configured.
      log('WARN', `Architect '${architectName}' harness is retired; not configuring auto-restart into it in ${workspacePath}: ${err.message}`);
      return undefined;
    }
    // Fall back to the plain command without harness role-prompt args so the
    // session can still reconnect. `cleanEnv` carries CODEV_ARCHITECT_NAME
    // (Spec 786 Phase 2), so identity is preserved even on harness failure.
    log('WARN', `Harness resolution failed for workspace ${workspacePath}: ${err instanceof Error ? err.message : err}`);
    return { command, args: baseArgs, cwd: workspacePath, env: cleanEnv, restartDelay: 2000, maxRestarts: 50 };
  }
}

/**
 * Serve a static file from the React dashboard dist.
 * Returns true if the file was served, false otherwise.
 */
export function serveStaticFile(filePath: string, res: ServerResponse): boolean {
  if (!fs.existsSync(filePath)) {
    return false;
  }

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
    return true;
  } catch {
    return false;
  }
}
