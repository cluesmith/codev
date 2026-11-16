/**
 * Issue #1227: a shared single-`ps`-call process snapshot, reused by both the
 * shellper husk sweep (predicate needs pid/ppid to detect "childless") and the
 * fleet-RSS observability feature (needs rss). Centralizing the scan avoids
 * growing a fourth bespoke `ps` caller alongside the three that already exist
 * (session-manager.ts, architect-session-holder.ts, commands/cleanup.ts).
 *
 * Async (`execFile`, not `execFileSync`) is load-bearing, not a style choice:
 * this is called from `/health` (tower-routes.ts), a hot Tower HTTP path.
 * `execFileSync` blocks the entire Node.js event loop for the duration of the
 * `ps` call, freezing every open terminal's WebSocket traffic — the exact
 * previously-fixed anti-pattern documented at lessons-learned.md:160
 * ("execSync in HTTP request handlers blocks the entire Node.js event loop").
 */

import { processes, type CensusReadOptions, type ProcessCensusEntry } from '../../lib/platform/processes.js';

// The census types live with the processes capability, so lib/ never imports agent-farm/.
export type { CensusReadOptions, ProcessCensusEntry };

export function listProcessCensus(read?: CensusReadOptions): Promise<ProcessCensusEntry[]> {
  return processes().census(read);
}
