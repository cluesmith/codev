/**
 * Single PTY session: wraps node-pty with ring buffer, disk logging,
 * WebSocket broadcast, and reconnection support.
 */

import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { IPty } from 'node-pty';
import { RingBuffer } from './ring-buffer.js';
import type { IShellperClient } from './shellper-client.js';

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
}

/**
 * #1198: how long an unexpected shellper disconnect may remain unresolved
 * before the session is torn down. Sized above SessionManager's full
 * in-place-reconnect budget (3 rounds of backoff plus connect time) so a
 * successful recovery always lands before the teardown fires.
 */
export const SHELLPER_CLOSE_GRACE_MS = 15_000;

export class PtySession extends EventEmitter {
  readonly id: string;
  label: string;
  readonly createdAt: string;
  readonly ringBuffer: RingBuffer;

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
   */
  attachShellper(client: IShellperClient, replayData: Buffer, shellperPid: number, shellperSessionId?: string): void {
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

    // Populate ring buffer with replay data from shellper
    if (replayData.length > 0) {
      this.ringBuffer.pushData(replayData.toString('utf-8'));
    }

    // Forward shellper data to ring buffer + WebSocket clients
    client.on('data', (buf: Buffer) => {
      this.onPtyData(buf.toString('utf-8'));
    });

    // Handle shellper exit (process inside shellper exited)
    client.on('exit', (exitInfo: { code: number; signal: string | null }) => {
      this.exitCode = exitInfo.code;
      if (this._restartOnExit) {
        // Clear any pending restart state from a previous exit (crash loop guard)
        if (this._restartCleanupTimeout) {
          clearTimeout(this._restartCleanupTimeout);
          if (this._restartCancelFn) {
            client.removeListener('data', this._restartCancelFn);
          }
        }
        // Process will auto-restart via SessionManager — keep WebSocket clients
        // connected and don't emit 'exit' so Tower doesn't clear references.
        this.onPtyData('\r\n\x1b[90m[Process exited — restarting...]\x1b[0m\r\n');
        // Wait for the process to restart. If new data arrives (process restarted),
        // cancel the cleanup timer. If no data within 10s (e.g. max restarts
        // exceeded), fall through to normal exit cleanup.
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
    // Note: ring buffer is NOT cleared — shellper handles replay
    // Note: shellper client is NOT disconnected — SessionManager owns that lifecycle
  }

  private onPtyData(data: string): void {
    // Track last output activity for idle detection (Spec 467)
    this._lastDataAt = Date.now();

    // Store in ring buffer
    this.ringBuffer.pushData(data);

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

  /** Attach a WebSocket client. Returns ring buffer contents for replay. */
  attach(client: { send: (data: Buffer | string) => void }): string[] {
    this.clients.add(client);
    if (this.disconnectTimer) {
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = null;
    }
    return this.ringBuffer.getAll();
  }

  /** Attach with resume from a specific sequence number. */
  attachResume(client: { send: (data: Buffer | string) => void }, sinceSeq: number): string[] {
    this.clients.add(client);
    if (this.disconnectTimer) {
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = null;
    }
    return this.ringBuffer.getSince(sinceSeq);
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
    };
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /** Bytes held in the ring buffer's incomplete-line partial (observability, #1047). */
  get partialBytes(): number {
    return this.ringBuffer.partialBytes;
  }

  /** Record that a user sent input to this session. */
  recordUserInput(): void {
    this._lastInputAt = Date.now();
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
    // Release all WebSocket clients
    this.clients.clear();
    // Release ring buffer memory
    this.ringBuffer.clear();
    // Close disk log handle
    if (this.logFd !== null) {
      try { fs.closeSync(this.logFd); } catch { /* ignore */ }
      this.logFd = null;
    }
  }
}
