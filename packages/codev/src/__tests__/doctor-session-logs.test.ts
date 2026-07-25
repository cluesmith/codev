/**
 * Issue #1238: tests for `codev doctor`'s "Session Logs" health line.
 *
 * Lives in its own file rather than doctor.test.ts because that file mocks
 * node:child_process at module scope for the dependency-probe tests; this check
 * is pure filesystem accounting and wants a real temp directory instead.
 *
 * The env is passed explicitly rather than mutated on `process.env`, so these
 * cases stay hermetic regardless of what the developer running them has set.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkSessionLogs, SESSION_LOG_WARN_BYTES } from '../commands/doctor.js';

let logDir: string;

/** A session log of an exact size, without actually writing GBs. */
function writeSparseLog(name: string, size: number): void {
  const fd = fs.openSync(path.join(logDir, name), 'w');
  if (size > 0) {
    fs.ftruncateSync(fd, size); // sparse — no real bytes hit the disk
  }
  fs.closeSync(fd);
}

beforeEach(() => {
  logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-session-logs-'));
});

afterEach(() => {
  fs.rmSync(logDir, { recursive: true, force: true });
});

describe('checkSessionLogs', () => {
  it('is ok with a distinct message when there are no logs', () => {
    const result = checkSessionLogs(logDir, {});

    expect(result.status).toBe('ok');
    expect(result.files).toBe(0);
    expect(result.bytes).toBe(0);
    expect(result.summary).toBe('No PTY session logs on disk');
    expect(result.recommendation).toBeUndefined();
  });

  it('is ok, with a footprint summary, below the warn threshold', () => {
    writeSparseLog('a.log', 1024 * 1024);
    writeSparseLog('b.log', 1024 * 1024);

    const result = checkSessionLogs(logDir, {});

    expect(result.status).toBe('ok');
    expect(result.files).toBe(2);
    expect(result.summary).toBe('2 file(s), 2.0 MB');
    expect(result.retentionNote).toBe('retention 30d');
    expect(result.recommendation).toBeUndefined();
  });

  it('warns past the threshold and recommends a Tower restart', () => {
    writeSparseLog('big.log', SESSION_LOG_WARN_BYTES);

    const result = checkSessionLogs(logDir, {});

    expect(result.status).toBe('warn');
    expect(result.summary).toBe('1 file(s), 2.0 GB');
    expect(result.recommendation).toContain('restart Tower');
  });

  it('stays ok exactly one byte below the threshold (boundary is inclusive)', () => {
    writeSparseLog('big.log', SESSION_LOG_WARN_BYTES - 1);

    expect(checkSessionLogs(logDir, {}).status).toBe('ok');
  });

  it('reports the configured retention window rather than assuming the default', () => {
    writeSparseLog('a.log', 10);

    const result = checkSessionLogs(logDir, { AGENT_FARM_LOG_RETENTION_DAYS: '7' });

    expect(result.retentionDays).toBe(7);
    expect(result.retentionNote).toBe('retention 7d');
  });

  it('names retention as the culprit when the sweep is disabled and the dir is large', () => {
    writeSparseLog('big.log', SESSION_LOG_WARN_BYTES);

    const result = checkSessionLogs(logDir, { AGENT_FARM_LOG_RETENTION_DAYS: '0' });

    expect(result.status).toBe('warn');
    expect(result.retentionNote).toBe('retention disabled');
    expect(result.recommendation).toContain('AGENT_FARM_LOG_RETENTION_DAYS=0');
  });

  it('treats a missing log directory as healthy rather than throwing', () => {
    const missing = path.join(logDir, 'never-created');

    expect(() => checkSessionLogs(missing, {})).not.toThrow();
    expect(checkSessionLogs(missing, {}).status).toBe('ok');
    expect(checkSessionLogs(missing, {}).files).toBe(0);
  });

  it('ignores files that are not session logs', () => {
    writeSparseLog('sess.log', 100);
    fs.writeFileSync(path.join(logDir, 'tower.log.gz'), 'archive');
    fs.writeFileSync(path.join(logDir, 'notes.txt'), 'hello');

    expect(checkSessionLogs(logDir, {}).files).toBe(1);
  });
});
