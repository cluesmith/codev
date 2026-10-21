/**
 * Port → PID lookup.
 *
 * A leaf module on purpose: `codev doctor` needs this to find the running Tower
 * (#1219), and reaching into `agent-farm/commands/tower.ts` for it would drag
 * that command's whole import graph — `promisify(exec)` at module scope
 * included — into the doctor tests. `commands/tower.ts` re-exports it, so its
 * existing consumers are unaffected. On Windows the lookup is `Get-NetTCPConnection`.
 */

import { execFileSync, execSync } from 'node:child_process';
import { isWindows } from '../../lib/platform.js';

/** Windows: `Get-NetTCPConnection` in a cold PowerShell takes a few seconds; bound it. */
const WINDOWS_PORT_QUERY_TIMEOUT_MS = 15_000;

/**
 * Get the PID(s) of the process *listening* on a port (the server), not its
 * clients.
 *
 * `-sTCP:LISTEN` is load-bearing (#991): without it, `lsof -ti :PORT` also
 * returns every process holding an *established* client socket to the port —
 * notably the VSCode extension host (its SSE stream + terminal WebSockets) and
 * dashboard browsers. `afx tower stop` SIGTERMs whatever this returns, so the
 * unfiltered form would kill the editor's extension host (and every open
 * terminal with it), not just the Tower server.
 */
export function getProcessesOnPort(port: number): number[] {
  if (isWindows()) return getWindowsProcessesOnPort(port);
  try {
    const result = execSync(`lsof -ti :${port} -sTCP:LISTEN 2>/dev/null`, { encoding: 'utf-8' });
    return result
      .trim()
      .split('\n')
      .map((line) => parseInt(line, 10))
      .filter((pid) => !isNaN(pid));
  } catch {
    return [];
  }
}

/**
 * Windows (Spec 1658): there is no `lsof`. `Get-NetTCPConnection -State Listen`
 * is the listener-only equivalent of `-sTCP:LISTEN`, so a client holding an
 * established socket to the port (the VS Code extension host) is never
 * returned. The port is a number, so nothing user-supplied reaches the
 * command. A failed or timed-out query returns `[]`, as the POSIX branch does.
 */
function getWindowsProcessesOnPort(port: number): number[] {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return [];
  try {
    const result = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique`,
      ],
      { encoding: 'utf-8', timeout: WINDOWS_PORT_QUERY_TIMEOUT_MS, windowsHide: true },
    );
    return parsePidLines(result);
  } catch {
    return [];
  }
}

/** One pid per line; blank lines, non-numbers and pid 0 (the idle process) are dropped. */
export function parsePidLines(output: string): number[] {
  const pids: number[] = [];
  for (const line of output.split(/\r?\n/)) {
    const pid = parseInt(line.trim(), 10);
    if (!isNaN(pid) && pid > 0 && !pids.includes(pid)) pids.push(pid);
  }
  return pids;
}
