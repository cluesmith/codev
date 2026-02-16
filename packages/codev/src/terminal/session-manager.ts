/**
 * SessionManager: orchestrates shellper process lifecycle.
 *
 * Responsibilities:
 * - Spawn shellper processes as detached children
 * - Connect ShellperClient to each shellper
 * - Kill sessions (SIGTERM → wait → SIGKILL)
 * - Detect and clean up stale sockets
 * - Auto-restart on exit (configurable per session)
 * - Reconnect to existing shellpers after Tower restart
 *
 * Process start time validation prevents PID reuse reconnection.
 */

import { spawn as cpSpawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { defaultSessionOptions } from './index.js';
import type { Readable } from 'node:stream';
import { ShellperClient, type IShellperClient } from './shellper-client.js';

export interface SessionManagerConfig {
  socketDir: string;
  shellperScript: string;
  nodeExecutable: string;
  logger?: (message: string) => void;
}

export interface CreateSessionOptions {
  sessionId: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  restartOnExit?: boolean;
  restartDelay?: number;
  maxRestarts?: number;
  restartResetAfter?: number;
}

export interface ReconnectRestartOptions {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  restartDelay?: number;
  maxRestarts?: number;
  restartResetAfter?: number;
}

/**
 * Ring buffer for stderr lines. Retains the last `maxLines` lines,
 * each truncated at `maxLineLength` chars. Non-UTF-8 bytes (decoded as
 * U+FFFD by Node) are replaced with '?'.
 */
export class StderrBuffer {
  private lines: string[] = [];
  private partial = '';
  readonly maxLines: number;
  readonly maxLineLength: number;

  constructor(maxLines = 500, maxLineLength = 10000) {
    this.maxLines = maxLines;
    this.maxLineLength = maxLineLength;
  }

  /** Push a chunk of UTF-8 text, splitting on newlines. */
  push(chunk: string): void {
    // Replace U+FFFD (invalid UTF-8 replacement char) with '?'
    const cleaned = chunk.replace(/\uFFFD/g, '?');
    const parts = (this.partial + cleaned).split('\n');
    // Last element is the incomplete line (or '' if chunk ends with \n)
    this.partial = parts.pop()!;
    for (const line of parts) {
      const truncated = line.length > this.maxLineLength ? line.slice(0, this.maxLineLength) : line;
      this.lines.push(truncated);
      if (this.lines.length > this.maxLines) {
        this.lines.shift();
      }
    }
  }

  /** Flush the partial line (if any) into the buffer. */
  flush(): void {
    if (this.partial) {
      const truncated = this.partial.length > this.maxLineLength
        ? this.partial.slice(0, this.maxLineLength)
        : this.partial;
      this.lines.push(truncated);
      if (this.lines.length > this.maxLines) {
        this.lines.shift();
      }
      this.partial = '';
    }
  }

  /** Get all buffered lines. */
  getLines(): string[] {
    return [...this.lines];
  }

  /** Whether the buffer has any content (including partial). */
  hasContent(): boolean {
    return this.lines.length > 0 || this.partial.length > 0;
  }
}

interface ManagedSession {
  client: IShellperClient;
  socketPath: string;
  pid: number;
  startTime: number;
  options: CreateSessionOptions;
  restartCount: number;
  restartResetTimer: ReturnType<typeof setTimeout> | null;
  stderrBuffer: StderrBuffer | null;
  stderrStream: Readable | null;
  stderrTailLogged: boolean;
}

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, ManagedSession>();
  private readonly log: (msg: string) => void;

  constructor(private readonly config: SessionManagerConfig) {
    super();
    this.log = config.logger ?? (() => {});
  }

  /**
   * Spawn a new shellper process and connect to it.
   * Returns the connected client.
   */
  async createSession(opts: CreateSessionOptions): Promise<IShellperClient> {
    const socketPath = this.getSocketPath(opts.sessionId);
    this.log(`Creating session ${opts.sessionId}: command=${opts.command}, socket=${socketPath}`);

    // Ensure socket directory exists with 0700 permissions
    fs.mkdirSync(this.config.socketDir, { recursive: true, mode: 0o700 });

    // Clean up any stale socket file
    this.unlinkSocketIfExists(socketPath);

    // Build config for shellper-main.js
    const shellperConfig = JSON.stringify({
      command: opts.command,
      args: opts.args,
      cwd: opts.cwd,
      env: opts.env,
      cols: opts.cols,
      rows: opts.rows,
      socketPath,
    });

    // Redirect shellper stderr to a log file instead of a pipe.
    // Using 'pipe' for stderr creates a parent→child pipe dependency: when Tower
    // exits, the pipe breaks, and the async EPIPE error on process.stderr crashes
    // the shellper (Bugfix #324). A file FD has no such dependency.
    const stderrLogPath = socketPath.replace('.sock', '.log');
    let stderrFd: number | null = null;
    try {
      stderrFd = fs.openSync(stderrLogPath, 'a');
    } catch {
      // Fall back to /dev/null if log file can't be opened
    }

    const child = cpSpawn(this.config.nodeExecutable, [this.config.shellperScript, shellperConfig], {
      detached: true,
      stdio: ['ignore', 'pipe', stderrFd ?? 'ignore'],
    });

    // Close our copy of the stderr log FD — child has its own after fork
    if (stderrFd !== null) {
      try { fs.closeSync(stderrFd); } catch { /* ignore */ }
    }

    // Read PID + startTime from stdout
    let info: { pid: number; startTime: number };
    try {
      info = await this.readShellperInfo(child);
    } catch (err) {
      this.log(`Session ${opts.sessionId} creation failed: ${(err as Error).message}`);
      // Kill orphaned child process using handle (not PID — may not be available yet)
      try { child.kill('SIGKILL'); } catch { /* already dead or no permission */ }
      this.unlinkSocketIfExists(socketPath);
      throw err;
    }
    child.unref();

    // Post-spawn setup with rollback: if anything fails after the shellper
    // is spawned, kill the orphaned process and clean up the socket.
    let client: ShellperClient;
    try {
      // Wait briefly for socket to be ready
      await this.waitForSocket(socketPath);

      // Connect client
      client = new ShellperClient(socketPath);
      await client.connect();
    } catch (err) {
      // Rollback: kill the orphaned shellper process
      this.log(`Session ${opts.sessionId} creation failed: ${(err as Error).message}`);
      try { process.kill(info.pid, 'SIGKILL'); } catch { /* already dead */ }
      this.unlinkSocketIfExists(socketPath);
      throw err;
    }

    const session: ManagedSession = {
      client,
      socketPath,
      pid: info.pid,
      startTime: info.startTime,
      options: opts,
      restartCount: 0,
      restartResetTimer: null,
      stderrBuffer: null, // stderr goes to file, not pipe (Bugfix #324)
      stderrStream: null,
      stderrTailLogged: false,
    };

    this.sessions.set(opts.sessionId, session);
    this.log(`Session ${opts.sessionId} created: pid=${info.pid}`);

    // Set up auto-restart if configured
    if (opts.restartOnExit) {
      this.setupAutoRestart(session, opts.sessionId);
    }

    // Forward exit events and clean up dead sessions
    client.on('exit', (exitInfo) => {
      this.log(`Session ${opts.sessionId} exited (code=${exitInfo.code})`);
      this.logStderrTail(opts.sessionId, session, exitInfo.code);
      this.emit('session-exit', opts.sessionId, exitInfo);
      // If not auto-restarting, remove the dead session from the map
      // so listSessions() doesn't report it and cleanupStaleSockets()
      // can clean its socket file.
      if (!opts.restartOnExit) {
        this.removeDeadSession(opts.sessionId);
      }
    });

    client.on('error', (err) => {
      this.emit('session-error', opts.sessionId, err);
    });

    // Handle shellper crash (socket disconnects without EXIT frame)
    client.on('close', () => {
      // If the session is still in the map (wasn't already cleaned up by exit/kill),
      // the shellper died without sending EXIT. Remove the dead session.
      if (this.sessions.has(opts.sessionId)) {
        this.log(`Session ${opts.sessionId} shellper disconnected unexpectedly`);
        this.logStderrTail(opts.sessionId, session, -1);
        this.removeDeadSession(opts.sessionId);
        this.emit('session-error', opts.sessionId, new Error('Shellper disconnected unexpectedly'));
      }
    });

    // Start restart reset timer if configured
    if (opts.restartOnExit) {
      this.startRestartResetTimer(session);
    }

    return client;
  }

  /**
   * Reconnect to an existing shellper process after Tower restart.
   * Validates PID is alive and start time matches.
   * Returns connected client, or null if shellper is stale/dead.
   */
  async reconnectSession(
    sessionId: string,
    socketPath: string,
    pid: number,
    startTime: number,
    restartOptions?: ReconnectRestartOptions,
  ): Promise<IShellperClient | null> {
    this.log(`Reconnecting session ${sessionId}: pid=${pid}, socket=${socketPath}`);

    // Check if process is alive
    if (!this.isProcessAlive(pid)) {
      this.log(`Session ${sessionId} reconnect failed: process ${pid} is dead`);
      return null;
    }

    // Validate process start time to prevent PID reuse
    const actualStartTime = await getProcessStartTime(pid);
    if (actualStartTime === null || Math.abs(actualStartTime - startTime) > 2000) {
      // Start time mismatch or couldn't determine — PID was reused
      this.log(`Session ${sessionId} reconnect failed: PID ${pid} reused (start time mismatch)`);
      return null;
    }

    // Check socket file exists
    try {
      const stat = fs.lstatSync(socketPath);
      if (!stat.isSocket()) {
        this.log(`Session ${sessionId} reconnect failed: socket not a socket file`);
        return null;
      }
    } catch {
      this.log(`Session ${sessionId} reconnect failed: socket missing or lstat error`);
      return null;
    }

    // Connect client
    const client = new ShellperClient(socketPath);
    try {
      await client.connect();
    } catch (err) {
      this.log(`Session ${sessionId} reconnect failed: connect error: ${(err as Error).message}`);
      return null;
    }

    const hasRestart = !!restartOptions;
    const session: ManagedSession = {
      client,
      socketPath,
      pid,
      startTime,
      options: {
        sessionId,
        command: restartOptions?.command ?? '',
        args: restartOptions?.args ?? [],
        cwd: restartOptions?.cwd ?? '',
        env: restartOptions?.env ?? {},
        ...defaultSessionOptions({
          restartOnExit: hasRestart,
          restartDelay: restartOptions?.restartDelay,
          maxRestarts: restartOptions?.maxRestarts,
          restartResetAfter: restartOptions?.restartResetAfter,
        }),
      },
      restartCount: 0,
      restartResetTimer: null,
      stderrBuffer: null,
      stderrStream: null,
      stderrTailLogged: false,
    };

    this.sessions.set(sessionId, session);
    this.log(`Session ${sessionId} reconnected: pid=${pid}`);

    // Set up auto-restart if configured (e.g. architect sessions after Tower restart)
    if (hasRestart) {
      this.setupAutoRestart(session, sessionId);
    }

    client.on('exit', (exitInfo) => {
      this.emit('session-exit', sessionId, exitInfo);
      if (!hasRestart) {
        this.removeDeadSession(sessionId);
      }
    });

    client.on('error', (err) => {
      this.emit('session-error', sessionId, err);
    });

    // Handle shellper crash (socket disconnects without EXIT frame)
    client.on('close', () => {
      if (this.sessions.has(sessionId)) {
        this.log(`Session ${sessionId} shellper disconnected unexpectedly`);
        this.removeDeadSession(sessionId);
        this.emit('session-error', sessionId, new Error('Shellper disconnected unexpectedly'));
      }
    });

    // Start restart reset timer if auto-restart is enabled
    if (hasRestart) {
      this.startRestartResetTimer(session);
    }

    return client;
  }

  /**
   * Kill a session: SIGTERM, wait 5s, SIGKILL if needed.
   * Cleans up socket file and removes from session map.
   */
  async killSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    this.log(`Killing session ${sessionId}: pid=${session.pid}`);

    // Clear restart timer
    if (session.restartResetTimer) {
      clearTimeout(session.restartResetTimer);
      session.restartResetTimer = null;
    }

    // Disable auto-restart by removing the session from the map before killing
    this.sessions.delete(sessionId);

    // Send SIGTERM
    try {
      process.kill(session.pid, 'SIGTERM');
    } catch {
      // Process already dead
    }

    // Wait up to 5s for process to die
    const died = await this.waitForProcessExit(session.pid, 5000);

    if (!died) {
      // Force kill
      try {
        process.kill(session.pid, 'SIGKILL');
      } catch {
        // Already dead
      }
    }

    // Log exit and stderr tail if available
    this.log(`Session ${sessionId} exited (code=-1)`);
    this.logStderrTail(sessionId, session, -1);

    // Disconnect client
    session.client.disconnect();

    // Clean up socket file
    this.unlinkSocketIfExists(session.socketPath);
  }

  /**
   * List all active sessions.
   */
  listSessions(): Map<string, IShellperClient> {
    const result = new Map<string, IShellperClient>();
    for (const [id, session] of this.sessions) {
      result.set(id, session.client);
    }
    return result;
  }

  /**
   * Get session metadata (pid, startTime, socketPath) for a session.
   */
  getSessionInfo(sessionId: string): { pid: number; startTime: number; socketPath: string } | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    return {
      pid: session.pid,
      startTime: session.startTime,
      socketPath: session.socketPath,
    };
  }

  /**
   * Scan socket directory for stale sockets (no live process).
   * A socket is stale if nothing is listening on it (connection refused).
   * Returns the number of sockets cleaned up.
   */
  async cleanupStaleSockets(): Promise<number> {
    let cleaned = 0;
    let files: string[];
    try {
      files = fs.readdirSync(this.config.socketDir);
    } catch {
      return 0;
    }

    for (const file of files) {
      if (!file.startsWith('shellper-') || !file.endsWith('.sock')) continue;

      const fullPath = path.join(this.config.socketDir, file);

      // Safety: reject symlinks
      try {
        const stat = fs.lstatSync(fullPath);
        if (stat.isSymbolicLink()) continue;
        if (!stat.isSocket()) continue;
      } catch {
        continue;
      }

      // Extract session ID from filename: shellper-{sessionId}.sock
      const sessionId = file.replace('shellper-', '').replace('.sock', '');

      // Skip if we have an active session for this
      if (this.sessions.has(sessionId)) continue;

      // Probe the socket: try connecting to see if a shellper is alive.
      // If connection is refused, the socket is stale and safe to delete.
      // If connection succeeds, a shellper is still running — leave it alone.
      const isAlive = await this.probeSocket(fullPath);
      if (isAlive) continue;

      // No live process — it's stale
      try {
        fs.unlinkSync(fullPath);
        cleaned++;
      } catch {
        // Permission error or already gone
      }
      // Also clean up companion stderr log file (Bugfix #324)
      const logPath = fullPath.replace('.sock', '.log');
      try { fs.unlinkSync(logPath); } catch { /* ignore */ }
    }

    if (cleaned > 0) {
      this.log(`Cleaned ${cleaned} stale sockets`);
    }
    return cleaned;
  }

  /**
   * Test if a Unix socket has a listener by attempting a brief connection.
   * Returns true if connection succeeds, false if refused/timed out.
   */
  private probeSocket(socketPath: string): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = net.createConnection(socketPath);
      const timeout = setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, 2000);

      socket.on('connect', () => {
        clearTimeout(timeout);
        socket.destroy();
        resolve(true);
      });

      socket.on('error', () => {
        clearTimeout(timeout);
        socket.destroy();
        resolve(false);
      });
    });
  }

  /**
   * Disconnect from all sessions without killing shellper processes.
   * Per spec: "When Tower intentionally stops, Tower closes its socket
   * connections to shellpers. Shellpers continue running."
   */
  shutdown(): void {
    for (const [id, session] of this.sessions) {
      if (session.restartResetTimer) {
        clearTimeout(session.restartResetTimer);
        session.restartResetTimer = null;
      }
      session.client.disconnect();
    }
    this.sessions.clear();
  }

  // --- Private helpers ---

  /**
   * Remove a dead session from the map, clear its timers, and clean up socket.
   * Called when a session exits naturally (no restart) or exhausts maxRestarts.
   */
  private removeDeadSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.restartResetTimer) {
      clearTimeout(session.restartResetTimer);
      session.restartResetTimer = null;
    }
    this.sessions.delete(sessionId);
    this.unlinkSocketIfExists(session.socketPath);
  }

  private getSocketPath(sessionId: string): string {
    return path.join(this.config.socketDir, `shellper-${sessionId}.sock`);
  }

  private unlinkSocketIfExists(socketPath: string): void {
    try {
      const stat = fs.lstatSync(socketPath);
      if (stat.isSocket()) {
        fs.unlinkSync(socketPath);
      }
    } catch {
      // Doesn't exist — fine
    }
    // Also clean up the companion stderr log file (Bugfix #324)
    const logPath = socketPath.replace('.sock', '.log');
    try {
      fs.unlinkSync(logPath);
    } catch {
      // Doesn't exist — fine
    }
  }

  private readShellperInfo(
    child: ReturnType<typeof cpSpawn>,
  ): Promise<{ pid: number; startTime: number }> {
    return new Promise((resolve, reject) => {
      let data = '';
      const timeout = setTimeout(() => {
        reject(new Error('Timed out reading shellper info from stdout'));
      }, 10_000);

      child.stdout!.on('data', (chunk: Buffer) => {
        data += chunk.toString();
      });

      child.stdout!.on('end', () => {
        clearTimeout(timeout);
        try {
          const info = JSON.parse(data) as { pid: number; startTime: number };
          resolve(info);
        } catch {
          reject(new Error(`Invalid shellper info JSON: ${data}`));
        }
      });

      child.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      child.on('exit', (code) => {
        if (code !== null && code !== 0 && data === '') {
          clearTimeout(timeout);
          reject(new Error(`Shellper exited with code ${code} before writing info`));
        }
      });
    });
  }

  private waitForSocket(socketPath: string, timeout = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        try {
          fs.statSync(socketPath);
          resolve();
        } catch {
          if (Date.now() - start > timeout) {
            reject(new Error(`Socket ${socketPath} not created within ${timeout}ms`));
          } else {
            setTimeout(check, 50);
          }
        }
      };
      check();
    });
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private waitForProcessExit(pid: number, timeout: number): Promise<boolean> {
    return new Promise((resolve) => {
      const start = Date.now();
      const check = () => {
        if (!this.isProcessAlive(pid)) {
          resolve(true);
          return;
        }
        if (Date.now() - start > timeout) {
          resolve(false);
          return;
        }
        setTimeout(check, 100);
      };
      check();
    });
  }

  private setupAutoRestart(session: ManagedSession, sessionId: string): void {
    session.client.on('exit', () => {
      // Check if session was removed (killed intentionally)
      if (!this.sessions.has(sessionId)) return;

      // Cancel the reset timer while the process is down — it should only
      // run while the process is alive, preventing restartResetAfter < restartDelay
      // from resetting the counter during downtime.
      if (session.restartResetTimer) {
        clearTimeout(session.restartResetTimer);
        session.restartResetTimer = null;
      }

      const maxRestarts = session.options.maxRestarts ?? 50;
      if (session.restartCount >= maxRestarts) {
        this.log(`Session ${sessionId} exhausted max restarts (${maxRestarts})`);
        this.emit('session-error', sessionId, new Error(`Max restarts (${maxRestarts}) exceeded`));
        // Remove the exhausted session from the map
        this.removeDeadSession(sessionId);
        return;
      }

      session.restartCount++;
      const delay = session.options.restartDelay ?? 2000;
      this.log(`Session ${sessionId} auto-restart #${session.restartCount}/${maxRestarts} in ${delay}ms`);

      this.emit('session-restart', sessionId, {
        restartCount: session.restartCount,
        delay,
      });

      setTimeout(() => {
        // Re-check session still exists after delay
        if (!this.sessions.has(sessionId)) return;

        session.client.spawn({
          command: session.options.command,
          args: session.options.args,
          cwd: session.options.cwd,
          env: session.options.env,
        });

        // Only restart the reset timer after a successful spawn
        this.startRestartResetTimer(session);
      }, delay);
    });
  }

  private startRestartResetTimer(session: ManagedSession): void {
    if (session.restartResetTimer) {
      clearTimeout(session.restartResetTimer);
    }

    const restartDelay = session.options.restartDelay ?? 2000;
    const resetAfter = session.options.restartResetAfter ?? 300_000; // 5 minutes
    // Enforce minimum: reset window must be at least as long as restartDelay
    // to prevent the counter from resetting while the process is restarting
    const effectiveResetAfter = Math.max(resetAfter, restartDelay);
    session.restartResetTimer = setTimeout(() => {
      session.restartCount = 0;
    }, effectiveResetAfter);
  }

  /**
   * Wire stderr capture on a child process. Sets encoding to UTF-8
   * and pushes decoded chunks into the buffer.
   */
  private wireStderrCapture(stderr: Readable, buffer: StderrBuffer): void {
    stderr.setEncoding('utf8');
    stderr.on('data', (chunk: string) => {
      buffer.push(chunk);
    });
    stderr.on('error', () => {
      // Silently ignore EPIPE and other stderr errors
    });
  }

  /**
   * Log the tail of a session's stderr buffer after exit/crash/kill.
   * Waits up to 1000ms for stderr stream to close (to capture all data),
   * then logs with the session's logger. Deduplicates via stderrTailLogged flag.
   */
  private logStderrTail(sessionId: string, session: ManagedSession, exitCode: number): void {
    if (session.stderrTailLogged) return;
    session.stderrTailLogged = true;
    if (!session.stderrBuffer) return;

    const emitLog = (incomplete: boolean) => {
      session.stderrBuffer!.flush();
      const lines = session.stderrBuffer!.getLines();
      if (lines.length === 0) return;
      const suffix = incomplete ? ' (stderr incomplete)' : '';
      this.log(`Session ${sessionId} last stderr${suffix}:\n  ${lines.join('\n  ')}`);
    };

    // If no stream reference or stream already destroyed/closed, log immediately
    if (!session.stderrStream || session.stderrStream.destroyed) {
      emitLog(false);
      return;
    }

    // Wait up to 1000ms for stderr stream to close
    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) { resolved = true; emitLog(true); }
    }, 1000);
    const check = setInterval(() => {
      if (session.stderrStream!.destroyed && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        clearInterval(check);
        emitLog(false);
      }
    }, 50);
    // Ensure interval is cleaned up after timeout
    setTimeout(() => { clearInterval(check); }, 1100);
  }
}

