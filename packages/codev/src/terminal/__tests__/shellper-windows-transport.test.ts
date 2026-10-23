/**
 * Spec 1658 Phase 2: shellper endpoint abstraction, the Windows per-session
 * secret gate, and reconnect identity via WELCOME.
 *
 * The Windows branches run here with the host-platform seam forced to `win32`
 * over the host's real transport (a Unix socket, or a named pipe on a Windows
 * host): the gate and the identity checks are transport-agnostic, so either
 * exercises the same code. Real
 * named pipes (and a second local user, scenario 14) are covered by the
 * on-demand Windows workflow.
 */
// spec-1658-tmp: opaque (the /tmp cwd is handed to a MockPty; the real socket dir uses os.tmpdir())

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  FrameType,
  PROTOCOL_VERSION,
  createFrameParser,
  encodeData,
  encodeHello,
  encodePing,
  encodeResize,
  encodeSignal,
  encodeSpawn,
  parseJsonPayload,
  type HelloMessage,
  type ParsedFrame,
  type WelcomeMessage,
} from '../shellper-protocol.js';
import { ShellperProcess, type IShellperPty, type PtyOptions, type ShellperAuth } from '../shellper-process.js';
import { ShellperClient, ShellperIdentityError } from '../shellper-client.js';
import {
  SHELLPER_SECRET_ENV,
  SHELLPER_SESSION_ENV,
  endpointMayExist,
  isPipeEndpoint,
  removeStaleEndpoint,
  resolveShellperEndpoint,
  secretsMatch,
  shellperLogPath,
} from '../shellper-endpoint.js';
import { SessionManager, getProcessStartTime, isIdentityRefused } from '../session-manager.js';
import { resetHostPlatformForTests, setHostPlatformForTests } from '../../lib/platform.js';
import { testEndpointIn } from './shellper-test-endpoint.js';

const SECRET = 'f'.repeat(64);

class MockPty implements IShellperPty {
  pid = 12345;
  spawnCount = 0;
  killed = false;
  writtenData: string[] = [];
  resizes: Array<{ cols: number; rows: number }> = [];
  spawnEnvs: Array<Record<string, string>> = [];
  private dataCallback: ((data: string) => void) | null = null;

  spawn(_command: string, _args: string[], options: PtyOptions): void {
    this.spawnCount++;
    this.spawnEnvs.push(options.env);
  }
  write(data: string): void {
    this.writtenData.push(data);
  }
  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }
  kill(): void {
    this.killed = true;
  }
  onData(callback: (data: string) => void): void {
    this.dataCallback = callback;
  }
  onExit(): void {
    // Not exercised here
  }
  simulateData(data: string): void {
    this.dataCallback?.(data);
  }
}

let tmpDir: string;
let socketPath: string;
let mockPty: MockPty;
const cleanups: Array<() => void> = [];

async function startShellper(
  sockPath: string,
  auth: ShellperAuth | null,
  env: Record<string, string> = {},
): Promise<ShellperProcess> {
  const shellper = new ShellperProcess(
    () => {
      mockPty = new MockPty();
      return mockPty;
    },
    sockPath,
    1000,
    () => {},
    undefined,
    auth,
  );
  await shellper.start('/bin/bash', [], '/tmp', env, 80, 24);
  cleanups.push(() => shellper.shutdown());
  return shellper;
}

/** Open a raw connection and record every byte the server writes to it. */
function rawConnect(sockPath: string): Promise<{ socket: net.Socket; received: Buffer[]; closed: Promise<void> }> {
  return new Promise((resolve, reject) => {
    const received: Buffer[] = [];
    const socket = net.createConnection(sockPath);
    const closed = new Promise<void>((resolveClosed) => socket.on('close', () => resolveClosed()));
    socket.on('data', (chunk: Buffer) => received.push(chunk));
    socket.on('error', () => {});
    socket.once('connect', () => resolve({ socket, received, closed }));
    socket.once('error', reject);
  });
}

