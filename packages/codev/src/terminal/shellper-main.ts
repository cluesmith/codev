#!/usr/bin/env node

/**
 * Shellper main: standalone entry point spawned by Tower as a detached process.
 *
 * Usage:
 *   node shellper-main.js <json-config>
 *
 * Where json-config is a JSON string with:
 *   { command, args, cwd, env, cols, rows, socketPath }
 *
 * On startup:
 * 1. Creates socket directory with 0700 permissions
 * 2. Spawns PTY with requested command
 * 3. Writes { pid, startTime } to stdout as JSON, then closes stdout
 * 4. Listens on Unix socket at socketPath
 * 5. Handles SIGTERM gracefully
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ShellperProcess, type IShellperPty, type PtyOptions } from './shellper-process.js';

// createRequire enables importing native/CJS modules (like node-pty) from ESM.
// The package uses "type": "module", so bare `require()` is not available.
const require = createRequire(import.meta.url);

interface ShellperConfig {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  socketPath: string;
  replayBufferLines?: number;
}

function createRealPty(): IShellperPty {
  let ptyModule: typeof import('node-pty') | null = null;
  let ptyInstance: import('node-pty').IPty | null = null;
  let dataCallback: ((data: string) => void) | null = null;
  let exitCallback: ((info: { exitCode: number; signal?: number }) => void) | null = null;

  return {
    spawn(command: string, args: string[], options: PtyOptions): void {
      // Load node-pty at spawn time via createRequire (defined at module level).
      // node-pty is a native CJS module; createRequire handles ESM→CJS interop.
      ptyModule = require('node-pty') as typeof import('node-pty');
      ptyInstance = ptyModule.spawn(command, args, {
        name: options.name ?? 'xterm-256color',
        cols: options.cols,
        rows: options.rows,
        cwd: options.cwd,
        env: options.env,
      });

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
      ptyInstance?.resize(cols, rows);
    },

    kill(signal?: number): void {
      if (ptyInstance) {
        try {
          process.kill(ptyInstance.pid, signal ?? 15);
        } catch {
          // Process already dead
        }
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

  // Ensure socket directory exists with 0700 permissions
  const socketDir = path.dirname(config.socketPath);
  fs.mkdirSync(socketDir, { recursive: true, mode: 0o700 });

  // Remove stale socket file if it exists
  try {
    const stat = fs.lstatSync(config.socketPath);
    if (stat.isSocket()) {
      fs.unlinkSync(config.socketPath);
    }
  } catch {
    // File doesn't exist — fine
  }

  const shellper = new ShellperProcess(
    createRealPty,
    config.socketPath,
    config.replayBufferLines ?? 10_000,
  );

  // Start the shellper (spawns PTY and listens on socket)
  await shellper.start(
    config.command,
    config.args,
    config.cwd,
    config.env,
    config.cols,
    config.rows,
  );

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
    shellper.shutdown();
    // Clean up socket file
    try {
      fs.unlinkSync(config.socketPath);
    } catch {
      // Already gone
    }
    process.exit(0);
  });

  // When the child process exits and no connection is active, exit the shellper
  shellper.on('exit', () => {
    // Don't exit immediately — Tower might send a SPAWN frame to restart.
    // The shellper stays alive as long as the socket server is running.
    // If Tower never reconnects, the shellper will be cleaned up by stale
    // socket cleanup on next Tower startup.
  });

  shellper.on('error', (err) => {
    process.stderr.write(`Shellper error: ${err.message}\n`);
  });
}

main().catch((err) => {
  process.stderr.write(`Shellper fatal: ${err.message}\n`);
  process.exit(1);
});
