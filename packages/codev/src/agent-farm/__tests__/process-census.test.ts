/**
 * Issue #1227: process-census.ts — the shared ps snapshot backing both the
 * shellper husk sweep and fleet-RSS observability.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { listProcessCensus } from '../servers/process-census.js';

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execFileSync: vi.fn(),
  };
});

const mockExecFileSync = vi.mocked(execFileSync);

afterEach(() => {
  vi.clearAllMocks();
});

describe('listProcessCensus (Issue #1227)', () => {
  it('parses pid, ppid, rss, and full argv from ps output', () => {
    mockExecFileSync.mockReturnValue(
      '12345     1  34816 node /opt/codev/dist/terminal/shellper-main.js {"cwd":"/ws"}\n' +
      '   99  12345    512 /bin/bash -c echo hi\n',
    );

    const entries = listProcessCensus();

    expect(entries).toEqual([
      { pid: 12345, ppid: 1, rssKb: 34816, cmdline: 'node /opt/codev/dist/terminal/shellper-main.js {"cwd":"/ws"}' },
      { pid: 99, ppid: 12345, rssKb: 512, cmdline: '/bin/bash -c echo hi' },
    ]);
  });

  it('invokes ps with -A -ww -eo pid=,ppid=,rss=,args= for full, untruncated argv', () => {
    mockExecFileSync.mockReturnValue('');

    listProcessCensus();

    expect(mockExecFileSync).toHaveBeenCalledWith(
      'ps',
      ['-A', '-ww', '-eo', 'pid=,ppid=,rss=,args='],
      expect.objectContaining({ encoding: 'utf-8' }),
    );
  });

  it('skips malformed lines rather than throwing', () => {
    mockExecFileSync.mockReturnValue(
      'not-a-pid-line\n' +
      '12345     1  34816 node /path/to/thing\n' +
      '\n',
    );

    const entries = listProcessCensus();

    expect(entries).toEqual([
      { pid: 12345, ppid: 1, rssKb: 34816, cmdline: 'node /path/to/thing' },
    ]);
  });

  it('returns an empty array for empty ps output', () => {
    mockExecFileSync.mockReturnValue('');

    expect(listProcessCensus()).toEqual([]);
  });

  it('preserves a JSON-blob argv containing many spaces', () => {
    const argv = 'node shellper-main.js {"cwd":"/ws","env":{"PATH":"/usr/bin:/bin"},"args":["a","b"]}';
    mockExecFileSync.mockReturnValue(`  555     1   1024 ${argv}\n`);

    const entries = listProcessCensus();

    expect(entries).toEqual([{ pid: 555, ppid: 1, rssKb: 1024, cmdline: argv }]);
  });
});
