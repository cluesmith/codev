/**
 * IDE server record (~/.agent-farm/ide-server.json) read/write/delete + the
 * Tower-owned connection token (Issue #1668 §D3). AGENT_FARM_DIR is pointed at
 * a temp dir so the tests never touch the real ~/.agent-farm.
 */
import { describe, it, expect, afterEach, afterAll, vi } from 'vitest';
import { rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const TMP_DIR = vi.hoisted(() => `${process.env.TMPDIR || '/tmp'}/ide-record-test-${process.pid}-${Date.now()}`);

vi.mock('@cluesmith/codev-core/constants', async (importActual) => {
  const actual = await importActual<typeof import('@cluesmith/codev-core/constants')>();
  return { ...actual, AGENT_FARM_DIR: TMP_DIR };
});

import {
  readIdeRecord,
  writeIdeRecord,
  deleteIdeRecord,
  getIdeRecordPath,
  ensureIdeConnectionToken,
  getIdeConnectionTokenPath,
  type IdeServerRecord,
} from '../lib/ide-record.js';

const SAMPLE: IdeServerRecord = {
  prefix: '/ide/',
  port: 8200,
  serverPath: '/opt/codev-ide/bin/server',
  pid: 4242,
  defaultFolder: '/home/dev/project',
  startedAt: '2026-09-11T00:00:00.000Z',
};

afterEach(() => {
  deleteIdeRecord();
});

afterAll(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

describe('ide-record', () => {
  it('writes to ~/.agent-farm/ide-server.json under the configured dir', () => {
    writeIdeRecord(SAMPLE);
    expect(getIdeRecordPath()).toBe(resolve(TMP_DIR, 'ide-server.json'));
    expect(existsSync(getIdeRecordPath())).toBe(true);
  });

  it('round-trips a record', () => {
    writeIdeRecord(SAMPLE);
    expect(readIdeRecord()).toEqual(SAMPLE);
  });

  it('returns null when no record exists', () => {
    expect(readIdeRecord()).toBeNull();
  });

  it('deletes the record', () => {
    writeIdeRecord(SAMPLE);
    deleteIdeRecord();
    expect(readIdeRecord()).toBeNull();
    expect(existsSync(getIdeRecordPath())).toBe(false);
  });

  it('fails soft (null) on a malformed or incomplete record rather than throwing', () => {
    mkdirSync(TMP_DIR, { recursive: true });
    writeFileSync(getIdeRecordPath(), 'not json at all');
    expect(readIdeRecord()).toBeNull();

    writeFileSync(getIdeRecordPath(), JSON.stringify({ port: 8200 })); // missing required fields
    expect(readIdeRecord()).toBeNull();
  });

  it('generates and persists a connection token, returning the same value on reuse', () => {
    const first = ensureIdeConnectionToken();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(getIdeConnectionTokenPath())).toBe(true);
    expect(ensureIdeConnectionToken()).toBe(first);
  });
});
