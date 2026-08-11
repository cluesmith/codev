/**
 * Single PTY session: wraps node-pty with ring buffer, disk logging,
 * WebSocket broadcast, and reconnection support.
 */

import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { IPty } from 'node-pty';
import { RingBuffer } from './ring-buffer.js';
import { SessionScreen } from './session-screen.js';
import type { IShellperClient } from './shellper-client.js';
import { isDeliberateExit } from './shellper-protocol.js';

/**
 * Terminal delivery-signal bus (Spec 1313, Phase 5).
 *
 * Sessions emit two fast delivery triggers on this module-singleton emitter, each
 * carrying only the signalling session's id:
 *   - `'submit'`     — the user pressed Enter (submitting any draft), so the composer
 *                      may now be a clean prompt.
 *   - `'quiescence'` — PTY output has been idle for {@link QUIESCENCE_DEBOUNCE_MS}, so
 *                      an agent that was streaming has likely settled.
 *
 * The mailbox wiring subscribes once and schedules a coalesced, gated drain for the
 * signalling session's agent. A single global bus (mirroring the single global
 * drainer) is what lets `pty-session` stay ignorant of the mailbox layer: it only
 * announces occupancy-relevant transitions and never decides delivery. A signal with
 * no subscriber is a no-op, and the quiescence timer is armed only while a subscriber
 * is present, so this is zero-cost when the drainer is not running.
 */
export const terminalDeliverySignals = new EventEmitter();

/**
 * Output-idle window after which a session emits `'quiescence'` (Spec 1313 Phase 5).
 * Comfortably under the backstop interval so held mail delivers sooner, yet long
 * enough to ride over the sub-second gaps in a streaming agent's output (a premature
 * fire is harmless — the gate still decides — so this favours fewer wasted checks).
 */
export const QUIESCENCE_DEBOUNCE_MS = 500;

export interface PtySessionConfig {
  id: string;
  command: string;
  args: string[];
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
  label: string;
  logDir: string; // e.g., .agent-farm/logs/
  ringBufferLines?: number; // Default: 1000
  diskLogEnabled?: boolean; // Default: true
  diskLogMaxBytes?: number; // Default: 50MB
  reconnectTimeoutMs?: number; // Default: 300_000 (5 min)
}

export interface PtySessionInfo {
  id: string;
  pid: number;
  cols: number;
  rows: number;
  label: string;
  status: 'running' | 'exited';
  createdAt: string;
  exitCode?: number;
  persistent?: boolean;
  /**
   * Whether input can actually reach the process RIGHT NOW (Spec 1273).
   *
   * Serialised alongside `status` because the two disagree in the case that
   * matters: a session whose shellper connection died reports status 'running'
   * until teardown while every write to it is dropped (#1198). `afx reset`
   * preflights on this so it refuses a terminal it cannot write to BEFORE
   * touching anything, rather than discovering it on the first send.
   */
  writable?: boolean;
  /**
   * Epoch ms of the last PTY output (Spec 467's tracking, surfaced by Spec 1273).
   *
   * Serialised by `GET /api/terminals/:id`, which makes output quiescence
   * *measurable* by a client: an agent mid-turn emits continuously (spinner
   * frames, streamed tokens), so a stretch with no advance means the turn ended.
   * `afx reset` uses this to avoid typing into a terminal that is still working.
   */
  lastDataAt: number;
}

/**
 * #1198: how long an unexpected shellper disconnect may remain unresolved
 * before the session is torn down. Sized above SessionManager's full
 * in-place-reconnect budget (3 rounds of backoff plus connect time) so a
 * successful recovery always lands before the teardown fires.
 */
export const SHELLPER_CLOSE_GRACE_MS = 15_000;

/**
 * Bound on {@link PtySession.replaySnapshot}'s flush-until-quiescent loop. Each retry
 * means output arrived during the previous parser flush; three consecutive busy flushes
 * (each typically <100ms even for MB-scale backlogs) indicate a pathologically streaming
 * session, for which the raw-tail fallback (whose correctness the client nudge already
 * recovers) is the right answer rather than an unbounded wait (PIR #1354).
 */
export const REPLAY_FLUSH_ATTEMPTS = 3;

