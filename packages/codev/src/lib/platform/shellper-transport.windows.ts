/**
 * Shellper transport on native Windows (Spec 1658, Amendment 2, phase A2-5).
 *
 * A named pipe `\\.\pipe\codev-shellper-<user>-<uuid>` that any local user can
 * open, so every connection presents a per-session secret, and a reconnect
 * proves identity by the WELCOME's session id and shellper PID rather than the
 * process start time. Each method is the Windows branch its call site used to
 * carry. See `shellper-transport.ts` for the contract. Imports only leaf
 * modules (no cycle).
 */

import crypto from 'node:crypto';
import os from 'node:os';
import { generateShellperSecret } from '../../terminal/shellper-endpoint.js';
import { readJsonStringField, unquoteWindowsCommandLine } from '../../terminal/shellper-cmdline-parse.js';
import { sessionJobName } from '../windows-job.js';
import type { ShellperTransport } from './shellper-transport.js';

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

export const windowsShellperTransport: ShellperTransport = Object.freeze<ShellperTransport>({
  resolveEndpoint() {
    // A fresh UUID per session: the name is unguessable before the shellper creates it.
    return `\\\\.\\pipe\\codev-shellper-${pipeUserSegment()}-${crypto.randomUUID()}`;
  },

  mintSecret() {
    // It travels in the shellper's environment, never its argv.
    return generateShellperSecret();
  },

  async isProcessCurrent() {
    // Start time is not the identity proof here; the authenticated WELCOME is,
    // and every reconnect verifies it. Liveness is the caller's precondition.
    return true;
  },

  async admitReconnect({ auth }) {
    // The row must carry what the identity check needs; without it this
    // endpoint can never be authenticated.
    if (!auth?.secret || !auth.shellperSessionId) {
      return { admitted: false, refusal: 'row has no shellper secret or session id' };
    }
    return { admitted: true, secret: auth.secret, shellperSessionId: auth.shellperSessionId };
  },

  connectErrorRefusal(err, endpoint) {
    // A named pipe exists exactly as long as its server listens, and a
    // shellper listens for its whole life. No pipe means no shellper, so the
    // live PID is someone else's.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return `pipe ${endpoint} does not exist`;
    }
    return null;
  },

  // Resolve as soon as the complete info object has arrived rather than on EOF:
  // the shellper's `closeSync(1)` does not close the pipe Tower reads (libuv
  // keeps its own handle), so 'end' never fires there.
  spawnInfoResolvesOnData: true,

  commandLineText(cmdline) {
    // The argv-unquoted text.
    return unquoteWindowsCommandLine(cmdline);
  },

  sessionJobName(cmdline) {
    const shellperSessionId = readJsonStringField(unquoteWindowsCommandLine(cmdline), 'sessionId');
    if (!shellperSessionId) {
      return null;
    }
    return sessionJobName(shellperSessionId);
  },

  scanForAttachEndpoint() {
    // No socket directory to scan: a pipe has no file.
    return null;
  },
});
