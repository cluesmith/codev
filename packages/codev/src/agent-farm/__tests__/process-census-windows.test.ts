/**
 * Spec 1658 Phase 3: the Windows census provider in process-census.ts.
 *
 * The CIM JSON parser (fixtures, including CRLF, a single row and empty
 * output), the TTL cache with single-flight coalescing, and the failure
 * contract: on Windows a failed census rejects; POSIX keeps `[]` (asserted in
 * process-census.test.ts).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import {
  WINDOWS_CENSUS_QUERY,
  createWindowsCensusProvider,
  listProcessCensus,
  parseWindowsCensus,
} from '../servers/process-census.js';
import { resetHostPlatformForTests, setHostPlatformForTests } from '../../lib/platform.js';

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, execFile: vi.fn() };
});

const mockExecFile = vi.mocked(execFile);

afterEach(() => {
  resetHostPlatformForTests();
  vi.clearAllMocks();
});

const SHELLPER_ROW = {
  ProcessId: 4100,
  ParentProcessId: 1200,
  CommandLine: '"C:\\Program Files\\nodejs\\node.exe" "C:\\codev\\shellper-main.js" "{\\"socketDir\\":\\"C:\\\\Users\\\\me\\\\run\\"}"',
  CreationDate: '2026-10-21T07:00:00.1234567Z',
  WorkingSetSize: 52428800,
};

describe('parseWindowsCensus', () => {
  it('maps pid, ppid, command line, creation time and working set', () => {
    const [entry] = parseWindowsCensus(JSON.stringify([SHELLPER_ROW]));
    expect(entry).toEqual({
      pid: 4100,
      ppid: 1200,
      rssKb: 51200,
      cmdline: SHELLPER_ROW.CommandLine,
      creationTime: Date.parse('2026-10-21T07:00:00.123Z'),
    });
  });

  it('accepts the single-object form ConvertTo-Json emits for one row', () => {
    expect(parseWindowsCensus(JSON.stringify(SHELLPER_ROW)).map((e) => e.pid)).toEqual([4100]);
  });

  it('accepts CRLF line endings and a UTF-8 byte-order mark', () => {
    const out = '\uFEFF' + JSON.stringify([SHELLPER_ROW]) + '\r\n';
    expect(parseWindowsCensus(out).map((e) => e.pid)).toEqual([4100]);
  });

  it('reads empty output as an empty table', () => {
    expect(parseWindowsCensus('')).toEqual([]);
    expect(parseWindowsCensus('\r\n')).toEqual([]);
  });

  it('reads a null command line as "" (another user\'s process) and keeps the row', () => {
    const [entry] = parseWindowsCensus(JSON.stringify([{ ...SHELLPER_ROW, CommandLine: null }]));
    expect(entry.cmdline).toBe('');
  });

  it('leaves creation time unset when CIM had none', () => {
    const [entry] = parseWindowsCensus(JSON.stringify([{ ...SHELLPER_ROW, CreationDate: null }]));
    expect(entry.creationTime).toBeUndefined();
  });

  it('drops rows without a usable pid, including the System Idle Process (pid 0)', () => {
    const rows = [{ ...SHELLPER_ROW, ProcessId: 0, ParentProcessId: 0 }, { ...SHELLPER_ROW, ProcessId: 'x' }, SHELLPER_ROW];
    expect(parseWindowsCensus(JSON.stringify(rows)).map((e) => e.pid)).toEqual([4100]);
  });

  it('throws on output that is not the expected JSON', () => {
    expect(() => parseWindowsCensus('Get-CimInstance : Access denied')).toThrow();
  });
});

describe('createWindowsCensusProvider', () => {
  it('runs the inline CIM query', async () => {
    const exec = vi.fn(async () => JSON.stringify([SHELLPER_ROW]));
    await createWindowsCensusProvider({ exec })();
    expect(exec).toHaveBeenCalledWith(WINDOWS_CENSUS_QUERY, expect.any(Number));
    expect(WINDOWS_CENSUS_QUERY).toContain('Get-CimInstance Win32_Process');
    expect(WINDOWS_CENSUS_QUERY).not.toContain('"');
  });

  it('coalesces concurrent callers onto one query', async () => {
    let finish: (out: string) => void = () => {};
    const exec = vi.fn(() => new Promise<string>((resolve) => {
      finish = resolve;
    }));
    const census = createWindowsCensusProvider({ exec });
    const calls = [census(), census(), census()];
    finish(JSON.stringify([SHELLPER_ROW]));
    const results = await Promise.all(calls);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r[0].pid === 4100)).toBe(true);
  });

  it('reuses a result inside the TTL and queries again after it', async () => {
    let clock = 1000;
    const exec = vi.fn(async () => JSON.stringify([SHELLPER_ROW]));
    const census = createWindowsCensusProvider({ exec, ttlMs: 2000, now: () => clock });
    await census();
    clock += 1999;
    await census();
    expect(exec).toHaveBeenCalledTimes(1);
    clock += 1;
    await census();
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failure', async () => {
    const exec = vi.fn()
      .mockRejectedValueOnce(new Error('timed out'))
      .mockResolvedValueOnce(JSON.stringify([SHELLPER_ROW]));
    const census = createWindowsCensusProvider({ exec });
    await expect(census()).rejects.toThrow('timed out');
    expect((await census()).map((e) => e.pid)).toEqual([4100]);
    expect(exec).toHaveBeenCalledTimes(2);
  });
});

describe('listProcessCensus on Windows', () => {
  it('rejects when PowerShell fails, never resolving to an empty table', async () => {
    setHostPlatformForTests('win32');
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as (err: Error | null, stdout: string) => void)(new Error('powershell.exe ENOENT'), '');
      return {} as ReturnType<typeof execFile>;
    });
    await expect(listProcessCensus()).rejects.toThrow(/process census failed.*ENOENT/);
    expect(mockExecFile.mock.calls[0][0]).toBe('powershell.exe');
  });
});
