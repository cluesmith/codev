/**
 * Spec 1658, Amendment 2 phase A2-5: the shellper transport capability.
 *
 * The reconnect gate is the riskiest move, so it is pinned on each
 * implementation: POSIX checks the start time, then the socket file, and logs
 * each rejection exactly as reconnectSession did; Windows refuses a row without
 * its secret and session id. Also the endpoint, secret, ENOENT refusal and
 * command-line forms. The accessor follows the seam.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const startTime = vi.hoisted(() => vi.fn<(pid: number) => Promise<number | null>>());
vi.mock('../lib/platform/processes.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/platform/processes.js')>();
  return { ...actual, processes: () => ({ ...actual.processes(), startTime }) };
});

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { shellperTransport } from '../lib/platform/shellper-transport.js';
import { posixShellperTransport } from '../lib/platform/shellper-transport.posix.js';
import { windowsShellperTransport } from '../lib/platform/shellper-transport.windows.js';
import { useHostPlatform } from './helpers/host-platform.js';

describe('shellperTransport() follows the host seam', () => {
  describe('on linux', () => {
    useHostPlatform('linux');
    it('returns the POSIX implementation', () => {
      expect(shellperTransport()).toBe(posixShellperTransport);
    });
  });
  describe('on win32', () => {
    useHostPlatform('win32');
    it('returns the Windows implementation', () => {
      expect(shellperTransport()).toBe(windowsShellperTransport);
    });
  });
});

describe('POSIX: socket file, no secret, start-time gate', () => {
  useHostPlatform('linux');
  let dir: string;
  let server: net.Server | null = null;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec1658-a25-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    startTime.mockReset();
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('endpoint, secret and command-line forms', () => {
    expect(posixShellperTransport.resolveEndpoint('/run/dir', 'abc')).toBe(path.join('/run/dir', 'shellper-abc.sock'));
    expect(posixShellperTransport.mintSecret()).toBeNull();
    expect(posixShellperTransport.connectErrorRefusal(Object.assign(new Error('x'), { code: 'ENOENT' }), '/x.sock')).toBeNull();
    expect(posixShellperTransport.spawnInfoResolvesOnData).toBe(false);
    expect(posixShellperTransport.commandLineText('node "shellper-main.js" {"a":1}')).toBe('node "shellper-main.js" {"a":1}');
    expect(posixShellperTransport.sessionJobName('node shellper-main.js {"sessionId":"abc"}')).toBeNull();
  });

  it('a start-time mismatch is rejected and logged before the socket is looked at', async () => {
    startTime.mockResolvedValue(1_000_000);
    const lstat = vi.spyOn(fs, 'lstatSync');
    const log = vi.fn();
    const admission = await posixShellperTransport.admitReconnect({ sessionId: 's1', socketPath: '/no/such.sock', pid: 42, startTime: 1, log });
    expect(admission).toEqual({ admitted: false, refusal: null });
    expect(log).toHaveBeenCalledWith('Session s1 reconnect failed: PID 42 reused (start time mismatch)');
    expect(lstat).not.toHaveBeenCalled();
  });

  it('a missing socket file is rejected and logged', async () => {
    startTime.mockResolvedValue(5000);
    const log = vi.fn();
    const admission = await posixShellperTransport.admitReconnect({ sessionId: 's2', socketPath: path.join(dir, 'gone.sock'), pid: 42, startTime: 5000, log });
    expect(admission).toEqual({ admitted: false, refusal: null });
    expect(log).toHaveBeenCalledWith('Session s2 reconnect failed: socket missing or lstat error');
  });

  it('a non-socket file is rejected and logged', async () => {
    startTime.mockResolvedValue(5000);
    const file = path.join(dir, 'plain.sock');
    fs.writeFileSync(file, '');
    const log = vi.fn();
    const admission = await posixShellperTransport.admitReconnect({ sessionId: 's3', socketPath: file, pid: 42, startTime: 5000, log });
    expect(admission).toEqual({ admitted: false, refusal: null });
    expect(log).toHaveBeenCalledWith('Session s3 reconnect failed: socket not a socket file');
  });

  it('a live socket within the tolerance is admitted, with no secret and the row session id', async () => {
    startTime.mockResolvedValue(5000);
    const socketPath = path.join(dir, 'live.sock');
    server = net.createServer();
    await new Promise<void>((resolve) => server!.listen(socketPath, () => resolve()));
    const log = vi.fn();
    const admitted = await posixShellperTransport.admitReconnect({ sessionId: 's4', socketPath, pid: 42, startTime: 5000 + 1500, log });
    expect(admitted).toEqual({ admitted: true, secret: null, shellperSessionId: 's4' });
    const withRowId = await posixShellperTransport.admitReconnect({ sessionId: 's4', socketPath, pid: 42, startTime: 5000, auth: { shellperSessionId: 'row-id', secret: null }, log });
    expect(withRowId).toEqual({ admitted: true, secret: null, shellperSessionId: 'row-id' });
    expect(log).not.toHaveBeenCalled();
  });

  it('isProcessCurrent compares the start time within the tolerance', async () => {
    startTime.mockResolvedValue(10_000);
    await expect(posixShellperTransport.isProcessCurrent(42, 11_500)).resolves.toBe(true);
    await expect(posixShellperTransport.isProcessCurrent(42, 13_000)).resolves.toBe(false);
  });
});

describe('Windows: named pipe, per-session secret, row-identity gate', () => {
  it('endpoint is a fresh pipe name; a secret is minted', () => {
    const first = windowsShellperTransport.resolveEndpoint('C:\\run', 'abc');
    const second = windowsShellperTransport.resolveEndpoint('C:\\run', 'abc');
    expect(first).toMatch(/^\\\\\.\\pipe\\codev-shellper-/);
    expect(first).not.toBe(second);
    expect(windowsShellperTransport.mintSecret()).toMatch(/^[0-9a-f]{64}$/);
    expect(windowsShellperTransport.spawnInfoResolvesOnData).toBe(true);
  });

  it('the gate refuses a row without its secret or session id, else admits with them', async () => {
    const log = vi.fn();
    const base = { sessionId: 's', socketPath: '\\\\.\\pipe\\x', pid: 1, startTime: 0, log };
    await expect(windowsShellperTransport.admitReconnect(base)).resolves.toEqual({ admitted: false, refusal: 'row has no shellper secret or session id' });
    await expect(windowsShellperTransport.admitReconnect({ ...base, auth: { secret: 'k', shellperSessionId: null } })).resolves.toMatchObject({ admitted: false });
    await expect(windowsShellperTransport.admitReconnect({ ...base, auth: { secret: 'k', shellperSessionId: 'id' } })).resolves.toEqual({ admitted: true, secret: 'k', shellperSessionId: 'id' });
    expect(log).not.toHaveBeenCalled();
    await expect(windowsShellperTransport.isProcessCurrent(1, 0)).resolves.toBe(true);
  });

  it('a missing pipe is a refusal; other connect errors are not', () => {
    expect(windowsShellperTransport.connectErrorRefusal(Object.assign(new Error('x'), { code: 'ENOENT' }), '\\\\.\\pipe\\p')).toBe('pipe \\\\.\\pipe\\p does not exist');
    expect(windowsShellperTransport.connectErrorRefusal(Object.assign(new Error('x'), { code: 'EPIPE' }), '\\\\.\\pipe\\p')).toBeNull();
  });

  it('command lines are argv-unquoted; the session job is named from the config', () => {
    const cmdline = 'node shellper-main.js "{\\"sessionId\\":\\"abc\\"}"';
    expect(windowsShellperTransport.commandLineText(cmdline)).toBe('node shellper-main.js {"sessionId":"abc"}');
    expect(windowsShellperTransport.sessionJobName(cmdline)).toContain('abc');
    expect(windowsShellperTransport.sessionJobName('node shellper-main.js {}')).toBeNull();
    expect(windowsShellperTransport.scanForAttachEndpoint()).toBeNull();
  });
});
