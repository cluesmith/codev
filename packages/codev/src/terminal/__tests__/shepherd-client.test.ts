import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  FrameType,
  PROTOCOL_VERSION,
  createFrameParser,
  encodeFrame,
  encodeWelcome,
  encodeData,
  encodeExit,
  encodeReplay,
  encodePing,
  encodePong,
  parseJsonPayload,
  type ParsedFrame,
  type HelloMessage,
  type WelcomeMessage,
} from '../shepherd-protocol.js';
import { ShepherdClient } from '../shepherd-client.js';

// Helper: create a temp socket path
function tmpSocketPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shepherd-client-test-'));
  return path.join(dir, 'test.sock');
}

// Helper: mini shepherd server that does HELLO/WELCOME handshake
function createMiniShepherd(
  socketPath: string,
  welcomeMsg: WelcomeMessage = { pid: 1234, cols: 80, rows: 24, startTime: Date.now() },
) {
  const server = net.createServer((socket) => {
    const parser = createFrameParser();
    socket.pipe(parser);

    parser.on('data', (frame: ParsedFrame) => {
      if (frame.type === FrameType.HELLO) {
        // Respond with WELCOME
        socket.write(encodeWelcome(welcomeMsg));
      }
    });
  });

  server.listen(socketPath);

  return {
    server,
    close: () => {
      server.close();
      try { fs.unlinkSync(socketPath); } catch { /* noop */ }
      try { fs.rmdirSync(path.dirname(socketPath)); } catch { /* noop */ }
    },
  };
}