/**
 * Outcome of {@link PtySession.replaySnapshot} (PIR #1354). On `ok`, `data` is the
 * serialized O(screen) replay payload and `token` is the `bytesWritten` value the
 * snapshot is provably current to — the caller re-checks it (and attaches the client)
 * with NO intervening await, so no output byte can fall between snapshot and live
 * stream. On failure, `reason` feeds the attach path's fallback log line.
 */
export type ReplaySnapshotResult =
  | { ok: true; data: string; token: number }
  | { ok: false; reason: 'no-mirror' | 'flush-timeout' | 'serialize-error' | 'empty-snapshot'; error?: unknown };

export class PtySession extends EventEmitter {
  readonly id: string;
  label: string;
  readonly createdAt: string;
  readonly ringBuffer: RingBuffer;
  // Spec 1313 (render-gate round 2): the persistent bounded gate mirror, fed the same
  // output bytes as the ring buffer from this session's birth. The render gate reads its
  // current viewport to decide "is the composer a clean empty prompt?" — replacing the old
  // whole-ring re-render that #1205's partial cap could hand a torn frame. Lazily created on
  // the first output byte (see feedGateScreen); null until then and after teardown.
  private _gateScreen: SessionScreen | null = null;

  private pty: IPty | null = null;
  private shellperClient: IShellperClient | null = null;
  private _shellperBacked = false;
  private _shellperSessionId: string | null = null;
  private _restartOnExit = false;
  private _restartCleanupTimeout: ReturnType<typeof setTimeout> | null = null;
  private _restartCancelFn: (() => void) | null = null;
  // #1198: pending teardown after an unexpected shellper disconnect. Started
  // by the client 'close' handler, cancelled by attachShellper() when
  // SessionManager's in-place reconnect delivers a replacement client.
  private _closeGraceTimer: ReturnType<typeof setTimeout> | null = null;
  private shellperPid = -1;
  private cols: number;
  private rows: number;
  private exitCode: number | undefined;
  private logFd: number | null = null;
  private logBytes: number = 0;
  private logPath: string;
  private readonly diskLogEnabled: boolean;
  private readonly diskLogMaxBytes: number;
  private readonly reconnectTimeoutMs: number;
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // Spec 1313 Phase 5: self-rescheduling output-quiescence trigger (see armQuiescence).
  private _quiescenceTimer: ReturnType<typeof setTimeout> | null = null;
  private clients: Set<{ send: (data: Buffer | string) => void }> = new Set();
  private _lastInputAt = 0;
  private _lastDataAt = Date.now();
  private _composing = false;

  constructor(private readonly config: PtySessionConfig) {
    super();
    this.id = config.id;
    this.label = config.label;
    this.cols = config.cols;
    this.rows = config.rows;
    this.createdAt = new Date().toISOString();
    this.ringBuffer = new RingBuffer(config.ringBufferLines ?? 1000);
    this.diskLogEnabled = config.diskLogEnabled ?? true;
    this.diskLogMaxBytes = config.diskLogMaxBytes ?? 50 * 1024 * 1024; // DEFAULT_DISK_LOG_MAX_BYTES
    this.reconnectTimeoutMs = config.reconnectTimeoutMs ?? 300_000;
    this.logPath = path.join(config.logDir, `${config.id}.log`);
  }

  /** Spawn the PTY process. Must be called after construction. */
  async spawn(): Promise<void> {
    // Dynamic import to avoid hard dependency at module level
    const nodePty = await import('node-pty');

    // Ensure log directory exists
    if (this.diskLogEnabled) {
      fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
      this.logFd = fs.openSync(this.logPath, 'a');
    }

    this.pty = nodePty.spawn(this.config.command, this.config.args, {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: this.config.cwd,
      env: this.config.env,
    });

    this.pty.onData((data: string) => {
      this.onPtyData(data);
    });

    this.pty.onExit(({ exitCode, signal }) => {
      this.exitCode = exitCode;
      this.emit('exit', exitCode, signal);
      this.cleanup();
    });
  }

