/**
 * Spec 1658, Amendment 2 phase A2-3: the processes capability.
 *
 * The two behaviours the architect named are pinned here on each
 * implementation: a census failure resolves `[]` on POSIX but REJECTS on
 * Windows, and the POSIX `killTree` signals synchronously, before its promise
 * settles. child_process is stubbed so both hold on any host.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const childProcess = vi.hoisted(() => ({
  execFile: vi.fn(),
  execSync: vi.fn(),
}));
const fsStub = vi.hoisted(() => ({
  readFile: vi.fn(),
  stat: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, ...childProcess };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const merged = { ...actual, ...fsStub };
  return { ...merged, default: merged };
});

import { processes } from '../lib/platform/processes.js';
import { posixProcesses } from '../lib/platform/processes.posix.js';
import { windowsProcesses } from '../lib/platform/processes.windows.js';
import { useHostPlatform } from './helpers/host-platform.js';

beforeEach(() => {
  childProcess.execFile.mockReset();
  childProcess.execSync.mockReset();
});

function failExecFile(): void {
  childProcess.execFile.mockImplementation((...args: unknown[]) => {
    const cb = args[args.length - 1] as (err: Error, stdout: string, stderr: string) => void;
    cb(new Error('spawn failed'), '', '');
  });
}

describe('processes() follows the host seam', () => {
  describe('on darwin', () => {
    useHostPlatform('darwin');
    it('returns the POSIX implementation', () => {
      expect(processes()).toBe(posixProcesses);
    });
  });
  describe('on win32', () => {
    useHostPlatform('win32');
    it('returns the Windows implementation', () => {
      expect(processes()).toBe(windowsProcesses);
    });
  });
});

describe('census failure: POSIX resolves [] , Windows rejects', () => {
  it('POSIX: a failed `ps` reads as an empty table', async () => {
    failExecFile();
    await expect(posixProcesses.census()).resolves.toEqual([]);
    expect(childProcess.execFile.mock.calls[0][0]).toBe('ps');
  });

  it('Windows: a failed CIM query rejects, never an empty table', async () => {
    failExecFile();
    await expect(windowsProcesses.census({ fresh: true })).rejects.toThrow(/process census failed/);
  });
});

describe('POSIX killTree signals synchronously', () => {
  it('the group signal leaves before the returned promise settles', () => {
    const kill = vi.fn();
    const result = posixProcesses.killTree(4242, { kill, signal: 'SIGTERM' });
    expect(kill).toHaveBeenCalledWith(-4242, 'SIGTERM');
    return expect(result).resolves.toEqual({ signaled: true, snapshot: { rootPid: 4242, members: [] } });
  });

  it('falls back to the pid when the group signal fails, only when asked', async () => {
    const kill = vi.fn((pid: number) => {
      if (pid < 0) throw new Error('ESRCH');
    });
    const result = posixProcesses.killTree(7, { kill, fallbackToPid: true });
    expect(kill.mock.calls).toEqual([[-7, 'SIGTERM'], [7, 'SIGTERM']]);
    await expect(result).resolves.toMatchObject({ signaled: true });
  });
});

describe('POSIX: the pre-refactor forms', () => {
  it('waitForTreeExit probes the group and ignores the snapshot', async () => {
    const kill = vi.fn(() => {
      throw new Error('ESRCH');
    });
    await expect(posixProcesses.waitForTreeExit(9, { rootPid: 9, members: [{ pid: 1, creationTime: 1 }] }, 1000, { kill })).resolves.toBe(true);
    expect(kill).toHaveBeenCalledWith(-9, 0);
  });

  it('listeningPids runs lsof for listeners only; the async form never reads as unknown', async () => {
    childProcess.execSync.mockReturnValue('101\n102\n');
    expect(posixProcesses.listeningPids(4100)).toEqual([101, 102]);
    expect(childProcess.execSync.mock.calls[0][0]).toBe('lsof -ti :4100 -sTCP:LISTEN 2>/dev/null');
    childProcess.execSync.mockImplementation(() => {
      throw new Error('no lsof');
    });
    await expect(posixProcesses.listeningPidsAsync(4100)).resolves.toEqual([]);
  });

  it('startTime on macOS parses `ps -o lstart=`', async () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    try {
      childProcess.execFile.mockImplementation((_file: string, _args: string[], cb: (err: Error | null, stdout: string) => void) => {
        cb(null, 'Tue Nov 10 09:00:00 2026\n');
      });
      await expect(posixProcesses.startTime(42)).resolves.toBe(new Date('Tue Nov 10 09:00:00 2026').getTime());
      expect(childProcess.execFile.mock.calls[0].slice(0, 2)).toEqual(['ps', ['-p', '42', '-o', 'lstart=']]);
    } finally {
      Object.defineProperty(process, 'platform', original);
    }
  });

  it('startTime on Linux uses the /proc/<pid> ctime after a parseable stat line', async () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      const fields = Array.from({ length: 30 }, (_v, i) => String(i));
      fsStub.readFile.mockImplementation((_p: string, _enc: string, cb: (err: Error | null, data: string) => void) => {
        cb(null, `42 (node) ${fields.join(' ')}`);
      });
      fsStub.stat.mockImplementation((_p: string, cb: (err: Error | null, st: { ctimeMs: number }) => void) => {
        cb(null, { ctimeMs: 5555 });
      });
      await expect(posixProcesses.startTime(42)).resolves.toBe(5555);
      expect(fsStub.readFile.mock.calls[0][0]).toBe('/proc/42/stat');
      expect(fsStub.stat.mock.calls[0][0]).toBe('/proc/42');
    } finally {
      Object.defineProperty(process, 'platform', original);
    }
  });

  it('no census entry is console infrastructure', () => {
    expect(posixProcesses.isConsoleInfrastructure({ pid: 1, ppid: 0, rssKb: 0, cmdline: 'conhost.exe --headless' })).toBe(false);
  });
});

describe('Windows: census-backed start times and console hosts', () => {
  it('startTimeLookup answers from the census; startTime has no per-pid probe', async () => {
    const lookup = windowsProcesses.startTimeLookup([
      { pid: 5, ppid: 1, rssKb: 0, cmdline: 'x', creationTime: 1234 },
      { pid: 6, ppid: 1, rssKb: 0, cmdline: 'y' },
    ]);
    await expect(lookup(5)).resolves.toBe(1234);
    await expect(lookup(6)).resolves.toBeNull();
    await expect(windowsProcesses.startTime(5)).resolves.toBeNull();
  });

  it('conhost/OpenConsole --headless is console infrastructure', () => {
    expect(windowsProcesses.isConsoleInfrastructure({ pid: 1, ppid: 0, rssKb: 0, cmdline: 'C:\\Windows\\System32\\conhost.exe --headless --width 80' })).toBe(true);
    expect(windowsProcesses.isConsoleInfrastructure({ pid: 1, ppid: 0, rssKb: 0, cmdline: 'conhost.exe 0x4' })).toBe(false);
  });
});
