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
  /**
   * argv[0] the shellper reported it actually spawned the PTY with (PIR #1475),
   * or null when it sent no usable identity — an older shellper that omits the
   * WELCOME fields, or a payload that failed validation.
   *
   * OPTIONAL on the interface, always present on {@link ShellperClient}. Test
   * doubles are the reason: `tower-shellper-integration.test.ts` implements this
   * interface for real (required members would break its typecheck), while
   * several others are `as unknown as IShellperClient` casts whose objects yield
   * `undefined` at runtime rather than `null`. Consumers must therefore treat
   * absent/null/empty identically — use a falsy check, never `!== null`.
   */
  readonly welcomeCommand?: string | null;
  /**
   * argv[1..] paired with {@link IShellperClient.welcomeCommand}. The pair is one
   * capability: both are set together or both are null, so a caller that has a
   * command can trust these args belong to it.
   */
  readonly welcomeArgs?: string[] | null;
}

// PIR #1475: bounds on the WELCOME identity payload — a sanity check against a
// garbled frame, NOT a security boundary (the frame already arrives over an
// owner-only socket and is capped at MAX_FRAME_SIZE by the parser).
//
// These are deliberately generous, and the arg bound is on the TOTAL rather than
// per-argument. A per-arg cap of 4096 looked reasonable and was wrong in the
// field: an architect launches with `--append-system-prompt <entire role doc>`,
// several KB in a single argument. Because rejection is atomic, that cap threw
// away the whole identity and silently sent every architect down the config
// fallback — the exact sessions this feature exists to make authoritative.
// Bound the aggregate instead, well above any real argv and far below the frame
// cap. A command is a path, so PATH_MAX is the right shape of limit for it.
//
// The args bound is measured in real UTF-8 BYTES (`Buffer.byteLength`), not
// `String.length` — the latter counts UTF-16 code units, which would hand a
// non-ASCII argv up to ~3x the nominal budget. The command bound stays in chars
// deliberately: it is a path-shaped sanity check, not an allocation guard.
const MAX_IDENTITY_COMMAND_LENGTH = 4096;
const MAX_IDENTITY_ARGS = 256;
const MAX_IDENTITY_ARGS_TOTAL_BYTES = 512 * 1024;

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
  // PIR #1475: the shellper's own statement of what it spawned, hydrated on
  // WELCOME and refreshed when Tower itself issues a SPAWN. Null means "no
  // usable identity" — an older shellper, or a payload that failed validation —
  // and consumers fall back to the persisted launch command.
  private _welcomeCommand: string | null = null;
  private _welcomeArgs: string[] | null = null;

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

  /** argv[0] the shellper reported spawning, or null (PIR #1475). */
  get welcomeCommand(): string | null {
    return this._welcomeCommand;
  }

  /** argv[1..] paired with {@link ShellperClient.welcomeCommand}, or null. */
  get welcomeArgs(): string[] | null {
    return this._welcomeArgs;
  }

  /**
   * Adopt a reported identity, ATOMICALLY (PIR #1475).
   *
   * The command and args are one capability, so anything short of a fully valid
   * pair rejects BOTH and leaves the client with no identity — the caller then
   * falls back to the persisted launch command rather than acting on half a
   * truth. Rejected: a non-string or empty/whitespace-only command (an empty
   * string would otherwise overwrite a good persisted value, and `''` is what
   * `createSessionRaw` uses for "unknown"), an over-long command, a non-array or
   * non-string-element args list, and args that exceed the count/length bounds.
   *
   * Validation is about coherence, not spoof-resistance: a WELCOME payload is
   * trusted because it arrives over an owner-only socket (mode 0600 inside the
   * 0700 run dir) from a PID/start-time-validated shellper — NOT because a
   * semantically bogus command would fail safely. It would not: `resolveProfile`
   * matches by substring, so a garbled string containing `claude` resolves a real
   * profile.
   */
  private setIdentity(command: unknown, args: unknown): void {
    // A shellper that states NO identity is the legacy case, and silence is the
    // right response. A shellper that states one we then throw away is not: that
    // is the failure mode this project already shipped once (a per-argument bound
    // an architect's multi-KB `--append-system-prompt` tripped), and it was
    // invisible because a rejection and a legacy shellper look identical
    // downstream — both land on `source=config`. Warn only in the second case, so
    // a recurrence is visible where it happens instead of being inferred.
    const reject = (why: string): void => {
      this._welcomeCommand = null;
      this._welcomeArgs = null;
      if (command !== undefined || args !== undefined) {
        console.warn(`[shellper-client] discarding WELCOME identity from ${this.socketPath}: ${why}`);
      }
    };
    const trimmed = typeof command === 'string' ? command.trim() : '';
    if (!trimmed || trimmed.length > MAX_IDENTITY_COMMAND_LENGTH) {
      reject(
        typeof command === 'string'
          ? `command is empty or exceeds ${MAX_IDENTITY_COMMAND_LENGTH} chars (${command.length})`
          : `command is ${typeof command}, expected string`,
      );
      return;
    }
    let resolvedArgs: string[] = [];
    if (args !== undefined) {
      if (!Array.isArray(args)) {
        reject(`args is ${typeof args}, expected array`);
        return;
      }
      if (args.length > MAX_IDENTITY_ARGS) {
        reject(`args has ${args.length} elements, limit ${MAX_IDENTITY_ARGS}`);
        return;
      }
      if (!args.every((a) => typeof a === 'string')) {
        reject('args contains a non-string element');
        return;
      }
      // Byte length, not `String.length`: the latter counts UTF-16 code units, so a
      // non-ASCII argv would silently get several times the nominal budget.
      const total = (args as string[]).reduce((n, a) => n + Buffer.byteLength(a, 'utf8'), 0);
      if (total > MAX_IDENTITY_ARGS_TOTAL_BYTES) {
        reject(`args total ${total} bytes, limit ${MAX_IDENTITY_ARGS_TOTAL_BYTES}`);
        return;
      }
      resolvedArgs = args as string[];
    }
    this._welcomeCommand = trimmed;
    this._welcomeArgs = resolvedArgs;
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
              // PIR #1475: hydrate the authoritative app identity. Old shellpers
              // omit both fields, leaving them null so consumers fall back to the
              // persisted command.
              this.setIdentity(welcome.command, welcome.args);
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
    // PIR #1475: Tower issued this relaunch, so the identity it just asked for
    // is the identity the shellper will report on its next WELCOME. Adopt it now
    // rather than waiting for a reconnect that an ordinary SPAWN never triggers —
    // otherwise every consumer reading through this client (PtySession.command,
    // and through it the render gate) would stay pinned to the pre-relaunch value
    // for the rest of the session. Deliberately AFTER the connected guard and the
    // write: a dropped SPAWN must not leave us claiming an argv the shellper
    // never received.
    this.setIdentity(msg.command, msg.args);
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
