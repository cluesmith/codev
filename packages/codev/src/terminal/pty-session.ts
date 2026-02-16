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

export class PtySession extends EventEmitter {
  readonly id: string;
  readonly label: string;
  readonly createdAt: string;
  readonly ringBuffer: RingBuffer;

  private pty: IPty | null = null;
  private shellperClient: IShellperClient | null = null;
  private _shellperBacked = false;
  private _shellperSessionId: string | null = null;
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
    this._shellperBacked = true;
    this.shellperClient = client;
    this.shellperPid = shellperPid;
    this._shellperSessionId = shellperSessionId ?? null;

    // Ensure log directory exists
    if (this.diskLogEnabled) {
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
      this.emit('exit', exitInfo.code, exitInfo.signal);
      // For shellper-backed sessions, cleanup closes disk log and clients
      // but doesn't clear the ring buffer (shellper may still have replay data)
      this.cleanupShellper();
    });

    // Handle shellper disconnect (socket closed without EXIT)
    client.on('close', () => {
      if (this.exitCode === undefined) {
        // Unexpected disconnect — shellper may have crashed
        this.exitCode = -1;
        this.emit('exit', -1);
        this.cleanupShellper();
      }
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

  /** Write user input to the PTY or shellper. */
  write(data: string): void {
    if (this._shellperBacked) {
      if (this.shellperClient && this.status === 'running') {
        this.shellperClient.write(data);
      }
      return;
    }
    if (this.pty && this.status === 'running') {
      this.pty.write(data);
    }
  }

  /** Resize the PTY or shellper. */
  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    if (this._shellperBacked) {
      if (this.shellperClient && this.status === 'running') {
        this.shellperClient.resize(cols, rows);
      }
      return;
    }
    if (this.pty && this.status === 'running') {
      this.pty.resize(cols, rows);
    }
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
