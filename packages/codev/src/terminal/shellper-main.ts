#!/usr/bin/env node

/**
 * Shellper main: standalone entry point spawned by Tower as a detached process.
 *
 * Usage:
 *   node shellper-main.js <json-config>
 *
 * Where json-config is a JSON string with:
 *   { command, args, cwd, env, cols, rows, socketPath }
 * plus, on Windows only, { socketDir, sessionId } (Spec 1658).
 *
 * On startup:
 * 1. Creates socket directory with 0700 permissions (POSIX)
 * 2. Spawns PTY with requested command (on Windows with `deferPty`, on
 *    Tower's first HELLO instead, once Tower has assigned the session job)
 * 3. Writes { pid, startTime } to stdout as JSON, then closes stdout
 * 4. Listens on the Unix socket or named pipe at socketPath
 * 5. Handles SIGTERM gracefully
 *
 * A named-pipe shellper requires the per-session secret in its environment
 * (SHELLPER_SECRET_ENV) and refuses to start without it. The secret is removed
 * from this process's environment before anything else runs.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DEFER_PTY_DEADLINE_MS, ShellperProcess, type IShellperPty, type PtyOptions, type ShellperAuth } from './shellper-process.js';
import { SHELLPER_SECRET_ENV, isPipeEndpoint, removeStaleEndpoint } from './shellper-endpoint.js';
import { REPLAY_BUFFER_MAX_BYTES } from './shellper-replay-buffer.js';
import { isWindows } from '../lib/platform.js';
import { ptyCommand } from '../lib/pty-command.js';
import { withNativeLoadExplanation } from '../lib/native-deps.js';
import { killSessionTree } from '../lib/process-tree.js';

// createRequire enables importing native/CJS modules (like node-pty) from ESM.
// The package uses "type": "module", so bare `require()` is not available.
const require = createRequire(import.meta.url);

/** EPIPE-safe stderr logger with ISO timestamp. Silently ignores broken pipe errors. */
function logStderr(message: string): void {
  try {
    process.stderr.write(`[${new Date().toISOString()}] ${message}\n`);
  } catch (err: unknown) {
    // EPIPE: Tower closed the read end of the pipe (e.g., after restart).
    // Node.js ignores SIGPIPE via libuv, so we just get an error on write.
    // Re-throw non-EPIPE errors so they aren't silently swallowed.
    if (err instanceof Error && (err as NodeJS.ErrnoException).code !== 'EPIPE') {
      throw err;
    }
  }
}

interface ShellperConfig {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  socketPath: string;
  replayBufferLines?: number;
  /** Byte ceiling on the replay buffer (#1205). Defaults to REPLAY_BUFFER_MAX_BYTES. */
  replayBufferBytes?: number;
  /**
   * Windows only (Spec 1658). A pipe name does not contain the socket directory,
   * so it is carried separately: it is the Tower-instance scope marker the orphan
   * sweep matches in this process's command line.
   */
  socketDir?: string;
  /** Windows only (Spec 1658): the session id reported in WELCOME. */
  sessionId?: string;
  /**
   * Windows only (Spec 1658 Phase 3b): hold the first PTY spawn until Tower's
   * HELLO, after Tower has put this process in its per-session job.
   */
  deferPty?: boolean;
}

function createRealPty(): IShellperPty {
  let ptyModule: typeof import('node-pty') | null = null;
  let ptyInstance: import('node-pty').IPty | null = null;
  let dataCallback: ((data: string) => void) | null = null;
  let exitCallback: ((info: { exitCode: number; signal?: number }) => void) | null = null;
  // Issue #1482: a resize that arrives while there is no PTY instance used to vanish
  // (`ptyInstance?.resize(...)`). Hold it and apply it at spawn instead, so the process starts
  // at the geometry that was last asked for rather than at a stale one. Narrow by design — the
  // window is small (ShellperProcess creates this adapter and spawns into it back-to-back, and
  // caches dims across a relaunch itself) — but a silently dropped resize is exactly the class
  // of bug this issue is about, and a dropped one here would put the kernel winsize out of step
  // with every layer above it.
  let pendingResize: { cols: number; rows: number } | null = null;

  return {
    spawn(command: string, args: string[], options: PtyOptions): void {
      // Load node-pty at spawn time via createRequire (defined at module level).
      // node-pty is a native CJS module; createRequire handles ESM→CJS interop.
      // A binding that cannot load on Windows surfaces with the supported-versions message (Spec 1658).
      const nodePty = withNativeLoadExplanation(() => require('node-pty') as typeof import('node-pty'));
      ptyModule = nodePty;
      // A resize that landed before this spawn wins over the spawn options — it is the more
      // recent statement of the caller's intent (Issue #1482).
      const cols = pendingResize?.cols ?? options.cols;
      const rows = pendingResize?.rows ?? options.rows;
      pendingResize = null;
      // Spec 1658: on Windows a bare or `.cmd` command becomes one ConPTY can start.
      const launch = ptyCommand(command, args, options.env);
      ptyInstance = withNativeLoadExplanation(() => nodePty.spawn(launch.file, launch.args, {
        name: options.name ?? 'xterm-256color',
        cols,
        rows,
        cwd: options.cwd,
        env: options.env,
      }));

      if (dataCallback) {
        ptyInstance.onData(dataCallback);
      }
      if (exitCallback) {
        ptyInstance.onExit(exitCallback);
      }
    },

    write(data: string): void {
      ptyInstance?.write(data);
    },

    resize(cols: number, rows: number): void {
      if (!ptyInstance) {
        pendingResize = { cols, rows };
        return;
      }
      ptyInstance.resize(cols, rows);
    },

    kill(signal?: number): void {
      if (!ptyInstance) return;
      // Windows has no signals to forward: every kill is a hard kill, and
      // killing the PTY's root alone would leave its descendants running, so
      // the whole tree goes (Spec 1658).
      if (isWindows()) {
        killSessionTree(ptyInstance.pid).catch((err: Error) => {
          logStderr(`PTY tree teardown incomplete: ${err.message}`);
        });
        return;
      }
      try {
        process.kill(ptyInstance.pid, signal ?? 15);
      } catch {
        // Process already dead
      }
    },

    onData(callback: (data: string) => void): void {
      dataCallback = callback;
      if (ptyInstance) {
        ptyInstance.onData(callback);
      }
    },

    onExit(callback: (exitInfo: { exitCode: number; signal?: number }) => void): void {
      exitCallback = callback;
      if (ptyInstance) {
        ptyInstance.onExit(callback);
      }
    },

    get pid(): number {
      return ptyInstance?.pid ?? -1;
    },
  };
}

