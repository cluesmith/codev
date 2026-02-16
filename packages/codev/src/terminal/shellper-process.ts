/**
 * ShellperProcess: the testable core logic of the shellper daemon.
 *
 * Owns a single PTY via the IShellperPty interface (injected for testability).
 * Listens on a Unix socket for multiple client connections. Handles the binary
 * wire protocol: HELLO/WELCOME handshake, DATA forwarding, RESIZE, SIGNAL,
 * SPAWN, PING/PONG, and EXIT lifecycle.
 *
 * Supports multiple simultaneous connections:
 * - Tower connections (clientType: 'tower') can send DATA, RESIZE, SIGNAL, SPAWN
 * - Terminal connections (clientType: 'terminal') can send DATA, RESIZE only
 * - New tower connection replaces any existing tower connection
 * - Terminal connections always coexist
 * - PTY output is broadcast to all connected clients
 */

import fs from 'node:fs';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import {
  FrameType,
  PROTOCOL_VERSION,
  ALLOWED_SIGNALS,
  createFrameParser,
  encodeData,
  encodeWelcome,
  encodeExit,
  encodeReplay,
  encodePong,
  parseJsonPayload,
  isKnownFrameType,
  type FrameTypeValue,
  type ParsedFrame,
  type HelloMessage,
  type ResizeMessage,
  type SignalMessage,
  type SpawnMessage,
} from './shellper-protocol.js';
import { ShellperReplayBuffer } from './shellper-replay-buffer.js';
import { DEFAULT_COLS, DEFAULT_ROWS } from './index.js';

// --- IShellperPty: abstraction over node-pty for testing ---

export interface PtyOptions {
  name?: string;
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
}

export interface IShellperPty {
  spawn(command: string, args: string[], options: PtyOptions): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: number): void;
  onData(callback: (data: string) => void): void;
  onExit(callback: (exitInfo: { exitCode: number; signal?: number }) => void): void;
  pid: number;
}

// --- Connection metadata ---

interface ConnectionEntry {
  socket: net.Socket;
  clientType: 'tower' | 'terminal';
}

// --- ShellperProcess ---

export class ShellperProcess extends EventEmitter {
  private pty: IShellperPty | null = null;
  private server: net.Server | null = null;
  private connections: Map<string, ConnectionEntry> = new Map();
  private pendingSockets: Set<net.Socket> = new Set();
  private nextConnectionId = 0;
  private replayBuffer: ShellperReplayBuffer;
  private cols = DEFAULT_COLS;
  private rows = DEFAULT_ROWS;
  private startTime: number = Date.now();
  private exited = false;

  constructor(
    private readonly ptyFactory: () => IShellperPty,
    private readonly socketPath: string,
    replayBufferLines: number = 10_000,
    private readonly log: (msg: string) => void = () => {},
  ) {
    super();
    this.replayBuffer = new ShellperReplayBuffer(replayBufferLines);
  }

  /**
   * Start the shellper: spawn the PTY and begin listening on the Unix socket.
   */
  async start(
    command: string,
    args: string[],
    cwd: string,
    env: Record<string, string>,
    cols: number,
    rows: number,
  ): Promise<void> {
    this.cols = cols;
    this.rows = rows;
    this.startTime = Date.now();

    this.spawnPty(command, args, cwd, env, cols, rows);
    await this.listen();
  }

  private spawnPty(
    command: string,
    args: string[],
    cwd: string,
    env: Record<string, string>,
    cols: number,
    rows: number,
  ): void {
    this.exited = false;
    const pty = this.ptyFactory();
    this.pty = pty;
    pty.spawn(command, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env,
    });

    pty.onData((data: string) => {
      // Guard: ignore data from a replaced PTY (after SPAWN)
      if (this.pty !== pty) return;

      const buf = Buffer.from(data, 'utf-8');
      this.replayBuffer.append(buf);

      this.broadcast(encodeData(buf));
    });

