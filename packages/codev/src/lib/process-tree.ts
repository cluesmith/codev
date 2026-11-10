/**
 * Session-tree teardown (Spec 1658, Area B1).
 *
 * Every place that used to signal a POSIX process group (`process.kill(-pid)`)
 * goes through `killSessionTree`, and every place that waited for a group to
 * empty goes through `waitForTreeExit`.
 *
 * - POSIX: exactly today's behavior. The root leads its own process group
 *   (spawned `detached: true`), so one group signal reaches every descendant.
 * - Windows: there are no process groups and every signal is a hard kill. A
 *   census snapshot of the root's descendants (pid, ppid, creation time) is
 *   taken BEFORE killing, then `taskkill /T /F` kills the tree it can still
 *   walk, then each recorded descendant that is still alive with the same
 *   creation time is killed explicitly. `taskkill /T` walks parent links, so a
 *   process whose parent exited between the snapshot and the kill escapes it,
 *   and when the root itself is already dead it walks nothing; the snapshot
 *   closes both gaps. The orphan and husk sweeps remain the backstop for
 *   anything started after the snapshot. With the session's Job Object
 *   (Phase 3b), the job is terminated before `taskkill`, reaching descendants
 *   no parent link leads to.
 */

import { processes } from './platform/processes.js';
import type { ProcessCensusEntry } from '../agent-farm/servers/process-census.js';
import type { JobResult } from './windows-job.js';

export { collectTree, ROOT_START_TOLERANCE_MS } from './process-tree-windows.js';

/** A process recorded by a teardown snapshot. */
export interface TreeMember {
  pid: number;
  /** Creation time from the census, epoch ms; null when the census had none. */
  creationTime: number | null;
}

/**
 * The processes a teardown targeted. On Windows, the root (when it was alive)
 * and every descendant the census showed before the kill. Empty on POSIX,
 * where the process group is the tracking mechanism.
 */
export interface TreeSnapshot {
  rootPid: number;
  members: TreeMember[];
}

export interface KillSessionTreeOptions {
  /** POSIX: the signal sent to the group. Default SIGTERM. Windows kills outright. */
  signal?: NodeJS.Signals;
  /** POSIX: when the first signal landed, SIGKILL the group after this delay. */
  escalateAfterMs?: number;
  /** POSIX: when the group signal fails, signal the root pid alone. */
  fallbackToPid?: boolean;
  /**
   * Windows: when the root was started (epoch ms), if the caller knows it. A
   * root found in the census whose creation time differs by more than
   * ROOT_START_TOLERANCE_MS is a reused pid, and nothing is killed (result
   * `refused: 'reused-pid'`). A root with no creation time to compare cannot
   * be verified, so nothing is killed and the call rejects. With the
   * root already dead, it also anchors which ppid-matching processes count as
   * the root's children.
   */
  rootStartTime?: number;
  /**
   * Windows: the session's Job Object (Spec 1658 Phase 3b). When given, the job
   * is terminated first, which also ends descendants the census cannot link
   * (a parent that exited); the snapshot pass then runs as before. Ignored on
   * POSIX.
   */
  jobName?: string;
  /** Seam (Windows): terminate a job by name, only if the root pid is in it. */
  terminateJob?: (name: string, rootPid: number) => Promise<JobResult>;
  /** Seam: the process census (must read the table fresh, never a cached copy). */
  census?: () => Promise<ProcessCensusEntry[]>;
  /** Seam (Windows): `taskkill /T /F /PID <pid>`; must not reject. */
  taskkill?: (pid: number) => Promise<void>;
  /** Seam: signal delivery. */
  kill?: (pid: number, signal: NodeJS.Signals | 0) => void;
}

export interface KillSessionTreeResult {
  /**
   * True when something was signaled (POSIX) or there was a live tree to kill
   * (Windows: the snapshot found one, or the session job was terminated).
   */
  signaled: boolean;
  snapshot: TreeSnapshot;
  /**
   * Windows: set when the root's identity check refused the kill because the
   * census shows a different process on that pid. Expected and harmless: the
   * session's own root is gone.
   */
  refused?: 'reused-pid';
  /**
   * Windows, with `jobName`: why terminating the job failed. The snapshot pass
   * still ran; the caller reports this, since orphans may survive. Not set
   * when jobs are disabled outright: that was reported once, when it happened.
   */
  jobError?: string;
}

/**
 * Kill `rootPid` and its descendants.
 *
 * POSIX runs synchronously before the returned promise settles, so the signals
 * leave in the same tick as the old inline `process.kill(-pid)` calls, and it
 * trusts the caller's pid exactly as those calls did.
 *
 * Windows checks the root's identity first: `taskkill` runs only on a root the
 * census shows alive (and, given `rootStartTime`, with a matching creation
 * time), so a reused pid's unrelated tree is never killed. A census failure
 * leaves nothing to check against; the root then gets `taskkill /T /F` on the
 * caller's word, as POSIX would signal it, and the call rejects so the caller
 * can report that the snapshot pass did not run. A live root the census lists
 * without a creation time, when the caller gave `rootStartTime`, is left alive
 * and the call rejects: that is a degraded census, and the leak must be
 * reported, not read as "nothing to kill".
 */
export function killSessionTree(rootPid: number, opts: KillSessionTreeOptions = {}): Promise<KillSessionTreeResult> {
  return processes().killTree(rootPid, opts);
}

export interface WaitForTreeExitOptions {
  pollMs?: number;
  /** Seam: liveness probe (`process.kill(pid, 0)` by default). */
  kill?: (pid: number, signal: 0) => void;
  /** Seam (Windows): fresh census for the final creation-time check. */
  census?: () => Promise<ProcessCensusEntry[]>;
}

/**
 * Resolve true once the tree is gone, false when `timeoutMs` passes first.
 *
 * - POSIX: probes the process group (`process.kill(-rootPid, 0)`); the
 *   snapshot is unused.
 * - Windows: probes each snapshot member. At the deadline, members that still
 *   answer are checked against a fresh census, so a pid reused by an unrelated
 *   process does not count as a survivor.
 */
export function waitForTreeExit(
  rootPid: number,
  snapshot: TreeSnapshot,
  timeoutMs: number,
  opts: WaitForTreeExitOptions = {},
): Promise<boolean> {
  return processes().waitForTreeExit(rootPid, snapshot, timeoutMs, opts);
}
