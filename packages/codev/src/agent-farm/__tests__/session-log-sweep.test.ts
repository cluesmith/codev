/**
 * Issue #1238: tests for PTY session log retention.
 *
 * Uses a real temp directory rather than mocking `fs`: the whole point of the
 * module is filesystem behavior (mtime-based eligibility, unlink, resilience to
 * unreadable entries), and a real tmpdir exercises that faithfully while staying
 * fast. `now` is injected so age is deterministic without sleeping.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  sweepSessionLogs,
  measureSessionLogs,
  resolveLogRetentionDays,
  resolveLogSweepIntervalMs,
  formatBytes,
  DEFAULT_LOG_RETENTION_DAYS,
  DEFAULT_LOG_SWEEP_INTERVAL_MS,
} from '../servers/session-log-sweep.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000; // fixed clock so ages are exact
const RETENTION_MS = 30 * DAY_MS;

let logDir: string;

/** Write a session log with a specific age in days. */
function writeLog(name: string, ageDays: number, contents = 'x'): string {
  const full = path.join(logDir, name);
  fs.writeFileSync(full, contents);
  const mtime = new Date(NOW - ageDays * DAY_MS);
  fs.utimesSync(full, mtime, mtime);
  return full;
}

beforeEach(() => {
  logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-log-sweep-'));
});

afterEach(() => {
  fs.rmSync(logDir, { recursive: true, force: true });
});

describe('sweepSessionLogs', () => {
  it('deletes logs older than the retention window and keeps fresh ones', () => {
    writeLog('old-a.log', 45);
    writeLog('old-b.log', 31);
    writeLog('fresh.log', 2);
    writeLog('boundary.log', 29);

    const result = sweepSessionLogs({ logDir, retentionMs: RETENTION_MS, now: NOW });

    expect(result.deleted).toBe(2);
    expect(result.scanned).toBe(4);
    expect(fs.existsSync(path.join(logDir, 'old-a.log'))).toBe(false);
    expect(fs.existsSync(path.join(logDir, 'old-b.log'))).toBe(false);
    expect(fs.existsSync(path.join(logDir, 'fresh.log'))).toBe(true);
    expect(fs.existsSync(path.join(logDir, 'boundary.log'))).toBe(true);
  });

  it('reports bytes freed', () => {
    writeLog('old.log', 40, 'a'.repeat(2048));
    writeLog('fresh.log', 1, 'b'.repeat(4096));

    const result = sweepSessionLogs({ logDir, retentionMs: RETENTION_MS, now: NOW });

    expect(result.deleted).toBe(1);
    expect(result.bytesFreed).toBe(2048);
  });

  it('sweeps rotated .log.1 files too', () => {
    writeLog('sess.log', 40);
    writeLog('sess.log.1', 40);

    const result = sweepSessionLogs({ logDir, retentionMs: RETENTION_MS, now: NOW });

    expect(result.deleted).toBe(2);
    expect(fs.readdirSync(logDir)).toEqual([]);
  });

  it('never deletes the log of a live session, however old the mtime', () => {
    writeLog('live-session.log', 400);
    writeLog('live-session.log.1', 400);
    writeLog('dead-session.log', 400);

    const result = sweepSessionLogs({
      logDir,
      retentionMs: RETENTION_MS,
      now: NOW,
      activeSessionIds: ['live-session'],
    });

    expect(result.deleted).toBe(1);
    expect(result.skippedActive).toBe(2);
    expect(fs.existsSync(path.join(logDir, 'live-session.log'))).toBe(true);
    expect(fs.existsSync(path.join(logDir, 'live-session.log.1'))).toBe(true);
    expect(fs.existsSync(path.join(logDir, 'dead-session.log'))).toBe(false);
  });

  it('is a no-op when retention is disabled (0)', () => {
    writeLog('ancient.log', 9999);

    const result = sweepSessionLogs({ logDir, retentionMs: 0, now: NOW });

    expect(result).toEqual({ scanned: 0, deleted: 0, bytesFreed: 0, skippedActive: 0, failed: 0 });
    expect(fs.existsSync(path.join(logDir, 'ancient.log'))).toBe(true);
  });

  it('ignores non-log files and subdirectories', () => {
    writeLog('sess.log', 40);
    const keep = path.join(logDir, 'tower.log.gz');
    fs.writeFileSync(keep, 'archive');
    fs.utimesSync(keep, new Date(NOW - 400 * DAY_MS), new Date(NOW - 400 * DAY_MS));
    const subdir = path.join(logDir, 'nested.log');
    fs.mkdirSync(subdir);

    const result = sweepSessionLogs({ logDir, retentionMs: RETENTION_MS, now: NOW });

    expect(result.scanned).toBe(1);
    expect(result.deleted).toBe(1);
    expect(fs.existsSync(keep)).toBe(true);
    expect(fs.existsSync(subdir)).toBe(true);
  });

  it('returns zeros for a missing log directory instead of throwing', () => {
    const missing = path.join(logDir, 'does-not-exist');

    expect(() => sweepSessionLogs({ logDir: missing, retentionMs: RETENTION_MS, now: NOW })).not.toThrow();
    expect(sweepSessionLogs({ logDir: missing, retentionMs: RETENTION_MS, now: NOW }).deleted).toBe(0);
  });

  it('logs a summary only when it actually deleted something', () => {
    writeLog('fresh.log', 1);
    const lines: string[] = [];
    sweepSessionLogs({ logDir, retentionMs: RETENTION_MS, now: NOW, log: (m) => lines.push(m) });
    expect(lines).toEqual([]);

    writeLog('old.log', 40);
    sweepSessionLogs({ logDir, retentionMs: RETENTION_MS, now: NOW, log: (m) => lines.push(m) });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('deleted 1 log(s)');
  });
});