    pty.onExit((exitInfo) => {
      // Guard: ignore exit from a replaced PTY (after SPAWN).
      // Without this, the old PTY's exit would set this.exited = true
      // and send an EXIT frame, corrupting the state of the new PTY.
      if (this.pty !== pty) return;

      this.log(`PTY exited: code=${exitInfo.exitCode}, signal=${exitInfo.signal ?? null}`);

      this.exited = true;
      const exitFrame = encodeExit({
        code: exitInfo.exitCode,
        signal: exitInfo.signal != null ? String(exitInfo.signal) : null,
      });

      this.broadcast(exitFrame);

      this.emit('exit', exitInfo);
    });
  }

  /**
   * Broadcast a frame to all connected clients.
   * If a write fails, the connection is removed from the map.
   */
  private broadcast(frame: Buffer): void {
    for (const [id, entry] of this.connections) {
      if (entry.socket.destroyed) {
        this.connections.delete(id);
        continue;
      }
      const ok = entry.socket.write(frame);
      if (ok === false) {
        // Backpressure: socket buffer full — remove this client
        this.log(`Write failed for connection ${id}, removing`);
        entry.socket.destroy();
        this.connections.delete(id);
      }
    }
  }

  private listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        this.handleConnection(socket);
      });

      this.server.on('error', (err) => {
        this.emit('error', err);
        reject(err);
      });

      this.server.listen(this.socketPath, () => {
        // Enforce 0600 permissions on socket file (owner-only access).
        // Unix sockets inherit permissions from umask; we override after creation.
        try {
          fs.chmodSync(this.socketPath, 0o600);
        } catch {
          // Non-fatal: socket still works, just with default permissions
        }
        resolve();
      });
    });
  }

  /**
   * Handle an incoming connection. The socket enters a "pre-HELLO" state
   * where it is tracked but not added to the connection map. Only after
   * a valid HELLO frame is received does it become a full connection.
   */
  handleConnection(socket: net.Socket): void {
    this.log('Connection accepted');

    // Track as pending until HELLO completes
    this.pendingSockets.add(socket);

    let connectionId: string | null = null;
    let handshakeComplete = false;

    const parser = createFrameParser();
    socket.pipe(parser);

    parser.on('data', (frame: ParsedFrame) => {
      if (!handshakeComplete) {
        // Pre-HELLO: only accept HELLO frames
        if (frame.type === FrameType.HELLO) {
          const result = this.handleHello(socket, frame.payload);
          if (result) {
            connectionId = result;
            handshakeComplete = true;
            this.pendingSockets.delete(socket);
          }
        }
        // All other frames before HELLO are silently ignored
        return;
      }

      // Post-handshake: dispatch frames with connection context
      this.handleFrame(socket, connectionId!, frame);
    });

    parser.on('error', (err) => {
      this.log(`Protocol error: ${err.message}`);
      this.emit('protocol-error', err);
      socket.destroy();
    });

    socket.on('close', () => {
      this.pendingSockets.delete(socket);
      if (connectionId && this.connections.has(connectionId)) {
        this.connections.delete(connectionId);
        this.log(`Connection ${connectionId} closed`);
      }
    });

    socket.on('error', () => {
      this.pendingSockets.delete(socket);
      if (connectionId && this.connections.has(connectionId)) {
        this.connections.delete(connectionId);
      }
    });
  }

  private handleFrame(socket: net.Socket, connId: string, frame: ParsedFrame): void {
    if (!isKnownFrameType(frame.type)) {
      // Unknown frame types are silently ignored (forward compatibility)
      return;
    }

    const entry = this.connections.get(connId);

    switch (frame.type) {
      case FrameType.HELLO:
        // Duplicate HELLO after handshake — ignore
        break;
      case FrameType.DATA:
        this.handleData(frame.payload);
        break;
      case FrameType.RESIZE:
        this.handleResize(socket, frame.payload);
        break;
      case FrameType.SIGNAL:
        // Tower-only: terminal connections silently ignored
        if (entry?.clientType === 'tower') {
          this.handleSignal(socket, frame.payload);
        }
        break;
      case FrameType.SPAWN:
        // Tower-only: terminal connections silently ignored
        if (entry?.clientType === 'tower') {
          this.handleSpawn(socket, frame.payload);
        }
        break;
      case FrameType.PING:
        socket.write(encodePong());
        break;
      case FrameType.PONG:
        // No-op: keepalive acknowledgement
        break;
      // Shellper doesn't expect REPLAY, EXIT, WELCOME from clients
      default:
        break;
    }
  }

  /**
   * Handle HELLO frame: validate, register connection, send WELCOME + REPLAY.
   * Returns the connection ID on success, or null on failure.
   */
  private handleHello(socket: net.Socket, payload: Buffer): string | null {
    let hello: HelloMessage;
    try {
      hello = parseJsonPayload<HelloMessage>(payload);
      const clientType = hello.clientType || 'tower'; // Default to tower for backward compat
      this.log(`HELLO: version=${hello.version}, clientType=${clientType}`);
      this.emit('hello', hello);
    } catch {
      this.log('Protocol error: Invalid HELLO payload');
      this.emit('protocol-error', new Error('Invalid HELLO payload'));
      socket.destroy();
      return null;
    }

    const clientType = hello.clientType || 'tower';

    // Tower replacement: destroy any existing tower connection
    if (clientType === 'tower') {
      for (const [id, entry] of this.connections) {
        if (entry.clientType === 'tower') {
          this.log(`Replacing existing tower connection ${id}`);
          entry.socket.destroy();
          this.connections.delete(id);
        }
      }
    }

    // Register this connection
    const connectionId = String(this.nextConnectionId++);
    this.connections.set(connectionId, { socket, clientType });

    // Send WELCOME response
    const pid = this.pty?.pid ?? -1;
    const welcome = encodeWelcome({
      version: PROTOCOL_VERSION,
      pid,
      cols: this.cols,
      rows: this.rows,
      startTime: this.startTime,
    });
    socket.write(welcome);
    this.log(`WELCOME sent: pid=${pid}, version=${PROTOCOL_VERSION}`);

    // Send replay buffer
    const replayData = this.replayBuffer.getReplayData();
    if (replayData.length > 0) {
      socket.write(encodeReplay(replayData));
    }

    return connectionId;
  }

  private handleData(payload: Buffer): void {
    if (this.pty && !this.exited) {
      this.pty.write(payload.toString('utf-8'));
    }
  }

  private handleResize(socket: net.Socket, payload: Buffer): void {
    try {
      const msg = parseJsonPayload<ResizeMessage>(payload);
      this.cols = msg.cols;
      this.rows = msg.rows;
      if (this.pty && !this.exited) {
        this.pty.resize(msg.cols, msg.rows);
      }
    } catch {
      this.log('Protocol error: Invalid RESIZE payload');
      this.emit('protocol-error', new Error('Invalid RESIZE payload'));
      socket.destroy();
    }
  }

  private handleSignal(socket: net.Socket, payload: Buffer): void {
    try {
      const msg = parseJsonPayload<SignalMessage>(payload);
      if (!ALLOWED_SIGNALS.has(msg.signal)) {
        this.log(`Protocol error: Signal ${msg.signal} not in allowlist`);
        this.emit('protocol-error', new Error(`Signal ${msg.signal} not in allowlist`));
        return;
      }
      if (this.pty && !this.exited) {
        this.pty.kill(msg.signal);
      }
    } catch {
      this.log('Protocol error: Invalid SIGNAL payload');
      this.emit('protocol-error', new Error('Invalid SIGNAL payload'));
      socket.destroy();
    }
  }

  private handleSpawn(socket: net.Socket, payload: Buffer): void {
    try {
      const msg = parseJsonPayload<SpawnMessage>(payload);
      const oldPid = this.pty?.pid ?? -1;
      this.log(`SPAWN: command=${msg.command}, killing old PTY pid=${oldPid}`);

      // Kill old PTY if still alive
      if (this.pty && !this.exited) {
        this.pty.kill(15); // SIGTERM
      }

      // Clear replay buffer for fresh session
      this.replayBuffer.clear();

      // Spawn new PTY
      this.spawnPty(msg.command, msg.args, msg.cwd, msg.env, this.cols, this.rows);
      this.emit('spawn', msg);
    } catch {
      this.log('Protocol error: Invalid SPAWN payload');
      this.emit('protocol-error', new Error('Invalid SPAWN payload'));
      socket.destroy();
    }
  }

  /** Get the current replay buffer data. */
  getReplayData(): Buffer {
    return this.replayBuffer.getReplayData();
  }

  /** Get the process start time (epoch ms). */
  getStartTime(): number {
    return this.startTime;
  }

  /** Get the current PTY PID. */
  getPid(): number {
    return this.pty?.pid ?? -1;
  }

  /** Whether the child process has exited. */
  get hasExited(): boolean {
    return this.exited;
  }

  /**
   * Graceful shutdown: kill child process, close socket server, clean up.
   */
  shutdown(): void {
    if (this.pty && !this.exited) {
      this.pty.kill(15); // SIGTERM
    }

    // Destroy all active connections
    for (const [, entry] of this.connections) {
      if (!entry.socket.destroyed) {
        entry.socket.destroy();
      }
    }
    this.connections.clear();

    // Destroy any pre-HELLO pending sockets
    for (const socket of this.pendingSockets) {
      if (!socket.destroyed) {
        socket.destroy();
      }
    }
    this.pendingSockets.clear();

    if (this.server) {
      this.server.close();
      this.server = null;
    }

    this.emit('shutdown');
  }
}
