/**
 * Processes capability (Spec 1658, Amendment 2, phase A2-3).
 *
 * How the host lists, inspects and ends processes: the census, start times,
 * listening ports, session-tree teardown and the wait for it, and which census
 * entries are console infrastructure. Shared code asks `processes()` (through
 * the existing entry points `listProcessCensus`, `killSessionTree`,
 * `waitForTreeExit`, `getProcessesOnPort`, `getProcessStartTime`) instead of
 * choosing a platform. The POSIX implementation is the macOS/Linux code those
 * entry points carried, moved verbatim; the Windows implementation calls the
 * Windows modules beside it (`windows/process-census.ts`, `windows/process-tree.ts`,
 * `windows/port-query.ts`), which import nothing that reaches back here except
 * the census types below.
 *
 * Behaviours each implementation keeps: the POSIX census resolves `[]` when `ps`
 * fails while the Windows census rejects; the POSIX `killTree` signals
 * synchronously, before its promise settles.
 */

import type { KillSessionTreeOptions, KillSessionTreeResult, TreeSnapshot, WaitForTreeExitOptions } from '../process-tree.js';
import { isWindows } from '../platform.js';
import { posixProcesses } from './posix/processes.js';
import { windowsProcesses } from './windows/processes.js';

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

/**
 * Snapshot every running process. POSIX resolves to `[]` when `ps` fails. On
 * Windows a failure REJECTS: the census is load-bearing for teardown and the
 * sweeps (Spec 1658), so an unreadable process table must surface as an error
 * rather than look like a machine with no processes.
 */
/** Looks up a process's start time (epoch ms), or null when it cannot be read. */
export type StartTimeLookup = (pid: number) => Promise<number | null>;

export interface Processes {
  /** Snapshot every running process (listProcessCensus). */
  census(read?: CensusReadOptions): Promise<ProcessCensusEntry[]>;
  /** A process's start time, epoch ms, or null when it cannot be read (getProcessStartTime). */
  startTime(pid: number): Promise<number | null>;
  /** The start-time source for a sweep over `census` (startTimeLookupFor). */
  startTimeLookup(census: ProcessCensusEntry[]): StartTimeLookup;
  /** PIDs listening on `port` (getProcessesOnPort). */
  listeningPids(port: number): number[];
  /** `listeningPids` for callers inside Tower's event loop; null when the lookup itself failed. */
  listeningPidsAsync(port: number): Promise<number[] | null>;
  /** Kill `rootPid` and its descendants (killSessionTree). */
  killTree(rootPid: number, opts: KillSessionTreeOptions): Promise<KillSessionTreeResult>;
  /** Resolve true once the tree is gone, false when `timeoutMs` passes first (waitForTreeExit). */
  waitForTreeExit(rootPid: number, snapshot: TreeSnapshot, timeoutMs: number, opts: WaitForTreeExitOptions): Promise<boolean>;
  /** Whether a census entry is console infrastructure rather than a child program (isConsoleHostEntry). */
  isConsoleInfrastructure(entry: ProcessCensusEntry): boolean;
}

/** The host's processes implementation. */
export function processes(): Processes {
  if (isWindows()) {
    return windowsProcesses;
  }
  return posixProcesses;
}
