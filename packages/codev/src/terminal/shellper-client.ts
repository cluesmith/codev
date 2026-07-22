/**
 * ShellperClient: Tower's connection to a single shellper process.
 *
 * Connects to a shellper via Unix socket, performs HELLO/WELCOME handshake,
 * and provides a typed API for sending/receiving frames. Emits events for
 * data, exit, replay, and errors.
 *
 * Usage:
 *   const client = new ShellperClient('/path/to/shellper.sock');
 *   const welcome = await client.connect();
 *   client.on('data', (buf) => { ... });
 *   client.write('ls\n');
 *   client.disconnect();
 */

import net from 'node:net';
import { EventEmitter } from 'node:events';
import {
  FrameType,
  PROTOCOL_VERSION,
  createFrameParser,
  encodeHello,
  encodeData,
  encodeResize,
  encodeSignal,
  encodeSpawn,
  encodePing,
  encodePong,
  parseJsonPayload,
  isKnownFrameType,
  type ParsedFrame,
  type WelcomeMessage,
  type ExitMessage,
  type SpawnMessage,
} from './shellper-protocol.js';

// Default bound for waitForReplay() against a shellper that advertised
// `alwaysSendsReplay` on WELCOME — long enough to cover a slow/large REPLAY
// send (see REPLAY_PAYLOAD_MAX) without the caller having to think about it.
export const DEFAULT_REPLAY_TIMEOUT_MS = 500;

// #1215: bound on how long waitForReplay() waits for a shellper that hasn't
// advertised `alwaysSendsReplay` on WELCOME. Short enough that an idle
// pre-#1215-behavior shellper's stall is negligible even across many
// sessions; long enough to still catch a busy legacy shellper's REPLAY
// frame arriving on a later socket read (same-process reads are normally
// sub-millisecond) — see waitForReplay() for the full rationale.
export const LEGACY_REPLAY_TIMEOUT_MS = 50;

export interface IShellperClient extends EventEmitter {
  connect(): Promise<WelcomeMessage>;
  disconnect(): void;
  /** Returns false when the frame was dropped because the client is not connected (#1198). */
  write(data: string | Buffer): boolean;
  /** Returns false when the frame was dropped because the client is not connected (#1198). */
  resize(cols: number, rows: number): boolean;
  signal(sig: number): void;
  spawn(msg: SpawnMessage): void;
  ping(): void;
  getReplayData(): Buffer | null;
  waitForReplay(timeoutMs?: number): Promise<Buffer>;
  readonly connected: boolean;
  /**
   * Epoch (ms) of the last PTY byte the shellper has seen.
   * Hydrated from the shellper's own tracker on WELCOME, then bumped on
   * every DATA frame. Falls back to construct time only if the shellper
   * is an older one that doesn't send the field.
   */
  readonly lastDataAt: number;
}

export class ShellperClient extends EventEmitter implements IShellperClient {
  private socket: net.Socket | null = null;
  private _connected = false;
  // #1198: a 'close' emission is owed to consumers. Recorded by cleanup()
  // when it tears down a live connection that did not ask to die (anything
  // other than disconnect()); consumed by the socket's 'close' event. The
  // decision must be captured at teardown time because error paths run
  // cleanup() before that event fires — reading _connected inside the close
  // handler is what swallowed the emission.
  private _closePending = false;
  private replayData: Buffer | null = null;
  // Wall-clock epoch (ms) of the last PTY byte the shellper has seen.
  //
  // Lifecycle:
  //   - Construct: initialised to `Date.now()` (a sane fallback for the
  //     window before WELCOME arrives, plus the path for legacy shellpers
  //     that don't yet send the field).
  //   - WELCOME handshake: overwritten with the shellper's own
  //     `lastDataAt` if present. This is the critical step — the
  //     shellper process survives Tower restart and keeps tracking, so
  //     hydrating from its value here gives Tower a reading that's
  //     accurate from the moment of connect, with no 5-minute warm-up
  //     window after a Tower restart against a long-silent builder.
  //   - DATA frame: bumped to `Date.now()` on every byte burst (the
  //     in-memory live update path; matches what the shellper does on
  //     its side).
  // PtySession reads this once at attachShellper to hydrate Spec 467's
  // own `lastDataAt`; from there, PtySession owns the read side and
  // /api/overview enrichment uses ptySession.lastDataAt.
  private _lastDataAt: number = Date.now();
  // #1215: whether the connected shellper guarantees a REPLAY frame right
  // after WELCOME, even when empty. False until WELCOME says otherwise —
  // an older shellper never sends this field, so waitForReplay() must not
  // assume an empty REPLAY is coming for it.
  private _alwaysSendsReplay = false;