/**
 * Get the start time of a process by PID.
 * Returns epoch milliseconds, or null if the process doesn't exist or can't be queried.
 *
 * Platform-specific:
 * - macOS: parse `ps -p {pid} -o lstart=`
 * - Linux: read `/proc/{pid}/stat` field 22 (starttime in clock ticks)
 */
export function getProcessStartTime(pid: number): Promise<number | null> {
  return new Promise((resolve) => {
    try {
    if (process.platform === 'darwin') {
      // macOS: use ps to get launch time
      execFile('ps', ['-p', String(pid), '-o', 'lstart='], (err, stdout) => {
        if (err || !stdout.trim()) {
          resolve(null);
          return;
        }
        const date = new Date(stdout.trim());
        if (isNaN(date.getTime())) {
          resolve(null);
          return;
        }
        resolve(date.getTime());
      });
    } else if (process.platform === 'linux') {
      // Linux: read /proc/{pid}/stat and parse starttime (field 22)
      fs.readFile(`/proc/${pid}/stat`, 'utf-8', (err, data) => {
        if (err) {
          resolve(null);
          return;
        }
        // Fields in /proc/PID/stat are space-separated, but field 2 (comm) may
        // contain spaces in parentheses. Find the last ')' to skip past it.
        const closeParenIdx = data.lastIndexOf(')');
        if (closeParenIdx === -1) {
          resolve(null);
          return;
        }
        const fields = data.substring(closeParenIdx + 2).split(' ');
        // Field 22 is starttime, but after stripping comm it's at index 19
        // (fields 3-51, so starttime = field 22 → index 22-3 = 19)
        const startTimeTicks = parseInt(fields[19], 10);
        if (isNaN(startTimeTicks)) {
          resolve(null);
          return;
        }
        // Convert clock ticks to ms: we need the system boot time + starttime
        // This is complex — use a simpler approach via /proc/PID/stat creation time
        fs.stat(`/proc/${pid}`, (statErr, stat) => {
          if (statErr) {
            resolve(null);
            return;
          }
          // /proc/PID directory creation time approximates process start time
          resolve(stat.ctimeMs);
        });
      });
    } else {
      resolve(null);
    }
    } catch {
      // Defensive: if execFile/readFile throws synchronously (e.g., EPERM
      // in restricted environments), return null instead of rejecting.
      resolve(null);
    }
  });
}
