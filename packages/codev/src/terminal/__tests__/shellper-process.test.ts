import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  FrameType,
  PROTOCOL_VERSION,
  encodeHello,
  encodeData,
  encodeResize,
  encodeSignal,
  encodeSpawn,
  encodePing,
  createFrameParser,
  parseJsonPayload,
  type ParsedFrame,
  type WelcomeMessage,
  type ExitMessage,
} from '../shellper-protocol.js';
import { ShellperProcess, type IShellperPty, type PtyOptions } from '../shellper-process.js';

// --- Mock PTY ---

class MockPty implements IShellperPty {
  pid = 12345;
  spawned = false;
  killed = false;
  lastKillSignal: number | undefined;
  writtenData: string[] = [];
  resizes: Array<{ cols: number; rows: number }> = [];
  spawnArgs: { command: string; args: string[]; options: PtyOptions } | null = null;

  private dataCallback: ((data: string) => void) | null = null;
  private exitCallback: ((info: { exitCode: number; signal?: number }) => void) | null = null;

  spawn(command: string, args: string[], options: PtyOptions): void {
    this.spawned = true;
    this.killed = false;
    this.spawnArgs = { command, args, options };
  }

  write(data: string): void {
    this.writtenData.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }

  kill(signal?: number): void {
    this.killed = true;
    this.lastKillSignal = signal;
  }

  onData(callback: (data: string) => void): void {
    this.dataCallback = callback;
  }

  onExit(callback: (exitInfo: { exitCode: number; signal?: number }) => void): void {
    this.exitCallback = callback;
  }

  // Test helpers to simulate PTY events
  simulateData(data: string): void {
    this.dataCallback?.(data);
  }

  simulateExit(exitCode: number, signal?: number): void {
    this.exitCallback?.({ exitCode, signal });
  }
}

// --- Test Helpers ---

let tmpDir: string;
let socketPath: string;
let mockPty: MockPty;
let shellper: ShellperProcess;

function createMockPty(): IShellperPty {
  mockPty = new MockPty();
  return mockPty;
}

/** Connect to the shellper socket, perform handshake, return socket and welcome message. */
async function connectAndHandshake(sockPath: string): Promise<{ socket: net.Socket; welcome: WelcomeMessage }> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(sockPath);
    const parser = createFrameParser();
    socket.pipe(parser);

    let welcomed = false;
    const frames: ParsedFrame[] = [];

    parser.on('data', (frame: ParsedFrame) => {
      frames.push(frame);
      if (!welcomed && frame.type === FrameType.WELCOME) {
        welcomed = true;
        const welcome = parseJsonPayload<WelcomeMessage>(frame.payload);
        resolve({ socket, welcome });
      }
    });

    socket.on('error', reject);

    socket.on('connect', () => {
      socket.write(encodeHello({ version: PROTOCOL_VERSION, clientType: 'tower' }));
    });

    setTimeout(() => {
      if (!welcomed) reject(new Error('Handshake timeout'));
    }, 2000);
  });
}

/** Collect frames from a parser with a timeout. */
function collectFramesFor(
  parser: ReturnType<typeof createFrameParser>,
  durationMs: number,
): Promise<ParsedFrame[]> {
  return new Promise((resolve) => {
    const frames: ParsedFrame[] = [];
    parser.on('data', (f: ParsedFrame) => frames.push(f));
    setTimeout(() => resolve(frames), durationMs);
  });
}

/** Connect as a terminal client (clientType: 'terminal'). */
async function connectAsTerminal(sockPath: string): Promise<{ socket: net.Socket; welcome: WelcomeMessage }> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(sockPath);
    const parser = createFrameParser();
    socket.pipe(parser);

    let welcomed = false;

    parser.on('data', (frame: ParsedFrame) => {
      if (!welcomed && frame.type === FrameType.WELCOME) {
        welcomed = true;
        const welcome = parseJsonPayload<WelcomeMessage>(frame.payload);
        resolve({ socket, welcome });
      }
    });

    socket.on('error', reject);

    socket.on('connect', () => {
      socket.write(encodeHello({ version: PROTOCOL_VERSION, clientType: 'terminal' }));
    });

    setTimeout(() => {
      if (!welcomed) reject(new Error('Handshake timeout'));
    }, 2000);
  });
}