  /**
   * Attach a shellper client as the I/O backend instead of node-pty.
   * Data flows: shellper → ring buffer → WebSocket clients.
   * User input flows: WebSocket → write() → shellper.
   *
   * `mirrorSeed` (PIR #1354): the UNCAPPED replay for the screen mirror, when the
   * caller capped `replayData` for the ring (`capRingSeed`). The two seeds diverge
   * deliberately — ring contents are shipped raw to clients only on the fallback
   * path, so the 1 MiB client-payload cap stays; the mirror folds its seed into a
   * fixed-size grid, so feeding it the full (wire-capped, ≤8 MB) history costs
   * bounded parse time and shrinks the #1361 born-torn window from 1 MiB to the
   * shellper's whole retention. Omitted → the mirror gets `replayData`, i.e. the
   * pre-#1354 behavior (fresh spawns, whose replay is never capped).
   */
  attachShellper(client: IShellperClient, replayData: Buffer, shellperPid: number, shellperSessionId?: string, mirrorSeed?: Buffer): void {
    // Idempotent re-attach (Issue #1047 Fix E): if a previous client is still
    // attached, drop our listeners on it before subscribing to the new one so
    // a re-attach can't double the per-byte data fan-out (each leaked 'data'
    // listener would re-run onPtyData for every PTY byte).
    if (this.shellperClient && this.shellperClient !== client) {
      this.shellperClient.removeAllListeners('data');
      this.shellperClient.removeAllListeners('exit');
      this.shellperClient.removeAllListeners('close');
    }
    // #1198: a replacement client arriving means the connection recovered.
    // Cancel any pending unexpected-close teardown.
    if (this._closeGraceTimer) {
      clearTimeout(this._closeGraceTimer);
      this._closeGraceTimer = null;
    }
    this._shellperBacked = true;
    this.shellperClient = client;
    this.shellperPid = shellperPid;
    this._shellperSessionId = shellperSessionId ?? null;
    // Hydrate Spec 467's lastDataAt from the shellper's own tracker if
    // it has a value (WELCOME-side hydration carries genuine activity
    // history across Tower restart). The data-frame subscription below
    // keeps it bumped going forward via onPtyData.
    this._lastDataAt = client.lastDataAt;

    // Ensure log directory exists. Guarded on logFd: with #1198 re-attach is
    // a routine recovery step, and reopening unconditionally would leak one
    // append handle per reconnect. cleanupShellper() closes and nulls the fd,
    // so a post-teardown attach still reopens.
    if (this.diskLogEnabled && this.logFd === null) {
      fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
      this.logFd = fs.openSync(this.logPath, 'a');
    }

    // Populate the ring buffer and seed the screen mirror so both reflect the session's
    // history from the moment Tower (re)attaches — a mirror seeded only from live output
    // after this point would be born torn (Spec 1313 render-gate round 2). The mirror may
    // receive a LONGER seed than the ring (see `mirrorSeed` above); that superset is safe
    // for the `bytesWritten` token protocol, which only ever compares the token against
    // itself across a flush — every LIVE byte after this point still feeds both in
    // lockstep via onPtyData.
    if (replayData.length > 0) {
      this.ringBuffer.pushData(replayData.toString('utf-8'));
    }
    const screenSeed = mirrorSeed ?? replayData;
    if (screenSeed.length > 0) {
      this.feedGateScreen(screenSeed.toString('utf-8'));
    }

    // Forward shellper data to ring buffer + WebSocket clients
    client.on('data', (buf: Buffer) => {
      this.onPtyData(buf.toString('utf-8'));
    });

    // Handle shellper exit (process inside shellper exited)
    client.on('exit', (exitInfo: { code: number; signal: string | null }) => {
      this.exitCode = exitInfo.code;
      // Issue #1264: a clean exit reruns the harness in this same PTY with a
      // fresh conversation, so it takes the restart path below exactly like a
      // crash does — same wait-for-the-respawn window, same suppressed 'exit'
      // so WebSocket clients and the terminal's identity survive. Only the
      // notice differs, because "restarting" would misdescribe what the user
      // gets back: a new conversation, not the one they just left.
      // (#1241 ended the session here; #1264 reversed that — a session now
      // ends only on an explicit kill.)
      if (this._restartOnExit && isDeliberateExit(exitInfo)) {
        this.startRestartWait(client, exitInfo, '\r\n\x1b[90m[Agent exited — starting a fresh session...]\x1b[0m\r\n');
        return;
      }
      if (this._restartOnExit) {
        // Process will auto-restart via SessionManager — keep WebSocket clients
        // connected and don't emit 'exit' so Tower doesn't clear references.
        this.startRestartWait(client, exitInfo, '\r\n\x1b[90m[Process exited — restarting...]\x1b[0m\r\n');
        return;
      }
      this.emit('exit', exitInfo.code, exitInfo.signal);
      // For shellper-backed sessions, cleanup closes disk log and clients
      // but doesn't clear the ring buffer (shellper may still have replay data)
      this.cleanupShellper();
    });

    // Handle shellper disconnect (socket closed without EXIT)
    client.on('close', () => {
      if (this.exitCode !== undefined) return;
      if (this.shellperClient !== client) return;
      if (this._closeGraceTimer) return;
      // #1198: SessionManager attempts an in-place reconnect first, so give
      // it a grace window instead of tearing down immediately. A successful
      // re-attach cancels the timer; expiry means the connection is truly
      // gone and the historical teardown proceeds.
      this._closeGraceTimer = setTimeout(() => {
        this._closeGraceTimer = null;
        if (this.exitCode !== undefined) return;
        this.exitCode = -1;
        this.emit('exit', -1);
        this.cleanupShellper();
      }, SHELLPER_CLOSE_GRACE_MS);
    });
  }

