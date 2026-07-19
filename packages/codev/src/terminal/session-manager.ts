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
import type { ExitMessage } from './shellper-protocol.js';

export interface SessionManagerConfig {
  socketDir: string;
  shellperScript: string;
  nodeExecutable: string;
  logger?: (message: string) => void;
}

/**
 * Alternate launch config applied once if the session crash-loops (Issue #1149:
 * CRASH_LOOP_THRESHOLD failing exits inside CRASH_LOOP_WINDOW_MS). The caller
 * precomputes it; this layer stays agnostic of what the args mean.
 */
export interface CrashLoopFallback {
  args: string[];
  env: Record<string, string>;
  /** Fired once when the fallback is applied (caller repairs persisted state, logs). */
  onApply?: () => void;
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
  crashLoopFallback?: CrashLoopFallback;
}

export interface ReconnectRestartOptions {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  restartDelay?: number;
  maxRestarts?: number;
  restartResetAfter?: number;
  crashLoopFallback?: CrashLoopFallback;
}

/** Failing exits inside this window count toward crash-loop detection. */
export const CRASH_LOOP_WINDOW_MS = 30_000;
/** Failing exits within the window needed to declare a crash loop. */
export const CRASH_LOOP_THRESHOLD = 3;

/**
 * #1198 in-place reconnect tuning. When a session's socket closes without an
 * EXIT frame but the shellper process is still alive, the connection is
 * re-established instead of tearing the session down: backoff per attempt
 * within one recovery round, a stability window that resets the round
 * counter, and a cap on consecutive unstable rounds.
 */
export const RECONNECT_BACKOFF_MS = [500, 1000, 2000];
export const RECONNECT_STABILITY_MS = 30_000;
export const MAX_RECOVERY_ROUNDS = 3;

/**
 * Issue #1149: true when the recorded failing-exit timestamps amount to a
 * crash loop (>= CRASH_LOOP_THRESHOLD failures inside the trailing
 * CRASH_LOOP_WINDOW_MS ending at `now`). Pure so the policy is testable
 * without spawning processes.
 */
