/**
 * Spec 1658 Phase 4: `afx tower stop` on Windows, with every system seam
 * injected.
 *
 * - The graceful path asks Tower over HTTP and waits on the pid it names.
 * - A Tower that does not exit is killed alone (never its tree: sessions survive).
 * - Without an answer, only a pid that holds the port is killed; a lock pid
 *   that no longer listens (reused) is left alone.
 * - The force path kills every shellper's session tree (with its job) and
 *   Tower's tree.
 */

import { describe, it, expect, vi } from 'vitest';
import { forceKillTowerWindows, stopTowerWindows, WINDOWS_STOP_EXIT_TIMEOUT_MS, type WindowsStopDeps } from '../commands/tower-stop-windows.js';
import type { TowerOwner } from '../db/tower-owner.js';
import { checkWindowsTowerSession } from '../../commands/doctor.js';
import { SUPPORTED_TOWER_LAUNCH_PATHS, TOWER_IN_SESSION_WARNING, towerBootSessionWarning } from '../commands/tower-start-windows.js';
import { windowsShellperCmdline } from '../../terminal/__tests__/windows-cmdline-fixtures.js';
import { resetHostPlatformForTests, setHostPlatformForTests } from '../../lib/platform.js';

function owner(pid: number, port = 4100): TowerOwner {
  return { pid, port, hostname: 'h', startedAt: 1, dbDir: 'C:\\af', bindHost: '127.0.0.1' };
}

function fakeDeps(overrides: Partial<WindowsStopDeps> & { alive?: Set<number> } = {}) {
  const alive = overrides.alive ?? new Set<number>();
  let clock = 0;
  const deps: WindowsStopDeps = {
    readOwner: () => null,
    listeners: () => [],
    requestShutdown: async () => null,
    isAlive: (pid) => alive.has(pid),
    kill: vi.fn((pid: number) => {
      alive.delete(pid);
    }),
    releaseLock: vi.fn(),
    census: async () => [],
    killTree: vi.fn(async (pid: number) => {
      alive.delete(pid);
      return { signaled: true, snapshot: { rootPid: pid, members: [] } };
    }),
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    log: { info: vi.fn(), warn: vi.fn(), success: vi.fn() },
    ...overrides,
  };
  return { deps, alive };
}

describe('stopTowerWindows', () => {
  it('asks Tower to shut down and waits for the pid it names; no kill', async () => {
    const alive = new Set([500]);
    const requestShutdown = vi.fn(async () => {
      setTimeout(() => alive.delete(500), 0);
      return 500;
    });
    const { deps } = fakeDeps({ alive, readOwner: () => owner(500), requestShutdown });
    // Tower exits after a couple of polls.
    let polls = 0;
    deps.isAlive = (pid) => {
      polls++;
      return polls < 3 && pid === 500;
    };

    const result = await stopTowerWindows(4100, deps);

    expect(requestShutdown).toHaveBeenCalledWith('127.0.0.1', 4100);
    expect(result).toEqual({ stopped: [500], graceful: true });
    expect(deps.kill).not.toHaveBeenCalled();
    expect(deps.killTree).not.toHaveBeenCalled();
  });

  it('kills the answering pid alone when it does not exit in time, and releases the lock', async () => {
    const { deps } = fakeDeps({ alive: new Set([500]), requestShutdown: async () => 500 });
    deps.isAlive = () => true;

    const result = await stopTowerWindows(4100, deps);

    expect(result).toEqual({ stopped: [500], graceful: false });
    expect(deps.kill).toHaveBeenCalledWith(500);
    expect(deps.releaseLock).toHaveBeenCalledWith(500);
    expect(deps.killTree).not.toHaveBeenCalled();
    expect(deps.now()).toBeGreaterThanOrEqual(WINDOWS_STOP_EXIT_TIMEOUT_MS);
  });

  it('without an answer, kills only the port listener, not a lock pid that no longer listens', async () => {
    const { deps } = fakeDeps({ alive: new Set([500, 600]), readOwner: () => owner(600), listeners: () => [500] });

    const result = await stopTowerWindows(4100, deps);

    expect(result).toEqual({ stopped: [500], graceful: false });
    expect(deps.kill).toHaveBeenCalledTimes(1);
    expect(deps.kill).toHaveBeenCalledWith(500);
  });

  it('reports not running when nothing answers and nothing listens', async () => {
    const { deps } = fakeDeps({ alive: new Set([600]), readOwner: () => owner(600) });
    expect(await stopTowerWindows(4100, deps)).toEqual({ stopped: [], graceful: false });
    expect(deps.kill).not.toHaveBeenCalled();
  });

  it('probes the recorded bind host', async () => {
    const requestShutdown = vi.fn(async () => null);
    const bridged = { ...owner(500), bindHost: '0.0.0.0' };
    const { deps } = fakeDeps({ alive: new Set([500]), readOwner: () => bridged, requestShutdown });
    await stopTowerWindows(4100, deps);
    expect(requestShutdown).toHaveBeenCalledWith('127.0.0.1', 4100);
  });
});