  /**
   * Hold the session open while SessionManager respawns the child, printing
   * `notice` in its place.
   *
   * Shared by both relaunch paths (#1264): an unnatural exit restarting with
   * recovery, and a clean exit rerunning the harness fresh. They differ only in
   * wording — structurally both keep WebSocket clients attached, suppress
   * 'exit' so Tower doesn't clear its references, and arm a bounded wait. If
   * new data arrives the child is back and the teardown is cancelled; if
   * nothing arrives within the window (e.g. max restarts exhausted) the session
   * falls through to normal exit cleanup.
   */
  private startRestartWait(
    client: IShellperClient,
    exitInfo: { code: number; signal: string | null },
    notice: string,
  ): void {
    // Clear any pending restart state from a previous exit (crash loop guard)
    if (this._restartCleanupTimeout) {
      clearTimeout(this._restartCleanupTimeout);
      if (this._restartCancelFn) {
        client.removeListener('data', this._restartCancelFn);
      }
    }
    this.onPtyData(notice);
    this._restartCleanupTimeout = setTimeout(() => {
      client.removeListener('data', cancelCleanup);
      this._restartCleanupTimeout = null;
      this._restartCancelFn = null;
      this.emit('exit', exitInfo.code, exitInfo.signal);
      this.cleanupShellper();
    }, 10_000);
    const cancelCleanup = () => {
      clearTimeout(this._restartCleanupTimeout!);
      client.removeListener('data', cancelCleanup);
      this._restartCleanupTimeout = null;
      this._restartCancelFn = null;
      // Process restarted — reset exitCode so write/resize work again
      this.exitCode = undefined;
    };
    this._restartCancelFn = cancelCleanup;
    client.on('data', cancelCleanup);
  }

  /**
   * Write an out-of-band notice into the terminal, as if the process had
   * printed it. Goes to the ring buffer and every attached client, so it
   * survives reconnects and is visible to whoever is watching.
   *
   * For lifecycle news the process itself cannot report — #1264's give-up
   * being the motivating case, where a broken harness would otherwise leave a
   * silently dead terminal.
   */
  notice(text: string): void {
    this.onPtyData(`\r\n\x1b[33m${text}\x1b[0m\r\n`);
  }

  /** Whether this session is backed by a shellper process. */
  get shellperBacked(): boolean {
    return this._shellperBacked;
  }

  /** The SessionManager session ID for this shellper-backed session, or null. */
  get shellperSessionId(): string | null {
    return this._shellperSessionId;
  }


  /**
   * Whether this session should suppress exit cleanup because the process
   * will auto-restart via SessionManager. When true, the exit handler
   * keeps WebSocket clients connected and does not emit 'exit'.
   */
  get restartOnExit(): boolean {
    return this._restartOnExit;
  }

  set restartOnExit(value: boolean) {
    this._restartOnExit = value;
  }

