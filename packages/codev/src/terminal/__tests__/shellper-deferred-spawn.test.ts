/**
 * Spec 1658 Phase 3b: a secret-gated shellper started with `deferSpawnMs`
 * holds its first PTY spawn until Tower's authenticated HELLO (Tower assigns
 * the per-session Job Object in between). Over the host's real transport (a
 * Unix socket, or a named pipe on a Windows host): the gate is transport-
 * agnostic, so either exercises the same code.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  FrameType,
  PROTOCOL_VERSION,
  createFrameParser,
  encodeHello,
  parseJsonPayload,
  type HelloMessage,
  type ParsedFrame,
  type WelcomeMessage,
} from '../shellper-protocol.js';
import { ShellperProcess, type IShellperPty, type PtyOptions } from '../shellper-process.js';
import { testEndpointIn } from './shellper-test-endpoint.js';

const SECRET = 'a'.repeat(64);

class MockPty implements IShellperPty {
  pid = 4321;
  spawnCount = 0;
  spawn(_command: string, _args: string[], _options: PtyOptions): void {
    this.spawnCount++;
  }
  write(): void {}
  resize(): void {}
  kill(): void {}
  onData(): void {}
  onExit(): void {}
}

let tmpDir: string;
let socketPath: string;
let ptys: MockPty[];
let shellper: ShellperProcess;

function newShellper(withAuth = true): ShellperProcess {
  let auth = null;
  if (withAuth) auth = { secret: SECRET, sessionId: 'sess-1', shellperPid: 999 };
  return new ShellperProcess(() => {
    const pty = new MockPty();
    ptys.push(pty);
    return pty;
  }, socketPath, 1000, () => {}, undefined, auth);
}

interface Handshake {
  welcome: WelcomeMessage;
  frames: ParsedFrame[];
  socket: net.Socket;
}

function hello(clientType: HelloMessage['clientType'], secret: string = SECRET): Promise<Handshake> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const parser = createFrameParser();
    socket.pipe(parser);
    const frames: ParsedFrame[] = [];
    let welcome: WelcomeMessage | null = null;
    parser.on('data', (frame: ParsedFrame) => {
      frames.push(frame);
      if (frame.type === FrameType.WELCOME) welcome = parseJsonPayload<WelcomeMessage>(frame.payload);
      if (frame.type === FrameType.REPLAY && welcome) resolve({ welcome, frames, socket });
    });
    socket.on('error', reject);
    socket.on('connect', () => socket.write(encodeHello({ version: PROTOCOL_VERSION, clientType, secret })));
    setTimeout(() => reject(new Error('handshake timeout')), 2000);
  });
}

describe('ShellperProcess deferred first spawn (Spec 1658 Phase 3b)', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellper-defer-'));
    socketPath = testEndpointIn(tmpDir, 's.sock');
    ptys = [];
  });

  afterEach(() => {
    shellper?.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('listens without a PTY, then spawns on the first tower HELLO, before the WELCOME', async () => {
    shellper = newShellper();
    await shellper.start('cmd', [], tmpDir, {}, 80, 24, 5000);
    expect(ptys).toHaveLength(0);
    expect(shellper.spawnDeferred).toBe(true);

    const { welcome, socket } = await hello('tower');
    expect(ptys).toHaveLength(1);
    expect(ptys[0].spawnCount).toBe(1);
    expect(welcome.pid).toBe(4321);
    expect(welcome.command).toBe('cmd');
    expect(shellper.spawnDeferred).toBe(false);
    socket.destroy();

    // A second tower HELLO (Tower reconnect) does not spawn again.
    const again = await hello('tower');
    expect(ptys).toHaveLength(1);
    again.socket.destroy();
  });

  it('a non-tower HELLO first neither spawns nor errors, and sees an empty replay', async () => {
    shellper = newShellper();
    await shellper.start('cmd', [], tmpDir, {}, 80, 24, 5000);

    const { welcome, frames, socket } = await hello('terminal');
    expect(ptys).toHaveLength(0);
    expect(welcome.pid).toBe(-1);
    const replay = frames.find((f) => f.type === FrameType.REPLAY);
    expect(replay?.payload.length).toBe(0);
    expect(shellper.spawnDeferred).toBe(true);
    socket.destroy();

    const tower = await hello('tower');
    expect(ptys).toHaveLength(1);
    tower.socket.destroy();
  });

  it('a HELLO with the wrong secret does not spawn', async () => {
    shellper = newShellper();
    await shellper.start('cmd', [], tmpDir, {}, 80, 24, 5000);
    const socket = net.createConnection(socketPath);
    await new Promise<void>((resolve) => socket.on('connect', () => resolve()));
    socket.write(encodeHello({ version: PROTOCOL_VERSION, clientType: 'tower', secret: 'b'.repeat(64) }));
    await new Promise<void>((resolve) => socket.on('close', () => resolve()));
    expect(ptys).toHaveLength(0);
  });

  it('emits spawn-deadline when no tower HELLO arrives in time', async () => {
    shellper = newShellper();
    let fired = false;
    shellper.on('spawn-deadline', () => {
      fired = true;
    });
    await shellper.start('cmd', [], tmpDir, {}, 80, 24, 100);
    await new Promise((r) => setTimeout(r, 250));
    expect(fired).toBe(true);
    expect(ptys).toHaveLength(0);
  });

  it('a spawn before the deadline cancels it', async () => {
    shellper = newShellper();
    let fired = false;
    shellper.on('spawn-deadline', () => {
      fired = true;
    });
    await shellper.start('cmd', [], tmpDir, {}, 80, 24, 300);
    const { socket } = await hello('tower');
    await new Promise((r) => setTimeout(r, 400));
    expect(fired).toBe(false);
    socket.destroy();
  });

  it('without the secret gate the spawn is never deferred', async () => {
    shellper = newShellper(false);
    await shellper.start('cmd', [], tmpDir, {}, 80, 24, 5000);
    expect(ptys).toHaveLength(1);
    expect(shellper.spawnDeferred).toBe(false);
  });

  it('without deferSpawnMs the PTY spawns at start, as before', async () => {
    shellper = newShellper();
    await shellper.start('cmd', [], tmpDir, {}, 80, 24);
    expect(ptys).toHaveLength(1);
  });
});
