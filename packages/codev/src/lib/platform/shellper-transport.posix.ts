/**
 * Shellper transport on macOS and Linux (Spec 1658, Amendment 2, phase A2-5).
 *
 * A Unix socket in the socket directory, no secret (the socket is owner-only
 * `0600`), and a reconnect gate on the process start time and the socket file.
 * Each method is the POSIX branch its call site used to carry, moved verbatim.
 * See `shellper-transport.ts` for the contract.
 */

import fs from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { PID_REUSE_TOLERANCE_MS } from '../../terminal/pid-reuse.js';
import { processes } from './processes.js';
import type { ShellperTransport } from './shellper-transport.js';

export const posixShellperTransport: ShellperTransport = Object.freeze<ShellperTransport>({
  resolveEndpoint(socketDir, sessionId) {
    return path.join(socketDir, `shellper-${sessionId}.sock`);
  },

  mintSecret() {
    return null;
  },

  async isProcessCurrent(pid, recordedStartTime) {
    const actualStartTime = await processes().startTime(pid);
    if (actualStartTime === null || Math.abs(actualStartTime - recordedStartTime) > PID_REUSE_TOLERANCE_MS) {
      return false;
    }
    return true;
  },

  async admitReconnect({ sessionId, socketPath, pid, startTime, auth, log }) {
    // Validate process start time to prevent PID reuse
    const actualStartTime = await processes().startTime(pid);
    if (actualStartTime === null || Math.abs(actualStartTime - startTime) > PID_REUSE_TOLERANCE_MS) {
      // Start time mismatch or couldn't determine — PID was reused
      log(`Session ${sessionId} reconnect failed: PID ${pid} reused (start time mismatch)`);
      return { admitted: false, refusal: null };
    }

    // Check socket file exists
    try {
      const stat = fs.lstatSync(socketPath);
      if (!stat.isSocket()) {
        log(`Session ${sessionId} reconnect failed: socket not a socket file`);
        return { admitted: false, refusal: null };
      }
    } catch {
      log(`Session ${sessionId} reconnect failed: socket missing or lstat error`);
      return { admitted: false, refusal: null };
    }
    let shellperSessionId = sessionId;
    if (auth?.shellperSessionId) {
      shellperSessionId = auth.shellperSessionId;
    }
    return { admitted: true, secret: null, shellperSessionId };
  },

  connectErrorRefusal() {
    return null;
  },

  // The spawn-info read resolves on EOF, unchanged.
  spawnInfoResolvesOnData: false,

  commandLineText(cmdline) {
    // The raw `ps` argv.
    return cmdline;
  },

  sessionJobName() {
    return null;
  },

  scanForAttachEndpoint() {
    // Fallback: scan ~/.codev/run/ for matching sockets
    const runDir = path.join(homedir(), '.codev', 'run');
    try {
      if (!fs.existsSync(runDir)) return null;
      const files = fs.readdirSync(runDir);
      for (const file of files) {
        if (file.startsWith('shellper-') && file.endsWith('.sock')) {
          const sockPath = path.join(runDir, file);
          // Check if socket file exists and is accessible
          try {
            fs.accessSync(sockPath, fs.constants.R_OK | fs.constants.W_OK);
            return sockPath;
          } catch {
            continue;
          }
        }
      }
    } catch {
      // Directory not readable
    }

    return null;
  },
});
