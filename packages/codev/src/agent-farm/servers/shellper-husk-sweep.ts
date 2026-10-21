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
import { isWindows } from '../../lib/platform.js';
import { SHELLPER_MARKER, isShellperInScope, shellperTeardownIdentities } from '../../terminal/shellper-cmdline.js';

export { SHELLPER_MARKER };

/**
 * True for the console host ConPTY runs under a Windows PTY owner
 * (`conhost.exe --headless`, or `OpenConsole.exe` when node-pty ships its own).
 * It stays a child of the shellper for as long as the pseudoconsole is open,
 * including after the PTY's program exits, so it is infrastructure rather than
 * a child program: it does not make a shellper "not childless". Killing the
 * husk's tree takes it down too.
 */
export function isConsoleHostEntry(entry: ProcessCensusEntry): boolean {
  if (!isWindows()) return false;
  const cmdline = entry.cmdline.toLowerCase();
  return cmdline.includes('--headless') && (cmdline.includes('conhost.exe') || cmdline.includes('openconsole.exe'));
}

/** Looks up a process's start time (epoch ms), or null when it cannot be read. */
export type StartTimeLookup = (pid: number) => Promise<number | null>;

/**
 * A start-time lookup answered from an existing census snapshot's creation
 * times, with no process spawned per PID. A PID absent from the snapshot, or
 * without a creation time, reads as unknown (null).
 */
export function censusStartTimeLookup(census: ProcessCensusEntry[]): StartTimeLookup {
  const created = new Map<number, number>();
  for (const entry of census) {
    if (entry.creationTime !== undefined) created.set(entry.pid, entry.creationTime);
  }
  return async (pid) => created.get(pid) ?? null;
}

/**
 * The start-time source for a sweep over `census`. On Windows the census
 * already carries creation time, so one census serves the whole sweep (Spec
 * 1658); POSIX keeps its per-PID `getProcessStartTime`.
 */
export function startTimeLookupFor(census: ProcessCensusEntry[]): StartTimeLookup {
  if (isWindows()) return censusStartTimeLookup(census);
  return getProcessStartTime;
}

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
  /**
   * Seam, defaults to `listProcessCensus`. Accepts a plain array too (not just
   * a function returning one) so a caller that already took a snapshot for
   * another purpose (e.g. RSS display) can pass it through and avoid a second
   * `ps` scan — see `handleHuskPreview` in tower-routes.ts.
   */
  census?: () => ProcessCensusEntry[] | Promise<ProcessCensusEntry[]>;
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
  const census = await (opts.census ?? listProcessCensus)();
  const now = opts.now ?? Date.now();
  const getStartTime = opts.getStartTime ?? startTimeLookupFor(census);

  // Scope to this instance: the trailing-'/' socketDir marker on POSIX
  // (prevents /run matching /run2), the decoded `socketDir` config field on
  // Windows (see isShellperInScope).
  const parentPids = new Set(census.filter((entry) => !isConsoleHostEntry(entry)).map((entry) => entry.ppid));

  const candidates: number[] = [];
  for (const entry of census) {
    if (!entry.cmdline.includes(SHELLPER_MARKER)) continue;
    if (!isShellperInScope(entry.cmdline, opts.socketDir)) continue;
    if (opts.registeredShellperPids.has(entry.pid)) continue;
    if (parentPids.has(entry.pid)) continue; // has a live child — not a husk

    const startTime = await getStartTime(entry.pid);
    if (startTime === null) continue; // can't confirm age — safe default is to skip
    if (now - startTime < opts.graceMs) continue; // too young — race-safety window

    candidates.push(entry.pid);
  }
  return candidates;
}

/**
 * The husk grace period (env `SHELLPER_HUSK_GRACE_MS`, default 1 hour), shared
 * by every trigger (startup, periodic, on-demand preview/apply) so a preview
 * always predicts what the periodic sweep would actually do.
 *
 * NaN-checked rather than `parsed || default`: `0` is a legitimate override
 * (tests want an immediate-eligibility grace period) and `0` is falsy in JS,
 * so `parsed || default` would silently discard a deliberate zero.
 */
export function resolveHuskGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = parseInt(env.SHELLPER_HUSK_GRACE_MS || '3600000', 10);
  return Math.max(Number.isNaN(parsed) ? 3600000 : parsed, 0);
}

export interface SweepShellperHusksOptions {
  socketDir: string;
  db: Database.Database;
  graceMs: number;
  log?: (msg: string) => void;
  census?: () => ProcessCensusEntry[] | Promise<ProcessCensusEntry[]>;
  now?: number;
  getStartTime?: (pid: number) => Promise<number | null>;
  /** Seam, defaults to `reapShellpers`. Rejects when a teardown failed. */
  reap?: (pids: number[], startTimes?: Map<number, number>, jobNames?: Map<number, string>) => Promise<void>;
}

/**
 * Compute the registered-shellper set from the DB, find husk candidates, and
 * reap them. Returns the swept PIDs so callers (startup log, periodic-timer
 * log, on-demand CLI) can report what happened.
 */
export async function sweepShellperHusks(
  opts: SweepShellperHusksOptions,
): Promise<{ swept: number; pids: number[] }> {
  // One census per sweep, shared by the registration check and the husk
  // predicate. On Windows it rejects on failure, which the sweep's callers log.
  const census = await (opts.census ?? listProcessCensus)();
  const getStartTime = opts.getStartTime ?? startTimeLookupFor(census);
  const registeredShellperPids = await computeRegisteredShellperPids(opts.db, getStartTime);
  const pids = await findHuskShellpers({
    socketDir: opts.socketDir,
    registeredShellperPids,
    graceMs: opts.graceMs,
    census: () => census,
    now: opts.now,
    getStartTime,
  });

  if (pids.length > 0) {
    opts.log?.(`Sweeping ${pids.length} husk shellper process(es): ${pids.join(', ')}`);
    // The census creation times (Windows only; POSIX has none) let a teardown
    // refuse a pid reused since the sweep looked.
    // The session job names (Windows, Phase 3b) let the teardown end
    // descendants no parent link leads to.
    const { startTimes, jobNames } = shellperTeardownIdentities(census, pids);
    const reap = opts.reap ?? ((targets: number[], times?: Map<number, number>, names?: Map<number, string>) => reapShellpers(targets, { startTimes: times, jobNames: names }));
    if (startTimes.size > 0) {
      await reap(pids, startTimes, jobNames);
    } else {
      await reap(pids);
    }
  }

  return { swept: pids.length, pids };
}
