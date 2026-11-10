/**
 * Port to PID lookup on native Windows (Spec 1658): `Get-NetTCPConnection
 * -State Listen`, the listener-only equivalent of `lsof -sTCP:LISTEN`. The
 * Windows implementation of the processes capability calls in here. Leaf
 * module: node builtins and the platform seam only.
 */

import { execFile, execFileSync } from 'node:child_process';
import { windowsPowerShellPath } from '../../lib/platform.js';

/** Windows: `Get-NetTCPConnection` in a cold PowerShell takes a few seconds; bound it. */
const WINDOWS_PORT_QUERY_TIMEOUT_MS = 15_000;

/**
 * Windows (Spec 1658): there is no `lsof`. `Get-NetTCPConnection -State Listen`
 * is the listener-only equivalent of `-sTCP:LISTEN`, so a client holding an
 * established socket to the port (the VS Code extension host) is never
 * returned. The port is a number, so nothing user-supplied reaches the
 * command. A failed or timed-out query returns `[]`, as the POSIX branch does.
 */
export function getWindowsProcessesOnPort(port: number): number[] {
  if (!isValidPort(port)) return [];
  try {
    const result = execFileSync(windowsPowerShellPath(), windowsPortQueryArgs(port), {
      encoding: 'utf-8',
      timeout: WINDOWS_PORT_QUERY_TIMEOUT_MS,
      windowsHide: true,
    });
    return parsePidLines(result);
  } catch {
    return [];
  }
}

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port <= 65535;
}

function windowsPortQueryArgs(port: number): string[] {
  return [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique`,
  ];
}

/** Asynchronous `getWindowsProcessesOnPort`; null when the query itself fails or times out. */
export function getWindowsProcessesOnPortAsync(port: number): Promise<number[] | null> {
  if (!isValidPort(port)) return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile(
      windowsPowerShellPath(),
      windowsPortQueryArgs(port),
      { encoding: 'utf-8', timeout: WINDOWS_PORT_QUERY_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        resolve(parsePidLines(stdout));
      },
    );
  });
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