async function main(): Promise<void> {
  // Bugfix #324: Prevent crashes from broken/closed stdio FDs.
  // When Tower exits, any pipe-based stdio FDs break. Async EPIPE errors
  // surface as unhandled 'error' events on the stream, crashing the process.
  // Even though stderr is now redirected to a file (not a pipe), add handlers
  // as a defensive measure against future regressions.
  for (const stream of [process.stdout, process.stderr]) {
    if (stream && typeof stream.on === 'function') {
      stream.on('error', () => { /* swallow EPIPE/EBADF — stdio is non-essential */ });
    }
  }

  const configJson = process.argv[2];
  if (!configJson) {
    process.stderr.write('Usage: shellper-main.js <json-config>\n');
    process.exit(1);
  }

  let config: ShellperConfig;
  try {
    config = JSON.parse(configJson) as ShellperConfig;
  } catch {
    process.stderr.write('Invalid JSON config\n');
    process.exit(1);
  }

  // Spec 1658: take the secret out of the environment before anything can
  // inherit it. A pipe shellper without one would be open to every local user.
  const secret = process.env[SHELLPER_SECRET_ENV];
  delete process.env[SHELLPER_SECRET_ENV];
  let auth: ShellperAuth | null = null;
  if (isPipeEndpoint(config.socketPath)) {
    if (!secret) {
      logStderr(`Shellper refusing to start: named pipe endpoint without ${SHELLPER_SECRET_ENV}`);
      process.exit(1);
    }
    auth = { secret, sessionId: config.sessionId ?? '', shellperPid: process.pid };
  } else {
    // Ensure socket directory exists with 0700 permissions
    const socketDir = path.dirname(config.socketPath);
    fs.mkdirSync(socketDir, { recursive: true, mode: 0o700 });

    // Remove stale socket file if it exists
    removeStaleEndpoint(config.socketPath);
  }

  const shellper = new ShellperProcess(
    createRealPty,
    config.socketPath,
    config.replayBufferLines ?? 10_000,
    logStderr,
    config.replayBufferBytes ?? REPLAY_BUFFER_MAX_BYTES,
    auth,
  );

  logStderr(`Shellper started: pid=${process.pid}, command=${config.command}, socket=${config.socketPath}`);

  // A deferred spawn needs the secret gate: only an authenticated Tower may start the PTY.
  let deferSpawnMs: number | undefined;
  if (config.deferPty === true && auth) {
    deferSpawnMs = DEFER_PTY_DEADLINE_MS;
    shellper.on('spawn-deadline', () => {
      logStderr('Shellper exiting: Tower never connected to start the PTY');
      shellper.shutdown();
      process.exit(1);
    });
  }

  // Start the shellper (spawns PTY, unless deferred, and listens on socket)
  await shellper.start(
    config.command,
    config.args,
    config.cwd,
    config.env,
    config.cols,
    config.rows,
    deferSpawnMs,
  );

  if (shellper.spawnDeferred) {
    logStderr(`PTY spawn deferred until Tower connects, cols=${config.cols}, rows=${config.rows}`);
  } else {
    logStderr(`PTY spawned: pid=${shellper.getPid()}, cols=${config.cols}, rows=${config.rows}`);
  }
  logStderr(`Socket listening: ${config.socketPath}`);

  // Write PID and start time to stdout, then close stdout
  const info = JSON.stringify({
    pid: process.pid,
    startTime: shellper.getStartTime(),
  });
  process.stdout.write(info, () => {
    // Close stdout after write completes (Tower reads this, then we detach)
    try {
      fs.closeSync(1);
    } catch {
      // Already closed or not available
    }
  });

  // Handle SIGTERM: graceful shutdown
  process.on('SIGTERM', () => {
    logStderr('Shellper received SIGTERM, shutting down');
    shellper.shutdown();
    // Clean up socket file (a pipe vanishes with its server)
    removeStaleEndpoint(config.socketPath);
    process.exit(0);
  });

  // When the child process exits and no connection is active, exit the shellper
  shellper.on('exit', (exitInfo: { exitCode: number; signal?: number }) => {
    logStderr(`PTY exited: code=${exitInfo.exitCode}, signal=${exitInfo.signal ?? null}`);
    // Don't exit immediately — Tower might send a SPAWN frame to restart.
    // The shellper stays alive as long as the socket server is running.
    // If Tower never reconnects, the shellper will be cleaned up by stale
    // socket cleanup on next Tower startup.
  });

  shellper.on('error', (err) => {
    logStderr(`Shellper error: ${err.message}`);
  });
}

main().catch((err) => {
  logStderr(`Shellper fatal: ${err.message}`);
  process.exit(1);
});