  /**
   * Detach from shellper client during Tower shutdown.
   * Removes all event listeners so that SessionManager.shutdown() disconnecting
   * the client doesn't cascade into exit events and SQLite row deletion.
   */
  detachShellper(): void {
    if (this.shellperClient) {
      this.shellperClient.removeAllListeners();
      this.shellperClient = null;
    }
    this.cleanupShellper();
  }

  private cleanupShellper(): void {
    if (this.disconnectTimer) {
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = null;
    }
    if (this._closeGraceTimer) {
      clearTimeout(this._closeGraceTimer);
      this._closeGraceTimer = null;
    }
    this.clients.clear();
    // Close disk log handle
    if (this.logFd !== null) {
      try { fs.closeSync(this.logFd); } catch { /* ignore */ }
      this.logFd = null;
    }
    // Release the gate mirror's headless Terminal (Spec 1313). Unlike the ring buffer (kept
    // for shellper replay), the mirror serves only the gate and this is a real teardown, so
    // free it; a later re-attach lazily builds a fresh one from the replay seed.
    this._gateScreen?.dispose();
    this._gateScreen = null;
    // Note: ring buffer is NOT cleared — shellper handles replay
    // Note: shellper client is NOT disconnected — SessionManager owns that lifecycle
  }

  private onPtyData(data: string): void {
    // Track last output activity for idle detection (Spec 467)
    this._lastDataAt = Date.now();

    // Spec 1313 Phase 5: (re)arm the output-quiescence trigger so held mail drains
    // shortly after a streaming agent settles, rather than at the next backstop tick.
    this.armQuiescence();

    // Store in ring buffer + fold into the gate mirror (Spec 1313 render-gate round 2).
    // Both are fed the SAME bytes here (the single live-output chokepoint), keeping the
    // mirror's screen and `ringBuffer.bytesWritten` (the gate's change token) in lockstep.
    this.ringBuffer.pushData(data);
    this.feedGateScreen(data);

    // Write to disk log
    if (this.diskLogEnabled && this.logFd !== null) {
      const buf = Buffer.from(data, 'utf-8');
      if (this.logBytes + buf.length <= this.diskLogMaxBytes) {
        fs.writeSync(this.logFd, buf);
        this.logBytes += buf.length;
      } else {
        this.rotateDiskLog();
        fs.writeSync(this.logFd!, buf);
        this.logBytes = buf.length;
      }
    }

    // Broadcast to all connected WebSocket clients
    for (const client of this.clients) {
      try {
        client.send(data);
      } catch {
        this.clients.delete(client);
      }
    }

    this.emit('data', data);
  }

  /**
   * Fold one output chunk into the persistent gate mirror (Spec 1313 render-gate round 2),
   * creating it lazily on the first byte. Called at EVERY point the mirror is fed —
   * `onPtyData` (live output, in lockstep with the ring) and the `attachShellper` seed — so
   * the mirror's rendered screen and `ringBuffer.bytesWritten` (the gate's monotone change
   * token) can never drift apart on the live path. Creating it on the first byte (not at
   * construction) means a session that never emits output costs nothing, while any session
   * that does is mirrored from its very first LIVE byte. On adopt/reconnect the seed is the
   * FULL shellper replay (≤8 MB wire cap), not the ring's 1 MiB `capRingSeed` tail
   * (PIR #1354) — so a long-lived alt-screen frame is only born torn when its coherent
   * start predates the shellper's whole retention (#1361's residual case); the gate then
   * HOLDS (fail-safe) until the next repaint heals it.
   */
  private feedGateScreen(data: string): void {
    if (!this._gateScreen) this._gateScreen = new SessionScreen(this.cols, this.rows);
    this._gateScreen.feed(data);
  }