describe('ShepherdClient', () => {
  let socketPath: string;
  let cleanup: (() => void)[] = [];

  beforeEach(() => {
    socketPath = tmpSocketPath();
    cleanup = [];
  });

  afterEach(() => {
    for (const fn of cleanup) {
      try { fn(); } catch { /* noop */ }
    }
    try { fs.unlinkSync(socketPath); } catch { /* noop */ }
    try { fs.rmdirSync(path.dirname(socketPath)); } catch { /* noop */ }
  });

  describe('connect/disconnect lifecycle', () => {
    it('connects and performs HELLO/WELCOME handshake', async () => {
      const welcomeMsg: WelcomeMessage = { pid: 5678, cols: 120, rows: 40, startTime: 1700000000000 };
      const shepherd = createMiniShepherd(socketPath, welcomeMsg);
      cleanup.push(shepherd.close);

      const client = new ShepherdClient(socketPath);
      cleanup.push(() => client.disconnect());

      const welcome = await client.connect();
      expect(welcome.pid).toBe(5678);
      expect(welcome.cols).toBe(120);
      expect(welcome.rows).toBe(40);
      expect(welcome.startTime).toBe(1700000000000);
      expect(client.connected).toBe(true);
    });

    it('disconnect sets connected to false', async () => {
      const shepherd = createMiniShepherd(socketPath);
      cleanup.push(shepherd.close);

      const client = new ShepherdClient(socketPath);
      await client.connect();
      expect(client.connected).toBe(true);

      client.disconnect();
      expect(client.connected).toBe(false);
    });

    it('rejects on connection refused', async () => {
      const client = new ShepherdClient(socketPath);
      await expect(client.connect()).rejects.toThrow();
    });

    it('rejects if already connected', async () => {
      const shepherd = createMiniShepherd(socketPath);
      cleanup.push(shepherd.close);

      const client = new ShepherdClient(socketPath);
      cleanup.push(() => client.disconnect());

      await client.connect();
      await expect(client.connect()).rejects.toThrow('Already connected');
    });

    it('emits close event when server disconnects', async () => {
      // Track connected sockets so we can forcefully close them
      const connectedSockets: net.Socket[] = [];
      const server = net.createServer((socket) => {
        connectedSockets.push(socket);
        const parser = createFrameParser();
        socket.pipe(parser);
        parser.on('data', (frame: ParsedFrame) => {
          if (frame.type === FrameType.HELLO) {
            socket.write(encodeWelcome({ pid: 1, cols: 80, rows: 24, startTime: Date.now() }));
          }
        });
      });
      server.listen(socketPath);
      cleanup.push(() => { server.close(); });

      const client = new ShepherdClient(socketPath);
      cleanup.push(() => client.disconnect());

      await client.connect();

      const closePromise = new Promise<void>((resolve) => {
        client.on('close', resolve);
      });

      // Destroy all connected sockets — this closes the client's connection
      for (const sock of connectedSockets) {
        sock.destroy();
      }

      // Client should emit close
      await Promise.race([
        closePromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
      ]);

      expect(client.connected).toBe(false);
    });
  });

  describe('frame sending', () => {
    it('sends DATA frame via write()', async () => {
      const receivedFrames: ParsedFrame[] = [];

      const server = net.createServer((socket) => {
        const parser = createFrameParser();
        socket.pipe(parser);
        parser.on('data', (frame: ParsedFrame) => {
          if (frame.type === FrameType.HELLO) {
            socket.write(encodeWelcome({ pid: 1, cols: 80, rows: 24, startTime: Date.now() }));
          } else {
            receivedFrames.push(frame);
          }
        });
      });
      server.listen(socketPath);
      cleanup.push(() => { server.close(); });

      const client = new ShepherdClient(socketPath);
      cleanup.push(() => client.disconnect());
      await client.connect();

      client.write('hello world');

      // Wait for frame to be received
      await new Promise((r) => setTimeout(r, 50));

      expect(receivedFrames).toHaveLength(1);
      expect(receivedFrames[0].type).toBe(FrameType.DATA);
      expect(receivedFrames[0].payload.toString()).toBe('hello world');
    });

    it('sends RESIZE frame', async () => {
      const receivedFrames: ParsedFrame[] = [];

      const server = net.createServer((socket) => {
        const parser = createFrameParser();
        socket.pipe(parser);
        parser.on('data', (frame: ParsedFrame) => {
          if (frame.type === FrameType.HELLO) {
            socket.write(encodeWelcome({ pid: 1, cols: 80, rows: 24, startTime: Date.now() }));
          } else {
            receivedFrames.push(frame);
          }
        });
      });
      server.listen(socketPath);
      cleanup.push(() => { server.close(); });

      const client = new ShepherdClient(socketPath);
      cleanup.push(() => client.disconnect());
      await client.connect();

      client.resize(200, 50);

      await new Promise((r) => setTimeout(r, 50));

      expect(receivedFrames).toHaveLength(1);
      expect(receivedFrames[0].type).toBe(FrameType.RESIZE);
      const msg = parseJsonPayload<{ cols: number; rows: number }>(receivedFrames[0].payload);
      expect(msg.cols).toBe(200);
      expect(msg.rows).toBe(50);
    });

    it('sends SIGNAL frame', async () => {
      const receivedFrames: ParsedFrame[] = [];

      const server = net.createServer((socket) => {
        const parser = createFrameParser();
        socket.pipe(parser);
        parser.on('data', (frame: ParsedFrame) => {
          if (frame.type === FrameType.HELLO) {
            socket.write(encodeWelcome({ pid: 1, cols: 80, rows: 24, startTime: Date.now() }));
          } else {
            receivedFrames.push(frame);
          }
        });
      });
      server.listen(socketPath);
      cleanup.push(() => { server.close(); });

      const client = new ShepherdClient(socketPath);
      cleanup.push(() => client.disconnect());
      await client.connect();

      client.signal(2); // SIGINT

      await new Promise((r) => setTimeout(r, 50));

      expect(receivedFrames).toHaveLength(1);
      expect(receivedFrames[0].type).toBe(FrameType.SIGNAL);
      const msg = parseJsonPayload<{ signal: number }>(receivedFrames[0].payload);
      expect(msg.signal).toBe(2);
    });

    it('sends SPAWN frame', async () => {
      const receivedFrames: ParsedFrame[] = [];

      const server = net.createServer((socket) => {
        const parser = createFrameParser();
        socket.pipe(parser);
        parser.on('data', (frame: ParsedFrame) => {
          if (frame.type === FrameType.HELLO) {
            socket.write(encodeWelcome({ pid: 1, cols: 80, rows: 24, startTime: Date.now() }));
          } else {
            receivedFrames.push(frame);
          }
        });
      });
      server.listen(socketPath);
      cleanup.push(() => { server.close(); });

      const client = new ShepherdClient(socketPath);
      cleanup.push(() => client.disconnect());
      await client.connect();

      client.spawn({
        command: '/bin/bash',
        args: ['-l'],
        cwd: '/home/user',
        env: { HOME: '/home/user' },
      });

      await new Promise((r) => setTimeout(r, 50));

      expect(receivedFrames).toHaveLength(1);
      expect(receivedFrames[0].type).toBe(FrameType.SPAWN);
    });

    it('sends PING frame', async () => {
      const receivedFrames: ParsedFrame[] = [];

      const server = net.createServer((socket) => {
        const parser = createFrameParser();
        socket.pipe(parser);
        parser.on('data', (frame: ParsedFrame) => {
          if (frame.type === FrameType.HELLO) {
            socket.write(encodeWelcome({ pid: 1, cols: 80, rows: 24, startTime: Date.now() }));
          } else {
            receivedFrames.push(frame);
          }
        });
      });
      server.listen(socketPath);
      cleanup.push(() => { server.close(); });

      const client = new ShepherdClient(socketPath);
      cleanup.push(() => client.disconnect());
      await client.connect();

      client.ping();

      await new Promise((r) => setTimeout(r, 50));

      expect(receivedFrames).toHaveLength(1);
      expect(receivedFrames[0].type).toBe(FrameType.PING);
    });

    it('does not send frames when disconnected', async () => {
      const client = new ShepherdClient(socketPath);
      // No connection — should be no-ops
      client.write('hello');
      client.resize(80, 24);
      client.signal(2);
      client.ping();
      // No error thrown
    });
  });

  describe('frame receiving', () => {
    it('emits data event on DATA frame', async () => {
      let serverSocket: net.Socket | null = null;
      const server = net.createServer((socket) => {
        serverSocket = socket;
        const parser = createFrameParser();
        socket.pipe(parser);
        parser.on('data', (frame: ParsedFrame) => {
          if (frame.type === FrameType.HELLO) {
            socket.write(encodeWelcome({ pid: 1, cols: 80, rows: 24, startTime: Date.now() }));
          }
        });
      });
      server.listen(socketPath);
      cleanup.push(() => { server.close(); });

      const client = new ShepherdClient(socketPath);
      cleanup.push(() => client.disconnect());
      await client.connect();

      const dataPromise = new Promise<Buffer>((resolve) => {
        client.on('data', resolve);
      });

      // Send DATA from server
      serverSocket!.write(encodeData('server output'));

      const data = await dataPromise;
      expect(data.toString()).toBe('server output');
    });

    it('emits exit event on EXIT frame', async () => {
      let serverSocket: net.Socket | null = null;
      const server = net.createServer((socket) => {
        serverSocket = socket;
        const parser = createFrameParser();
        socket.pipe(parser);
        parser.on('data', (frame: ParsedFrame) => {
          if (frame.type === FrameType.HELLO) {
            socket.write(encodeWelcome({ pid: 1, cols: 80, rows: 24, startTime: Date.now() }));
          }
        });
      });
      server.listen(socketPath);
      cleanup.push(() => { server.close(); });

      const client = new ShepherdClient(socketPath);
      cleanup.push(() => client.disconnect());
      await client.connect();

      const exitPromise = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
        client.on('exit', resolve);
      });

      // Import encodeExit from protocol
      const { encodeExit } = await import('../shepherd-protocol.js');
      serverSocket!.write(encodeExit({ code: 42, signal: null }));

      const exitInfo = await exitPromise;
      expect(exitInfo.code).toBe(42);
      expect(exitInfo.signal).toBeNull();
    });

    it('emits replay event on REPLAY frame and stores data', async () => {
      let serverSocket: net.Socket | null = null;
      const server = net.createServer((socket) => {
        serverSocket = socket;
        const parser = createFrameParser();
        socket.pipe(parser);
        parser.on('data', (frame: ParsedFrame) => {
          if (frame.type === FrameType.HELLO) {
            socket.write(encodeWelcome({ pid: 1, cols: 80, rows: 24, startTime: Date.now() }));
          }
        });
      });
      server.listen(socketPath);
      cleanup.push(() => { server.close(); });

      const client = new ShepherdClient(socketPath);
      cleanup.push(() => client.disconnect());
      await client.connect();

      expect(client.getReplayData()).toBeNull();

      const replayPromise = new Promise<Buffer>((resolve) => {
        client.on('replay', resolve);
      });

      serverSocket!.write(encodeReplay(Buffer.from('line1\r\nline2\r\n')));

      const replay = await replayPromise;
      expect(replay.toString()).toBe('line1\r\nline2\r\n');
      expect(client.getReplayData()?.toString()).toBe('line1\r\nline2\r\n');
    });

    it('responds to PING with PONG', async () => {
      let serverSocket: net.Socket | null = null;
      const serverParser = createFrameParser();
      const server = net.createServer((socket) => {
        serverSocket = socket;
        const parser = createFrameParser();
        socket.pipe(parser);
        parser.on('data', (frame: ParsedFrame) => {
          if (frame.type === FrameType.HELLO) {
            socket.write(encodeWelcome({ pid: 1, cols: 80, rows: 24, startTime: Date.now() }));
          } else if (frame.type === FrameType.PONG) {
            serverParser.emit('pong-received');
          }
        });
      });
      server.listen(socketPath);
      cleanup.push(() => { server.close(); });

      const client = new ShepherdClient(socketPath);
      cleanup.push(() => client.disconnect());
      await client.connect();

      // Need to capture the PONG that the client sends back
      const pongPromise = new Promise<void>((resolve) => {
        // Re-parse what's coming back on server socket
        const responseParser = createFrameParser();
        serverSocket!.pipe(responseParser);
        responseParser.on('data', (frame: ParsedFrame) => {
          if (frame.type === FrameType.PONG) {
            resolve();
          }
        });
      });

      // Server sends PING
      serverSocket!.write(encodePing());

      await Promise.race([
        pongPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
      ]);
    });

    it('emits pong event when server sends PONG', async () => {
      let serverSocket: net.Socket | null = null;
      const server = net.createServer((socket) => {
        serverSocket = socket;
        const parser = createFrameParser();
        socket.pipe(parser);
        parser.on('data', (frame: ParsedFrame) => {
          if (frame.type === FrameType.HELLO) {
            socket.write(encodeWelcome({ pid: 1, cols: 80, rows: 24, startTime: Date.now() }));
          }
        });
      });
      server.listen(socketPath);
      cleanup.push(() => { server.close(); });

      const client = new ShepherdClient(socketPath);
      cleanup.push(() => client.disconnect());
      await client.connect();

      const pongPromise = new Promise<void>((resolve) => {
        client.on('pong', resolve);
      });

      serverSocket!.write(encodePong());

      await Promise.race([
        pongPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
      ]);
    });
  });

  describe('error handling', () => {
    it('rejects on broken pipe during handshake', async () => {
      const server = net.createServer((socket) => {
        // Close immediately without sending WELCOME
        socket.destroy();
      });
      server.listen(socketPath);
      cleanup.push(() => { server.close(); });

      const client = new ShepherdClient(socketPath);
      await expect(client.connect()).rejects.toThrow();
    });

    it('does not crash when error emitted with no listener', async () => {
      let serverSocket: net.Socket | null = null;
      const server = net.createServer((socket) => {
        serverSocket = socket;
        const parser = createFrameParser();
        socket.pipe(parser);
        parser.on('data', (frame: ParsedFrame) => {
          if (frame.type === FrameType.HELLO) {
            socket.write(encodeWelcome({ pid: 1, cols: 80, rows: 24, startTime: Date.now() }));
          }
        });
      });
      server.listen(socketPath);
      cleanup.push(() => { server.close(); });

      const client = new ShepherdClient(socketPath);
      cleanup.push(() => client.disconnect());
      await client.connect();

      // Do NOT attach an error listener.
      // Send an EXIT frame with non-JSON payload — this triggers safeEmitError
      // internally via the Invalid EXIT payload catch path.
      // If error emission were unsafe, this would throw and crash the test process.
      serverSocket!.write(encodeFrame(FrameType.EXIT, Buffer.from('not-json')));
      await new Promise((r) => setTimeout(r, 50));

      // Process survived — no crash
      expect(client.connected).toBe(true);
    });

    it('buffers frames received before WELCOME and delivers them after', async () => {
      let serverSocket: net.Socket | null = null;
      const server = net.createServer((socket) => {
        serverSocket = socket;
        const parser = createFrameParser();
        socket.pipe(parser);
        parser.on('data', (frame: ParsedFrame) => {
          if (frame.type === FrameType.HELLO) {
            // Send DATA before WELCOME (simulates PTY output racing handshake)
            socket.write(encodeData('pre-welcome-data'));
            // Then send WELCOME
            socket.write(encodeWelcome({ pid: 1, cols: 80, rows: 24, startTime: Date.now() }));
          }
        });
      });
      server.listen(socketPath);
      cleanup.push(() => { server.close(); });

      const client = new ShepherdClient(socketPath);
      cleanup.push(() => client.disconnect());

      const receivedData: string[] = [];
      client.on('data', (buf: Buffer) => {
        receivedData.push(buf.toString());
      });

      // Connect should succeed even though DATA arrived before WELCOME
      const welcome = await client.connect();
      expect(welcome.pid).toBe(1);

      // The pre-WELCOME DATA frame should have been replayed after handshake
      await new Promise((r) => setTimeout(r, 50));
      expect(receivedData).toContain('pre-welcome-data');
    });
  });
});