export function isCrashLooping(failingExitTimes: number[], now: number): boolean {
  let recent = 0;
  for (const t of failingExitTimes) {
    if (now - t <= CRASH_LOOP_WINDOW_MS) {
      recent++;
    }
  }
  return recent >= CRASH_LOOP_THRESHOLD;
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
  /** Timestamps of nonzero-code exits, pruned to CRASH_LOOP_WINDOW_MS (Issue #1149). */
  failingExitTimes: number[];
  stderrBuffer: StderrBuffer | null;
  stderrStream: Readable | null;
  stderrTailLogged: boolean;
  /** Consecutive close-triggered recovery rounds without a stable connection (#1198). */
  recoveryRounds: number;
  /** Epoch of the last successful in-place reconnect, for the stability reset (#1198). */
  lastRecoveryAt: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
      info = await this.readShellperInfo(child, stderrLogPath);
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
      failingExitTimes: [],
      stderrBuffer: null, // stderr goes to file, not pipe (Bugfix #324)
      stderrStream: null,
      stderrTailLogged: false,
      recoveryRounds: 0,
      lastRecoveryAt: 0,
    };

    this.sessions.set(opts.sessionId, session);
    this.log(`Session ${opts.sessionId} created: pid=${info.pid}`);

    this.wireClientEvents(opts.sessionId, session);

    // Start restart reset timer if configured
    if (opts.restartOnExit) {
      this.startRestartResetTimer(session);
    }

    return client;
  }

  /**
   * Subscribe to a session client's lifecycle events (exit, error, close) and
   * set up auto-restart when configured. Called on session creation, on
   * reconnection after a Tower restart, and again for the replacement client
   * after an in-place reconnect (#1198), so all three paths behave identically.
   */
  private wireClientEvents(sessionId: string, session: ManagedSession): void {
    const client = session.client;

    // Forward exit events and clean up dead sessions
    client.on('exit', (exitInfo: ExitMessage) => {
      this.log(`Session ${sessionId} exited (code=${exitInfo.code})`);
      this.logStderrTail(sessionId, session, exitInfo.code ?? -1);
      this.emit('session-exit', sessionId, exitInfo);
      // If not auto-restarting, remove the dead session from the map
      // so listSessions() doesn't report it and cleanupStaleSockets()
      // can clean its socket file.
      if (!session.options.restartOnExit) {
        this.removeDeadSession(sessionId);
      }
    });

    client.on('error', (err: Error) => {
      this.emit('session-error', sessionId, err);
    });

    client.on('frame-skipped', (info: { type: number; size: number }) => {
      this.log(`Session ${sessionId} skipped oversized frame (type=${info.type}, ${info.size} bytes)`);
    });

    // Socket closed without an EXIT frame. Historically treated as "shellper
    // crashed", but #1198 showed it also fires for a transient socket error
    // against a perfectly healthy shellper, so try to reconnect in place
    // before declaring the session dead.
    client.on('close', () => {
      if (!this.sessions.has(sessionId)) return;
      // A replaced client's stale wiring must not trigger recovery again.
      if (session.client !== client) return;
      this.log(`Session ${sessionId} shellper connection lost unexpectedly`);
      this.recoverSession(sessionId, session).catch((err) => {
        this.log(`Session ${sessionId} recovery failed unexpectedly: ${(err as Error).message}`);
        this.declareSessionDead(sessionId, session);
      });
    });

    if (session.options.restartOnExit) {
      this.setupAutoRestart(session, sessionId);
    }
  }

  /**
   * #1198: attempt to re-establish a session's shellper connection after an
   * unexpected socket close. The shellper protocol is built for reconnection
   * (that is how sessions survive Tower restarts), so a transient socket
   * error must not tear down a healthy shellper: doing so unlinks the live
   * socket and orphans the process. Falls through to the historical
   * dead-session path when the process is gone or every attempt fails.
   */
  private async recoverSession(sessionId: string, session: ManagedSession): Promise<void> {
    if (Date.now() - session.lastRecoveryAt > RECONNECT_STABILITY_MS) {
      session.recoveryRounds = 0;
    }
    session.recoveryRounds++;

    if (session.recoveryRounds > MAX_RECOVERY_ROUNDS) {
      this.log(`Session ${sessionId} gave up reconnecting after ${MAX_RECOVERY_ROUNDS} unstable recovery rounds`);
      this.declareSessionDead(sessionId, session);
      return;
    }

    for (let attempt = 0; attempt < RECONNECT_BACKOFF_MS.length; attempt++) {
      await sleep(RECONNECT_BACKOFF_MS[attempt]);
      // The session may have been killed or shut down while we waited.
      if (this.sessions.get(sessionId) !== session) return;
      if (!(await this.canReachShellper(session))) {
        break;
      }

      const client = new ShellperClient(session.socketPath);
      try {
        await client.connect();
      } catch (err) {
        this.log(`Session ${sessionId} reconnect attempt ${attempt + 1}/${RECONNECT_BACKOFF_MS.length} failed: ${(err as Error).message}`);
        continue;
      }

      if (this.sessions.get(sessionId) !== session) {
        // Killed while we were connecting
        client.disconnect();
        return;
      }

      session.client = client;
      session.lastRecoveryAt = Date.now();
      this.wireClientEvents(sessionId, session);
      this.log(`Session ${sessionId} shellper connection re-established (round ${session.recoveryRounds}, attempt ${attempt + 1})`);
      this.emit('session-reconnected', sessionId, client);
      return;
    }

    this.declareSessionDead(sessionId, session);
  }

  /**
   * Whether the session's recorded shellper process is still the one running
   * under its PID: alive, and with a matching start time (guards PID reuse).
   */
  private async isShellperProcessCurrent(session: ManagedSession): Promise<boolean> {
    if (!this.isProcessAlive(session.pid)) return false;
    const actualStartTime = await getProcessStartTime(session.pid);
    if (actualStartTime === null || Math.abs(actualStartTime - session.startTime) > 2000) {
      return false;
    }
    return true;
  }

  /**
   * Whether an in-place reconnect can possibly succeed: the shellper process
   * is current (alive, same start time) and its socket file still exists.
   */
  private async canReachShellper(session: ManagedSession): Promise<boolean> {
    if (!(await this.isShellperProcessCurrent(session))) return false;
    try {
      const stat = fs.lstatSync(session.socketPath);
      return stat.isSocket();
    } catch {
      return false;
    }
  }

  /**
   * The historical unexpected-death path: remove the session, clean up its
   * socket, and emit 'session-error' so the Tower layer can log the loss.
   */
  private declareSessionDead(sessionId: string, session: ManagedSession): void {
    if (this.sessions.get(sessionId) !== session) return;
    this.log(`Session ${sessionId} shellper disconnected unexpectedly`);
    this.logStderrTail(sessionId, session, -1);
    this.removeDeadSession(sessionId);
    this.emit('session-error', sessionId, new Error('Shellper disconnected unexpectedly'));
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
        crashLoopFallback: restartOptions?.crashLoopFallback,
      },
      restartCount: 0,
      restartResetTimer: null,
      failingExitTimes: [],
      stderrBuffer: null,
      stderrStream: null,
      stderrTailLogged: false,
      recoveryRounds: 0,
      lastRecoveryAt: 0,
    };

    this.sessions.set(sessionId, session);
    this.log(`Session ${sessionId} reconnected: pid=${pid}`);

    this.wireClientEvents(sessionId, session);

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
   * Bugfix #341: Kill orphaned shellper-main.js processes.
   *
   * Finds shellper-main.js processes scoped to THIS Tower instance's socketDir
   * and kills any whose PIDs are NOT in the active sessions map. This catches
   * shellpers that lost their socket file but are still running (reparented to
   * init/launchd).
   *
   * IMPORTANT: Only kills shellpers belonging to this instance (identified by
   * socketDir in their command line args). Other Tower instances' shellpers
   * are left untouched.
   *
   * Safety: Before killing, probes the shellper's socket. If the socket is
   * responsive, the shellper is serving a live session that this Tower lost
   * track of (e.g., SQLite was corrupt/empty during reconciliation). In that
   * case, the shellper is NOT killed — reality (live socket) trumps SQLite.
   *
   * Returns the number of orphans killed.
   */
  async killOrphanedShellpers(): Promise<number> {
    const activePids = new Set<number>();
    for (const session of this.sessions.values()) {
      activePids.add(session.pid);
    }

    let killed = 0;
    try {
      const entries = await this.findShellperProcesses();
      for (const { pid, socketPath } of entries) {
        if (pid === process.pid) continue;  // Don't kill ourselves
        if (activePids.has(pid)) continue;  // Known active session

        // Safety: before killing, probe the socket to check if the shellper
        // is serving a live session that this Tower instance lost track of
        // (e.g., SQLite was corrupt/empty during reconciliation).
        if (socketPath) {
          const isAlive = await this.probeSocket(socketPath);
          if (isAlive) {
            this.log(`Orphan pid=${pid} has responsive socket ${socketPath} — skipping kill`);
            continue;
          }
        }

        this.log(`Killing orphaned shellper process: pid=${pid}`);
        try {
          // Kill the process group (shellper + its PTY child) to prevent
          // orphaned PTY processes. Shellper is spawned with detached:true,
          // so it's a process group leader.
          process.kill(-pid, 'SIGTERM');
          killed++;
        } catch {
          // Process already dead or permission error — try individual PID
          try { process.kill(pid, 'SIGTERM'); killed++; } catch { /* already dead */ }
        }
      }
    } catch {
      // ps not available or failed — not fatal
    }

    if (killed > 0) {
      this.log(`Killed ${killed} orphaned shellper process(es)`);
    }
    return killed;
  }

  /**
   * Find shellper-main.js processes belonging to THIS Tower instance.
   *
   * Uses `ps -ww -eo pid,args` and filters for lines containing both
   * "shellper-main.js" and this instance's socketDir. Returns PID and
   * socketPath (extracted from the JSON config argument) for each match.
   *
   * The socketPath is used by killOrphanedShellpers() to probe the socket
   * before killing — if the socket is responsive, the process is spared.
   */
  private findShellperProcesses(): Promise<Array<{ pid: number; socketPath?: string }>> {
    return new Promise((resolve) => {
      // -ww prevents arg truncation on macOS/Linux
      execFile('ps', ['-ww', '-eo', 'pid,args'], (err, stdout) => {
        if (err || !stdout.trim()) {
          resolve([]);
          return;
        }
        const results: Array<{ pid: number; socketPath?: string }> = [];
        // Use socketDir + '/' to prevent prefix overlaps (e.g. /run matching /run2)
        const scopeMarker = this.config.socketDir.endsWith('/') ? this.config.socketDir : this.config.socketDir + '/';
        for (const line of stdout.trim().split('\n')) {
          if (line.includes('shellper-main.js') && line.includes(scopeMarker)) {
            const pid = parseInt(line.trim(), 10);
            if (!isNaN(pid) && pid > 0) {
              // Extract socketPath from the JSON config argument visible in ps output.
              // shellper-main.js receives JSON as argv[2]: {"socketPath":"/path/to/sock",...}
              const socketMatch = line.match(/"socketPath"\s*:\s*"([^"]+)"/);
              results.push({ pid, socketPath: socketMatch?.[1] });
            }
          }
        }
        resolve(results);
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
    this.cleanupDeadSessionSocket(sessionId, session).catch((err) => {
      this.log(`Session ${sessionId} socket cleanup failed: ${(err as Error).message}`);
    });
  }

  /**
   * #1198: only unlink a removed session's socket when its shellper process
   * is actually gone. Unlinking a live shellper's socket makes it
   * unreachable AND flags it for the orphan sweeper's kill path — so a
   * session whose connection fails deterministically must degrade to a
   * recoverable orphan (re-adoptable, attachable), never to a killed live
   * process. The check uses the same start-time guard as reconnection: a
   * reused PID counts as "gone", so a dead shellper's socket/log files do
   * not leak just because an unrelated process took its PID. Async and
   * best-effort by design; removeDeadSession's map mutation stays sync.
   */
  private async cleanupDeadSessionSocket(sessionId: string, session: ManagedSession): Promise<void> {
    if (await this.isShellperProcessCurrent(session)) {
      this.log(`Session ${sessionId} removed but shellper pid=${session.pid} is alive; preserving socket`);
      return;
    }
    // Socket paths are keyed by session id, so if a new session claimed this
    // id while we awaited (an in-process re-create/re-adopt), the path now
    // belongs to the new occupant — leave it alone. The caller already
    // deleted OUR map entry, so any present entry is a successor's.
    if (this.sessions.has(sessionId)) {
      return;
    }
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
    stderrLogPath: string,
  ): Promise<{ pid: number; startTime: number }> {
    return new Promise((resolve, reject) => {
      let data = '';
      let settled = false;
      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(new Error(this.withShellperDiagnostics(message, data, stderrLogPath)));
      };
      const timeout = setTimeout(() => {
        fail('Timed out reading shellper info from stdout');
      }, 10_000);

      child.stdout!.on('data', (chunk: Buffer) => {
        data += chunk.toString();
      });

      child.stdout!.on('end', () => {
        if (settled) return;
        try {
          const info = JSON.parse(data) as { pid: number; startTime: number };
          if (typeof info.pid !== 'number' || typeof info.startTime !== 'number') {
            fail('Invalid shellper info JSON');
            return;
          }
          settled = true;
          clearTimeout(timeout);
          resolve(info);
        } catch {
          fail('Invalid shellper info JSON');
        }
      });

      child.on('error', (err) => {
        fail(err.message);
      });

      child.on('exit', (code) => {
        if (code !== null && code !== 0 && data === '') {
          fail(`Shellper exited with code ${code} before writing info`);
        }
      });
    });
  }

  private withShellperDiagnostics(message: string, stdout: string, stderrLogPath: string): string {
    const details: string[] = [message];
    const stdoutSnippet = this.safeDiagnosticSnippet(stdout);
    if (stdoutSnippet) {
      details.push(`stdout: ${stdoutSnippet}`);
    }

    const stderrTail = this.readTextTail(stderrLogPath, 4000);
    if (stderrTail) {
      details.push(`stderr log (${stderrLogPath}): ${stderrTail}`);
    }

    return details.join('\n');
  }

  private safeDiagnosticSnippet(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) return '';
    try {
      return JSON.stringify(this.redactDiagnosticValue(JSON.parse(trimmed))).slice(0, 1000);
    } catch {
      return '';
    }
  }

  private redactDiagnosticValue(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.redactDiagnosticValue(item));
    }
    if (!value || typeof value !== 'object') {
      return value;
    }

    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === 'env' || key === 'args') {
        result[key] = '[redacted]';
      } else {
        result[key] = this.redactDiagnosticValue(child);
      }
    }
    return result;
  }

  private readTextTail(filePath: string, maxChars: number): string {
    try {
      const content = fs.readFileSync(filePath, 'utf-8').trim();
      if (!content) return '';
      return content.length > maxChars ? content.slice(-maxChars) : content;
    } catch {
      return '';
    }
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
    session.client.on('exit', (exit: ExitMessage) => {
      // Check if session was removed (killed intentionally)
      if (!this.sessions.has(sessionId)) return;

      // Cancel the reset timer while the process is down — it should only
      // run while the process is alive, preventing restartResetAfter < restartDelay
      // from resetting the counter during downtime.
      if (session.restartResetTimer) {
        clearTimeout(session.restartResetTimer);
        session.restartResetTimer = null;
      }

      // Issue #1149: a fast-failing process (e.g. an unresumable `--resume`
      // replayed verbatim) never lives long enough for the reset timer to
      // clear the counter, so it would burn all restarts on identical args.
      // Count failing exits and swap to the caller-provided fallback launch
      // once they amount to a crash loop. Clean exits (code 0) never count:
      // a user quitting a healthy session repeatedly must not trigger it.
      if (exit.code !== 0) {
        const now = Date.now();
        session.failingExitTimes = session.failingExitTimes.filter(
          (t) => now - t <= CRASH_LOOP_WINDOW_MS,
        );
        session.failingExitTimes.push(now);
        this.maybeApplyCrashLoopFallback(session, sessionId, now);
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

  /**
   * Issue #1149: swap the session's launch options to the caller-provided
   * fallback when the failing-exit history amounts to a crash loop. One-shot:
   * the fallback is consumed on application, so a fallback that itself
   * crash-loops proceeds to the ordinary maxRestarts cap. The next scheduled
   * restart picks the swapped options up automatically because spawn() reads
   * session.options.
   */
  private maybeApplyCrashLoopFallback(session: ManagedSession, sessionId: string, now: number): void {
    const fallback = session.options.crashLoopFallback;
    if (!fallback) return;
    if (!isCrashLooping(session.failingExitTimes, now)) return;

    session.options.args = fallback.args;
    session.options.env = fallback.env;
    session.options.crashLoopFallback = undefined;
    this.log(`Session ${sessionId} crash-looping; applying fallback launch args`);
    if (fallback.onApply) {
      try {
        fallback.onApply();
      } catch (err) {
        this.log(`Session ${sessionId} crash-loop fallback onApply failed: ${(err as Error).message}`);
      }
    }
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