  /**
   * Arm (or leave armed) the output-quiescence trigger (Spec 1313 Phase 5). Uses a
   * single self-rescheduling timer keyed on {@link lastDataAt} instead of a
   * clear/reset on every byte, so high-throughput output costs nothing extra: when it
   * fires it either emits `'quiescence'` (output idle long enough) or re-arms for the
   * remaining window. Armed only while a subscriber is present, so idle/unwatched
   * sessions pay nothing. The timer is unref'd — a pending quiescence check never
   * keeps the process alive.
   */
  private armQuiescence(): void {
    if (this._quiescenceTimer) return;
    if (terminalDeliverySignals.listenerCount('quiescence') === 0) return;
    const check = (): void => {
      const idleMs = Date.now() - this._lastDataAt;
      if (idleMs >= QUIESCENCE_DEBOUNCE_MS) {
        this._quiescenceTimer = null;
        terminalDeliverySignals.emit('quiescence', this.id);
      } else {
        this._quiescenceTimer = setTimeout(check, QUIESCENCE_DEBOUNCE_MS - idleMs);
        if (typeof this._quiescenceTimer.unref === 'function') this._quiescenceTimer.unref();
      }
    };
    this._quiescenceTimer = setTimeout(check, QUIESCENCE_DEBOUNCE_MS);
    if (typeof this._quiescenceTimer.unref === 'function') this._quiescenceTimer.unref();
  }

  private rotateDiskLog(): void {
    if (this.logFd !== null) {
      fs.closeSync(this.logFd);
    }
    const rotatedPath = this.logPath + '.1';
    // Remove old rotation if exists
    try { fs.unlinkSync(rotatedPath + '.1'); } catch { /* ignore */ }
    try { fs.renameSync(rotatedPath, rotatedPath + '.1'); } catch { /* ignore */ }
    try { fs.renameSync(this.logPath, rotatedPath); } catch { /* ignore */ }
    this.logFd = fs.openSync(this.logPath, 'a');
    this.logBytes = 0;
  }

  /**
   * Whether input can actually reach the underlying process right now.
   * For shellper-backed sessions this checks the live socket connection, not
   * just the session status: a session whose shellper connection died reports
   * status 'running' until teardown, and writes to it are dropped (#1198).
   */
  get writable(): boolean {
    if (this.status !== 'running') return false;
    if (this._shellperBacked) {
      return this.shellperClient !== null && this.shellperClient.connected;
    }
    return this.pty !== null;
  }

  /**
   * Write user input to the PTY or shellper.
   * Returns false when the input was dropped (#1198).
   */
  write(data: string): boolean {
    if (this._shellperBacked) {
      if (this.shellperClient && this.status === 'running') {
        return this.shellperClient.write(data);
      }
      return false;
    }
    if (this.pty && this.status === 'running') {
      this.pty.write(data);
      return true;
    }
    return false;
  }

  /**
   * Resize the PTY or shellper.
   * Returns false when the resize was dropped (#1198).
   */
  resize(cols: number, rows: number): boolean {
    this.cols = cols;
    this.rows = rows;
    // Keep the gate mirror at the live geometry (Spec 1313) so the classified screen wraps
    // identically to what the user sees; no-op before the mirror's first output / after teardown.
    this._gateScreen?.resize(cols, rows);
    if (this._shellperBacked) {
      if (this.shellperClient && this.status === 'running') {
        return this.shellperClient.resize(cols, rows);
      }
      return false;
    }
    if (this.pty && this.status === 'running') {
      this.pty.resize(cols, rows);
      return true;
    }
    return false;
  }

  /** Kill the PTY process or send signal to shellper. */
  kill(): void {
    if (this._shellperBacked) {
      if (this.shellperClient && this.status === 'running') {
        this.shellperClient.signal(15); // SIGTERM
      }
      this.cleanupShellper();
      return;
    }
    if (this.pty && this.status === 'running') {
      try {
        // Kill process group to prevent orphans
        process.kill(-this.pty.pid, 'SIGTERM');
        setTimeout(() => {
          try { process.kill(-this.pty!.pid, 'SIGKILL'); } catch { /* already dead */ }
        }, 5000);
      } catch {
        // Process already exited
      }
    }
    this.cleanup();
  }

  /**
   * Register a live client for output broadcast without producing any replay.
   * The replay-payload decision (snapshot vs raw lines) belongs to the attach
   * path (PIR #1354); this is the shared registration step every variant uses.
   */
  addClient(client: { send: (data: Buffer | string) => void }): void {
    this.clients.add(client);
    if (this.disconnectTimer) {
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = null;
    }
  }

  /** Attach a WebSocket client. Returns ring buffer contents for replay. */
  attach(client: { send: (data: Buffer | string) => void }): string[] {
    this.addClient(client);
    return this.ringBuffer.getAll();
  }