  constructor(
    private readonly socketPath: string,
    private readonly clientType: 'tower' | 'terminal' = 'tower',
  ) {
    super();
  }

  /**
   * Emit an 'error' event only if listeners are attached.
   * Prevents Node.js from throwing on unhandled 'error' events,
   * which would crash Tower.
   */
  private safeEmitError(err: Error): void {
    if (this.listenerCount('error') > 0) {
      this.emit('error', err);
    }
  }

  get connected(): boolean {
    return this._connected;
  }

  /**
   * Epoch (ms) of the last DATA frame received from the shellper. Updated
   * on every data frame; initialised to construction time so a fresh
   * client is treated as "just heard from" rather than stale. Used by
   * PtySession at attach time to hydrate Spec 467's own lastDataAt.
   */
  get lastDataAt(): number {
    return this._lastDataAt;
  }

  /**
   * Connect to the shellper, perform HELLO/WELCOME handshake.
   * Resolves with the WelcomeMessage on success.
   * Rejects on connection error or handshake failure.
   */
  connect(): Promise<WelcomeMessage> {
    return new Promise((resolve, reject) => {
      if (this._connected) {
        reject(new Error('Already connected'));
        return;
      }
      this._closePending = false;

      const socket = net.createConnection(this.socketPath);
      this.socket = socket;

      let handshakeResolved = false;
      const parser = createFrameParser();

      const onError = (err: Error) => {
        if (!handshakeResolved) {
          handshakeResolved = true;
          reject(err);
        } else {
          this.safeEmitError(err);
        }
        this.cleanup();
      };

      socket.on('error', onError);
      parser.on('error', (err) => {
        this.safeEmitError(err);
        this.cleanup();
      });
      // #1198: the parser drops oversized frames instead of erroring (a
      // long-lived shellper's replay can exceed the frame cap). The
      // connection stays healthy; surface what was lost. For a dropped
      // REPLAY, unblock replay waiters with an empty replay so adoption
      // proceeds (viewers repaint via the post-connect resize nudge).
      parser.on('frame-skipped', (info: { type: number; size: number }) => {
        if (info.type === FrameType.REPLAY && this.replayData === null) {
          this.replayData = Buffer.alloc(0);
          this.emit('replay', this.replayData);
        }
        this.emit('frame-skipped', info);
      });

      socket.on('connect', () => {
        socket.pipe(parser);
        // Send HELLO to initiate handshake
        socket.write(encodeHello({ version: PROTOCOL_VERSION, clientType: this.clientType }));
      });

      socket.on('close', () => {
        this.cleanup();
        // Emit exactly once per unexpectedly lost live connection.
        // _closePending was recorded by whichever cleanup() ran first — an
        // error path's or the one just above — so error-path closes are no
        // longer swallowed (#1198).
        if (this._closePending) {
          this._closePending = false;
          this.emit('close');
        }
        if (!handshakeResolved) {
          handshakeResolved = true;
          reject(new Error('Connection closed during handshake'));
        }
      });

      // Buffer frames that arrive before WELCOME (e.g., DATA from PTY output
      // that the shellper forwards immediately on connection)
      const preWelcomeBuffer: ParsedFrame[] = [];

      parser.on('data', (frame: ParsedFrame) => {
        if (!handshakeResolved) {
          if (frame.type === FrameType.WELCOME) {
            try {
              const welcome = parseJsonPayload<WelcomeMessage>(frame.payload);

              // Version mismatch handling per spec:
              // - shellper version < Tower version → disconnect (stale shellper)
              // - shellper version > Tower version → warn but continue
              const shellperVersion = welcome.version ?? 0;
              if (shellperVersion < PROTOCOL_VERSION) {
                handshakeResolved = true;
                reject(new Error(`Shellper protocol version ${shellperVersion} is older than Tower version ${PROTOCOL_VERSION}`));
                this.cleanup();
                return;
              }
              if (shellperVersion > PROTOCOL_VERSION) {
                // Newer shellper — log warning but continue (forward compatible)
                this.emit('version-warning', shellperVersion, PROTOCOL_VERSION);
              }

              handshakeResolved = true;
              this._connected = true;
              // Hydrate lastDataAt from the shellper's own tracker if it
              // sent one. Old shellpers omit the field (it's optional in
              // the protocol) — leave the construct-time fallback in
              // place for those. New shellpers send the genuine last-PTY
              // moment, including across Tower restarts.
              if (typeof welcome.lastDataAt === 'number') {
                this._lastDataAt = welcome.lastDataAt;
              }
              // #1215: hydrate the REPLAY guarantee flag. Old shellpers omit
              // it (falsy default stands); waitForReplay() uses this to pick
              // its timeout.
              this._alwaysSendsReplay = welcome.alwaysSendsReplay === true;
              // Replay any buffered frames received before WELCOME
              for (const buffered of preWelcomeBuffer) {
                this.handleFrame(buffered);
              }
              resolve(welcome);
            } catch {
              handshakeResolved = true;
              reject(new Error('Invalid WELCOME payload'));
              this.cleanup();
            }
          } else {
            // Buffer non-WELCOME frames for replay after handshake
            preWelcomeBuffer.push(frame);
          }
        } else {
          // Post-handshake: dispatch frames
          this.handleFrame(frame);
        }
      });
    });
  }

