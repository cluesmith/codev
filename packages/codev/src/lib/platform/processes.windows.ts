/**
 * Processes on native Windows (Spec 1658, Amendment 2, phase A2-3).
 *
 * Adapters over the existing Windows modules: the CIM census with its TTL cache
 * (`process-census-windows.ts`), Job Object and `taskkill` teardown
 * (`process-tree-windows.ts`) and the `Get-NetTCPConnection` listener query
 * (`port-windows.ts`). None of them imports back into the capability. See
 * `processes.ts` for the contract.
 */

import type { ProcessCensusEntry } from '../../agent-farm/servers/process-census.js';
import { windowsCensus } from '../../agent-farm/servers/process-census-windows.js';
import { getWindowsProcessesOnPort, getWindowsProcessesOnPortAsync } from '../../agent-farm/utils/port-windows.js';
import { killWindowsTree, waitForWindowsTreeExit } from '../process-tree-windows.js';
import type { Processes, StartTimeLookup } from './processes.js';

/**
 * A start-time lookup answered from an existing census snapshot's creation
 * times, with no process spawned per PID. A PID absent from the snapshot, or
 * without a creation time, reads as unknown (null).
 */
function censusStartTimeLookup(census: ProcessCensusEntry[]): StartTimeLookup {
  const created = new Map<number, number>();
  for (const entry of census) {
    if (entry.creationTime !== undefined) created.set(entry.pid, entry.creationTime);
  }
  return async (pid) => created.get(pid) ?? null;
}

export const windowsProcesses: Processes = Object.freeze<Processes>({
  census(read) {
    // Rejects on failure: the census is load-bearing for teardown and the sweeps.
    return windowsCensus(read);
  },

  startTime() {
    // No per-PID probe on Windows (start times come from the census).
    return Promise.resolve(null);
  },

  startTimeLookup(census) {
    // The census already carries creation time, so one census serves the whole sweep.
    return censusStartTimeLookup(census);
  },

  listeningPids(port) {
    return getWindowsProcessesOnPort(port);
  },

  listeningPidsAsync(port) {
    return getWindowsProcessesOnPortAsync(port);
  },

  killTree(rootPid, opts) {
    return killWindowsTree(rootPid, opts);
  },

  waitForTreeExit(rootPid, snapshot, timeoutMs, opts) {
    return waitForWindowsTreeExit(rootPid, snapshot, timeoutMs, opts);
  },

  isConsoleInfrastructure(entry) {
    // The console host ConPTY runs under a PTY owner (`conhost.exe --headless`,
    // or `OpenConsole.exe` when node-pty ships its own).
    const cmdline = entry.cmdline.toLowerCase();
    return cmdline.includes('--headless') && (cmdline.includes('conhost.exe') || cmdline.includes('openconsole.exe'));
  },
});