  /** Attach with resume from a specific sequence number. */
  attachResume(client: { send: (data: Buffer | string) => void }, sinceSeq: number): string[] {
    this.addClient(client);
    return this.ringBuffer.getSince(sinceSeq);
  }

  /**
   * Which buffer the session's emulated screen is in: 'alternate' means a
   * full-screen TUI, the case whose reconnect is unservable from the line ring
   * (a caught-up client's delta resume returns [] — `ring-buffer.ts` getSince)
   * and so must be served the snapshot. Null before the first output byte and
   * after teardown.
   */
  get screenBufferType(): 'normal' | 'alternate' | null {
    if (!this._gateScreen) return null;
    return this._gateScreen.bufferType;
  }

  /**
   * Produce the O(screen) viewer-attach replay payload from the session's mirror
   * (PIR #1354): the serialized current screen plus bounded scrollback, replacing
   * the raw ring-tail replay whose truncation the client-side resize nudge papered
   * over. Does NOT attach the client — the caller must, and the split is what makes
   * the byte partition airtight:
   *
   * The flush loop samples `ringBuffer.bytesWritten` (the same monotone token the
   * render gate uses), flushes the mirror's parser, and re-checks; an unchanged token
   * proves every byte ever fed is parsed into the grid. Serialization then happens
   * synchronously, and the caller's continuation (token re-check + `addClient` +
   * replay send) runs in a microtask — PTY output only arrives via I/O macrotasks, so
   * nothing can interleave before the client is attached. Every output byte is
   * therefore either in the snapshot or broadcast live to the attached client:
   * no gap, no duplication.
   *
   * Failure never degrades availability: callers fall back to the raw-ring replay
   * (today's behavior, nudge-recovered), logging the `reason`.
   */
  async replaySnapshot(): Promise<ReplaySnapshotResult> {
    const screen = this._gateScreen;
    if (!screen) {
      // Lazily created on the first output byte, so no mirror simply means a
      // session that has never produced output (or was torn down) — benign.
      return { ok: false, reason: 'no-mirror' };
    }
    for (let attempt = 0; attempt < REPLAY_FLUSH_ATTEMPTS; attempt++) {
      const token = this.ringBuffer.bytesWritten;
      await screen.read();
      if (this._gateScreen !== screen) {
        // Torn down mid-flush; the freed term has no coherent frame.
        return { ok: false, reason: 'no-mirror' };
      }
      if (this.ringBuffer.bytesWritten !== token) continue;
      let data: string;
      try {
        data = screen.serialize();
      } catch (error) {
        return { ok: false, reason: 'serialize-error', error };
      }
      if (!data) {
        // A live mirror exists only for sessions that produced output, so an
        // empty serialization is the desync canary, not an idle session.
        return { ok: false, reason: 'empty-snapshot' };
      }
      return { ok: true, data, token };
    }
    return { ok: false, reason: 'flush-timeout' };
  }

  /** Detach a WebSocket client. Starts disconnect timer if no clients remain (non-shellper only). */
  detach(client: { send: (data: Buffer | string) => void }): void {
    this.clients.delete(client);
    // Shellper-backed sessions don't need a disconnect timer — the shellper
    // keeps the process alive independently of WebSocket connections.
    if (this._shellperBacked) return;
    if (this.clients.size === 0 && this.status === 'running') {
      this.disconnectTimer = setTimeout(() => {
        this.emit('timeout');
        this.kill();
      }, this.reconnectTimeoutMs);
    }
  }

  /** Working directory of the PTY session. */
  get cwd(): string {
    return this.config.cwd;
  }

  /**
   * Launch command of this session's process (Spec 1313 — render-gate identity seam).
   *
   * `command` and `args` live in the private `config`; the render-gate's
   * `resolveProfile` needs an authoritative source to map a session to its
   * classifier profile (claude/codex/unknown). Exposed as read-only getters so
   * the gate never guesses app identity from the label alone.
   */
  get command(): string {
    return this.config.command;
  }

  /** Launch arguments of this session's process (Spec 1313 — paired with `command`). */
  get launchArgs(): string[] {
    return this.config.args;
  }

  get status(): 'running' | 'exited' {
    return this.exitCode === undefined ? 'running' : 'exited';
  }

  get pid(): number {
    if (this._shellperBacked) return this.shellperPid;
    return this.pty?.pid ?? -1;
  }

