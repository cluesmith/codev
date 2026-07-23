/**
 * Issue #1227: process-census.ts — the shared ps snapshot backing both the
 * shellper husk sweep and fleet-RSS observability.
 *
 * Mocks `execFile`'s callback form directly (not `util.promisify`), matching
 * cleanup-shellper-kill.test.ts's established pattern for this codebase's
 * async-execFile convention.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { listProcessCensus } from '../servers/process-census.js';

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execFile: vi.fn(),
    execFileSync: vi.fn(),
  };
});

const mockExecFile = vi.mocked(execFile);
const mockExecFileSync = vi.mocked(execFileSync);

function simulatePsOutput(stdout: string): void {
  mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
    (callback as (err: Error | null, stdout: string) => void)(null, stdout);
    return {} as ReturnType<typeof execFile>;
  });
}

function simulatePsError(): void {
  mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
    (callback as (err: Error | null, stdout: string) => void)(new Error('ps failed'), '');
    return {} as ReturnType<typeof execFile>;
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('listProcessCensus (Issue #1227)', () => {
  it('parses pid, ppid, rss, and full argv from ps output', async () => {
    simulatePsOutput(
      '12345     1  34816 node /opt/codev/dist/terminal/shellper-main.js {"cwd":"/ws"}\n' +
      '   99  12345    512 /bin/bash -c echo hi\n',
    );

    const entries = await listProcessCensus();

    expect(entries).toEqual([
      { pid: 12345, ppid: 1, rssKb: 34816, cmdline: 'node /opt/codev/dist/terminal/shellper-main.js {"cwd":"/ws"}' },
      { pid: 99, ppid: 12345, rssKb: 512, cmdline: '/bin/bash -c echo hi' },
    ]);
  });

  it('invokes ps with -A -ww -eo pid=,ppid=,rss=,args= for full, untruncated argv', async () => {
    simulatePsOutput('');

    await listProcessCensus();

    expect(mockExecFile).toHaveBeenCalledWith(
      'ps',
      ['-A', '-ww', '-eo', 'pid=,ppid=,rss=,args='],
      expect.objectContaining({ timeout: 5000 }),
      expect.any(Function),
    );
  });

  it('skips malformed lines rather than throwing', async () => {
    simulatePsOutput(
      'not-a-pid-line\n' +
      '12345     1  34816 node /path/to/thing\n' +
      '\n',
    );

    const entries = await listProcessCensus();

    expect(entries).toEqual([
      { pid: 12345, ppid: 1, rssKb: 34816, cmdline: 'node /path/to/thing' },
    ]);
  });

  it('returns an empty array for empty ps output', async () => {
    simulatePsOutput('');

    expect(await listProcessCensus()).toEqual([]);
  });

  it('resolves to an empty array (never rejects) when ps itself fails', async () => {
    simulatePsError();

    await expect(listProcessCensus()).resolves.toEqual([]);
  });

  it('preserves a JSON-blob argv containing many spaces', async () => {
    const argv = 'node shellper-main.js {"cwd":"/ws","env":{"PATH":"/usr/bin:/bin"},"args":["a","b"]}';
    simulatePsOutput(`  555     1   1024 ${argv}\n`);

    const entries = await listProcessCensus();

    expect(entries).toEqual([{ pid: 555, ppid: 1, rssKb: 1024, cmdline: argv }]);
  });

  // Regression (codex #1227 PR review): listProcessCensus() is called from
  // handleHealthCheck() on the `/health` HTTP path. A synchronous execFileSync
  // there blocks Tower's entire event loop — freezing every open terminal's
  // WebSocket traffic — for the duration of the `ps` call, on every request.
  // This pins the non-blocking contract structurally (never invoking the sync
  // API) rather than via a timing assertion, which would be flaky.
  it('never calls the synchronous execFileSync API', async () => {
    simulatePsOutput('12345     1  34816 node shellper-main.js\n');

    await listProcessCensus();

    expect(mockExecFileSync).not.toHaveBeenCalled();
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });
});
