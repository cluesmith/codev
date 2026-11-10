/**
 * Shellper transport capability (Spec 1658, Amendment 2, phase A2-5).
 *
 * How Tower reaches a shellper on the host and decides it is the right one:
 * the endpoint (a Unix socket on POSIX, a secret-gated named pipe on Windows),
 * the per-session secret, the pre-connect reconnect gate (start time and
 * socket file on POSIX; the row's secret and session id on Windows, where the
 * authenticated WELCOME is the identity proof), and how a shellper's command
 * line reads on the host. The session manager asks `shellperTransport()`
 * instead of choosing a platform; everything around these decisions (the
 * connect, the WELCOME check, the session record) stays shared.
 *
 * Branches on the endpoint's form (`isPipeEndpoint`) and on whether a secret
 * exists are data, not platform, and stay where they are.
 */

import type { ReconnectAuth } from '../../terminal/session-manager.js';
import { isWindows } from '../platform.js';
import { posixShellperTransport } from './shellper-transport.posix.js';
import { windowsShellperTransport } from './shellper-transport.windows.js';

/** The outcome of the pre-connect reconnect gate. */
export type ReconnectAdmission =
  | { admitted: true; secret: string | null; shellperSessionId: string }
  // `refusal` null: the gate already logged why and the reconnect returns null.
  // A string: the endpoint provably is not this session's; the reconnect refuses with it.
  | { admitted: false; refusal: string | null };

export interface ReconnectGateInput {
  sessionId: string;
  socketPath: string;
  pid: number;
  startTime: number;
  auth?: ReconnectAuth;
  log: (message: string) => void;
}

export interface ShellperTransport {
  /** A new session's endpoint. */
  resolveEndpoint(socketDir: string, sessionId: string): string;
  /** The per-session secret a new shellper is gated on, or null (POSIX: none). */
  mintSecret(): string | null;
  /** Whether a live PID is still the recorded shellper (POSIX: start time; Windows: the WELCOME proves it). */
  isProcessCurrent(pid: number, recordedStartTime: number): Promise<boolean>;
  /** The reconnect gate before any connect. */
  admitReconnect(input: ReconnectGateInput): Promise<ReconnectAdmission>;
  /** A connect error that proves the endpoint is not this session's, as a refusal reason, else null. */
  connectErrorRefusal(err: unknown, endpoint: string): string | null;
  /** Whether the spawn-info read resolves on the first complete object rather than on EOF. */
  readonly spawnInfoResolvesOnData: boolean;
  /** A shellper's command line as matchers read it. */
  commandLineText(cmdline: string): string;
  /** The session Job Object name a shellper's command line names, or null (POSIX: none). */
  sessionJobName(cmdline: string): string | null;
  /** `afx attach`'s last resort: a shellper endpoint found without the database, or null (POSIX scans `~/.codev/run`; Windows has nothing to scan). */
  scanForAttachEndpoint(): string | null;
}

/** The host's shellper transport. */
export function shellperTransport(): ShellperTransport {
  if (isWindows()) {
    return windowsShellperTransport;
  }
  return posixShellperTransport;
}
