/**
 * Shellper endpoint resolution (Spec 1658).
 *
 * A shellper listens on a platform-resolved endpoint:
 * - POSIX: a Unix socket at `<socketDir>/shellper-<sessionId>.sock` (unchanged).
 * - Windows: a named pipe `\\.\pipe\codev-shellper-<user>-<uuid>`. The UUID is
 *   freshly minted per session, so the name is unguessable before the shellper
 *   creates it. Pipes have no file: readiness is a connect probe, stale cleanup
 *   is a no-op (a pipe vanishes with its server), and the per-session log lives
 *   in the socket directory under the session id rather than beside the endpoint.
 *
 * On Windows, other local users can open a pipe by name, so every connection is
 * gated on a per-session secret (see `SHELLPER_SECRET_ENV`). POSIX keeps its
 * owner-only `0600` socket and carries no secret.
 *
 * Imported by the standalone shellper process, so it depends only on Node
 * built-ins and the platform seam.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { isWindows } from '../lib/platform.js';

/**
 * Environment variable that carries the per-session secret from Tower to a
 * Windows shellper. Never argv: another user can read a process's command line.
 * The shellper deletes it from its own environment at startup and strips it from
 * every PTY child's environment.
 */
export const SHELLPER_SECRET_ENV = 'CODEV_SHELLPER_SECRET';

const PIPE_PREFIXES = ['\\\\.\\pipe\\', '\\\\?\\pipe\\'];

/** True when the endpoint is a Windows named pipe rather than a socket file. */
export function isPipeEndpoint(endpoint: string): boolean {
  const lower = endpoint.toLowerCase();
  return PIPE_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/** The current user's name, reduced to characters safe in a pipe name. */
function pipeUserSegment(): string {
  let name = '';
  try {
    name = os.userInfo().username;
  } catch {
    name = process.env.USERNAME ?? '';
  }
  const safe = name.replace(/[^A-Za-z0-9._-]/g, '_');
  if (safe) {
    return safe;
  }
  return 'user';
}

/** Resolve a new session's endpoint. */
export function resolveShellperEndpoint(socketDir: string, sessionId: string): string {
  if (isWindows()) {
    return `\\\\.\\pipe\\codev-shellper-${pipeUserSegment()}-${crypto.randomUUID()}`;
  }
  return path.join(socketDir, `shellper-${sessionId}.sock`);
}

/**
 * The shellper's stderr log path.
 *
 * POSIX derives it from the socket path exactly as before (`.sock` → `.log`), so
 * existing sessions keep their log. A pipe has no directory, so on Windows the
 * log sits in the socket directory, named by the shellper session id.
 */
export function shellperLogPath(endpoint: string, socketDir: string, sessionId: string): string {
  if (isPipeEndpoint(endpoint)) {
    return path.join(socketDir, `shellper-${sessionId}.log`);
  }
  return endpoint.replace('.sock', '.log');
}

/** Mint a per-session secret (Windows only). */
export function generateShellperSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}

/** Constant-time comparison of a presented secret against the expected one. */
export function secretsMatch(presented: unknown, expected: string): boolean {
  if (typeof presented !== 'string') {
    return false;
  }
  const a = Buffer.from(presented, 'utf-8');
  const b = Buffer.from(expected, 'utf-8');
  if (a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

/**
 * Whether the endpoint currently exists without connecting to it.
 * A socket file must exist and be a socket; a pipe cannot be checked without a
 * connection, so it reports true and the caller's connect is the real check.
 */
export function endpointMayExist(endpoint: string): boolean {
  if (isPipeEndpoint(endpoint)) {
    return true;
  }
  try {
    return fs.lstatSync(endpoint).isSocket();
  } catch {
    return false;
  }
}

/** Remove a stale socket file. A no-op for pipes, which vanish with their server. */
export function removeStaleEndpoint(endpoint: string): void {
  if (isPipeEndpoint(endpoint)) {
    return;
  }
  try {
    const stat = fs.lstatSync(endpoint);
    if (stat.isSocket()) {
      fs.unlinkSync(endpoint);
    }
  } catch {
    // Doesn't exist — fine
  }
}

/**
 * Whether something is listening on the endpoint: a brief connect that is
 * dropped as soon as it succeeds. Sends nothing, so a secret-gated shellper sees
 * only an unauthenticated connection that closes.
 */
export function probeEndpoint(endpoint: string, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(endpoint);
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);

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
 * Wait until a new shellper's endpoint is ready. POSIX waits for the socket file
 * as before; a pipe is connect-probed until it answers.
 */
export function waitForEndpoint(endpoint: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  const pipe = isPipeEndpoint(endpoint);
  return new Promise((resolve, reject) => {
    const check = async (): Promise<void> => {
      let ready = false;
      if (pipe) {
        ready = await probeEndpoint(endpoint, 500);
      } else {
        try {
          fs.statSync(endpoint);
          ready = true;
        } catch {
          ready = false;
        }
      }
      if (ready) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Socket ${endpoint} not created within ${timeoutMs}ms`));
        return;
      }
      setTimeout(() => { check(); }, 50);
    };
    check();
  });
}