/** Handshake with a raw HELLO and return the WELCOME. */
function handshake(sockPath: string, hello: HelloMessage): Promise<{ socket: net.Socket; welcome: WelcomeMessage }> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(sockPath);
    const parser = createFrameParser();
    socket.pipe(parser);
    parser.on('data', (frame: ParsedFrame) => {
      if (frame.type === FrameType.WELCOME) {
        resolve({ socket, welcome: parseJsonPayload<WelcomeMessage>(frame.payload) });
      }
    });
    socket.on('error', reject);
    socket.on('connect', () => socket.write(encodeHello(hello)));
    setTimeout(() => reject(new Error('Handshake timeout')), 2000);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shp-1658-'));
  socketPath = testEndpointIn(tmpDir, 's.sock');
});

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()!();
  }
  resetHostPlatformForTests();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('endpoint resolution', () => {
  it('POSIX: the socket path and log path are unchanged', () => {
    setHostPlatformForTests('linux');
    const endpoint = resolveShellperEndpoint('/run/dir', 'abc');
    expect(endpoint).toBe(path.join('/run/dir', 'shellper-abc.sock'));
    expect(isPipeEndpoint(endpoint)).toBe(false);
    expect(shellperLogPath(endpoint, '/run/dir', 'abc')).toBe(path.join('/run/dir', 'shellper-abc.log'));
    // The log path is derived from the socket path, exactly as before, even when
    // the caller's id differs from the one in the basename (reconnected rows).
    expect(shellperLogPath('/run/dir/shellper-xyz.sock', '/run/dir', 'other')).toBe('/run/dir/shellper-xyz.log');
  });

  it('Windows: a user-namespaced pipe with a fresh UUID; log in the socket dir', () => {
    setHostPlatformForTests('win32');
    const first = resolveShellperEndpoint('C:\\run', 'abc');
    const second = resolveShellperEndpoint('C:\\run', 'abc');
    expect(first).toMatch(/^\\\\\.\\pipe\\codev-shellper-[A-Za-z0-9._-]+-[0-9a-f-]{36}$/);
    expect(second).not.toBe(first);
    expect(isPipeEndpoint(first)).toBe(true);
    expect(shellperLogPath(first, '/run/dir', 'abc')).toBe(path.join('/run/dir', 'shellper-abc.log'));
  });

  it('pipe endpoints have no file: stale cleanup is a no-op and existence defers to connect', () => {
    const pipe = '\\\\.\\pipe\\codev-shellper-user-1';
    expect(() => removeStaleEndpoint(pipe)).not.toThrow();
    expect(endpointMayExist(pipe)).toBe(true);
    expect(endpointMayExist(path.join(tmpDir, 'missing.sock'))).toBe(false);
  });

  it('secretsMatch requires an exact string', () => {
    expect(secretsMatch(SECRET, SECRET)).toBe(true);
    expect(secretsMatch(SECRET.slice(1), SECRET)).toBe(false);
    expect(secretsMatch('e'.repeat(64), SECRET)).toBe(false);
    expect(secretsMatch(undefined, SECRET)).toBe(false);
    expect(secretsMatch(42, SECRET)).toBe(false);
  });
});

describe('POSIX golden: handshake bytes unchanged', () => {
  it('HELLO without auth is byte-identical to the pre-1658 frame', async () => {
    const json = `{"version":${PROTOCOL_VERSION},"clientType":"tower"}`;
    const expected = Buffer.concat([Buffer.from([FrameType.HELLO, 0, 0, 0, json.length]), Buffer.from(json)]);

    const firstChunk = new Promise<Buffer>((resolve) => {
      const server = net.createServer((conn) => {
        conn.once('data', (chunk: Buffer) => {
          resolve(chunk);
          conn.destroy();
        });
      });
      server.listen(socketPath);
      cleanups.push(() => server.close());
    });
    await sleep(20);
    const client = new ShellperClient(socketPath);
    client.connect().catch(() => {});
    expect((await firstChunk).equals(expected)).toBe(true);
    client.disconnect();
  });

  it('an ungated shellper sends no identity fields in WELCOME, even to a HELLO carrying a secret', async () => {
    await startShellper(socketPath, null);
    const { socket, welcome } = await handshake(socketPath, {
      version: PROTOCOL_VERSION,
      clientType: 'tower',
      secret: SECRET,
    });
    cleanups.push(() => socket.destroy());
    expect(Object.keys(welcome).sort()).toEqual(
      ['alwaysSendsReplay', 'args', 'cols', 'command', 'lastDataAt', 'pid', 'rows', 'startTime', 'version'].sort(),
    );
  });

  // POSIX-only assertion: the POSIX reconnect lstat-checks a Unix socket file and
  // reads the process start time from ps or /proc, neither of which a Windows host
  // has (the Windows reconnect is covered by 'reconnects on a matching WELCOME
  // without consulting process start time' below).
  it.skipIf(process.platform === 'win32')('POSIX reconnect still runs the start-time check and sends no secret', async () => {
    const shellper = await startShellper(socketPath, null);
    const hellos: HelloMessage[] = [];
    shellper.on('hello', (hello: HelloMessage) => hellos.push(hello));
    const manager = new SessionManager({ socketDir: tmpDir, shellperScript: '/nonexistent.js', nodeExecutable: process.execPath });
    cleanups.push(() => manager.shutdown());

    // A wrong start time fails the reconnect, as before.
    expect(await manager.reconnectSession('t-bad', socketPath, process.pid, 1)).toBeNull();
    expect(hellos).toHaveLength(0);

    const startTime = (await getProcessStartTime(process.pid))!;
    const result = await manager.reconnectSession('t-ok', socketPath, process.pid, startTime);
    expect(result).not.toBeNull();
    expect(isIdentityRefused(result)).toBe(false);
    expect(hellos).toEqual([{ version: PROTOCOL_VERSION, clientType: 'tower' }]);
  });
});