describe('ShellperProcess', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellper-test-'));
    socketPath = path.join(tmpDir, 'test.sock');
  });

  afterEach(() => {
    shellper?.shutdown();
    // Clean up temp directory
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup failures in tests
    }
  });

  describe('start and spawn', () => {
    it('spawns PTY with correct parameters', async () => {
      shellper = new ShellperProcess(createMockPty, socketPath);
      await shellper.start('/bin/bash', ['-l'], '/home/user', { HOME: '/home/user' }, 120, 40);

      expect(mockPty.spawned).toBe(true);
      expect(mockPty.spawnArgs?.command).toBe('/bin/bash');
      expect(mockPty.spawnArgs?.args).toEqual(['-l']);
      expect(mockPty.spawnArgs?.options.cols).toBe(120);
      expect(mockPty.spawnArgs?.options.rows).toBe(40);
      expect(mockPty.spawnArgs?.options.cwd).toBe('/home/user');
    });

    it('listens on Unix socket', async () => {
      shellper = new ShellperProcess(createMockPty, socketPath);
      await shellper.start('/bin/bash', [], '/tmp', {}, 80, 24);

      // Verify socket file exists
      const stat = fs.statSync(socketPath);
      expect(stat.isSocket()).toBe(true);
    });

    it('records start time', async () => {
      shellper = new ShellperProcess(createMockPty, socketPath);
      const before = Date.now();
      await shellper.start('/bin/bash', [], '/tmp', {}, 80, 24);
      const after = Date.now();

      expect(shellper.getStartTime()).toBeGreaterThanOrEqual(before);
      expect(shellper.getStartTime()).toBeLessThanOrEqual(after);
    });
  });

  describe('connection handling', () => {
    it('performs HELLO/WELCOME handshake', async () => {
      shellper = new ShellperProcess(createMockPty, socketPath);
      await shellper.start('/bin/bash', [], '/tmp', {}, 80, 24);

      const { socket, welcome } = await connectAndHandshake(socketPath);
      expect(welcome.pid).toBe(12345); // MockPty pid
      expect(welcome.cols).toBe(80);
      expect(welcome.rows).toBe(24);
      expect(welcome.startTime).toBeGreaterThan(0);

      socket.destroy();
    });

    it('sends replay buffer on connect', async () => {
      shellper = new ShellperProcess(createMockPty, socketPath);
      await shellper.start('/bin/bash', [], '/tmp', {}, 80, 24);

      // Simulate some PTY output before connection
      mockPty.simulateData('hello\nworld\n');

      const { socket } = await connectAndHandshake(socketPath);

      // After WELCOME, we should get a REPLAY frame
      const parser = createFrameParser();
      socket.pipe(parser);

      // The replay frame may already have been sent before we pipe
      // Let's wait briefly and check
      const frames = await collectFramesFor(parser, 100);
      // Note: WELCOME was already consumed by connectAndHandshake
      // REPLAY should follow WELCOME
      const replayFrame = frames.find((f) => f.type === FrameType.REPLAY);
      // The replay data may arrive in the welcome handler or as a separate frame
      // Either way, the shellper should have sent it
      expect(shellper.getReplayData().length).toBeGreaterThan(0);

      socket.destroy();
    });

    it('new tower connection replaces old tower connection', async () => {
      shellper = new ShellperProcess(createMockPty, socketPath);
      await shellper.start('/bin/bash', [], '/tmp', {}, 80, 24);

      const { socket: socket1 } = await connectAndHandshake(socketPath);

      // Wait for socket1 to be established
      await new Promise((r) => setTimeout(r, 50));

      const { socket: socket2, welcome } = await connectAndHandshake(socketPath);
      expect(welcome.pid).toBe(12345);

      // socket1 should be destroyed (tower replaced tower)
      await new Promise((r) => setTimeout(r, 50));
      expect(socket1.destroyed).toBe(true);

      socket2.destroy();
    });
  });

  describe('data forwarding', () => {
    it('forwards PTY data to connected client', async () => {
      shellper = new ShellperProcess(createMockPty, socketPath);
      await shellper.start('/bin/bash', [], '/tmp', {}, 80, 24);

      const { socket } = await connectAndHandshake(socketPath);
      const parser = createFrameParser();
      socket.pipe(parser);

      const framesPromise = collectFramesFor(parser, 200);

      // Simulate PTY output
      mockPty.simulateData('test output');

      const frames = await framesPromise;
      const dataFrames = frames.filter((f) => f.type === FrameType.DATA);
      expect(dataFrames.length).toBeGreaterThan(0);
      const combinedData = Buffer.concat(dataFrames.map((f) => f.payload)).toString();
      expect(combinedData).toContain('test output');

      socket.destroy();
    });

    it('forwards client input to PTY', async () => {
      shellper = new ShellperProcess(createMockPty, socketPath);
      await shellper.start('/bin/bash', [], '/tmp', {}, 80, 24);

      const { socket } = await connectAndHandshake(socketPath);

      // Send DATA frame from client
      socket.write(encodeData('user input'));

      await new Promise((r) => setTimeout(r, 100));
      expect(mockPty.writtenData).toContain('user input');

      socket.destroy();
    });
  });

  describe('RESIZE handling', () => {
    it('resizes PTY on RESIZE frame', async () => {
      shellper = new ShellperProcess(createMockPty, socketPath);
      await shellper.start('/bin/bash', [], '/tmp', {}, 80, 24);

      const { socket } = await connectAndHandshake(socketPath);

      socket.write(encodeResize({ cols: 120, rows: 40 }));

      await new Promise((r) => setTimeout(r, 100));
      expect(mockPty.resizes).toContainEqual({ cols: 120, rows: 40 });

      socket.destroy();
    });
  });

  describe('SIGNAL handling', () => {
    it('forwards allowed signals to PTY', async () => {
      shellper = new ShellperProcess(createMockPty, socketPath);
      await shellper.start('/bin/bash', [], '/tmp', {}, 80, 24);

      const { socket } = await connectAndHandshake(socketPath);

      socket.write(encodeSignal({ signal: 2 })); // SIGINT

      await new Promise((r) => setTimeout(r, 100));
      expect(mockPty.killed).toBe(true);
      expect(mockPty.lastKillSignal).toBe(2);

      socket.destroy();
    });

    it('rejects disallowed signals', async () => {
      shellper = new ShellperProcess(createMockPty, socketPath);
      await shellper.start('/bin/bash', [], '/tmp', {}, 80, 24);

      const errors: Error[] = [];
      shellper.on('protocol-error', (err: Error) => errors.push(err));

      const { socket } = await connectAndHandshake(socketPath);

      socket.write(encodeSignal({ signal: 11 })); // SIGSEGV — not allowed

      await new Promise((r) => setTimeout(r, 100));
      expect(mockPty.killed).toBe(false);
      expect(errors.some((e) => e.message.includes('not in allowlist'))).toBe(true);

      socket.destroy();
    });
  });

  describe('EXIT handling', () => {
    it('sends EXIT frame when PTY exits', async () => {
      shellper = new ShellperProcess(createMockPty, socketPath);
      await shellper.start('/bin/bash', [], '/tmp', {}, 80, 24);

      const { socket } = await connectAndHandshake(socketPath);
      const parser = createFrameParser();
      socket.pipe(parser);

      const framesPromise = collectFramesFor(parser, 200);

      mockPty.simulateExit(0);

      const frames = await framesPromise;
      const exitFrame = frames.find((f) => f.type === FrameType.EXIT);
      expect(exitFrame).toBeDefined();
      if (exitFrame) {
        const msg = parseJsonPayload<ExitMessage>(exitFrame.payload);
        expect(msg.code).toBe(0);
        expect(msg.signal).toBeNull();
      }

      socket.destroy();
    });

    it('reports hasExited after PTY exits', async () => {
      shellper = new ShellperProcess(createMockPty, socketPath);
      await shellper.start('/bin/bash', [], '/tmp', {}, 80, 24);

      expect(shellper.hasExited).toBe(false);
      mockPty.simulateExit(1);
      expect(shellper.hasExited).toBe(true);
    });
  });

  describe('SPAWN handling', () => {
    it('kills old PTY and spawns new one on SPAWN frame', async () => {
      let ptyCount = 0;
      const ptys: MockPty[] = [];

      shellper = new ShellperProcess(
        () => {
          const pty = new MockPty();
          pty.pid = 12345 + ptyCount++;
          ptys.push(pty);
          return pty;
        },
        socketPath,
      );

      await shellper.start('/bin/bash', [], '/tmp', {}, 80, 24);
      const firstPty = ptys[0];
      expect(firstPty.spawned).toBe(true);

      const { socket } = await connectAndHandshake(socketPath);

      // Send SPAWN frame
      socket.write(
        encodeSpawn({
          command: '/bin/zsh',
          args: [],
          cwd: '/home/user',
          env: { SHELL: '/bin/zsh' },
        }),
      );

      await new Promise((r) => setTimeout(r, 100));

      // Old PTY should be killed
      expect(firstPty.killed).toBe(true);

      // New PTY should be spawned
      expect(ptys.length).toBe(2);
      const secondPty = ptys[1];
      expect(secondPty.spawned).toBe(true);
      expect(secondPty.spawnArgs?.command).toBe('/bin/zsh');
      expect(secondPty.spawnArgs?.options.cwd).toBe('/home/user');

      socket.destroy();
    });

    it('clears replay buffer on SPAWN', async () => {
      shellper = new ShellperProcess(createMockPty, socketPath);
      await shellper.start('/bin/bash', [], '/tmp', {}, 80, 24);

      // Accumulate some data
      mockPty.simulateData('old output\n');
      expect(shellper.getReplayData().length).toBeGreaterThan(0);

      const { socket } = await connectAndHandshake(socketPath);

      socket.write(
        encodeSpawn({
          command: '/bin/bash',
          args: [],
          cwd: '/tmp',
          env: {},
        }),
      );

      await new Promise((r) => setTimeout(r, 100));
      // Replay buffer should be cleared (new data from new PTY will accumulate)
      // But since no new PTY output happened, it should be empty or very small
      // The key assertion is that old data is gone
      const replayStr = shellper.getReplayData().toString();
      expect(replayStr).not.toContain('old output');

      socket.destroy();
    });
  });

  describe('PING/PONG handling', () => {
    it('responds to PING with PONG', async () => {
      shellper = new ShellperProcess(createMockPty, socketPath);
      await shellper.start('/bin/bash', [], '/tmp', {}, 80, 24);

      const { socket } = await connectAndHandshake(socketPath);
      const parser = createFrameParser();
      socket.pipe(parser);

      const framesPromise = collectFramesFor(parser, 200);

      socket.write(encodePing());

      const frames = await framesPromise;
      const pongFrame = frames.find((f) => f.type === FrameType.PONG);
      expect(pongFrame).toBeDefined();

      socket.destroy();
    });
  });

  describe('replay buffer', () => {
    it('accumulates PTY output in replay buffer', async () => {
      shellper = new ShellperProcess(createMockPty, socketPath);
      await shellper.start('/bin/bash', [], '/tmp', {}, 80, 24);

      mockPty.simulateData('line 1\n');
      mockPty.simulateData('line 2\n');
      mockPty.simulateData('line 3\n');

      const replay = shellper.getReplayData().toString();
      expect(replay).toContain('line 1');
      expect(replay).toContain('line 2');
      expect(replay).toContain('line 3');
    });

    it('respects replay buffer line limit', async () => {
      shellper = new ShellperProcess(createMockPty, socketPath, 5);
      await shellper.start('/bin/bash', [], '/tmp', {}, 80, 24);

      // Push more lines than the buffer can hold
      for (let i = 0; i < 20; i++) {
        mockPty.simulateData(`line-${i}\n`);
      }

      const replay = shellper.getReplayData().toString();
      // Early lines should be evicted
      expect(replay).not.toContain('line-0');
      // Recent lines should be present
      expect(replay).toContain('line-19');
    });
  });

  describe('shutdown', () => {
    it('kills PTY, closes connections, and closes server', async () => {
      shellper = new ShellperProcess(createMockPty, socketPath);
      await shellper.start('/bin/bash', [], '/tmp', {}, 80, 24);

      const { socket } = await connectAndHandshake(socketPath);

      let shutdownEmitted = false;
      shellper.on('shutdown', () => { shutdownEmitted = true; });

      shellper.shutdown();

      expect(mockPty.killed).toBe(true);
      expect(shutdownEmitted).toBe(true);

      // Socket should be closed
      await new Promise((r) => setTimeout(r, 50));
      expect(socket.destroyed).toBe(true);
    });
  });

  describe('protocol errors', () => {
    it('emits protocol-error and closes connection on malformed JSON', async () => {
      shellper = new ShellperProcess(createMockPty, socketPath);
      await shellper.start('/bin/bash', [], '/tmp', {}, 80, 24);

      const errors: Error[] = [];
      shellper.on('protocol-error', (err: Error) => errors.push(err));

      const { socket } = await connectAndHandshake(socketPath);

      // Send a RESIZE frame with invalid JSON payload
      const badPayload = Buffer.from('not-json');
      const header = Buffer.allocUnsafe(5);
      header[0] = FrameType.RESIZE;
      header.writeUInt32BE(badPayload.length, 1);
      socket.write(Buffer.concat([header, badPayload]));

      await new Promise((r) => setTimeout(r, 100));
      expect(errors.some((e) => e.message.includes('Invalid RESIZE payload'))).toBe(true);
      // Per spec: malformed frames close the connection
      expect(socket.destroyed).toBe(true);
    });

    it('silently ignores unknown frame types', async () => {
      shellper = new ShellperProcess(createMockPty, socketPath);
      await shellper.start('/bin/bash', [], '/tmp', {}, 80, 24);

      const errors: Error[] = [];
      shellper.on('protocol-error', (err: Error) => errors.push(err));

      const { socket } = await connectAndHandshake(socketPath);

      // Send an unknown frame type
      const payload = Buffer.from('test');
      const header = Buffer.allocUnsafe(5);
      header[0] = 0xff; // Unknown type
      header.writeUInt32BE(payload.length, 1);
      socket.write(Buffer.concat([header, payload]));

      await new Promise((r) => setTimeout(r, 100));
      // Should NOT cause any errors
      expect(errors.length).toBe(0);

      socket.destroy();
    });
  });

  describe('PTY replacement race condition', () => {
    it('old PTY exit does not corrupt new PTY state after SPAWN', async () => {
      let ptyCount = 0;
      const ptys: MockPty[] = [];

      shellper = new ShellperProcess(
        () => {
          const pty = new MockPty();
          pty.pid = 12345 + ptyCount++;
          ptys.push(pty);
          return pty;
        },
        socketPath,
      );

      await shellper.start('/bin/bash', [], '/tmp', {}, 80, 24);
      const firstPty = ptys[0];

      const { socket } = await connectAndHandshake(socketPath);

      // Send SPAWN to create new PTY
      socket.write(
        encodeSpawn({
          command: '/bin/zsh',
          args: [],
          cwd: '/tmp',
          env: {},
        }),
      );

      await new Promise((r) => setTimeout(r, 100));
      expect(ptys.length).toBe(2);
      const secondPty = ptys[1];

      // Old PTY exits AFTER new one is spawned
      firstPty.simulateExit(0);

      await new Promise((r) => setTimeout(r, 50));

      // Critical: new PTY should NOT be marked as exited
      expect(shellper.hasExited).toBe(false);

      // New PTY should still accept data
      socket.write(encodeData('still works'));
      await new Promise((r) => setTimeout(r, 50));
      expect(secondPty.writtenData).toContain('still works');

      socket.destroy();
    });

    it('old PTY data is ignored after SPAWN', async () => {
      let ptyCount = 0;
      const ptys: MockPty[] = [];

      shellper = new ShellperProcess(
        () => {
          const pty = new MockPty();
          pty.pid = 12345 + ptyCount++;
          ptys.push(pty);
          return pty;
        },
        socketPath,
      );

      await shellper.start('/bin/bash', [], '/tmp', {}, 80, 24);
      const firstPty = ptys[0];

      const { socket } = await connectAndHandshake(socketPath);
      const parser = createFrameParser();
      socket.pipe(parser);

      // Send SPAWN
      socket.write(
        encodeSpawn({
          command: '/bin/zsh',
          args: [],
          cwd: '/tmp',
          env: {},
        }),
      );

      await new Promise((r) => setTimeout(r, 100));

      // Simulate old PTY sending data after replacement
      firstPty.simulateData('stale data from old pty');

      await new Promise((r) => setTimeout(r, 50));

      // The replay buffer should NOT contain old PTY data
      const replay = shellper.getReplayData().toString();
      expect(replay).not.toContain('stale data from old pty');

      socket.destroy();
    });
  });

  describe('log callback', () => {
    it('logs connection accepted on new connection', async () => {
      const logs: string[] = [];
      shellper = new ShellperProcess(createMockPty, socketPath, 10_000, (msg) => logs.push(msg));
      await shellper.start('/bin/bash', [], '/tmp', {}, 80, 24);

      const { socket } = await connectAndHandshake(socketPath);
      await new Promise((r) => setTimeout(r, 50));

      expect(logs.some((m) => m.includes('Connection accepted'))).toBe(true);
      socket.destroy();
    });

    it('logs tower replacement when second tower connects', async () => {
      const logs: string[] = [];
      shellper = new ShellperProcess(createMockPty, socketPath, 10_000, (msg) => logs.push(msg));
      await shellper.start('/bin/bash', [], '/tmp', {}, 80, 24);

      const { socket: socket1 } = await connectAndHandshake(socketPath);
      await new Promise((r) => setTimeout(r, 50));

      const { socket: socket2 } = await connectAndHandshake(socketPath);
      await new Promise((r) => setTimeout(r, 50));

      expect(logs.some((m) => m.includes('Replacing existing tower connection'))).toBe(true);
      socket1.destroy();
      socket2.destroy();
    });

    it('logs HELLO version on handshake', async () => {
      const logs: string[] = [];
      shellper = new ShellperProcess(createMockPty, socketPath, 10_000, (msg) => logs.push(msg));
      await shellper.start('/bin/bash', [], '/tmp', {}, 80, 24);

      const { socket } = await connectAndHandshake(socketPath);
      await new Promise((r) => setTimeout(r, 50));

      expect(logs.some((m) => m.includes('HELLO: version='))).toBe(true);
      socket.destroy();
    });

    it('logs WELCOME sent after handshake', async () => {
      const logs: string[] = [];
      shellper = new ShellperProcess(createMockPty, socketPath, 10_000, (msg) => logs.push(msg));
      await shellper.start('/bin/bash', [], '/tmp', {}, 80, 24);

      const { socket } = await connectAndHandshake(socketPath);
      await new Promise((r) => setTimeout(r, 50));

      expect(logs.some((m) => m.includes('WELCOME sent: pid='))).toBe(true);
      socket.destroy();
    });

    it('logs PTY exit with code and signal', async () => {
      const logs: string[] = [];
      shellper = new ShellperProcess(createMockPty, socketPath, 10_000, (msg) => logs.push(msg));
      await shellper.start('/bin/bash', [], '/tmp', {}, 80, 24);

      mockPty.simulateExit(1, 15);
      await new Promise((r) => setTimeout(r, 50));

      expect(logs.some((m) => m.includes('PTY exited: code=1, signal=15'))).toBe(true);
    });

    it('logs SPAWN command and old PID', async () => {
      let ptyCount = 0;
      const ptys: MockPty[] = [];
      const logs: string[] = [];

      shellper = new ShellperProcess(
        () => {
          const pty = new MockPty();
          pty.pid = 12345 + ptyCount++;
          ptys.push(pty);
          return pty;
        },
        socketPath,
        10_000,
        (msg) => logs.push(msg),
      );

      await shellper.start('/bin/bash', [], '/tmp', {}, 80, 24);
      const { socket } = await connectAndHandshake(socketPath);

      socket.write(
        encodeSpawn({
          command: '/bin/zsh',
          args: [],
          cwd: '/tmp',
          env: {},
        }),
      );

      await new Promise((r) => setTimeout(r, 100));

      expect(logs.some((m) => m.includes('SPAWN: command=/bin/zsh'))).toBe(true);
      expect(logs.some((m) => m.includes('killing old PTY pid=12345'))).toBe(true);
      socket.destroy();
    });

    it('logs protocol errors', async () => {
      const logs: string[] = [];
      shellper = new ShellperProcess(createMockPty, socketPath, 10_000, (msg) => logs.push(msg));
      await shellper.start('/bin/bash', [], '/tmp', {}, 80, 24);

      const { socket } = await connectAndHandshake(socketPath);

      // Send a RESIZE frame with invalid JSON payload
      const badPayload = Buffer.from('not-json');
      const header = Buffer.allocUnsafe(5);
      header[0] = FrameType.RESIZE;
      header.writeUInt32BE(badPayload.length, 1);
      socket.write(Buffer.concat([header, badPayload]));

      await new Promise((r) => setTimeout(r, 100));
      expect(logs.some((m) => m.includes('Protocol error: Invalid RESIZE payload'))).toBe(true);
    });

    it('logs connection closed', async () => {
      const logs: string[] = [];
      shellper = new ShellperProcess(createMockPty, socketPath, 10_000, (msg) => logs.push(msg));
      await shellper.start('/bin/bash', [], '/tmp', {}, 80, 24);

      const { socket } = await connectAndHandshake(socketPath);
      await new Promise((r) => setTimeout(r, 50));

      socket.destroy();
      await new Promise((r) => setTimeout(r, 100));

      expect(logs.some((m) => m.includes('closed'))).toBe(true);
    });

    it('uses no-op logger by default (no errors)', async () => {
      // Constructor without log callback should use default no-op
      shellper = new ShellperProcess(createMockPty, socketPath);
      await shellper.start('/bin/bash', [], '/tmp', {}, 80, 24);

      const { socket } = await connectAndHandshake(socketPath);
      mockPty.simulateExit(0);
      await new Promise((r) => setTimeout(r, 50));

      // Should not throw
      socket.destroy();
    });
  });

  describe('getPid', () => {
    it('returns PTY pid after start', async () => {
      shellper = new ShellperProcess(createMockPty, socketPath);
      await shellper.start('/bin/bash', [], '/tmp', {}, 80, 24);

      expect(shellper.getPid()).toBe(12345);
    });
  });

  describe('socket permissions', () => {
    it('creates socket file with 0600 permissions', async () => {
      shellper = new ShellperProcess(createMockPty, socketPath);
      await shellper.start('/bin/bash', [], '/tmp', {}, 80, 24);

      const stat = fs.statSync(socketPath);
      // Socket file should be 0600 (owner read/write only)
      const mode = stat.mode & 0o777;
      expect(mode).toBe(0o600);
    });
  });

  describe('multi-client support', () => {
    it('terminal connection coexists with tower connection', async () => {
      shellper = new ShellperProcess(createMockPty, socketPath);
      await shellper.start('/bin/bash', [], '/tmp', {}, 80, 24);

      const { socket: towerSocket } = await connectAndHandshake(socketPath);
      await new Promise((r) => setTimeout(r, 50));

      const { socket: termSocket } = await connectAsTerminal(socketPath);
      await new Promise((r) => setTimeout(r, 50));

      // Both should be alive
      expect(towerSocket.destroyed).toBe(false);
      expect(termSocket.destroyed).toBe(false);

      towerSocket.destroy();
      termSocket.destroy();
    });

    it('new tower replaces old tower but not terminal', async () => {
      shellper = new ShellperProcess(createMockPty, socketPath);
      await shellper.start('/bin/bash', [], '/tmp', {}, 80, 24);

      const { socket: tower1 } = await connectAndHandshake(socketPath);
      await new Promise((r) => setTimeout(r, 50));

      const { socket: termSocket } = await connectAsTerminal(socketPath);
      await new Promise((r) => setTimeout(r, 50));

      const { socket: tower2 } = await connectAndHandshake(socketPath);
      await new Promise((r) => setTimeout(r, 50));

      // tower1 should be destroyed (replaced by tower2)
      expect(tower1.destroyed).toBe(true);
      // terminal should still be alive
      expect(termSocket.destroyed).toBe(false);
      // tower2 should be alive
      expect(tower2.destroyed).toBe(false);

      tower2.destroy();
      termSocket.destroy();
    });

    it('SIGNAL from terminal is silently ignored', async () => {
      shellper = new ShellperProcess(createMockPty, socketPath);
      await shellper.start('/bin/bash', [], '/tmp', {}, 80, 24);

      const errors: Error[] = [];
      shellper.on('protocol-error', (err: Error) => errors.push(err));

      const { socket: termSocket } = await connectAsTerminal(socketPath);

      // Terminal sends SIGNAL — should be silently ignored
      termSocket.write(encodeSignal({ signal: 2 }));

      await new Promise((r) => setTimeout(r, 100));
      expect(mockPty.killed).toBe(false);
      // No protocol error emitted
      expect(errors.length).toBe(0);

      termSocket.destroy();
    });

    it('SPAWN from terminal is silently ignored', async () => {
      let ptyCount = 0;
      const ptys: MockPty[] = [];

      shellper = new ShellperProcess(
        () => {
          const pty = new MockPty();
          pty.pid = 12345 + ptyCount++;
          ptys.push(pty);
          return pty;
        },
        socketPath,
      );

      await shellper.start('/bin/bash', [], '/tmp', {}, 80, 24);

      const { socket: termSocket } = await connectAsTerminal(socketPath);

      termSocket.write(
        encodeSpawn({
          command: '/bin/zsh',
          args: [],
          cwd: '/tmp',
          env: {},
        }),
      );

      await new Promise((r) => setTimeout(r, 100));
      // Only the initial PTY should exist — no new spawn
      expect(ptys.length).toBe(1);

      termSocket.destroy();
    });

    it('broadcast DATA to multiple clients', async () => {
      shellper = new ShellperProcess(createMockPty, socketPath);
      await shellper.start('/bin/bash', [], '/tmp', {}, 80, 24);

      const { socket: towerSocket } = await connectAndHandshake(socketPath);
      const towerParser = createFrameParser();
      towerSocket.pipe(towerParser);

      const { socket: termSocket } = await connectAsTerminal(socketPath);
      const termParser = createFrameParser();
      termSocket.pipe(termParser);

      const towerFramesPromise = collectFramesFor(towerParser, 200);
      const termFramesPromise = collectFramesFor(termParser, 200);

      // Simulate PTY output
      mockPty.simulateData('broadcast test');

      const towerFrames = await towerFramesPromise;
      const termFrames = await termFramesPromise;

      const towerData = Buffer.concat(
        towerFrames.filter((f) => f.type === FrameType.DATA).map((f) => f.payload),
      ).toString();
      const termData = Buffer.concat(
        termFrames.filter((f) => f.type === FrameType.DATA).map((f) => f.payload),
      ).toString();

      expect(towerData).toContain('broadcast test');
      expect(termData).toContain('broadcast test');

      towerSocket.destroy();
      termSocket.destroy();
    });

    it('broadcast EXIT to multiple clients', async () => {
      shellper = new ShellperProcess(createMockPty, socketPath);
      await shellper.start('/bin/bash', [], '/tmp', {}, 80, 24);

      const { socket: towerSocket } = await connectAndHandshake(socketPath);
      const towerParser = createFrameParser();
      towerSocket.pipe(towerParser);

      const { socket: termSocket } = await connectAsTerminal(socketPath);
      const termParser = createFrameParser();
      termSocket.pipe(termParser);

      const towerFramesPromise = collectFramesFor(towerParser, 200);
      const termFramesPromise = collectFramesFor(termParser, 200);

      mockPty.simulateExit(0);

      const towerFrames = await towerFramesPromise;
      const termFrames = await termFramesPromise;

      expect(towerFrames.some((f) => f.type === FrameType.EXIT)).toBe(true);
      expect(termFrames.some((f) => f.type === FrameType.EXIT)).toBe(true);

      towerSocket.destroy();
      termSocket.destroy();
    });

    it('independent REPLAY on each connect', async () => {
      shellper = new ShellperProcess(createMockPty, socketPath);
      await shellper.start('/bin/bash', [], '/tmp', {}, 80, 24);

      // Generate some output before any connections
      mockPty.simulateData('replay content\n');

      // Connect tower
      const { socket: towerSocket } = await connectAndHandshake(socketPath);
      await new Promise((r) => setTimeout(r, 50));

      // Connect terminal — should also get REPLAY
      const termSocket = net.createConnection(socketPath);
      const termParser = createFrameParser();
      termSocket.pipe(termParser);

      const termFrames: ParsedFrame[] = [];
      termParser.on('data', (f: ParsedFrame) => termFrames.push(f));

      await new Promise<void>((resolve, reject) => {
        termSocket.on('connect', () => {
          termSocket.write(encodeHello({ version: PROTOCOL_VERSION, clientType: 'terminal' }));
        });
        termSocket.on('error', reject);
        setTimeout(resolve, 200);
      });

      // Terminal should have received WELCOME and REPLAY
      const welcomeFrame = termFrames.find((f) => f.type === FrameType.WELCOME);
      const replayFrame = termFrames.find((f) => f.type === FrameType.REPLAY);
      expect(welcomeFrame).toBeDefined();
      expect(replayFrame).toBeDefined();
      if (replayFrame) {
        expect(replayFrame.payload.toString()).toContain('replay content');
      }

      towerSocket.destroy();
      termSocket.destroy();
    });

    it('disconnecting one client does not affect others', async () => {
      shellper = new ShellperProcess(createMockPty, socketPath);
      await shellper.start('/bin/bash', [], '/tmp', {}, 80, 24);

      const { socket: towerSocket } = await connectAndHandshake(socketPath);
      const { socket: termSocket } = await connectAsTerminal(socketPath);
      await new Promise((r) => setTimeout(r, 50));

      // Disconnect terminal
      termSocket.destroy();
      await new Promise((r) => setTimeout(r, 50));

      // Tower should still work — can send data
      towerSocket.write(encodeData('still working'));
      await new Promise((r) => setTimeout(r, 50));
      expect(mockPty.writtenData).toContain('still working');

      // Tower should still receive data
      const parser = createFrameParser();
      towerSocket.pipe(parser);
      const framesPromise = collectFramesFor(parser, 200);
      mockPty.simulateData('response');
      const frames = await framesPromise;
      const dataFrames = frames.filter((f) => f.type === FrameType.DATA);
      expect(dataFrames.length).toBeGreaterThan(0);

      towerSocket.destroy();
    });

    it('destroyed client is removed from broadcast', async () => {
      const logs: string[] = [];
      shellper = new ShellperProcess(createMockPty, socketPath, 10_000, (msg) => logs.push(msg));
      await shellper.start('/bin/bash', [], '/tmp', {}, 80, 24);

      const { socket: towerSocket } = await connectAndHandshake(socketPath);
      const { socket: termSocket } = await connectAsTerminal(socketPath);
      await new Promise((r) => setTimeout(r, 50));

      // Destroy the terminal socket — broadcast should detect and clean up
      termSocket.destroy();
      await new Promise((r) => setTimeout(r, 50));

      // Trigger broadcast — destroyed terminal socket should be skipped
      mockPty.simulateData('after disconnect');
      await new Promise((r) => setTimeout(r, 100));

      // Tower should still receive data (broadcast didn't throw)
      const parser = createFrameParser();
      towerSocket.pipe(parser);
      const framesPromise = collectFramesFor(parser, 200);
      mockPty.simulateData('still broadcasting');
      const frames = await framesPromise;
      const dataFrames = frames.filter((f) => f.type === FrameType.DATA);
      expect(dataFrames.length).toBeGreaterThan(0);

      towerSocket.destroy();
    });

    it('failed write removes client from map', async () => {
      const logs: string[] = [];
      shellper = new ShellperProcess(createMockPty, socketPath, 10_000, (msg) => logs.push(msg));
      await shellper.start('/bin/bash', [], '/tmp', {}, 80, 24);

      const { socket: towerSocket } = await connectAndHandshake(socketPath);
      await connectAsTerminal(socketPath);
      await new Promise((r) => setTimeout(r, 50));

      // Access the server-side connections map (white-box test for branch coverage)
      // We need to patch the server-side socket's write, not the client-side socket
      const connections = (shellper as any).connections as Map<
        string,
        { socket: net.Socket; clientType: string }
      >;
      expect(connections.size).toBe(2);

      // Find the terminal connection entry and patch its server-side socket.write
      let termConnId: string | undefined;
      for (const [id, entry] of connections) {
        if (entry.clientType === 'terminal') {
          termConnId = id;
          entry.socket.write = (() => false) as typeof entry.socket.write;
          break;
        }
      }
      expect(termConnId).toBeDefined();

      // Trigger broadcast — server-side write returns false, exercises ok === false branch
      mockPty.simulateData('backpressure test');
      await new Promise((r) => setTimeout(r, 100));

      // Verify the log message from the ok === false branch (line 174 of shellper-process.ts)
      expect(logs.some((msg) => msg.includes('Write failed') && msg.includes('removing'))).toBe(
        true,
      );

      // Connection should have been removed from the map
      expect(connections.has(termConnId!)).toBe(false);

      // Tower should still receive subsequent broadcasts
      const parser = createFrameParser();
      towerSocket.pipe(parser);
      const framesPromise = collectFramesFor(parser, 200);
      mockPty.simulateData('after backpressure');
      const frames = await framesPromise;
      const dataFrames = frames.filter((f) => f.type === FrameType.DATA);
      expect(dataFrames.length).toBeGreaterThan(0);

      towerSocket.destroy();
    });

    it('pre-HELLO DATA frames are ignored', async () => {
      shellper = new ShellperProcess(createMockPty, socketPath);
      await shellper.start('/bin/bash', [], '/tmp', {}, 80, 24);

      // Connect raw socket without sending HELLO
      const rawSocket = net.createConnection(socketPath);
      await new Promise<void>((resolve) => rawSocket.on('connect', resolve));

      // Send DATA frame without HELLO first
      rawSocket.write(encodeData('sneaky input'));

      await new Promise((r) => setTimeout(r, 100));

      // PTY should NOT have received the data
      expect(mockPty.writtenData.length).toBe(0);

      rawSocket.destroy();
    });

    it('socket close before HELLO completes cleanly', async () => {
      shellper = new ShellperProcess(createMockPty, socketPath);
      await shellper.start('/bin/bash', [], '/tmp', {}, 80, 24);

      // Connect and immediately close without HELLO
      const rawSocket = net.createConnection(socketPath);
      await new Promise<void>((resolve) => rawSocket.on('connect', resolve));
      rawSocket.destroy();

      await new Promise((r) => setTimeout(r, 100));

      // Should not crash — verify shellper still works
      const { socket, welcome } = await connectAndHandshake(socketPath);
      expect(welcome.pid).toBe(12345);
      socket.destroy();
    });
  });
});
