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

import { processes } from '../../lib/platform/processes.js';

export interface ProcessCensusEntry {
  pid: number;
  ppid: number;
  /** Resident set size in kilobytes, as `ps -o rss=` reports it (working set on Windows). */
  rssKb: number;
  /**
   * The full joined argv (as `ps ... -o args=` reports it). On Windows this is
   * the raw command line, still carrying its argv quoting; a process whose
   * command line the current user cannot read reports `''` ("not ours").
   */
  cmdline: string;
  /**
   * Process creation time, epoch ms. Set by the Windows provider (Spec 1658),
   * where it is what tells a live PID from a reused one; the POSIX provider
   * leaves it unset and callers use `getProcessStartTime` there.
   */
  creationTime?: number;
}

export interface CensusReadOptions {
  /**
   * Read the table now, bypassing the Windows TTL cache and any query already
   * in flight. Teardown needs this: a snapshot must include processes started
   * a moment ago, and its re-check must see processes that just died.
   */
  fresh?: boolean;
}

export {
  WINDOWS_CENSUS_QUERY,
  WINDOWS_CENSUS_TIMEOUT_MS,
  WINDOWS_CENSUS_TTL_MS,
  parseWindowsCensus,
  createWindowsCensusProvider,
  type PowerShellExec,
  type WindowsCensusProviderOptions,
} from './process-census-windows.js';

/**
 * Snapshot every running process. POSIX resolves to `[]` when `ps` fails. On
 * Windows a failure REJECTS: the census is load-bearing for teardown and the
 * sweeps (Spec 1658), so an unreadable process table must surface as an error
 * rather than look like a machine with no processes.
 */
export function listProcessCensus(read?: CensusReadOptions): Promise<ProcessCensusEntry[]> {
  return processes().census(read);
}