  private handleFrame(frame: ParsedFrame): void {
    if (!isKnownFrameType(frame.type)) {
      // Unknown types silently ignored (forward compatibility)
      return;
    }

    switch (frame.type) {
      case FrameType.DATA:
        this._lastDataAt = Date.now();
        this.emit('data', frame.payload);
        break;
      case FrameType.EXIT: {
        try {
          const exit = parseJsonPayload<ExitMessage>(frame.payload);
          this.emit('exit', exit);
        } catch {
          this.safeEmitError(new Error('Invalid EXIT payload'));
        }
        break;
      }
      case FrameType.REPLAY:
        this.replayData = frame.payload;
        this.emit('replay', frame.payload);
        break;
      case FrameType.PING:
        this.socket?.write(encodePong());
        break;
      case FrameType.PONG:
        this.emit('pong');
        break;
      case FrameType.WELCOME:
        // Duplicate WELCOME after handshake — ignore
        break;
      default:
        // Other frame types (HELLO, RESIZE, SIGNAL, SPAWN) are shellper-bound,
        // not expected from shellper → Tower
        break;
    }
  }

  disconnect(): void {
    this.cleanup(true);
  }

  private cleanup(intentional = false): void {
    if (this._connected && !intentional) {
      this._closePending = true;
    }
    this._connected = false;
    if (this.socket && !this.socket.destroyed) {
      this.socket.destroy();
    }
    this.socket = null;
  }

  write(data: string | Buffer): boolean {
    if (!this._connected || !this.socket) return false;
    this.socket.write(encodeData(data));
    return true;
  }

  resize(cols: number, rows: number): boolean {
    if (!this._connected || !this.socket) return false;
    this.socket.write(encodeResize({ cols, rows }));
    return true;
  }

  signal(sig: number): void {
    if (!this._connected || !this.socket) return;
    this.socket.write(encodeSignal({ signal: sig }));
  }

  spawn(msg: SpawnMessage): void {
    if (!this._connected || !this.socket) return;
    this.socket.write(encodeSpawn(msg));
  }

  ping(): void {
    if (!this._connected || !this.socket) return;
    this.socket.write(encodePing());
  }

  /** Get the last received replay data, or null if none. */
  getReplayData(): Buffer | null {
    return this.replayData;
  }

  /**
   * Wait for the REPLAY frame to arrive after connection.
   * The shellper sends REPLAY immediately after WELCOME, but they may
   * arrive in separate reads. Returns the replay data, or empty Buffer
   * if no REPLAY arrives within the timeout (shellper had nothing to replay).
   *
   * #1215: a shellper that didn't advertise `alwaysSendsReplay` on WELCOME
   * only sends REPLAY when it has buffered data — an idle one never sends
   * it at all, so waiting the full `timeoutMs` (DEFAULT_REPLAY_TIMEOUT_MS
   * by default) for every such session is pure stall. Bound the wait to
   * LEGACY_REPLAY_TIMEOUT_MS instead: short enough to keep idle-session
   * cost low, long enough to still catch a busy legacy shellper's REPLAY
   * arriving on the later socket read this method exists to wait for in
   * the first place (#1198).
   */
  waitForReplay(timeoutMs: number = DEFAULT_REPLAY_TIMEOUT_MS): Promise<Buffer> {
    if (this.replayData !== null) {
      return Promise.resolve(this.replayData);
    }
    const effectiveTimeoutMs = this._alwaysSendsReplay
      ? timeoutMs
      : Math.min(timeoutMs, LEGACY_REPLAY_TIMEOUT_MS);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.removeListener('replay', onReplay);
        this.emit('replay-timeout', { alwaysSendsReplay: this._alwaysSendsReplay, timeoutMs: effectiveTimeoutMs });
        resolve(Buffer.alloc(0));
      }, effectiveTimeoutMs);
      const onReplay = (data: Buffer) => {
        clearTimeout(timer);
        resolve(data);
      };
      this.once('replay', onReplay);
    });
  }
}
