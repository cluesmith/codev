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

  it('round-trips the Spec 1789 fields', () => {
    const record: IdeServerRecord = {
      ...SAMPLE,
      serverVersion: '1.135.0',
      extensionsDir: '/home/dev/.agent-farm/ide-extensions',
      sidebarVersion: '3.3.4',
    };
    writeIdeRecord(record);
    expect(readIdeRecord()).toEqual(record);
  });

  it('parses a legacy (pre-#1789) record without the new fields', () => {
    mkdirSync(TMP_DIR, { recursive: true });
    writeFileSync(getIdeRecordPath(), JSON.stringify(SAMPLE));
    const parsed = readIdeRecord();
    expect(parsed).toMatchObject(SAMPLE);
    expect(parsed?.serverVersion).toBeUndefined();
    expect(parsed?.extensionsDir).toBeUndefined();
    expect(parsed?.sidebarVersion).toBeUndefined();
  });

  it('ignores a retired defaultFolder left by an earlier Tower, keeping the record', () => {
    mkdirSync(TMP_DIR, { recursive: true });
    writeFileSync(getIdeRecordPath(), JSON.stringify({ ...SAMPLE, defaultFolder: '/home/dev/project' }));
    const parsed = readIdeRecord();
    expect(parsed).toEqual(SAMPLE);
    expect(parsed).not.toHaveProperty('defaultFolder');
  });

  it('drops new fields that are not strings, keeping the record', () => {
    mkdirSync(TMP_DIR, { recursive: true });
    writeFileSync(
      getIdeRecordPath(),
      JSON.stringify({ ...SAMPLE, serverVersion: 1135, extensionsDir: null, sidebarVersion: ['3.3.4'] }),
    );
    const parsed = readIdeRecord();
    expect(parsed).toMatchObject(SAMPLE);
    expect(parsed?.serverVersion).toBeUndefined();
    expect(parsed?.extensionsDir).toBeUndefined();
    expect(parsed?.sidebarVersion).toBeUndefined();
  });

  it('generates and persists a connection token, returning the same value on reuse', () => {
    const first = ensureIdeConnectionToken();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(getIdeConnectionTokenPath())).toBe(true);
    expect(ensureIdeConnectionToken()).toBe(first);
  });
});
