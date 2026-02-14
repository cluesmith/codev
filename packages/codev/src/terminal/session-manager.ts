/**
 * SessionManager: orchestrates shepherd process lifecycle.
 *
 * Responsibilities:
 * - Spawn shepherd processes as detached children
 * - Connect ShepherdClient to each shepherd
 * - Kill sessions (SIGTERM → wait → SIGKILL)
 * - Detect and clean up stale sockets
 * - Auto-restart on exit (configurable per session)
 * - Reconnect to existing shepherds after Tower restart
 *
 * Process start time validation prevents PID reuse reconnection.
 */

import { spawn as cpSpawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { ShepherdClient, type IShepherdClient } from './shepherd-client.js';

export interface SessionManagerConfig {
  socketDir: string;
  shepherdScript: string;
  nodeExecutable: string;
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

interface ManagedSession {
  client: IShepherdClient;
  socketPath: string;
  pid: number;
  startTime: number;
  options: CreateSessionOptions;
  restartCount: number;
  restartResetTimer: ReturnType<typeof setTimeout> | null;
}

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, ManagedSession>();

  constructor(private readonly config: SessionManagerConfig) {
    super();
  }

  /**
   * Spawn a new shepherd process and connect to it.
   * Returns the connected client.
   */
  async createSession(opts: CreateSessionOptions): Promise<IShepherdClient> {
    const socketPath = this.getSocketPath(opts.sessionId);

    // Ensure socket directory exists with 0700 permissions
    fs.mkdirSync(this.config.socketDir, { recursive: true, mode: 0o700 });

    // Clean up any stale socket file
    this.unlinkSocketIfExists(socketPath);

    // Build config for shepherd-main.js
    const shepherdConfig = JSON.stringify({
      command: opts.command,
      args: opts.args,
      cwd: opts.cwd,
      env: opts.env,
      cols: opts.cols,
      rows: opts.rows,
      socketPath,
    });

    // Spawn shepherd as detached process
    const child = cpSpawn(this.config.nodeExecutable, [this.config.shepherdScript, shepherdConfig], {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    // Read PID + startTime from stdout
    const info = await this.readShepherdInfo(child);
    child.unref();

    // Post-spawn setup with rollback: if anything fails after the shepherd
    // is spawned, kill the orphaned process and clean up the socket.
    let client: ShepherdClient;
    try {
      // Wait briefly for socket to be ready
      await this.waitForSocket(socketPath);

      // Connect client
      client = new ShepherdClient(socketPath);
      await client.connect();
    } catch (err) {
      // Rollback: kill the orphaned shepherd process
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
    };

    this.sessions.set(opts.sessionId, session);

    // Set up auto-restart if configured
    if (opts.restartOnExit) {
      this.setupAutoRestart(session, opts.sessionId);
    }

    // Forward exit events and clean up dead sessions
    client.on('exit', (exitInfo) => {
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

    // Handle shepherd crash (socket disconnects without EXIT frame)
    client.on('close', () => {
      // If the session is still in the map (wasn't already cleaned up by exit/kill),
      // the shepherd died without sending EXIT. Remove the dead session.
      if (this.sessions.has(opts.sessionId)) {
        this.removeDeadSession(opts.sessionId);
        this.emit('session-error', opts.sessionId, new Error('Shepherd disconnected unexpectedly'));
      }
    });

    // Start restart reset timer if configured
    if (opts.restartOnExit) {
      this.startRestartResetTimer(session);
    }

    return client;
  }

  /**
   * Reconnect to an existing shepherd process after Tower restart.
   * Validates PID is alive and start time matches.
   * Returns connected client, or null if shepherd is stale/dead.
   */
  async reconnectSession(
    sessionId: string,
    socketPath: string,
    pid: number,
    startTime: number,
  ): Promise<IShepherdClient | null> {
    // Check if process is alive
    if (!this.isProcessAlive(pid)) {
      return null;
    }

    // Validate process start time to prevent PID reuse
    const actualStartTime = await getProcessStartTime(pid);
    if (actualStartTime === null || Math.abs(actualStartTime - startTime) > 2000) {
      // Start time mismatch or couldn't determine — PID was reused
      return null;
    }

    // Check socket file exists
    try {
      const stat = fs.lstatSync(socketPath);
      if (!stat.isSocket()) {
        return null;
      }
    } catch {
      return null;
    }

    // Connect client
    const client = new ShepherdClient(socketPath);
    try {
      await client.connect();
    } catch {
      return null;
    }

    const session: ManagedSession = {
      client,
      socketPath,
      pid,
      startTime,
      options: {
        sessionId,
        command: '',
        args: [],
        cwd: '',
        env: {},
        cols: 80,
        rows: 24,
      },
      restartCount: 0,
      restartResetTimer: null,
    };

    this.sessions.set(sessionId, session);

    client.on('exit', (exitInfo) => {
      this.emit('session-exit', sessionId, exitInfo);
      // Reconnected sessions don't have auto-restart (no original options),
      // so always clean up on exit.
      this.removeDeadSession(sessionId);
    });

    client.on('error', (err) => {
      this.emit('session-error', sessionId, err);
    });

    // Handle shepherd crash (socket disconnects without EXIT frame)
    client.on('close', () => {
      if (this.sessions.has(sessionId)) {
        this.removeDeadSession(sessionId);
        this.emit('session-error', sessionId, new Error('Shepherd disconnected unexpectedly'));
      }
    });

    return client;
  }

  /**
   * Kill a session: SIGTERM, wait 5s, SIGKILL if needed.
   * Cleans up socket file and removes from session map.
   */
  async killSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

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

    // Disconnect client
    session.client.disconnect();

    // Clean up socket file
    this.unlinkSocketIfExists(session.socketPath);
  }

  /**
   * List all active sessions.
   */
  listSessions(): Map<string, IShepherdClient> {
    const result = new Map<string, IShepherdClient>();
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
      if (!file.startsWith('shepherd-') || !file.endsWith('.sock')) continue;

      const fullPath = path.join(this.config.socketDir, file);

      // Safety: reject symlinks
      try {
        const stat = fs.lstatSync(fullPath);
        if (stat.isSymbolicLink()) continue;
        if (!stat.isSocket()) continue;
      } catch {
        continue;
      }

      // Extract session ID from filename: shepherd-{sessionId}.sock
      const sessionId = file.replace('shepherd-', '').replace('.sock', '');

      // Skip if we have an active session for this
      if (this.sessions.has(sessionId)) continue;

      // Probe the socket: try connecting to see if a shepherd is alive.
      // If connection is refused, the socket is stale and safe to delete.
      // If connection succeeds, a shepherd is still running — leave it alone.
      const isAlive = await this.probeSocket(fullPath);
      if (isAlive) continue;

      // No live process — it's stale
      try {
        fs.unlinkSync(fullPath);
        cleaned++;
      } catch {
        // Permission error or already gone
      }
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
   * Shut down all sessions gracefully.
   */
  async shutdown(): Promise<void> {
    const sessionIds = [...this.sessions.keys()];
    await Promise.all(sessionIds.map((id) => this.killSession(id)));
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
    return path.join(this.config.socketDir, `shepherd-${sessionId}.sock`);
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
  }

  private readShepherdInfo(
    child: ReturnType<typeof cpSpawn>,
  ): Promise<{ pid: number; startTime: number }> {
    return new Promise((resolve, reject) => {
      let data = '';
      const timeout = setTimeout(() => {
        reject(new Error('Timed out reading shepherd info from stdout'));
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
          reject(new Error(`Invalid shepherd info JSON: ${data}`));
        }
      });

      child.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      child.on('exit', (code) => {
        if (code !== null && code !== 0 && data === '') {
          clearTimeout(timeout);
          reject(new Error(`Shepherd exited with code ${code} before writing info`));
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
        this.emit('session-error', sessionId, new Error(`Max restarts (${maxRestarts}) exceeded`));
        // Remove the exhausted session from the map
        this.removeDeadSession(sessionId);
        return;
      }

      session.restartCount++;
      const delay = session.options.restartDelay ?? 2000;

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