describe('forceKillTowerWindows', () => {
  it('kills every shellper session tree with its job, then Tower\'s tree', async () => {
    setHostPlatformForTests('win32');
    try {
      const census = [
        { pid: 500, ppid: 1, rssKb: 1, cmdline: 'node tower-server.js 4100', creationTime: 5 },
        { pid: 700, ppid: 1, rssKb: 1, cmdline: windowsShellperCmdline({ sessionId: 's-700' }), creationTime: 7 },
        { pid: 800, ppid: 700, rssKb: 1, cmdline: 'cmd.exe', creationTime: 8 },
      ];
      const { deps } = fakeDeps({ alive: new Set([500, 700, 800]), listeners: () => [500], census: async () => census });

      expect(await forceKillTowerWindows(4100, deps)).toBe(2);

      expect(deps.killTree).toHaveBeenNthCalledWith(1, 700, { rootStartTime: 7, jobName: 'Local\\codev-session-s-700' });
      expect(deps.killTree).toHaveBeenNthCalledWith(2, 500, { rootStartTime: 5 });
      expect(deps.releaseLock).toHaveBeenCalledWith(500);
    } finally {
      resetHostPlatformForTests();
    }
  });

  it('still kills Tower when the census fails, and says so', async () => {
    const { deps } = fakeDeps({
      alive: new Set([500]),
      listeners: () => [500],
      census: async () => {
        throw new Error('blocked');
      },
    });
    expect(await forceKillTowerWindows(4100, deps)).toBe(1);
    expect(deps.log.warn).toHaveBeenCalledWith(expect.stringContaining('blocked'));
  });
});

describe('Tower inside a codev session (boot self-check and doctor)', () => {
  it('boot: one warning on Windows with the marker, none otherwise', () => {
    const warning = towerBootSessionWarning({ CODEV_SHELLPER_SESSION: 's' }, true);
    expect(warning).toContain(TOWER_IN_SESSION_WARNING);
    expect(warning).toContain(SUPPORTED_TOWER_LAUNCH_PATHS);
    expect(towerBootSessionWarning({}, true)).toBeNull();
    expect(towerBootSessionWarning({ CODEV_SHELLPER_SESSION: 's' }, false)).toBeNull();
  });

  it('doctor: warns from /health, skips when no Tower answers', () => {
    expect(checkWindowsTowerSession({ insideCodevSession: true })).toEqual({
      status: 'warn',
      summary: TOWER_IN_SESSION_WARNING,
      recommendation: `Stop Tower, then ${SUPPORTED_TOWER_LAUNCH_PATHS}`,
    });
    expect(checkWindowsTowerSession({ insideCodevSession: false }).status).toBe('ok');
    expect(checkWindowsTowerSession(null).status).toBe('skipped');
  });
});
