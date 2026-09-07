/**
 * Port → PID lookup.
 *
 * A leaf module on purpose: `codev doctor` needs this to find the running Tower
 * (#1219), and reaching into `agent-farm/commands/tower.ts` for it would drag
 * that command's whole import graph — `promisify(exec)` at module scope
 * included — into the doctor tests. `commands/tower.ts` re-exports it, so its
 * existing consumers are unaffected.
 */

import { execSync } from 'node:child_process';

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
