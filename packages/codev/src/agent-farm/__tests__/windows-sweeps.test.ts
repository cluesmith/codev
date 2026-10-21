/**
 * Spec 1658 Phase 3: the sweeps and identity matchers on Windows (seam forced).
 *
 * - The husk sweep takes ONE census per sweep and reads start times from its
 *   creation times (no per-PID spawn), and scopes by the decoded socketDir.
 * - A census failure reaches the sweep's caller as an error.
 * - The architect session-holder matchers and `afx cleanup`'s shellper kill
 *   match escaped-backslash Windows command lines.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { ProcessCensusEntry } from '../servers/process-census.js';
import { resetHostPlatformForTests, setHostPlatformForTests } from '../../lib/platform.js';
import { windowsShellperCmdline } from '../../terminal/__tests__/windows-cmdline-fixtures.js';

const censusMock = vi.hoisted(() => ({ list: vi.fn() }));
const treeMock = vi.hoisted(() => ({ kill: vi.fn() }));

vi.mock('../servers/process-census.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../servers/process-census.js')>();
  return { ...actual, listProcessCensus: censusMock.list };
});
vi.mock('../../lib/process-tree.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/process-tree.js')>();
  return { ...actual, killSessionTree: treeMock.kill };
});

const { sweepShellperHusks, findHuskShellpers } = await import('../servers/shellper-husk-sweep.js');
const { listProcessEntries, findOwnArchitectShellpers, reconcileArchitectSessionHolder } = await import(
  '../servers/architect-session-holder.js'
);
const { killShellperProcesses } = await import('../commands/cleanup.js');

const SOCKET_DIR = 'C:\\Users\\me\\.agent-farm\\run';
const WS = 'C:\\Users\\me\\src\\repo';
const NOW = 1_800_000_000_000;
const ONE_HOUR = 60 * 60 * 1000;
const SID = '166e1c25-fd66-46ed-a81c-5dfcf2295efd';

function shellper(pid: number, opts: { socketDir?: string; cwd?: string; architect?: string; created?: number } = {}): ProcessCensusEntry {
  const config = {
    command: 'claude',
    args: ['--session-id', SID],
    cwd: opts.cwd ?? WS,
    env: { CODEV_ARCHITECT_NAME: opts.architect ?? 'main' },
    socketPath: `\\\\.\\pipe\\codev-shellper-me-${pid}`,
    socketDir: opts.socketDir ?? SOCKET_DIR,
    sessionId: `s-${pid}`,
  };
  return { pid, ppid: 1, rssKb: 1000, cmdline: windowsShellperCmdline(config), creationTime: opts.created ?? NOW - 2 * ONE_HOUR };
}

function emptyDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE terminal_sessions (shellper_pid INTEGER, shellper_start_time INTEGER)');
  return db;
}

beforeEach(() => {
  setHostPlatformForTests('win32');
  treeMock.kill.mockResolvedValue({ signaled: true, snapshot: { rootPid: 0, members: [] } });
});

afterEach(() => {
  resetHostPlatformForTests();
  vi.clearAllMocks();
});

describe('husk sweep on Windows', () => {
  it('takes one census per sweep and reads ages from its creation times', async () => {
    const db = emptyDb();
    // Registered row whose recorded start time matches the census creation time.
    db.prepare('INSERT INTO terminal_sessions VALUES (?, ?)').run(200, NOW - 3 * ONE_HOUR);
    censusMock.list.mockResolvedValue([
      shellper(100),
      shellper(200, { created: NOW - 3 * ONE_HOUR }),
      shellper(300, { created: NOW - 60_000 }),
      shellper(400, { socketDir: `${SOCKET_DIR}2` }),
    ]);
    const reap = vi.fn(async () => {});

    const result = await sweepShellperHusks({ socketDir: SOCKET_DIR, db, graceMs: ONE_HOUR, now: NOW, reap });

    expect(censusMock.list).toHaveBeenCalledTimes(1);
    // 100: unregistered, childless, aged. 200: registered. 300: too young. 400: other instance.
    expect(result).toEqual({ swept: 1, pids: [100] });
    // The reap gets the census creation time, so its teardown can refuse a reused pid.
    expect(reap).toHaveBeenCalledWith([100], new Map([[100, NOW - 2 * ONE_HOUR]]));
  });

  it('a stale row (pid reused, creation time differs) does not count as registered', async () => {
    const db = emptyDb();
    db.prepare('INSERT INTO terminal_sessions VALUES (?, ?)').run(100, NOW - 10 * ONE_HOUR);
    censusMock.list.mockResolvedValue([shellper(100)]);
    const result = await sweepShellperHusks({ socketDir: SOCKET_DIR, db, graceMs: ONE_HOUR, now: NOW, reap: async () => {} });
    expect(result.pids).toEqual([100]);
  });

  it('reports a failed reap to the caller rather than counting it as swept', async () => {
    censusMock.list.mockResolvedValue([shellper(100)]);
    const reap = vi.fn(async () => {
      throw new Error('shellper teardown incomplete');
    });
    await expect(sweepShellperHusks({ socketDir: SOCKET_DIR, db: emptyDb(), graceMs: ONE_HOUR, now: NOW, reap }))
      .rejects.toThrow('shellper teardown incomplete');
  });

  it('surfaces a census failure to the caller instead of sweeping nothing silently', async () => {
    censusMock.list.mockRejectedValue(new Error('process census failed (PowerShell CIM query): blocked'));
    await expect(sweepShellperHusks({ socketDir: SOCKET_DIR, db: emptyDb(), graceMs: ONE_HOUR, reap: async () => {} }))
      .rejects.toThrow(/process census failed/);
  });

  it('a shellper whose only child is the ConPTY console host is still a husk', async () => {
    const conhost = { pid: 900, ppid: 100, rssKb: 1, cmdline: '\\\\?\\C:\\Windows\\system32\\conhost.exe --headless --width 80 --height 24', creationTime: NOW - ONE_HOUR };
    const program = { pid: 901, ppid: 200, rssKb: 1, cmdline: 'C:\\Windows\\system32\\cmd.exe', creationTime: NOW - ONE_HOUR };
    const pids = await findHuskShellpers({
      socketDir: SOCKET_DIR,
      registeredShellperPids: new Set(),
      graceMs: ONE_HOUR,
      now: NOW,
      census: () => [shellper(100), conhost, shellper(200), program],
    });
    expect(pids).toEqual([100]);
  });

  it('skips a shellper whose creation time the census did not report', async () => {
    const entry = shellper(100);
    delete entry.creationTime;
    const pids = await findHuskShellpers({
      socketDir: SOCKET_DIR,
      registeredShellperPids: new Set(),
      graceMs: ONE_HOUR,
      now: NOW,
      census: () => [entry],
    });
    expect(pids).toEqual([]);
  });
});

describe('architect session-holder on Windows', () => {
  it('lists the census with argv quoting removed, so JSON needles match', async () => {
    censusMock.list.mockResolvedValue([shellper(100)]);
    const [entry] = await listProcessEntries();
    expect(entry.cmdline).toContain(`"--session-id","${SID}"`);
    expect(entry.cmdline).toContain('"cwd":"C:\\\\Users\\\\me\\\\src\\\\repo"');
  });

  it('finds our own shellper by decoded cwd and architect name', async () => {
    censusMock.list.mockResolvedValue([
      shellper(100),
      shellper(101, { architect: 'other' }),
      shellper(102, { cwd: 'C:\\Users\\me\\src\\repo2' }),
    ]);
    expect(await findOwnArchitectShellpers({ identity: { workspacePath: 'c:\\users\\me\\src\\repo', architectName: 'main' } }))
      .toEqual([100]);
  });

  it('reclaims our own holder through the census', async () => {
    censusMock.list.mockResolvedValue([shellper(100)]);
    const reap = vi.fn(async () => {});
    const result = await reconcileArchitectSessionHolder({ sessionId: SID, identity: { workspacePath: WS, architectName: 'main' }, reap });
    expect(result).toEqual({ foreignHolder: false, reclaimedPids: [100] });
  });

  it('logs a census failure and resumes as if there were no holder', async () => {
    censusMock.list.mockRejectedValue(new Error('process census failed'));
    const log = vi.fn();
    const result = await reconcileArchitectSessionHolder({ sessionId: SID, identity: { workspacePath: WS, architectName: 'main' }, log });
    expect(result).toEqual({ foreignHolder: false, reclaimedPids: [] });
    expect(log).toHaveBeenCalledWith('WARN', expect.stringContaining('process census failed'));
  });
});

describe('afx cleanup shellper kill on Windows', () => {
  it('tree-kills shellpers whose decoded cwd is the worktree, and only those', async () => {
    censusMock.list.mockResolvedValue([
      shellper(100, { cwd: `${WS}\\.builders\\spir-1` }),
      shellper(101, { cwd: `${WS}\\.builders\\spir-10` }),
      { pid: 102, ppid: 1, rssKb: 1, cmdline: 'C:\\Windows\\system32\\cmd.exe' },
    ]);
    const killed = await killShellperProcesses(`${WS}\\.builders\\spir-1`);
    expect(killed).toBe(1);
    expect(treeMock.kill).toHaveBeenCalledTimes(1);
    expect(treeMock.kill).toHaveBeenCalledWith(100, {
      rootStartTime: NOW - 2 * ONE_HOUR,
      jobName: 'Local\\codev-session-s-100',
      terminateJob: expect.any(Function),
    });
  });

  it('carries on (killing nothing) when the census fails', async () => {
    censusMock.list.mockRejectedValue(new Error('process census failed'));
    expect(await killShellperProcesses(WS)).toBe(0);
    expect(treeMock.kill).not.toHaveBeenCalled();
  });
});