describe('measureSessionLogs', () => {
  it('sums files and bytes and reports the oldest mtime', () => {
    writeLog('a.log', 10, 'a'.repeat(100));
    writeLog('b.log', 50, 'b'.repeat(200));
    writeLog('b.log.1', 20, 'c'.repeat(300));

    const footprint = measureSessionLogs(logDir);

    expect(footprint.files).toBe(3);
    expect(footprint.bytes).toBe(600);
    expect(footprint.oldestMtimeMs).toBeCloseTo(NOW - 50 * DAY_MS, -3);
  });

  it('is a healthy zero for a missing directory', () => {
    expect(measureSessionLogs(path.join(logDir, 'nope'))).toEqual({
      files: 0,
      bytes: 0,
      oldestMtimeMs: null,
    });
  });
});

describe('resolveLogRetentionDays', () => {
  it('defaults to 30 days', () => {
    expect(resolveLogRetentionDays({})).toBe(DEFAULT_LOG_RETENTION_DAYS);
    expect(DEFAULT_LOG_RETENTION_DAYS).toBe(30);
  });

  it('honours an explicit override', () => {
    expect(resolveLogRetentionDays({ AGENT_FARM_LOG_RETENTION_DAYS: '7' })).toBe(7);
  });

  it('honours an explicit 0 as "disabled" rather than falling back to the default', () => {
    expect(resolveLogRetentionDays({ AGENT_FARM_LOG_RETENTION_DAYS: '0' })).toBe(0);
  });

  it('falls back to the default for garbage and clamps negatives to 0', () => {
    expect(resolveLogRetentionDays({ AGENT_FARM_LOG_RETENTION_DAYS: 'banana' })).toBe(30);
    expect(resolveLogRetentionDays({ AGENT_FARM_LOG_RETENTION_DAYS: '-5' })).toBe(0);
  });
});

describe('resolveLogSweepIntervalMs', () => {
  it('defaults to 24 hours', () => {
    expect(resolveLogSweepIntervalMs({})).toBe(DEFAULT_LOG_SWEEP_INTERVAL_MS);
  });

  it('floors at 1s so a bad value cannot spin the event loop', () => {
    expect(resolveLogSweepIntervalMs({ AGENT_FARM_LOG_SWEEP_INTERVAL_MS: '10' })).toBe(1000);
    expect(resolveLogSweepIntervalMs({ AGENT_FARM_LOG_SWEEP_INTERVAL_MS: '0' })).toBe(1000);
  });

  it('honours a valid override', () => {
    expect(resolveLogSweepIntervalMs({ AGENT_FARM_LOG_SWEEP_INTERVAL_MS: '5000' })).toBe(5000);
  });
});

describe('formatBytes', () => {
  it('formats across units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(19 * 1024 * 1024 * 1024)).toBe('19 GB');
  });
});
