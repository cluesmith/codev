/**
 * Issue #1238: retention for PTY session logs.
 *
 * `PtySession` already bounds a *single* session's log (50 MB, one `.1`
 * rotation — see `../../terminal/pty-session.ts`), but nothing has ever
 * deleted the log of a session that ended. Every terminal Tower has ever
 * opened leaves a file behind forever: an audited machine reached 29,728 files
 * / 19 GB in `~/.agent-farm/logs`, 97% of it untouched for over a month.
 *
 * This module adds the missing cross-file policy: a log is deleted once its
 * last write is older than the retention window. mtime is the retention key
 * because the last byte written to a session log is, in effect, the moment
 * that session stopped producing output — the "session ended" signal, without
 * needing to join against DB session state (which is itself pruned, so dead
 * sessions leave no row to join against).
 *
 * Live sessions are excluded by id regardless of mtime. A session log's fd is
 * held open for the session's whole life, so unlinking it under a live writer
 * would silently redirect every subsequent write into an unlinked inode —
 * losing the log of the one session someone might actually want to read. A
 * 30-day-idle live session is vanishingly unlikely, but the guard is cheap.
 *
 * Wired in `./tower-server.ts` on two triggers (Tower startup, and a daily
 * in-process timer), mirroring the husk sweep in `./shellper-husk-sweep.ts`.
 */

import fs from 'node:fs';
import path from 'node:path';

/** `<session-uuid>.log` and its single rotation `<session-uuid>.log.1`. */
const SESSION_LOG_RE = /^(.+)\.log(\.1)?$/;

export const DEFAULT_LOG_RETENTION_DAYS = 30;
export const DEFAULT_LOG_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

export const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Retention window in days (env `AGENT_FARM_LOG_RETENTION_DAYS`, default 30).
 * `0` disables the sweep entirely — an explicit "keep everything" opt-out for
 * anyone who treats these logs as an audit trail.
 *
 * NaN-checked rather than `parsed || default` because `0` is a meaningful
 * override and is falsy in JS (same reasoning as `resolveHuskGraceMs`).
 */
export function resolveLogRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = parseInt(env.AGENT_FARM_LOG_RETENTION_DAYS ?? '', 10);
  return Math.max(Number.isNaN(parsed) ? DEFAULT_LOG_RETENTION_DAYS : parsed, 0);
}

/**
 * Sweep cadence (env `AGENT_FARM_LOG_SWEEP_INTERVAL_MS`, default 24h). Floored
 * at 1s so a bad value can't spin the event loop; tests shorten it deliberately.
 */
export function resolveLogSweepIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = parseInt(env.AGENT_FARM_LOG_SWEEP_INTERVAL_MS ?? '', 10);
  return Math.max(Number.isNaN(parsed) ? DEFAULT_LOG_SWEEP_INTERVAL_MS : parsed, 1000);
}

export interface SessionLogFootprint {
  /** Number of session log files (including `.log.1` rotations). */
  files: number;
  /** Total bytes on disk. */
  bytes: number;
  /** mtime of the oldest log, or null when there are none. */
  oldestMtimeMs: number | null;
}

/**
 * Total footprint of the session log directory. Read-only — used by
 * `codev doctor` to surface the number the issue was filed about, and by the
 * sweep's own logging. A missing directory is a healthy zero, not an error.
 */
export function measureSessionLogs(logDir: string): SessionLogFootprint {
  const footprint: SessionLogFootprint = { files: 0, bytes: 0, oldestMtimeMs: null };
  let entries: string[];
  try {
    entries = fs.readdirSync(logDir);
  } catch {
    return footprint;
  }

  for (const name of entries) {
    if (!SESSION_LOG_RE.test(name)) continue;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(path.join(logDir, name));
    } catch {
      continue; // vanished mid-scan — nothing to account for
    }
    if (!stat.isFile()) continue;
    footprint.files += 1;
    footprint.bytes += stat.size;
    if (footprint.oldestMtimeMs === null || stat.mtimeMs < footprint.oldestMtimeMs) {
      footprint.oldestMtimeMs = stat.mtimeMs;
    }
  }
  return footprint;
}

export interface SweepSessionLogsOptions {
  /** The session log directory, i.e. `~/.agent-farm/logs`. */
  logDir: string;
  /** Age at which a log becomes eligible for deletion. `0` disables the sweep. */
  retentionMs: number;
  /**
   * Ids of sessions that are alive right now. Their logs are never deleted,
   * however old the mtime looks, because their fd is still open.
   */
  activeSessionIds?: Iterable<string>;
  /** Seam, defaults to `Date.now()`. */
  now?: number;
  log?: (msg: string) => void;
}

export interface SweepSessionLogsResult {
  /** Session log files examined. */
  scanned: number;
  /** Files unlinked. */
  deleted: number;
  /** Bytes reclaimed (sum of the deleted files' sizes). */
  bytesFreed: number;
  /** Aged-out files kept because their session is still live. */
  skippedActive: number;
  /** Files that were eligible but could not be unlinked. */
  failed: number;
}

/**
 * Delete session logs whose last write is older than `retentionMs`.
 *
 * Never throws: a log directory that can't be read, or an individual file that
 * can't be stat'd or unlinked, is counted and skipped. Log retention is
 * janitorial — it must not be able to take Tower's startup path down with it.
 */
export function sweepSessionLogs(opts: SweepSessionLogsOptions): SweepSessionLogsResult {
  const result: SweepSessionLogsResult = {
    scanned: 0,
    deleted: 0,
    bytesFreed: 0,
    skippedActive: 0,
    failed: 0,
  };
  if (opts.retentionMs <= 0) return result;

  const now = opts.now ?? Date.now();
  const active = new Set(opts.activeSessionIds ?? []);

  let entries: string[];
  try {
    entries = fs.readdirSync(opts.logDir);
  } catch {
    return result; // no log dir yet (fresh install) — nothing to sweep
  }

  for (const name of entries) {
    const match = SESSION_LOG_RE.exec(name);
    if (!match) continue;
    const fullPath = path.join(opts.logDir, name);

    let stat: fs.Stats;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    result.scanned += 1;

    if (now - stat.mtimeMs < opts.retentionMs) continue;
    if (active.has(match[1])) {
      result.skippedActive += 1;
      continue;
    }

    try {
      fs.unlinkSync(fullPath);
      result.deleted += 1;
      result.bytesFreed += stat.size;
    } catch {
      result.failed += 1;
    }
  }

  if (result.deleted > 0 || result.failed > 0) {
    opts.log?.(
      `Session log sweep: deleted ${result.deleted} log(s), freed ${formatBytes(result.bytesFreed)}` +
      ` (${result.scanned} scanned` +
      (result.skippedActive > 0 ? `, ${result.skippedActive} kept as live` : '') +
      (result.failed > 0 ? `, ${result.failed} failed` : '') +
      ')',
    );
  }
  return result;
}

/** Human-readable byte count for log lines and `codev doctor` output. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
