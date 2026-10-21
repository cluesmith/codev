/**
 * Spec 1658 Phase 9: the Codev IDE server's Windows lifecycle, with the host
 * platform forced and every system seam injected.
 *
 * - Spawn goes through the shared shim resolver on Windows and is the plain
 *   `spawn` on POSIX.
 * - Stop kills the server's process tree on Windows: the recorded root only
 *   when a live listener descends from it (so a reused pid is never a root),
 *   any other listener as a root of its own. POSIX keeps the per-pid
 *   SIGTERM/SIGKILL loop.
 * - The Windows readiness probe is a loopback connect.
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import http from 'node:http';
import { rmSync } from 'node:fs';
import type { ProcessCensusEntry } from '../servers/process-census.js';

const TMP_DIR = vi.hoisted(() => `${process.env.TMPDIR || '/tmp'}/ide-server-windows-${process.pid}-${Date.now()}`);

vi.mock('@cluesmith/codev-core/constants', async (importActual) => {
  const actual = await importActual<typeof import('@cluesmith/codev-core/constants')>();
  return { ...actual, AGENT_FARM_DIR: TMP_DIR };
});

const spawnMock = vi.hoisted(() => vi.fn());
const spawnOnHostMock = vi.hoisted(() => vi.fn());
const portPids = vi.hoisted(() => ({ value: [] as number[] }));
const killSessionTreeMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async (importActual) => {
  const actual = await importActual<typeof import('node:child_process')>();
  return { ...actual, spawn: spawnMock };
});
vi.mock('../../lib/shell-launch.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/shell-launch.js')>();
  return { ...actual, spawnOnHost: spawnOnHostMock };
});
vi.mock('../utils/port.js', async (importActual) => {
  const actual = await importActual<typeof import('../utils/port.js')>();
  return { ...actual, getProcessesOnPort: () => portPids.value };
});
vi.mock('../../lib/process-tree.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/process-tree.js')>();
  return { ...actual, killSessionTree: killSessionTreeMock };
});
vi.mock('../servers/process-census.js', async (importActual) => {
  const actual = await importActual<typeof import('../servers/process-census.js')>();
  return { ...actual, listProcessCensus: async () => [] };
});

import {
  isPortAccepting,
  spawnIdeServerProcess,
  stopIdeServer,
  stopWindowsIdeServer,
  windowsIdeStopRoots,
} from '../servers/ide-server.js';
import { readIdeRecord, writeIdeRecord, type IdeServerRecord } from '../lib/ide-record.js';
import { resetHostPlatformForTests, setHostPlatformForTests } from '../../lib/platform.js';

function entry(pid: number, ppid: number, creationTime: number): ProcessCensusEntry {
  return { pid, ppid, rssKb: 1, cmdline: `proc-${pid}`, creationTime };
}

function record(pid: number, port = 8200): IdeServerRecord {
  return { prefix: '/ide/', port, serverPath: 'C:\\tools\\codev-ide-server.cmd', pid, startedAt: new Date().toISOString() };
}

const noopLog = (): void => {};

afterEach(() => {
  resetHostPlatformForTests();
  vi.clearAllMocks();
  portPids.value = [];
});

afterAll(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

describe('spawnIdeServerProcess', () => {
  const options = { detached: true, stdio: 'ignore' as const };

  it('Windows: spawns through the shim resolver with the arguments unaltered', () => {
    setHostPlatformForTests('win32');
    const longDir = `C:\\Users\\dev\\${'nested-folder\\'.repeat(20)}`;
    const args = ['--connection-token-file', `${longDir}ide-connection-token`];
    expect(args[1].length).toBeGreaterThan(260);
    spawnIdeServerProcess('C:\\tools\\codev-ide-server.cmd', args, options);
    expect(spawnOnHostMock).toHaveBeenCalledWith('C:\\tools\\codev-ide-server.cmd', args, options);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('POSIX: the plain spawn, exactly as before', () => {
    setHostPlatformForTests('linux');
    spawnIdeServerProcess('/opt/codev-ide/bin/server', ['--port', '8200'], options);
    expect(spawnMock).toHaveBeenCalledWith('/opt/codev-ide/bin/server', ['--port', '8200'], options);
    expect(spawnOnHostMock).not.toHaveBeenCalled();
  });
});

describe('windowsIdeStopRoots', () => {
  // Tower 10 → cmd.exe 20 (recorded) → node 30 (listener) → extension host 40.
  const census = [entry(10, 1, 1000), entry(20, 10, 2000), entry(30, 20, 2100), entry(40, 30, 2200)];

  it('kills the recorded root when the listener descends from it', () => {
    const plan = windowsIdeStopRoots(census, 20, [30]);
    expect(plan.roots).toEqual([20]);
    expect(plan.targets.sort()).toEqual([20, 30, 40]);
  });

  it('a recorded pid with no listener under it (reused) is never a root', () => {
    // pid 20 now belongs to an unrelated process; the server is an adopted 50.
    const reused = [entry(20, 10, 9000), entry(50, 1, 3000), entry(60, 50, 3100)];
    const plan = windowsIdeStopRoots(reused, 20, [50]);
    expect(plan.roots).toEqual([50]);
    expect(plan.targets.sort()).toEqual([50, 60]);
  });

  it('a recorded pid that is the listener itself (npm shim, adoption) is one root', () => {
    const plan = windowsIdeStopRoots(census, 30, [30]);
    expect(plan.roots).toEqual([30]);
    expect(plan.targets.sort()).toEqual([30, 40]);
  });

  it('a listener missing from the census is still a root and a target', () => {
    const plan = windowsIdeStopRoots([], 20, [77]);
    expect(plan.roots).toEqual([77]);
    expect(plan.targets).toEqual([77]);
  });
});

describe('stopWindowsIdeServer', () => {
  beforeEach(() => {
    writeIdeRecord(record(20));
  });

  it('kills the tree, waits for every target, deletes the record', async () => {
    const alive = new Set([20, 30, 40]);
    const killTree = vi.fn(async (pid: number) => {
      if (pid === 20) {
        alive.delete(20);
        alive.delete(30);
        setTimeout(() => alive.delete(40), 50);
      }
    });
    const census = async () => [entry(20, 10, 2000), entry(30, 20, 2100), entry(40, 30, 2200)];
    const result = await stopWindowsIdeServer(record(20), [30], noopLog, {
      census,
      killTree,
      isAlive: (pid) => alive.has(pid),
    });
    expect(killTree).toHaveBeenCalledTimes(1);
    expect(killTree).toHaveBeenCalledWith(20);
    expect(alive.size).toBe(0);
    expect(result).toEqual({ stopped: true, port: 8200 });
    expect(readIdeRecord()).toBeNull();
  });

  it('a census failure falls back to the listeners and says so', async () => {
    const log = vi.fn();
    const killTree = vi.fn(async () => {});
    await stopWindowsIdeServer(record(20), [30, 31], log, {
      census: async () => {
        throw new Error('powershell unavailable');
      },
      killTree,
      isAlive: () => false,
    });
    expect(killTree.mock.calls.map((call) => call[0])).toEqual([30, 31]);
    expect(log).toHaveBeenCalledWith('WARN', expect.stringContaining('powershell unavailable'));
  });

  it('a failed tree kill is logged and the survivor reported; the record still goes', async () => {
    const log = vi.fn();
    const result = await stopWindowsIdeServer(record(20), [30], log, {
      census: async () => [entry(30, 1, 2100)],
      killTree: async () => {
        throw new Error('taskkill timed out');
      },
      isAlive: (pid) => pid === 30,
    });
    expect(result.stopped).toBe(true);
    expect(log).toHaveBeenCalledWith('WARN', expect.stringContaining('taskkill timed out'));
    expect(log).toHaveBeenCalledWith('WARN', expect.stringContaining('survived the tree kill: 30'));
    expect(readIdeRecord()).toBeNull();
  }, 10_000);

  it('nothing listening: no kill, stopped is false', async () => {
    const killTree = vi.fn(async () => {});
    const result = await stopWindowsIdeServer(record(20), [], noopLog, { killTree, isAlive: () => false });
    expect(killTree).not.toHaveBeenCalled();
    expect(result).toEqual({ stopped: false, port: 8200 });
  });
});

describe('stopIdeServer routing', () => {
  it('Windows: tree kill, no signals', async () => {
    setHostPlatformForTests('win32');
    writeIdeRecord(record(999_990));
    portPids.value = [999_991];
    const signal = vi.spyOn(process, 'kill');
    await stopIdeServer(noopLog);
    expect(killSessionTreeMock).toHaveBeenCalledWith(999_991);
    expect(signal.mock.calls.filter((call) => call[1] === 'SIGTERM' || call[1] === 'SIGKILL')).toEqual([]);
    signal.mockRestore();
  });

  it('POSIX: SIGTERM per listener pid, no tree kill', async () => {
    setHostPlatformForTests('linux');
    writeIdeRecord(record(999_990));
    portPids.value = [999_991];
    const signal = vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig?: string | number) => {
      if (sig === 0) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      return true;
    }) as typeof process.kill);
    await stopIdeServer(noopLog);
    expect(signal).toHaveBeenCalledWith(999_991, 'SIGTERM');
    expect(killSessionTreeMock).not.toHaveBeenCalled();
    signal.mockRestore();
  });
});

describe('isPortAccepting', () => {
  it('true for a listening loopback port, false once it closes', async () => {
    const server = http.createServer((_req, res) => res.end());
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr !== 'string') resolve(addr.port);
      });
    });
    expect(await isPortAccepting(port)).toBe(true);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await isPortAccepting(port)).toBe(false);
  });
});
