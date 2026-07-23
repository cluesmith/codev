/**
 * Issue #1227: a stricter, second-pass reap for shellper "husks" — a shellper
 * whose PTY child has exited (deliberate lingering behavior from #905/#1198 so
 * a reconnect can replay history) but which `killOrphanedShellpers`
 * (`../../terminal/session-manager.ts`) can never reap, because that function
 * unconditionally protects any shellper whose Unix socket still responds.
 *
 * A husk still answers its socket, so it survives `killOrphanedShellpers`
 * forever. The predicate here is stricter and orthogonal: a shellper is a husk
 * only when it is simultaneously
 *   - unregistered  — not a live PID in `terminal_sessions.shellper_pid`
 *   - childless     — no process in the table has it as a parent (OS-level
 *                      signal; there is no wire-protocol "has-child" frame)
 *   - aged          — older than `graceMs`, which absorbs any legitimate
 *                      mid-respawn / mid-adoption transient (seconds), so the
 *                      three conditions together can only ever be true for a
 *                      genuine husk (per the issue: "unregistered and
 *                      childless" is a terminal state — a shellper that lost
 *                      its registration can never receive another SPAWN).
 *
 * The actual kill is delegated to `reapShellpers` (`./architect-session-holder.js`,
 * SIGTERM → poll → SIGKILL → confirm-death) rather than reimplemented here.
 */

import type Database from 'better-sqlite3';
import { listProcessCensus, type ProcessCensusEntry } from './process-census.js';
import { getProcessStartTime } from '../../terminal/session-manager.js';
import { reapShellpers } from './architect-session-holder.js';

const SHELLPER_MARKER = 'shellper-main.js';

/**
 * Same tolerance `SessionManager.reconnectSession` uses
 * (`../../terminal/session-manager.ts:471`) to detect PID reuse: a live
 * process's actual start time must match the DB-recorded one within this
 * window, or the DB row is stale (its PID was reused by an unrelated
 * process) and must not count as "registered".
 */
const PID_REUSE_TOLERANCE_MS = 2000;

interface ShellperRegistryRow {
  shellper_pid: number;
  shellper_start_time: number | null;
}

/**
 * The set of shellper PIDs Tower currently believes are registered, per
 * `terminal_sessions` — validated against each PID's actual process start
 * time to guard against PID reuse (a stale row whose PID was reused by an
 * unrelated process does not count as registered).
 */
export async function computeRegisteredShellperPids(
  db: Database.Database,
  getStartTime: (pid: number) => Promise<number | null> = getProcessStartTime,
): Promise<Set<number>> {
  const rows = db
    .prepare('SELECT shellper_pid, shellper_start_time FROM terminal_sessions WHERE shellper_pid IS NOT NULL')
    .all() as ShellperRegistryRow[];

  const registered = new Set<number>();
  for (const row of rows) {
    if (row.shellper_start_time === null) {
      // Legacy row with no recorded start time — no positive signal to
      // invalidate it, so trust the registration.
      registered.add(row.shellper_pid);
      continue;
    }
    const actual = await getStartTime(row.shellper_pid);
    if (actual !== null && Math.abs(actual - row.shellper_start_time) <= PID_REUSE_TOLERANCE_MS) {
      registered.add(row.shellper_pid);
    }
  }
  return registered;
}

export interface FindHuskShellpersOptions {
  /** This Tower instance's socket directory — scopes the sweep so another
   * instance's (or another user's) legitimate shellpers are never touched. */
  socketDir: string;
  registeredShellperPids: Set<number>;
  graceMs: number;
  /** Seam, defaults to `listProcessCensus`. */
  census?: () => ProcessCensusEntry[];
  /** Seam, defaults to `Date.now()`. */
  now?: number;
  /** Seam, defaults to `getProcessStartTime`. */
  getStartTime?: (pid: number) => Promise<number | null>;
}

/**
 * Returns the PIDs of shellper-main.js processes, scoped to `socketDir`, that
 * are unregistered AND childless AND older than `graceMs`.
 */
export async function findHuskShellpers(opts: FindHuskShellpersOptions): Promise<number[]> {
  const census = (opts.census ?? listProcessCensus)();
  const now = opts.now ?? Date.now();
  const getStartTime = opts.getStartTime ?? getProcessStartTime;

  // Match the trailing-'/' scope-marker technique already proven in
  // findShellperProcesses (../../terminal/session-manager.ts:782-793) to
  // prevent prefix collisions (e.g. /run matching /run2).
  const scopeMarker = opts.socketDir.endsWith('/') ? opts.socketDir : `${opts.socketDir}/`;
  const parentPids = new Set(census.map((entry) => entry.ppid));

  const candidates: number[] = [];
  for (const entry of census) {
    if (!entry.cmdline.includes(SHELLPER_MARKER)) continue;
    if (!entry.cmdline.includes(scopeMarker)) continue;
    if (opts.registeredShellperPids.has(entry.pid)) continue;
    if (parentPids.has(entry.pid)) continue; // has a live child — not a husk

    const startTime = await getStartTime(entry.pid);
    if (startTime === null) continue; // can't confirm age — safe default is to skip
    if (now - startTime < opts.graceMs) continue; // too young — race-safety window

    candidates.push(entry.pid);
  }
  return candidates;
}

export interface SweepShellperHusksOptions {
  socketDir: string;
  db: Database.Database;
  graceMs: number;
  log?: (msg: string) => void;
  census?: () => ProcessCensusEntry[];
  now?: number;
  getStartTime?: (pid: number) => Promise<number | null>;
  /** Seam, defaults to `reapShellpers`. */
  reap?: (pids: number[]) => Promise<void>;
}

/**
 * Compute the registered-shellper set from the DB, find husk candidates, and
 * reap them. Returns the swept PIDs so callers (startup log, periodic-timer
 * log, on-demand CLI) can report what happened.
 */
export async function sweepShellperHusks(
  opts: SweepShellperHusksOptions,
): Promise<{ swept: number; pids: number[] }> {
  const getStartTime = opts.getStartTime ?? getProcessStartTime;
  const registeredShellperPids = await computeRegisteredShellperPids(opts.db, getStartTime);
  const pids = await findHuskShellpers({
    socketDir: opts.socketDir,
    registeredShellperPids,
    graceMs: opts.graceMs,
    census: opts.census,
    now: opts.now,
    getStartTime,
  });

  if (pids.length > 0) {
    opts.log?.(`Sweeping ${pids.length} husk shellper process(es): ${pids.join(', ')}`);
    const reap = opts.reap ?? reapShellpers;
    await reap(pids);
  }

  return { swept: pids.length, pids };
}
