/**
 * Issue #1227: tests for the stricter husk-sweep predicate (unregistered AND
 * childless AND aged) and its orchestration. Uses the injectable-seam style
 * from architect-session-holder.test.ts (census/getStartTime/reap seams)
 * rather than mocking execFileSync directly, since the predicate logic — not
 * the ps invocation itself (covered by process-census.test.ts) — is under test.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  findHuskShellpers,
  computeRegisteredShellperPids,
  sweepShellperHusks,
  type FindHuskShellpersOptions,
} from '../servers/shellper-husk-sweep.js';
import type { ProcessCensusEntry } from '../servers/process-census.js';

const SOCKET_DIR = '/Users/x/.codev/run';
const OTHER_SOCKET_DIR = '/Users/x/.codev/run-e2e-test';

function shellperEntry(opts: {
  pid: number;
  ppid?: number;
  socketDir?: string;
  rssKb?: number;
}): ProcessCensusEntry {
  const dir = opts.socketDir ?? SOCKET_DIR;
  return {
    pid: opts.pid,
    ppid: opts.ppid ?? 1,
    rssKb: opts.rssKb ?? 34816,
    cmdline: `/usr/bin/node /opt/codev/dist/terminal/shellper-main.js {"socketPath":"${dir}/s-${opts.pid}.sock"}`,
  };
}

function otherEntry(pid: number, ppid: number, cmdline = '/bin/bash -c echo hi'): ProcessCensusEntry {
  return { pid, ppid, rssKb: 512, cmdline };
}

const ONE_HOUR = 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

function baseOpts(overrides: Partial<FindHuskShellpersOptions> = {}): FindHuskShellpersOptions {
  return {
    socketDir: SOCKET_DIR,
    registeredShellperPids: new Set<number>(),
    graceMs: ONE_HOUR,
    now: NOW,
    getStartTime: async () => NOW - 2 * ONE_HOUR,
    ...overrides,
  };
}

describe('findHuskShellpers (Issue #1227)', () => {
  it('sweeps a shellper that is unregistered AND childless AND aged', async () => {
    const entry = shellperEntry({ pid: 100 });
    const pids = await findHuskShellpers(baseOpts({ census: () => [entry] }));
    expect(pids).toEqual([100]);
  });

  it('does not sweep a registered shellper, even if childless and aged', async () => {
    const entry = shellperEntry({ pid: 100 });
    const pids = await findHuskShellpers(
      baseOpts({ census: () => [entry], registeredShellperPids: new Set([100]) }),
    );
    expect(pids).toEqual([]);
  });

  it('does not sweep a shellper that still has a child', async () => {
    const shellper = shellperEntry({ pid: 100 });
    const child = otherEntry(200, 100); // ppid=100 → shellper has a live child
    const pids = await findHuskShellpers(baseOpts({ census: () => [shellper, child] }));
    expect(pids).toEqual([]);
  });

  it('does not sweep an unregistered, childless shellper that is too young', async () => {
    const entry = shellperEntry({ pid: 100 });
    const pids = await findHuskShellpers(
      baseOpts({ census: () => [entry], getStartTime: async () => NOW - 10_000 }),
    );
    expect(pids).toEqual([]);
  });

  it('does not sweep when start time cannot be determined', async () => {
    const entry = shellperEntry({ pid: 100 });
    const pids = await findHuskShellpers(
      baseOpts({ census: () => [entry], getStartTime: async () => null }),
    );
    expect(pids).toEqual([]);
  });

  it('never touches a shellper scoped to a different socketDir', async () => {
    const foreign = shellperEntry({ pid: 100, socketDir: OTHER_SOCKET_DIR });
    const pids = await findHuskShellpers(baseOpts({ census: () => [foreign] }));
    expect(pids).toEqual([]);
  });

  it('ignores non-shellper processes entirely', async () => {
    const claude = otherEntry(100, 1, `/usr/bin/claude --resume abc ${SOCKET_DIR}/decoy`);
    const pids = await findHuskShellpers(baseOpts({ census: () => [claude] }));
    expect(pids).toEqual([]);
  });

  it('sweeps multiple independent husk candidates in one pass', async () => {
    const a = shellperEntry({ pid: 100 });
    const b = shellperEntry({ pid: 101 });
    const registered = shellperEntry({ pid: 102 });
    const pids = await findHuskShellpers(
      baseOpts({ census: () => [a, b, registered], registeredShellperPids: new Set([102]) }),
    );
    expect(pids.sort()).toEqual([100, 101]);
  });
});

function fakeDb(rows: Array<{ shellper_pid: number; shellper_start_time: number | null }>) {
  return {
    prepare: () => ({
      all: () => rows,
    }),
  } as unknown as import('better-sqlite3').Database;
}

describe('computeRegisteredShellperPids (Issue #1227)', () => {
  it('registers a pid whose live start time matches the DB row within tolerance', async () => {
    const db = fakeDb([{ shellper_pid: 100, shellper_start_time: NOW - 1000 }]);
    const getStartTime = async () => NOW - 1000;
    const registered = await computeRegisteredShellperPids(db, getStartTime);
    expect(registered.has(100)).toBe(true);
  });

  it('excludes a stale row whose PID was reused (start time mismatch)', async () => {
    const db = fakeDb([{ shellper_pid: 100, shellper_start_time: NOW - ONE_HOUR }]);
    const getStartTime = async () => NOW - 1000; // live process started much later — different process
    const registered = await computeRegisteredShellperPids(db, getStartTime);
    expect(registered.has(100)).toBe(false);
  });

  it('excludes a row whose PID is no longer alive', async () => {
    const db = fakeDb([{ shellper_pid: 100, shellper_start_time: NOW - 1000 }]);
    const getStartTime = async () => null;
    const registered = await computeRegisteredShellperPids(db, getStartTime);
    expect(registered.has(100)).toBe(false);
  });

  it('trusts a legacy row with no recorded start time', async () => {
    const db = fakeDb([{ shellper_pid: 100, shellper_start_time: null }]);
    const getStartTime = async () => NOW;
    const registered = await computeRegisteredShellperPids(db, getStartTime);
    expect(registered.has(100)).toBe(true);
  });
});

describe('sweepShellperHusks (Issue #1227)', () => {
  it('reaps exactly the husk candidates and reports them', async () => {
    const husk = shellperEntry({ pid: 100 });
    const db = fakeDb([]); // nothing registered
    const reap = vi.fn(async () => {});

    const result = await sweepShellperHusks({
      socketDir: SOCKET_DIR,
      db,
      graceMs: ONE_HOUR,
      now: NOW,
      getStartTime: async () => NOW - 2 * ONE_HOUR,
      census: () => [husk],
      reap,
    });

    expect(result).toEqual({ swept: 1, pids: [100] });
    expect(reap).toHaveBeenCalledWith([100]);
  });

  it('does not call reap when there is nothing to sweep', async () => {
    const db = fakeDb([{ shellper_pid: 100, shellper_start_time: NOW - 1000 }]);
    const reap = vi.fn(async () => {});

    const result = await sweepShellperHusks({
      socketDir: SOCKET_DIR,
      db,
      graceMs: ONE_HOUR,
      now: NOW,
      getStartTime: async () => NOW - 1000,
      census: () => [shellperEntry({ pid: 100 })], // registered → not a husk
      reap,
    });

    expect(result).toEqual({ swept: 0, pids: [] });
    expect(reap).not.toHaveBeenCalled();
  });
});