  get info(): PtySessionInfo {
    return {
      id: this.id,
      pid: this.pid,
      cols: this.cols,
      rows: this.rows,
      label: this.label,
      status: this.status,
      createdAt: this.createdAt,
      exitCode: this.exitCode,
      persistent: this._shellperBacked,
      lastDataAt: this._lastDataAt,
      writable: this.writable,
    };
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /** Bytes held in the ring buffer's incomplete-line partial (observability, #1047). */
  get partialBytes(): number {
    return this.ringBuffer.partialBytes;
  }

  /**
   * The persistent gate mirror (Spec 1313 render-gate round 2), or null before this session's
   * first output byte (and after teardown). The mailbox delivery gate reads its CURRENT
   * viewport to classify the composer, instead of re-rendering the (capped, tear-prone) ring.
   * A null mirror means the session has produced no output yet → not a verified-empty prompt →
   * the gate holds, exactly as an empty replay always did.
   */
  get gateScreen(): SessionScreen | null {
    return this._gateScreen;
  }

  /**
   * Cumulative output bytes ever fed to this session (Spec 1313 render-gate round 2) — the
   * gate's MONOTONE change token. Sourced from the ring buffer's `bytesWritten`, which the
   * mirror is fed in lockstep with, so an unchanged value proves the mirror's screen has not
   * moved. Monotone (never falls on a partial trim), unlike the retired `partialBytes` token.
   */
  get bytesWritten(): number {
    return this.ringBuffer.bytesWritten;
  }

  /** Record that a user sent input to this session. */
  recordUserInput(): void {
    this._lastInputAt = Date.now();
  }

  /**
   * Handle one chunk of user keyboard input from a live terminal client: record it for
   * typing-awareness (Spec 403), track composing/submit state (Bugfix #450 — Enter
   * submits any draft), then write it to the PTY. This is the single chokepoint every
   * live terminal input path routes through — the Tower WS handler and the standalone
   * pty-manager server — so submit detection (and thus the Spec 1313 Phase 5 `'submit'`
   * fast-delivery trigger emitted by {@link stopComposing}) can never diverge between
   * clients. Automated mailbox delivery calls {@link write} directly and so, correctly,
   * never trips a submit signal.
   */
  handleUserInput(data: string): void {
    this.recordUserInput();
    if (data.includes('\r') || data.includes('\n')) {
      this.stopComposing();
    } else {
      this.startComposing();
    }
    this.write(data);
  }

  /** Whether the user has been idle (no input) for at least thresholdMs. */
  isUserIdle(thresholdMs: number): boolean {
    return Date.now() - this._lastInputAt >= thresholdMs;
  }

  /** Timestamp (epoch ms) of the last user input, or 0 if none. */
  get lastInputAt(): number {
    return this._lastInputAt;
  }

  /** Timestamp (epoch ms) of the last PTY output data. Initialized to creation time. */
  get lastDataAt(): number {
    return this._lastDataAt;
  }

  /** Mark the user as composing input (has typed but not pressed Enter). */
  startComposing(): void {
    this._composing = true;
  }

  /** Mark the user as done composing (pressed Enter to submit). */
  stopComposing(): void {
    this._composing = false;
    // Spec 1313 Phase 5: the submit may have cleared a draft, exposing a clean
    // prompt — announce it so held mail can drain now, not at the next backstop tick.
    terminalDeliverySignals.emit('submit', this.id);
  }

  /** Whether the user is currently composing input (typed but not yet submitted). */
  get composing(): boolean {
    return this._composing;
  }

  private cleanup(): void {
    if (this.disconnectTimer) {
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = null;
    }
    if (this._quiescenceTimer) {
      clearTimeout(this._quiescenceTimer);
      this._quiescenceTimer = null;
    }
    // Release all WebSocket clients
    this.clients.clear();
    // Release ring buffer memory
    this.ringBuffer.clear();
    // Release the gate mirror's headless Terminal (Spec 1313).
    this._gateScreen?.dispose();
    this._gateScreen = null;
    // Close disk log handle
    if (this.logFd !== null) {
      try { fs.closeSync(this.logFd); } catch { /* ignore */ }
      this.logFd = null;
    }
  }
}
