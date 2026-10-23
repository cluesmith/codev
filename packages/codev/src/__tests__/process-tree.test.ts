/**
 * Spec 1658 Phase 3: session-tree teardown (`lib/process-tree.ts`).
 *
 * POSIX: `killSessionTree` / `waitForTreeExit` issue exactly the group signals
 * and probes the inline `process.kill(-pid)` code did.
 * Windows (seam forced, injected census/taskkill/kill): the descendant
 * snapshot is taken before the kill, recorded descendants that `taskkill /T`
 * missed are killed explicitly, a reused PID (creation-time mismatch) is
 * spared, and a census failure surfaces as an error.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  collectTree,
  killSessionTree,
  waitForTreeExit,
  type TreeSnapshot,
} from '../lib/process-tree.js';
import { resetHostPlatformForTests, setHostPlatformForTests } from '../lib/platform.js';
import type { ProcessCensusEntry } from '../agent-farm/servers/process-census.js';

afterEach(() => {
  resetHostPlatformForTests();
  vi.useRealTimers();
});

function esrch(): Error {
  return Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
}

function entry(pid: number, ppid: number, creationTime: number): ProcessCensusEntry {
  return { pid, ppid, rssKb: 0, cmdline: `proc-${pid}`, creationTime };
}

describe('killSessionTree on POSIX', () => {
  beforeEach(() => {
    setHostPlatformForTests('linux');
  });

  it('sends SIGTERM to the process group and nothing else by default', async () => {
    const kill = vi.fn();
    const result = await killSessionTree(4321, { kill });
    expect(kill.mock.calls).toEqual([[-4321, 'SIGTERM']]);
    expect(result).toEqual({ signaled: true, snapshot: { rootPid: 4321, members: [] } });
  });

  it('signals in the same tick as the call (no await before the group signal)', () => {
    const kill = vi.fn();
    const pending = killSessionTree(4321, { kill, signal: 'SIGINT' });
    expect(kill).toHaveBeenCalledWith(-4321, 'SIGINT');
    return pending;
  });

  it('falls back to the single pid when the group signal fails, only if asked', async () => {
    const groupFails = vi.fn((pid: number) => {
      if (pid < 0) throw esrch();
    });
    const withFallback = await killSessionTree(77, { kill: groupFails, fallbackToPid: true });
    expect(groupFails.mock.calls).toEqual([[-77, 'SIGTERM'], [77, 'SIGTERM']]);
    expect(withFallback.signaled).toBe(true);

    const noFallback = vi.fn(() => {
      throw esrch();
    });
    const without = await killSessionTree(77, { kill: noFallback });
    expect(noFallback.mock.calls).toEqual([[-77, 'SIGTERM']]);
    expect(without.signaled).toBe(false);
  });

  it('escalates to a group SIGKILL after the delay, only when the first signal landed', async () => {
    vi.useFakeTimers();
    const kill = vi.fn();
    await killSessionTree(500, { kill, escalateAfterMs: 5000 });
    expect(kill.mock.calls).toEqual([[-500, 'SIGTERM']]);
    vi.advanceTimersByTime(4999);
    expect(kill).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(kill.mock.calls).toEqual([[-500, 'SIGTERM'], [-500, 'SIGKILL']]);

    const dead = vi.fn(() => {
      throw esrch();
    });
    await killSessionTree(501, { kill: dead, escalateAfterMs: 5000 });
    vi.advanceTimersByTime(10_000);
    expect(dead.mock.calls).toEqual([[-501, 'SIGTERM']]);
  });

  it('never consults the census or taskkill', async () => {
    const census = vi.fn(async () => []);
    const taskkill = vi.fn(async () => {});
    await killSessionTree(9, { kill: vi.fn(), census, taskkill });
    expect(census).not.toHaveBeenCalled();
    expect(taskkill).not.toHaveBeenCalled();
  });
});

describe('waitForTreeExit on POSIX', () => {
  beforeEach(() => {
    setHostPlatformForTests('linux');
  });

  it('probes the process group with signal 0 until it is empty', async () => {
    let probes = 0;
    const kill = vi.fn(() => {
      probes++;
      if (probes >= 3) throw esrch();
    });
    const done = await waitForTreeExit(600, { rootPid: 600, members: [] }, 5000, { kill, pollMs: 1 });
    expect(done).toBe(true);
    expect(kill.mock.calls.every(([pid, signal]) => pid === -600 && signal === 0)).toBe(true);
    expect(kill).toHaveBeenCalledTimes(3);
  });

  it('resolves false when the group outlives the timeout', async () => {
    const kill = vi.fn();
    expect(await waitForTreeExit(600, { rootPid: 600, members: [] }, 20, { kill, pollMs: 5 })).toBe(false);
  });
});

describe('collectTree', () => {
  it('collects the root and its descendants through ppid links', () => {
    const census = [entry(10, 1, 100), entry(11, 10, 110), entry(12, 11, 120), entry(99, 1, 50)];
    expect(collectTree(census, 10).map((m) => m.pid)).toEqual([10, 11, 12]);
  });

  it('finds the children of a root that has already exited', () => {
    const census = [entry(11, 10, 110), entry(12, 11, 120)];
    expect(collectTree(census, 10).map((m) => m.pid)).toEqual([11, 12]);
  });

  it('skips a "child" created before its parent (the ppid names a reused pid)', () => {
    const census = [entry(10, 1, 100), entry(11, 10, 50)];
    expect(collectTree(census, 10).map((m) => m.pid)).toEqual([10]);
  });

  it('never includes the calling process', () => {
    const census = [entry(10, 1, 100), entry(process.pid, 10, 110)];
    expect(collectTree(census, 10).map((m) => m.pid)).toEqual([10]);
  });
});

describe('killSessionTree on Windows', () => {
  function windowsHarness(opts: {
    censuses: Array<ProcessCensusEntry[] | Error>;
    alive: Set<number>;
  }) {
    const events: string[] = [];
    let censusCalls = 0;
    const census = vi.fn(async () => {
      const next = opts.censuses[Math.min(censusCalls, opts.censuses.length - 1)];
      censusCalls++;
      events.push('census');
      if (next instanceof Error) throw next;
      return next;
    });
    const taskkill = vi.fn(async (pid: number) => {
      events.push(`taskkill ${pid}`);
    });
    const kill = vi.fn((pid: number, signal: NodeJS.Signals | 0) => {
      if (signal === 0) {
        if (!opts.alive.has(pid)) throw esrch();
        return;
      }
      events.push(`kill ${pid}`);
      opts.alive.delete(pid);
    });
    return { census, taskkill, kill, events };
  }

  it('snapshots the tree before taskkill, then kills a descendant taskkill missed', async () => {
    setHostPlatformForTests('win32');
    // root 10 -> intermediate 11 -> grandchild 12. The intermediate exits
    // after the snapshot, so taskkill /T cannot walk to 12.
    const before = [entry(10, 1, 100), entry(11, 10, 110), entry(12, 11, 120)];
    const after = [entry(12, 11, 120)];
    const h = windowsHarness({ censuses: [before, after], alive: new Set([12]) });

    const result = await killSessionTree(10, { census: h.census, taskkill: h.taskkill, kill: h.kill });

    expect(h.events).toEqual(['census', 'taskkill 10', 'census', 'kill 12']);
    expect(result.signaled).toBe(true);
    expect(result.snapshot.members.map((m) => m.pid)).toEqual([10, 11, 12]);
  });

  it('clears the recorded descendants when the root is already dead, without taskkill on its pid', async () => {
    setHostPlatformForTests('win32');
    const census = [entry(21, 20, 210), entry(22, 21, 220)];
    const h = windowsHarness({ censuses: [census, census], alive: new Set([21, 22]) });

    const result = await killSessionTree(20, { census: h.census, taskkill: h.taskkill, kill: h.kill });

    expect(h.events).toEqual(['census', 'census', 'kill 21', 'kill 22']);
    expect(result.signaled).toBe(true);
  });

  it('kills nothing when the root pid was reused (creation time differs from the known start)', async () => {
    setHostPlatformForTests('win32');
    const census = [entry(25, 1, 900_000), entry(26, 25, 900_100)];
    const h = windowsHarness({ censuses: [census], alive: new Set([25, 26]) });

    const result = await killSessionTree(25, { census: h.census, taskkill: h.taskkill, kill: h.kill, rootStartTime: 100_000 });

    expect(h.events).toEqual(['census']);
    expect(result).toEqual({ signaled: false, snapshot: { rootPid: 25, members: [] }, refused: 'reused-pid' });
  });

  it('fails closed and rejects, naming pid and cause, when the root has no creation time to check against the known start', async () => {
    setHostPlatformForTests('win32');
    const root: ProcessCensusEntry = { pid: 24, ppid: 1, rssKb: 0, cmdline: 'proc-24' };
    const h = windowsHarness({ censuses: [[root, entry(31, 24, 900)]], alive: new Set([24, 31]) });

    await expect(
      killSessionTree(24, { census: h.census, taskkill: h.taskkill, kill: h.kill, rootStartTime: 100_000, fallbackToPid: true }),
    ).rejects.toThrow(/pid 24 skipped: the census has no creation time/);

    // fallbackToPid does not reopen it: nothing is signaled.
    expect(h.events).toEqual(['census']);
  });

  it('accepts a root whose creation time is within tolerance of the known start', async () => {
    setHostPlatformForTests('win32');
    const census = [entry(27, 1, 101_500)];
    const h = windowsHarness({ censuses: [census], alive: new Set() });
    await killSessionTree(27, { census: h.census, taskkill: h.taskkill, kill: h.kill, rootStartTime: 100_000 });
    expect(h.events).toEqual(['census', 'taskkill 27']);
  });

  it('for a dead root with a known start, skips ppid matches created before it', async () => {
    setHostPlatformForTests('win32');
    // 29 predates the root's start: its ppid names an earlier holder of pid 28.
    const census = [entry(29, 28, 50_000), entry(30, 28, 100_500)];
    const h = windowsHarness({ censuses: [census, census], alive: new Set([29, 30]) });

    const result = await killSessionTree(28, { census: h.census, taskkill: h.taskkill, kill: h.kill, rootStartTime: 100_000 });

    expect(result.snapshot.members.map((m) => m.pid)).toEqual([30]);
    expect(h.events).toEqual(['census', 'census', 'kill 30']);
  });

  it('takes the snapshot before terminating the session job, then runs the kill pass', async () => {
    setHostPlatformForTests('win32');
    const census = [entry(40, 1, 100), entry(41, 40, 110)];
    const h = windowsHarness({ censuses: [census, census], alive: new Set([41]) });
    const terminateJob = vi.fn(async (name: string, rootPid: number) => {
      h.events.push(`terminate ${name} ${rootPid}`);
      return { ok: true, found: true, member: true };
    });

    const result = await killSessionTree(40, { census: h.census, taskkill: h.taskkill, kill: h.kill, jobName: 'J', terminateJob });

    expect(h.events).toEqual(['census', 'terminate J 40', 'taskkill 40', 'census', 'kill 41']);
    expect(result.jobError).toBeUndefined();
  });

  it('kills a descendant that broke away from the job after the job took its parents', async () => {
    setHostPlatformForTests('win32');
    // 50 root, 51 bash inside the job, 52 a native child that broke away.
    const before = [entry(50, 1, 100), entry(51, 50, 110), entry(52, 51, 120)];
    // After the job ends: only the breakaway child is left, its parent gone.
    const after = [entry(52, 51, 120)];
    const h = windowsHarness({ censuses: [before, after], alive: new Set([52]) });
    const terminateJob = vi.fn(async (name: string, rootPid: number) => {
      h.events.push(`terminate ${name} ${rootPid}`);
      return { ok: true, found: true, member: true };
    });

    const result = await killSessionTree(50, { census: h.census, taskkill: h.taskkill, kill: h.kill, jobName: 'J', terminateJob });

    expect(result.snapshot.members.map((m) => m.pid)).toEqual([50, 51, 52]);
    expect(h.events).toEqual(['census', 'terminate J 50', 'taskkill 50', 'census', 'kill 52']);
  });

  it('counts a terminated job as signaled even when the census then finds nothing', async () => {
    setHostPlatformForTests('win32');
    const h = windowsHarness({ censuses: [[]], alive: new Set() });
    const terminateJob = vi.fn(async () => ({ ok: true, found: true, member: true }));
    const result = await killSessionTree(45, { census: h.census, taskkill: h.taskkill, kill: h.kill, jobName: 'J', terminateJob });
    expect(result.signaled).toBe(true);

    const notOurs = vi.fn(async () => ({ ok: true, found: true, member: false }));
    const other = windowsHarness({ censuses: [[]], alive: new Set() });
    expect((await killSessionTree(46, { census: other.census, taskkill: other.taskkill, kill: other.kill, jobName: 'J', terminateJob: notOurs })).signaled).toBe(false);
  });

  it('does not report a job error when jobs are disabled (reported once already)', async () => {
    setHostPlatformForTests('win32');
    const h = windowsHarness({ censuses: [[entry(47, 1, 100)]], alive: new Set() });
    const terminateJob = vi.fn(async () => ({ ok: false, error: 'Per-session job objects disabled', helperFailure: true, disabled: true }));
    const result = await killSessionTree(47, { census: h.census, taskkill: h.taskkill, kill: h.kill, jobName: 'J', terminateJob });
    expect(result.jobError).toBeUndefined();
  });

  it('reports a failed job terminate and still runs the snapshot pass', async () => {
    setHostPlatformForTests('win32');
    const census = [entry(42, 1, 100)];
    const h = windowsHarness({ censuses: [census], alive: new Set() });
    const terminateJob = vi.fn(async () => ({ ok: false, error: 'TerminateJobObject failed', code: 5 }));

    const result = await killSessionTree(42, { census: h.census, taskkill: h.taskkill, kill: h.kill, jobName: 'J', terminateJob });

    expect(h.events).toEqual(['census', 'taskkill 42']);
    expect(result.jobError).toBe('job J not terminated: TerminateJobObject failed (Win32 error 5)');
  });

  it('terminates the job even when the root pid was reused, and names it in a refusal or census failure', async () => {
    setHostPlatformForTests('win32');
    const terminateJob = vi.fn(async () => ({ ok: true, found: true, member: true }));
    const reused = windowsHarness({ censuses: [[entry(43, 1, 900_000)]], alive: new Set([43]) });
    const refused = await killSessionTree(43, { census: reused.census, taskkill: reused.taskkill, kill: reused.kill, rootStartTime: 100_000, jobName: 'J', terminateJob });
    expect(refused.refused).toBe('reused-pid');
    expect(terminateJob).toHaveBeenCalledTimes(1);

    const failing = windowsHarness({ censuses: [new Error('cim down')], alive: new Set() });
    await expect(
      killSessionTree(44, { census: failing.census, taskkill: failing.taskkill, kill: failing.kill, jobName: 'J', terminateJob }),
    ).rejects.toThrow(/cim down; its session job was terminated/);
  });

  it('ignores the job name on POSIX', async () => {
    setHostPlatformForTests('linux');
    const kill = vi.fn();
    const terminateJob = vi.fn();
    await killSessionTree(4321, { kill, jobName: 'J', terminateJob });
    expect(terminateJob).not.toHaveBeenCalled();
  });

  it('spares a recorded pid whose creation time no longer matches (pid reused)', async () => {
    setHostPlatformForTests('win32');
    const before = [entry(30, 1, 300), entry(31, 30, 310)];
    const after = [entry(31, 5, 999)];
    const h = windowsHarness({ censuses: [before, after], alive: new Set([31]) });

    await killSessionTree(30, { census: h.census, taskkill: h.taskkill, kill: h.kill });

    expect(h.events).toEqual(['census', 'taskkill 30', 'census']);
  });

  it('skips the second census when taskkill left nothing alive', async () => {
    setHostPlatformForTests('win32');
    const h = windowsHarness({ censuses: [[entry(40, 1, 400), entry(41, 40, 410)]], alive: new Set() });

    await killSessionTree(40, { census: h.census, taskkill: h.taskkill, kill: h.kill });

    expect(h.events).toEqual(['census', 'taskkill 40']);
  });

  it('reports nothing signaled when the census shows no tree', async () => {
    setHostPlatformForTests('win32');
    const h = windowsHarness({ censuses: [[entry(99, 1, 1)]], alive: new Set() });
    const result = await killSessionTree(50, { census: h.census, taskkill: h.taskkill, kill: h.kill });
    expect(result.signaled).toBe(false);
  });

  it('on a census failure still runs taskkill on the root, then rejects', async () => {
    setHostPlatformForTests('win32');
    const h = windowsHarness({ censuses: [new Error('CIM blocked by policy')], alive: new Set() });

    await expect(killSessionTree(60, { census: h.census, taskkill: h.taskkill, kill: h.kill }))
      .rejects.toThrow(/taskkill only.*CIM blocked by policy/);
    expect(h.events).toEqual(['census', 'taskkill 60']);
  });
});

describe('waitForTreeExit on Windows', () => {
  const snapshot: TreeSnapshot = {
    rootPid: 70,
    members: [{ pid: 70, creationTime: 700 }, { pid: 71, creationTime: 710 }],
  };

  it('polls the snapshot members until none answers', async () => {
    setHostPlatformForTests('win32');
    const alive = new Set([70, 71]);
    let polls = 0;
    const kill = vi.fn((pid: number) => {
      polls++;
      if (polls > 3) alive.clear();
      if (!alive.has(pid)) throw esrch();
    });
    expect(await waitForTreeExit(70, snapshot, 5000, { kill, pollMs: 1 })).toBe(true);
    expect(kill.mock.calls.every(([pid]) => pid === 70 || pid === 71)).toBe(true);
  });

  it('treats a survivor whose creation time changed as gone (pid reused)', async () => {
    setHostPlatformForTests('win32');
    const kill = vi.fn();
    const census = vi.fn(async () => [entry(70, 1, 1234), entry(71, 1, 5678)]);
    expect(await waitForTreeExit(70, snapshot, 10, { kill, pollMs: 2, census })).toBe(true);
    expect(census).toHaveBeenCalledTimes(1);
  });

  it('resolves false when a member is still the same process at the deadline', async () => {
    setHostPlatformForTests('win32');
    const kill = vi.fn();
    const census = vi.fn(async () => [entry(71, 70, 710)]);
    expect(await waitForTreeExit(70, snapshot, 10, { kill, pollMs: 2, census })).toBe(false);
  });
});
