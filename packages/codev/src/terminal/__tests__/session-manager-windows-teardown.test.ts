/**
 * Spec 1658 Phase 3: SessionManager teardown and orphan sweep on Windows
 * (seam forced; census and tree kill mocked).
 *
 * - The orphan sweep finds this instance's shellpers through the census (the
 *   decoded socketDir field) and tree-kills unregistered ones.
 * - A census failure is a Tower log line, not a silent "0 orphans".
 * - killSession tears the shellper's whole tree down, because a Windows
 *   SIGTERM never lets the shellper stop its PTY child.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ProcessCensusEntry } from '../../agent-farm/servers/process-census.js';
import { windowsShellperCmdline } from './windows-cmdline-fixtures.js';

const censusMock = vi.hoisted(() => ({ list: vi.fn() }));
const treeMock = vi.hoisted(() => ({ kill: vi.fn(), wait: vi.fn() }));

vi.mock('../../agent-farm/servers/process-census.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../agent-farm/servers/process-census.js')>();
  return { ...actual, listProcessCensus: censusMock.list };
});
vi.mock('../../lib/process-tree.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/process-tree.js')>();
  return { ...actual, killSessionTree: treeMock.kill, waitForTreeExit: treeMock.wait };
});

const { SessionManager } = await import('../session-manager.js');
const { resetHostPlatformForTests, setHostPlatformForTests } = await import('../../lib/platform.js');

const SOCKET_DIR = 'C:\\Users\\me\\.agent-farm\\run';

function shellper(pid: number, socketDir = SOCKET_DIR): ProcessCensusEntry {
  const config = { socketPath: `\\\\.\\pipe\\codev-shellper-me-${pid}`, socketDir, sessionId: `s-${pid}` };
  return { pid, ppid: 1, rssKb: 1, cmdline: windowsShellperCmdline(config), creationTime: 1 };
}

function newManager(logs: string[]) {
  return new SessionManager({
    socketDir: SOCKET_DIR,
    shellperScript: 'shellper-main.js',
    nodeExecutable: process.execPath,
    logger: (msg) => logs.push(msg),
  });
}

beforeEach(() => {
  setHostPlatformForTests('win32');
  treeMock.kill.mockResolvedValue({ signaled: true, snapshot: { rootPid: 0, members: [] } });
  treeMock.wait.mockResolvedValue(true);
});

afterEach(() => {
  resetHostPlatformForTests();
  vi.clearAllMocks();
});

describe('killOrphanedShellpers on Windows', () => {
  it('tree-kills this instance\'s unregistered shellpers found through the census', async () => {
    censusMock.list.mockResolvedValue([
      shellper(100),
      shellper(200, `${SOCKET_DIR}-e2e`),
      { pid: 300, ppid: 1, rssKb: 1, cmdline: 'C:\\Windows\\explorer.exe', creationTime: 1 },
    ]);
    const manager = newManager([]);
    vi.spyOn(manager as unknown as { probeSocket: (p: string) => Promise<boolean> }, 'probeSocket').mockResolvedValue(false);

    expect(await manager.killOrphanedShellpers()).toBe(1);
    expect(treeMock.kill).toHaveBeenCalledTimes(1);
    expect(treeMock.kill).toHaveBeenCalledWith(100, { fallbackToPid: true });
  });

  it('probes the decoded pipe name before killing', async () => {
    censusMock.list.mockResolvedValue([shellper(100)]);
    const manager = newManager([]);
    const probe = vi
      .spyOn(manager as unknown as { probeSocket: (p: string) => Promise<boolean> }, 'probeSocket')
      .mockResolvedValue(true);

    expect(await manager.killOrphanedShellpers()).toBe(0);
    expect(probe).toHaveBeenCalledWith('\\\\.\\pipe\\codev-shellper-me-100');
    expect(treeMock.kill).not.toHaveBeenCalled();
  });

  it('logs that the sweep is disabled when the census fails', async () => {
    censusMock.list.mockRejectedValue(new Error('process census failed (PowerShell CIM query): blocked'));
    const logs: string[] = [];
    expect(await newManager(logs).killOrphanedShellpers()).toBe(0);
    expect(logs.some((line) => line.includes('Orphan shellper sweep disabled') && line.includes('process census failed'))).toBe(true);
  });
});

describe('killSession on Windows', () => {
  it('tears down the shellper tree and waits on its snapshot, sending no POSIX signals', async () => {
    const snapshot = { rootPid: 4242, members: [{ pid: 4242, creationTime: 1 }] };
    treeMock.kill.mockResolvedValue({ signaled: true, snapshot });
    const killSpy = vi.spyOn(process, 'kill');
    const manager = newManager([]);
    const disconnect = vi.fn();
    (manager as unknown as { sessions: Map<string, unknown> }).sessions.set('s1', {
      pid: 4242,
      client: { disconnect },
      socketPath: '\\\\.\\pipe\\codev-shellper-me-s1',
      logPath: 'C:\\nonexistent\\s1.log',
      restartResetTimer: null,
      stderrBuffer: null,
      stderrTailLogged: true,
    });

    await manager.killSession('s1');

    expect(treeMock.kill).toHaveBeenCalledWith(4242);
    expect(treeMock.wait).toHaveBeenCalledWith(4242, snapshot, 5000);
    expect(killSpy).not.toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalled();
    killSpy.mockRestore();
  });
});