describe('Windows secret gate (ShellperProcess with auth)', () => {
  const auth: ShellperAuth = { secret: SECRET, sessionId: 'sess-1', shellperPid: 4242 };

  async function expectDroppedWithZeroBytes(hello: HelloMessage): Promise<void> {
    await startShellper(socketPath, auth);
    mockPty.simulateData('secret screen contents');
    const conn = await rawConnect(socketPath);

    // Frames before any HELLO: none may act.
    conn.socket.write(encodeData('rm -rf ~\r'));
    conn.socket.write(encodeResize({ cols: 10, rows: 5 }));
    conn.socket.write(encodeSignal({ signal: 15 }));
    conn.socket.write(encodeSpawn({ command: '/bin/sh', args: [], cwd: '/', env: {} }));
    conn.socket.write(encodePing());
    await sleep(50);
    expect(conn.received).toHaveLength(0);

    conn.socket.write(encodeHello(hello));
    conn.socket.write(encodeData('after hello\r'));
    await conn.closed;

    expect(Buffer.concat(conn.received).length).toBe(0);
    expect(mockPty.writtenData).toEqual([]);
    expect(mockPty.resizes).toEqual([]);
    expect(mockPty.killed).toBe(false);
    expect(mockPty.spawnCount).toBe(1);
  }

  it('a HELLO without a secret gets zero bytes, no effect, and is dropped', async () => {
    await expectDroppedWithZeroBytes({ version: PROTOCOL_VERSION, clientType: 'terminal' });
  });

  it('a HELLO with the wrong secret gets zero bytes, no effect, and is dropped', async () => {
    await expectDroppedWithZeroBytes({ version: PROTOCOL_VERSION, clientType: 'tower', secret: 'e'.repeat(64) });
  });

  it('the right secret attaches, and WELCOME reports the shellper pid and session id', async () => {
    await startShellper(socketPath, auth);
    const { socket, welcome } = await handshake(socketPath, {
      version: PROTOCOL_VERSION,
      clientType: 'tower',
      secret: SECRET,
    });
    cleanups.push(() => socket.destroy());
    expect(welcome.shellperPid).toBe(4242);
    expect(welcome.sessionId).toBe('sess-1');
    expect(welcome.pid).toBe(12345);

    socket.write(encodeData('ls\r'));
    await sleep(50);
    expect(mockPty.writtenData).toEqual(['ls\r']);
  });

  it('the secret never reaches the PTY child env, at launch or on SPAWN; the session marker always does', async () => {
    await startShellper(socketPath, auth, { [SHELLPER_SECRET_ENV]: SECRET, KEEP: '1' });
    expect(mockPty.spawnEnvs[0]).toEqual({ KEEP: '1', [SHELLPER_SESSION_ENV]: 'sess-1' });

    const { socket } = await handshake(socketPath, { version: PROTOCOL_VERSION, clientType: 'tower', secret: SECRET });
    cleanups.push(() => socket.destroy());
    socket.write(encodeSpawn({ command: '/bin/sh', args: [], cwd: '/', env: { [SHELLPER_SECRET_ENV]: SECRET, B: '2' } }));
    await sleep(50);
    expect(mockPty.spawnEnvs[0]).toEqual({ B: '2', [SHELLPER_SESSION_ENV]: 'sess-1' });
  });
});

