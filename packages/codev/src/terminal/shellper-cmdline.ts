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

import * as path from 'node:path';
import { isWindows } from '../lib/platform.js';
import { sessionJobName } from '../lib/windows-job.js';

/** Marker identifying a Codev shellper process in a command line. */
export const SHELLPER_MARKER = 'shellper-main.js';

/**
 * Undo Windows argv quoting across a whole command line, the way
 * `CommandLineToArgvW` reads it, without splitting into arguments: `2n`
 * backslashes before a `"` become `n` backslashes and the quote is a delimiter
 * (dropped); `2n+1` backslashes before a `"` become `n` backslashes and a
 * literal `"`; backslashes not followed by a quote are literal. The result
 * holds each argument's text, so a JSON argument reads as plain JSON.
 */
export function unquoteWindowsCommandLine(cmdline: string): string {
  let out = '';
  let i = 0;
  while (i < cmdline.length) {
    const ch = cmdline[i];
    if (ch === '\\') {
      let run = 0;
      while (cmdline[i] === '\\') {
        run++;
        i++;
      }
      if (cmdline[i] === '"') {
        out += '\\'.repeat(Math.floor(run / 2));
        if (run % 2 === 1) out += '"';
        i++;
      } else {
        out += '\\'.repeat(run);
      }
      continue;
    }
    if (ch !== '"') out += ch;
    i++;
  }
  return out;
}

/**
 * The command line as matchers should read it: the raw `ps` argv on POSIX, the
 * argv-unquoted text on Windows.
 */
export function shellperArgvText(cmdline: string): string {
  if (isWindows()) return unquoteWindowsCommandLine(cmdline);
  return cmdline;
}

/**
 * Extract and JSON-decode a `"key":"value"` string field from text holding a
 * shellper's JSON config. Regex rather than JSON.parse of the whole blob: the
 * config embeds the full process env, so a partial or unusual line must
 * degrade to "field absent" (null) rather than throw. An empty value also
 * reads as absent.
 */
export function readJsonStringField(text: string, key: string): string | null {
  const match = text.match(new RegExp(`"${key}"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")`));
  if (!match) return null;
  try {
    const value: unknown = JSON.parse(match[1]);
    if (typeof value !== 'string' || value === '') return null;
    return value;
  } catch {
    return null;
  }
}

/**
 * Compare two Windows paths the way the filesystem does: separators and `.`
 * segments normalized, case-insensitive. Uses `path.win32` explicitly so the
 * comparison is the same when a test forces the platform seam on a POSIX host.
 */
export function sameWindowsPath(a: string, b: string): boolean {
  return path.win32.resolve(a).toLowerCase() === path.win32.resolve(b).toLowerCase();
}

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
    if (!isWindows()) continue;
    const shellperSessionId = readJsonStringField(unquoteWindowsCommandLine(entry.cmdline), 'sessionId');
    if (shellperSessionId) jobNames.set(entry.pid, sessionJobName(shellperSessionId));
  }
  return { startTimes, jobNames };
}
