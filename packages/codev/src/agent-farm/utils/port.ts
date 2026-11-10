/**
 * Port → PID lookup.
 *
 * A leaf module on purpose: `codev doctor` needs this to find the running Tower
 * (#1219), and reaching into `agent-farm/commands/tower.ts` for it would drag
 * that command's whole import graph — `promisify(exec)` at module scope
 * included — into the doctor tests. `commands/tower.ts` re-exports it, so its
 * existing consumers are unaffected. On Windows the lookup is `Get-NetTCPConnection` (`port-windows.ts`); the
 * platform choice is the processes capability's (Spec 1658, Amendment 2).
 */

import { processes } from '../../lib/platform/processes.js';

export { parsePidLines } from './port-windows.js';

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
  return processes().listeningPids(port);
}

/**
 * `getProcessesOnPort` for callers inside Tower's event loop. POSIX: the same
 * `lsof` lookup. Windows: the same query, run asynchronously, because it takes
 * seconds and the synchronous form would stall every terminal and request
 * while it runs (Spec 1658 Phase 9). Windows resolves null when the query
 * itself fails or times out, so a caller can tell "unknown" from "nothing
 * listening"; POSIX keeps `lsof`'s `[]` for both.
 */
export function getProcessesOnPortAsync(port: number): Promise<number[] | null> {
  return processes().listeningPidsAsync(port);
}
