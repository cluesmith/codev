/**
 * ShellperProcess: the testable core logic of the shellper daemon.
 *
 * Owns a single PTY via the IShellperPty interface (injected for testability).
 * Listens on a Unix socket for a single Tower connection. Handles the binary
 * wire protocol: HELLO/WELCOME handshake, DATA forwarding, RESIZE, SIGNAL,
 * SPAWN, PING/PONG, and EXIT lifecycle.
 *
 * The shellper accepts only one Tower connection at a time. A new connection
 * replaces the old one (handles rapid Tower restarts cleanly).
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

// --- ShellperProcess ---

export class ShellperProcess extends EventEmitter {
  private pty: IShellperPty | null = null;
  private server: net.Server | null = null;
  private currentConnection: net.Socket | null = null;
  private replayBuffer: ShellperReplayBuffer;
  private cols = 80;
  private rows = 24;
  private startTime: number = Date.now();
  private exited = false;

  constructor(
    private readonly ptyFactory: () => IShellperPty,
    private readonly socketPath: string,
    replayBufferLines: number = 10_000,
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

      if (this.currentConnection && !this.currentConnection.destroyed) {
        this.currentConnection.write(encodeData(buf));
      }
    });

    pty.onExit((exitInfo) => {
      // Guard: ignore exit from a replaced PTY (after SPAWN).
      // Without this, the old PTY's exit would set this.exited = true
      // and send an EXIT frame, corrupting the state of the new PTY.
      if (this.pty !== pty) return;

      this.exited = true;
      const exitFrame = encodeExit({
        code: exitInfo.exitCode,
        signal: exitInfo.signal != null ? String(exitInfo.signal) : null,
      });

      if (this.currentConnection && !this.currentConnection.destroyed) {
        this.currentConnection.write(exitFrame);
      }

      this.emit('exit', exitInfo);
    });
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
   * Handle an incoming Tower connection. Only one connection is active at a
   * time — a new connection closes the previous one.
   */
  handleConnection(socket: net.Socket): void {
    // Close previous connection if any
    if (this.currentConnection && !this.currentConnection.destroyed) {
      this.currentConnection.destroy();
    }
    this.currentConnection = socket;

    const parser = createFrameParser();

    socket.pipe(parser);

    parser.on('data', (frame: ParsedFrame) => {
      this.handleFrame(socket, frame);
    });

    parser.on('error', (err) => {
      this.emit('protocol-error', err);
      socket.destroy();
    });

    socket.on('close', () => {
      if (this.currentConnection === socket) {
        this.currentConnection = null;
      }
    });

    socket.on('error', () => {
      if (this.currentConnection === socket) {
        this.currentConnection = null;
      }
    });
  }

  private handleFrame(socket: net.Socket, frame: ParsedFrame): void {
    if (!isKnownFrameType(frame.type)) {
      // Unknown frame types are silently ignored (forward compatibility)
      return;
    }

    switch (frame.type) {
      case FrameType.HELLO:
        this.handleHello(socket, frame.payload);
        break;
      case FrameType.DATA:
        this.handleData(frame.payload);
        break;
      case FrameType.RESIZE:
        this.handleResize(socket, frame.payload);
        break;
      case FrameType.SIGNAL:
        this.handleSignal(socket, frame.payload);
        break;
      case FrameType.SPAWN:
        this.handleSpawn(socket, frame.payload);
        break;
      case FrameType.PING:
        socket.write(encodePong());
        break;
      case FrameType.PONG:
        // No-op: keepalive acknowledgement
        break;
      // Shellper doesn't expect REPLAY, EXIT, WELCOME from Tower
      default:
        break;
    }
  }

  private handleHello(socket: net.Socket, payload: Buffer): void {
    try {
      const hello = parseJsonPayload<HelloMessage>(payload);
      this.emit('hello', hello);
    } catch {
      this.emit('protocol-error', new Error('Invalid HELLO payload'));
      socket.destroy();
      return;
    }

    // Send WELCOME response
    const welcome = encodeWelcome({
      version: PROTOCOL_VERSION,
      pid: this.pty?.pid ?? -1,
      cols: this.cols,
      rows: this.rows,
      startTime: this.startTime,
    });
    socket.write(welcome);

    // Send replay buffer
    const replayData = this.replayBuffer.getReplayData();
    if (replayData.length > 0) {
      socket.write(encodeReplay(replayData));
    }
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
      this.emit('protocol-error', new Error('Invalid RESIZE payload'));
      socket.destroy();
    }
  }

  private handleSignal(socket: net.Socket, payload: Buffer): void {
    try {
      const msg = parseJsonPayload<SignalMessage>(payload);
      if (!ALLOWED_SIGNALS.has(msg.signal)) {
        this.emit('protocol-error', new Error(`Signal ${msg.signal} not in allowlist`));
        return;
      }
      if (this.pty && !this.exited) {
        this.pty.kill(msg.signal);
      }
    } catch {
      this.emit('protocol-error', new Error('Invalid SIGNAL payload'));
      socket.destroy();
    }
  }

  private handleSpawn(socket: net.Socket, payload: Buffer): void {
    try {
      const msg = parseJsonPayload<SpawnMessage>(payload);

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

    if (this.currentConnection && !this.currentConnection.destroyed) {
      this.currentConnection.destroy();
    }
    this.currentConnection = null;

    if (this.server) {
      this.server.close();
      this.server = null;
    }

    this.emit('shutdown');
  }
}
