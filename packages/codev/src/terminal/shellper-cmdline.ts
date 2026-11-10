/**
 * Reading a shellper's JSON config out of a process-table command line
 * (Spec 1658).
 *
 * A shellper is launched as `node shellper-main.js <json-config>`, and the
 * sweeps identify their own shellpers by fields of that config (`socketDir`,
 * `cwd`, `CODEV_ARCHITECT_NAME`). On POSIX, `ps` prints the argv verbatim, so
 * the JSON appears raw. On Windows the census reports the process's raw
 * command line, where the JSON argument carries Windows argv quoting: every
 * `"` is written `\"`, and backslashes before a quote are doubled. A path such
 * as `C:\Users\me` is JSON-escaped to `C:\\Users\\me` inside the config, so
 * substring matching against the real path fails there.
 *
 * These helpers undo the argv quoting (Windows only) and JSON-decode field
 * values, so every matcher compares decoded values on both platforms.
 */

import { isWindows } from '../lib/platform.js';
import { sameWindowsPath } from '../lib/platform/host-paths.windows.js';
import { readJsonStringField, unquoteWindowsCommandLine } from './shellper-cmdline-parse.js';
import { shellperTransport } from '../lib/platform/shellper-transport.js';

export { readJsonStringField, unquoteWindowsCommandLine };

/** Marker identifying a Codev shellper process in a command line. */
export const SHELLPER_MARKER = 'shellper-main.js';

/**
 * Quote one argument the way Node (libuv) does when it builds a Windows
 * command line, so `CommandLineToArgvW` reads it back unchanged: the inverse
 * of `unquoteWindowsCommandLine` for a single argument.
 */
export function quoteWindowsArg(arg: string): string {
  if (arg === '') return '""';
  if (!/[\s"]/.test(arg)) return arg;
  let out = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes++;
      continue;
    }
    if (ch === '"') {
      out += '\\'.repeat(backslashes * 2 + 1) + '"';
    } else {
      out += '\\'.repeat(backslashes) + ch;
    }
    backslashes = 0;
  }
  return out + '\\'.repeat(backslashes * 2) + '"';
}


/**
 * The command line as matchers should read it: the raw `ps` argv on POSIX, the
 * argv-unquoted text on Windows.
 */
export function shellperArgvText(cmdline: string): string {
  return shellperTransport().commandLineText(cmdline);
}


/** Windows path equality (case-insensitive, separators normalized); defined with the host paths capability. */
export { sameWindowsPath };

/**
 * True when `cmdline` belongs to a shellper launched by the Tower instance
 * whose socket directory is `socketDir`.
 *
 * - POSIX: the socket path lives inside `socketDir`, so the argv contains
 *   `<socketDir>/`. The trailing separator prevents prefix collisions (`/run`
 *   must not match `/run2`).
 * - Windows: the pipe name does not contain the directory, so the config
 *   carries `socketDir` as its own field (Spec 1658 Phase 2); it is decoded and
 *   compared as a path.
 *
 * Does not check for the shellper marker; callers do that first.
 */
export function isShellperInScope(cmdline: string, socketDir: string): boolean {
  if (isWindows()) {
    const configured = readJsonStringField(unquoteWindowsCommandLine(cmdline), 'socketDir');
    return configured !== null && sameWindowsPath(configured, socketDir);
  }
  const scopeMarker = socketDir.endsWith('/') ? socketDir : `${socketDir}/`;
  return cmdline.includes(scopeMarker);
}

/**
 * The teardown identity of each shellper in `pids`, read from process-table
 * entries: the census creation time (Windows; lets a teardown refuse a reused
 * pid) and the session Job Object name decoded from the config's `sessionId`
 * (Windows only, Spec 1658 Phase 3b). POSIX entries carry neither.
 */
export function shellperTeardownIdentities(
  entries: ReadonlyArray<{ pid: number; cmdline: string; creationTime?: number }>,
  pids: readonly number[],
): { startTimes: Map<number, number>; jobNames: Map<number, string> } {
  const startTimes = new Map<number, number>();
  const jobNames = new Map<number, string>();
  for (const entry of entries) {
    if (!pids.includes(entry.pid)) continue;
    if (entry.creationTime !== undefined) startTimes.set(entry.pid, entry.creationTime);
    const jobName = shellperTransport().sessionJobName(entry.cmdline);
    if (jobName !== null) jobNames.set(entry.pid, jobName);
  }
  return { startTimes, jobNames };
}
