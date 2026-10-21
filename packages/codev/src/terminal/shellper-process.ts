/**
 * ShellperProcess: the testable core logic of the shellper daemon.
 *
 * Owns a single PTY via the IShellperPty interface (injected for testability).
 * Listens on a Unix socket (POSIX) or named pipe (Windows) for multiple client
 * connections. Handles the binary
 * wire protocol: HELLO/WELCOME handshake, DATA forwarding, RESIZE, SIGNAL,
 * SPAWN, PING/PONG, and EXIT lifecycle.
 *
 * Supports multiple simultaneous connections:
 * - Tower connections (clientType: 'tower') can send DATA, RESIZE, SIGNAL, SPAWN
 * - Terminal connections (clientType: 'terminal') can send DATA, RESIZE only
 * - New tower connection replaces any existing tower connection
 * - Terminal connections always coexist
 * - PTY output is broadcast to all connected clients
 *
 * With a {@link ShellperAuth} (Windows only, Spec 1658) every connection must
 * present the per-session secret in its HELLO. Until it does, the shellper writes
 * nothing to it and acts on none of its frames; a wrong or missing secret drops
 * the connection, and so does staying unauthenticated past PRE_AUTH_TIMEOUT_MS.
 */

import fs from 'node:fs';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import {
  FrameType,
  PROTOCOL_VERSION,
  ALLOWED_SIGNALS,
  REPLAY_PAYLOAD_MAX,
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
import { ShellperReplayBuffer, REPLAY_BUFFER_MAX_BYTES } from './shellper-replay-buffer.js';
import { SHELLPER_SECRET_ENV, isPipeEndpoint, secretsMatch } from './shellper-endpoint.js';
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

/**
 * Per-session connection gate (Windows only). `shellperPid` and `sessionId` are
 * reported in WELCOME so the client can verify it reached the shellper its DB
 * row names.
 */
export interface ShellperAuth {
  secret: string;
  sessionId: string;
  shellperPid: number;
}

/** How long a secret-gated connection may stay unauthenticated before it is dropped. */
export const PRE_AUTH_TIMEOUT_MS = 10_000;

// --- Connection metadata ---

interface ConnectionEntry {
  socket: net.Socket;
  clientType: 'tower' | 'terminal';
  paused: boolean;
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
  // Wall-clock epoch (ms) of the last PTY byte received. Sent in every
  // WELCOME so Tower (which loses its own in-memory tracker on restart)
  // can hydrate to the genuine last-activity moment instead of treating
  // reconnect as fresh activity. Initialised to startTime so a brand-new
  // shellper that has emitted nothing yet still reports a sane value.
  private lastDataAt: number = Date.now();
  // PIR #1475: the argv this shellper's CURRENT PTY was spawned with, sent in
  // every WELCOME as the authoritative statement of the session's app identity.
  // Written by spawnPty(), so it tracks SPAWN replacements as well as the
  // original launch. Null only in the window before the first spawn.
  private ptyCommand: string | null = null;
  private ptyArgs: string[] = [];
  private exited = false;
  // Exit info retained after the PTY exits so clients that connect *after*
  // exit still learn the session ended. Without this, a fast-exiting command
  // (e.g. `exit 1`) can finish before the manager connects its client, the
  // EXIT broadcast reaches nobody, and the client hangs forever waiting for an
  // EXIT frame that already went out (Bugfix #905).
  private exitInfo: { code: number; signal: string | null } | null = null;
  // Spec 1658 Phase 3b: the first PTY spawn, held until Tower's HELLO, and the
  // deadline after which a shellper with no PTY gives up.
  private deferredSpawn: { command: string; args: string[]; cwd: string; env: Record<string, string> } | null = null;
  private deferredSpawnTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly ptyFactory: () => IShellperPty,
    private readonly socketPath: string,
    replayBufferLines: number = 10_000,
    private readonly log: (msg: string) => void = () => {},
    replayBufferBytes: number = REPLAY_BUFFER_MAX_BYTES,
    private readonly auth: ShellperAuth | null = null,
  ) {
    super();
    this.replayBuffer = new ShellperReplayBuffer(replayBufferLines, replayBufferBytes);
  }

  /**
   * Start the shellper: spawn the PTY and begin listening on the Unix socket.
   *
   * With `deferSpawnMs` (Windows, secret-gated shellpers only; Spec 1658 Phase
   * 3b) the PTY is not spawned yet: Tower first puts this process in a
   * per-session Job Object, so the PTY and everything it starts inherit the
   * job. The first authenticated HELLO from a `tower` client spawns it, before
   * the WELCOME. A HELLO from any other role neither spawns nor fails; that
   * client sees an empty replay. If no `tower` HELLO arrives within
   * `deferSpawnMs`, 'spawn-deadline' is emitted and the caller exits, so a
   * PTY-less shellper never lingers.
   */
  async start(
    command: string,
    args: string[],
    cwd: string,
    env: Record<string, string>,
    cols: number,
    rows: number,
    deferSpawnMs?: number,
  ): Promise<void> {
    this.cols = cols;
    this.rows = rows;
    this.startTime = Date.now();

    if (deferSpawnMs !== undefined && this.auth) {
      this.deferredSpawn = { command, args, cwd, env };
      this.deferredSpawnTimer = setTimeout(() => {
        this.deferredSpawnTimer = null;
        if (!this.deferredSpawn) return;
        this.log(`No tower HELLO within ${deferSpawnMs}ms; the PTY was never spawned`);
        this.emit('spawn-deadline');
      }, deferSpawnMs);
    } else {
      this.spawnPty(command, args, cwd, env, cols, rows);
    }
    await this.listen();
  }

  /** Whether the first PTY spawn is still waiting for Tower's HELLO. */
  get spawnDeferred(): boolean {
    return this.deferredSpawn !== null;
  }

  private clearDeferredSpawn(): void {
    this.deferredSpawn = null;
    if (this.deferredSpawnTimer) {
      clearTimeout(this.deferredSpawnTimer);
      this.deferredSpawnTimer = null;
    }
  }

  private spawnPty(
    command: string,
    args: string[],
    cwd: string,
    env: Record<string, string>,
    cols: number,
    rows: number,
  ): void {
    this.clearDeferredSpawn();
    this.exited = false;
    this.exitInfo = null;
    // PIR #1475: record what we are ACTUALLY spawning, for the WELCOME frame.
    // Set here rather than in start() so the SPAWN-frame replacement path
    // (handleSpawn) updates it too — a relaunched PTY must report its current
    // argv, not the one this shellper was born with.
    this.ptyCommand = command;
    this.ptyArgs = [...args];
    const pty = this.ptyFactory();
    this.pty = pty;
    // Spec 1658: the connection secret must never reach the PTY child, whatever
    // env the launch or a SPAWN frame supplies.
    const childEnv = { ...env };
    delete childEnv[SHELLPER_SECRET_ENV];
    pty.spawn(command, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: childEnv,
    });

    pty.onData((data: string) => {
      // Guard: ignore data from a replaced PTY (after SPAWN)
      if (this.pty !== pty) return;

      const buf = Buffer.from(data, 'utf-8');
      this.replayBuffer.append(buf);
      this.lastDataAt = Date.now();

      this.broadcast(encodeData(buf));
    });

    pty.onExit((exitInfo) => {
      // Guard: ignore exit from a replaced PTY (after SPAWN).
      // Without this, the old PTY's exit would set this.exited = true
      // and send an EXIT frame, corrupting the state of the new PTY.
      if (this.pty !== pty) return;

      this.log(`PTY exited: code=${exitInfo.exitCode}, signal=${exitInfo.signal ?? null}`);

      this.exited = true;
      this.exitInfo = {
        code: exitInfo.exitCode,
        signal: exitInfo.signal != null ? String(exitInfo.signal) : null,
      };
      const exitFrame = encodeExit(this.exitInfo);

      this.broadcast(exitFrame);

      this.emit('exit', exitInfo);
    });
  }

  /**
   * Broadcast a frame to all connected clients.
   * Connections under backpressure have frames dropped until drained.
   */
  private broadcast(frame: Buffer): void {
    for (const [id, entry] of this.connections) {
      if (entry.socket.destroyed) {
        this.connections.delete(id);
        continue;
      }
      if (entry.paused) {
        // Connection under backpressure — drop frame.
        // Terminal output is ephemeral; the client will recover
        // when subsequent frames arrive after drain.
        continue;
      }
      const ok = entry.socket.write(frame);
      if (ok === false) {
        // Socket buffer above highWaterMark — pause this connection.
        // Data was still queued, but we stop writing until drained.
        entry.paused = true;
        this.log(`Connection ${id} backpressure — pausing writes`);
        entry.socket.once('drain', () => {
          if (this.connections.has(id)) {
            entry.paused = false;
          }
        });
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
        // A named pipe has no file mode; its access control is the secret gate.
        if (isPipeEndpoint(this.socketPath)) {
          resolve();
          return;
        }
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

    // Spec 1658: a secret-gated connection that never authenticates is dropped.
    let preAuthTimer: ReturnType<typeof setTimeout> | null = null;
    if (this.auth) {
      preAuthTimer = setTimeout(() => {
        if (!handshakeComplete && !socket.destroyed) {
          this.log('Connection dropped: no authenticated HELLO in time');
          socket.destroy();
        }
      }, PRE_AUTH_TIMEOUT_MS);
      preAuthTimer.unref?.();
    }
    const clearPreAuthTimer = (): void => {
      if (preAuthTimer) {
        clearTimeout(preAuthTimer);
        preAuthTimer = null;
      }
    };

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
            clearPreAuthTimer();
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
      clearPreAuthTimer();
      this.pendingSockets.delete(socket);
      if (connectionId && this.connections.has(connectionId)) {
        this.connections.delete(connectionId);
        this.log(`Connection ${connectionId} closed`);
      }
    });

    socket.on('error', () => {
      clearPreAuthTimer();
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

    // Spec 1658: on a secret-gated shellper, a HELLO without the right secret is
    // dropped before anything is written or any connection state changes.
    if (this.auth && !secretsMatch(hello.secret, this.auth.secret)) {
      this.log('HELLO rejected: missing or wrong secret');
      this.emit('auth-rejected');
      socket.destroy();
      return null;
    }

    const clientType = hello.clientType || 'tower';

    // Spec 1658 Phase 3b: Tower's HELLO means the job is in place; spawn now,
    // so the WELCOME below carries the real PTY pid.
    const deferred = this.deferredSpawn;
    if (deferred && clientType === 'tower') {
      this.log('Tower HELLO: spawning the deferred PTY');
      this.spawnPty(deferred.command, deferred.args, deferred.cwd, deferred.env, this.cols, this.rows);
    }

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
    this.connections.set(connectionId, { socket, clientType, paused: false });

    // Send WELCOME response
    const pid = this.pty?.pid ?? -1;
    const welcome = encodeWelcome({
      version: PROTOCOL_VERSION,
      pid,
      cols: this.cols,
      rows: this.rows,
      startTime: this.startTime,
      lastDataAt: this.lastDataAt,
      // #1215: this build always sends REPLAY below, even when empty —
      // advertise that guarantee so the client can skip its full wait.
      alwaysSendsReplay: true,
      // PIR #1475: the authoritative app identity. Omitted entirely before the
      // first spawn, so the peer sees the same shape an older shellper sends and
      // falls back to its persisted command rather than adopting a half-identity.
      ...(this.ptyCommand ? { command: this.ptyCommand, args: this.ptyArgs } : {}),
      // Spec 1658: the reconnect identity on Windows. Only a secret-gated
      // shellper sends these, so POSIX WELCOME frames are unchanged.
      ...(this.auth ? { shellperPid: this.auth.shellperPid, sessionId: this.auth.sessionId } : {}),
    });
    socket.write(welcome);
    this.log(
      `WELCOME sent: pid=${pid}, version=${PROTOCOL_VERSION}, command=${this.ptyCommand ?? '(unspawned)'}`,
    );

    // Send replay buffer. #1198: never emit a frame the peer's parser must
    // drop — a long-lived TUI session's replay (newline-free, unbounded
    // partial) can exceed MAX_FRAME_SIZE, which is exactly what zombified
    // long-lived terminals on every reconnect. Send the most recent bytes
    // that fit; a tail-trimmed replay can render imperfectly for alt-screen
    // TUIs (#1047), but the client's post-connect resize nudge repaints,
    // and a truncated replay beats a dead connection.
    //
    // #1205: the cap is passed *into* the buffer rather than applied to its
    // result. This path runs on every connect, so capping afterwards meant
    // allocating a copy of the entire session history first — the multi-GB
    // open-time spike.
    //
    // There is deliberately no post-hoc `length > REPLAY_PAYLOAD_MAX` guard
    // here. Passing the cap in makes one unreachable: getReplayData never
    // returns more than its argument. An earlier revision kept such a guard as
    // "defense in depth" and claimed a test covered it; neither was true, and
    // an unreachable branch that looks load-bearing is worse than none. The
    // invariant is enforced by getReplayData's contract and pinned by the
    // oversized-retention test, which fails if this argument is ever dropped.
    const replayData = this.replayBuffer.getReplayData(REPLAY_PAYLOAD_MAX);
    // #1198: send REPLAY even when empty, so a client awaiting the frame
    // resolves immediately instead of burning its timeout. Creation-time
    // attach awaits the frame to avoid racing early child output into a
    // dropped replay; old clients treat an empty REPLAY as no replay data.
    socket.write(encodeReplay(replayData));

    // If the PTY already exited before this client connected, the original
    // EXIT broadcast missed it. Replay the retained EXIT frame so the client
    // doesn't hang waiting for an event that already fired (Bugfix #905).
    if (this.exited && this.exitInfo) {
      socket.write(encodeExit(this.exitInfo));
      this.log(`EXIT replayed to late connection ${connectionId}: code=${this.exitInfo.code}`);
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
    this.clearDeferredSpawn();
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
