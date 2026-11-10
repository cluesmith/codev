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
 * existing Windows modules (`process-census-windows.ts`, `process-tree-windows.ts`,
 * `port-windows.ts`), which import nothing that reaches back here.
 *
 * Behaviours each implementation keeps: the POSIX census resolves `[]` when `ps`
 * fails while the Windows census rejects; the POSIX `killTree` signals
 * synchronously, before its promise settles.
 */

import type { CensusReadOptions, ProcessCensusEntry } from '../../agent-farm/servers/process-census.js';
import type { KillSessionTreeOptions, KillSessionTreeResult, TreeSnapshot, WaitForTreeExitOptions } from '../process-tree.js';
import { isWindows } from '../platform.js';
import { posixProcesses } from './processes.posix.js';
import { windowsProcesses } from './processes.windows.js';

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