describe('ShellperClient WELCOME verification', () => {
  beforeEach(async () => {
    await startShellper(socketPath, { secret: SECRET, sessionId: 'sess-1', shellperPid: 4242 });
  });

  it('connects when the session id and shellper pid match', async () => {
    const client = new ShellperClient(socketPath, 'tower', {
      secret: SECRET,
      expectedSessionId: 'sess-1',
      expectedShellperPid: 4242,
    });
    cleanups.push(() => client.disconnect());
    const welcome = await client.connect();
    expect(welcome.sessionId).toBe('sess-1');
  });

  it('refuses a WELCOME naming another session', async () => {
    const client = new ShellperClient(socketPath, 'tower', { secret: SECRET, expectedSessionId: 'sess-2' });
    await expect(client.connect()).rejects.toBeInstanceOf(ShellperIdentityError);
    expect(client.connected).toBe(false);
  });

  it('refuses a WELCOME naming another shellper pid', async () => {
    const client = new ShellperClient(socketPath, 'tower', { secret: SECRET, expectedShellperPid: 1 });
    await expect(client.connect()).rejects.toBeInstanceOf(ShellperIdentityError);
  });

  it('a client without the secret is dropped (not an identity verdict)', async () => {
    const client = new ShellperClient(socketPath);
    const err = await client.connect().catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ShellperIdentityError);
  });
});

describe('SessionManager.reconnectSession on Windows (seam forced to win32)', () => {
  function makeManager(): SessionManager {
    const manager = new SessionManager({ socketDir: tmpDir, shellperScript: '/nonexistent.js', nodeExecutable: process.execPath });
    cleanups.push(() => manager.shutdown());
    return manager;
  }

  it('reconnects on a matching WELCOME without consulting process start time', async () => {
    await startShellper(socketPath, { secret: SECRET, sessionId: 'sess-1', shellperPid: process.pid });
    setHostPlatformForTests('win32');
    // startTime 0 would fail the POSIX check; on Windows the WELCOME is the proof.
    const result = await makeManager().reconnectSession('term-1', socketPath, process.pid, 0, undefined, {
      shellperSessionId: 'sess-1',
      secret: SECRET,
    });
    expect(result).not.toBeNull();
    expect(isIdentityRefused(result)).toBe(false);
  });

  it('is identity-refused when WELCOME names another session', async () => {
    await startShellper(socketPath, { secret: SECRET, sessionId: 'sess-other', shellperPid: process.pid });
    setHostPlatformForTests('win32');
    const result = await makeManager().reconnectSession('term-1', socketPath, process.pid, 0, undefined, {
      shellperSessionId: 'sess-1',
      secret: SECRET,
    });
    expect(isIdentityRefused(result)).toBe(true);
  });

  it('is identity-refused when WELCOME names another shellper pid (PID reuse)', async () => {
    await startShellper(socketPath, { secret: SECRET, sessionId: 'sess-1', shellperPid: process.ppid });
    setHostPlatformForTests('win32');
    const result = await makeManager().reconnectSession('term-1', socketPath, process.pid, 0, undefined, {
      shellperSessionId: 'sess-1',
      secret: SECRET,
    });
    expect(isIdentityRefused(result)).toBe(true);
  });

  it('is identity-refused when the endpoint does not exist but the pid is alive', async () => {
    setHostPlatformForTests('win32');
    const result = await makeManager().reconnectSession('term-1', path.join(tmpDir, 'gone.sock'), process.pid, 0, undefined, {
      shellperSessionId: 'sess-1',
      secret: SECRET,
    });
    expect(isIdentityRefused(result)).toBe(true);
  });

  it('is identity-refused when the row carries no secret', async () => {
    await startShellper(socketPath, { secret: SECRET, sessionId: 'sess-1', shellperPid: process.pid });
    setHostPlatformForTests('win32');
    const result = await makeManager().reconnectSession('term-1', socketPath, process.pid, 0, undefined, {
      shellperSessionId: 'sess-1',
      secret: null,
    });
    expect(isIdentityRefused(result)).toBe(true);
  });

  it('a dropped connection (wrong secret) stays a transient null, not a verdict', async () => {
    await startShellper(socketPath, { secret: SECRET, sessionId: 'sess-1', shellperPid: process.pid });
    setHostPlatformForTests('win32');
    const result = await makeManager().reconnectSession('term-1', socketPath, process.pid, 0, undefined, {
      shellperSessionId: 'sess-1',
      secret: 'e'.repeat(64),
    });
    expect(result).toBeNull();
  });

  it('a dead pid is null, as on POSIX', async () => {
    setHostPlatformForTests('win32');
    const result = await makeManager().reconnectSession('term-1', socketPath, 2 ** 22 + 12345, 0, undefined, {
      shellperSessionId: 'sess-1',
      secret: SECRET,
    });
    expect(result).toBeNull();
  });
});
