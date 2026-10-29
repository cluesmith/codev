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

import { execFile } from 'node:child_process';
import { isWindows, windowsSystem32Path } from './platform.js';
import { listProcessCensus, type ProcessCensusEntry } from '../agent-farm/servers/process-census.js';
import { terminateSessionJob, type JobResult } from './windows-job.js';

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

const TASKKILL_TIMEOUT_MS = 10_000;

/**
 * How far a caller's recorded start time may sit from the census creation time
 * and still be the same process. Matches the reconnect PID-reuse tolerance: a
 * shellper records `Date.now()` after Node boots, a little after creation.
 */
export const ROOT_START_TOLERANCE_MS = 2000;

function defaultKill(pid: number, signal: NodeJS.Signals | 0): void {
  process.kill(pid, signal);
}

/** Teardown reads the table now: a cached copy can miss a just-started child or show a just-killed one. */
function freshCensus(): Promise<ProcessCensusEntry[]> {
  return listProcessCensus({ fresh: true });
}

function runTaskkill(pid: number): Promise<void> {
  return new Promise((resolve) => {
    // Exit 128 ("process not found") is expected when the root already died;
    // the snapshot pass covers that case, so every outcome resolves.
    execFile(windowsSystem32Path('taskkill.exe'), ['/T', '/F', '/PID', String(pid)], { timeout: TASKKILL_TIMEOUT_MS, windowsHide: true }, () => {
      resolve();
    });
  });
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
  if (isWindows()) return killWindowsTree(rootPid, opts);
  return Promise.resolve(killPosixGroup(rootPid, opts));
}

function killPosixGroup(rootPid: number, opts: KillSessionTreeOptions): KillSessionTreeResult {
  const kill = opts.kill ?? defaultKill;
  const signal = opts.signal ?? 'SIGTERM';
  let signaled = false;
  try {
    kill(-rootPid, signal);
    signaled = true;
  } catch {
    if (opts.fallbackToPid) {
      try {
        kill(rootPid, signal);
        signaled = true;
      } catch {
        // Already dead
      }
    }
  }
  if (signaled && opts.escalateAfterMs !== undefined) {
    setTimeout(() => {
      try {
        kill(-rootPid, 'SIGKILL');
      } catch {
        // Already dead
      }
    }, opts.escalateAfterMs);
  }
  return { signaled, snapshot: { rootPid, members: [] } };
}

/**
 * The root (when present in the census) and every process descended from it,
 * following ppid links. A child whose creation time precedes its recorded
 * parent's cannot be that parent's child: Windows keeps a dead parent's pid as
 * the ppid, and that pid may since have been reused. For a dead root the anchor
 * is `rootStartTime` when known; without it, ppid-matching processes are taken
 * as the root's children. The calling process is never included.
 */
export function collectTree(census: ProcessCensusEntry[], rootPid: number, rootStartTime?: number): TreeMember[] {
  const childrenOf = new Map<number, ProcessCensusEntry[]>();
  for (const entry of census) {
    if (entry.pid === entry.ppid) continue;
    const siblings = childrenOf.get(entry.ppid);
    if (siblings) {
      siblings.push(entry);
    } else {
      childrenOf.set(entry.ppid, [entry]);
    }
  }

  const members: TreeMember[] = [];
  const seen = new Set<number>([rootPid]);
  const root = census.find((entry) => entry.pid === rootPid);
  if (root && root.pid !== process.pid) {
    members.push({ pid: root.pid, creationTime: root.creationTime ?? null });
  }

  // A dead root has no census entry; a caller-known start time still anchors
  // which ppid-matching processes can be its children.
  let rootCreated: number | null = root?.creationTime ?? null;
  if (rootCreated === null && rootStartTime !== undefined) {
    rootCreated = rootStartTime - ROOT_START_TOLERANCE_MS;
  }
  const queue: TreeMember[] = [{ pid: rootPid, creationTime: rootCreated }];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const child of childrenOf.get(parent.pid) ?? []) {
      if (seen.has(child.pid)) continue;
      const childCreated = child.creationTime ?? null;
      if (parent.creationTime !== null && childCreated !== null && childCreated < parent.creationTime) continue;
      seen.add(child.pid);
      const member = { pid: child.pid, creationTime: childCreated };
      queue.push(member);
      if (child.pid !== process.pid) members.push(member);
    }
  }
  return members;
}

function isAliveWith(kill: (pid: number, signal: 0) => void, pid: number): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Members of `snapshot` that are still the same process: present in `census`
 * with the recorded creation time. A member recorded without a creation time
 * cannot be told from a reused pid, so it never matches.
 */
function sameProcesses(snapshot: TreeMember[], census: ProcessCensusEntry[]): TreeMember[] {
  const createdByPid = new Map(census.map((entry) => [entry.pid, entry.creationTime ?? null]));
  return snapshot.filter((member) => {
    if (member.creationTime === null) return false;
    return createdByPid.get(member.pid) === member.creationTime;
  });
}

/**
 * Why the census cannot confirm a live root is the caller's process, when the
 * caller knows its start time: a different creation time (the pid was reused),
 * or none at all (unverifiable). Null when the root checks out or the caller
 * gave no start time.
 */
function rootIdentityFailure(root: ProcessCensusEntry, rootStartTime: number | undefined): 'reused-pid' | 'unverified-root' | null {
  if (rootStartTime === undefined) return null;
  if (root.creationTime === undefined) return 'unverified-root';
  if (Math.abs(root.creationTime - rootStartTime) > ROOT_START_TOLERANCE_MS) return 'reused-pid';
  return null;
}

interface JobTeardown {
  /** The job existed, held the root, and was terminated. */
  terminated: boolean;
  /** The job helper was asked (a round trip that can take seconds), whatever it answered. */
  attempted: boolean;
  /** Why terminating it failed, when that needs reporting. */
  error?: string;
}

/**
 * Whether `recorded` is still the same process on a fresh census: present,
 * with the same creation time when one was recorded. A census failure answers
 * false, so an unverifiable pid is not tree-killed. The kill pass that follows
 * reads the census again only when a recorded member still answers, and then
 * rejects if that read fails too; otherwise the skipped root is not reported.
 */
async function isSameProcess(census: () => Promise<ProcessCensusEntry[]>, recorded: ProcessCensusEntry): Promise<boolean> {
  let fresh: ProcessCensusEntry[];
  try {
    fresh = await census();
  } catch {
    return false;
  }
  const now = fresh.find((entry) => entry.pid === recorded.pid);
  if (!now) return false;
  if (recorded.creationTime === undefined) return true;
  return now.creationTime === recorded.creationTime;
}

/** Terminate the session job, if one is named and the root is in it. */
async function terminateJobFor(rootPid: number, opts: KillSessionTreeOptions): Promise<JobTeardown> {
  if (opts.jobName === undefined) return { terminated: false, attempted: false };
  const result = await (opts.terminateJob ?? terminateSessionJob)(opts.jobName, rootPid);
  if (result.ok) return { terminated: result.member === true, attempted: true };
  if (result.disabled) return { terminated: false, attempted: false };
  let error = `job ${opts.jobName} not terminated: ${result.error ?? 'unknown failure'}`;
  if (result.code !== undefined) error = `${error} (Win32 error ${result.code})`;
  return { terminated: false, attempted: true, error };
}

/** What became of the session job, for an error raised after it was handled. */
function jobNote(job: JobTeardown): string {
  if (job.error !== undefined) return `; ${job.error}`;
  if (job.terminated) return '; its session job was terminated';
  return '';
}

async function killWindowsTree(rootPid: number, opts: KillSessionTreeOptions): Promise<KillSessionTreeResult> {
  const census = opts.census ?? freshCensus;
  const taskkill = opts.taskkill ?? runTaskkill;
  const kill = opts.kill ?? defaultKill;

  // The snapshot is taken BEFORE the job ends. The job allows breakaway (Phase
  // 3b), and a child that broke away (the MSYS runtime starts native programs
  // that way) survives the job, while its parents inside the job die with it;
  // a snapshot taken afterwards would no longer link it to the root.
  let snapshotCensus: ProcessCensusEntry[] | null = null;
  let censusError: Error | null = null;
  try {
    snapshotCensus = await census();
  } catch (err) {
    censusError = err as Error;
  }

  // The job holds exactly this session's processes (the name carries the
  // session id, an existing name is never joined, and the helper terminates
  // it only when the root is a member), so it needs no creation-time check: a
  // reused pid's process is not in it.
  const job = await terminateJobFor(rootPid, opts);
  const jobError = job.error;

  if (snapshotCensus === null) {
    await taskkill(rootPid);
    throw new Error(`teardown of pid ${rootPid} ran taskkill only, without a descendant snapshot: ${censusError?.message}${jobNote(job)}`);
  }

  const root = snapshotCensus.find((entry) => entry.pid === rootPid);
  const identityFailure = root ? rootIdentityFailure(root, opts.rootStartTime) : null;
  if (identityFailure === 'reused-pid') {
    const refused: KillSessionTreeResult = { signaled: false, snapshot: { rootPid, members: [] }, refused: 'reused-pid' };
    if (jobError !== undefined) refused.jobError = jobError;
    return refused;
  }
  if (identityFailure === 'unverified-root') {
    // Stays closed even with `fallbackToPid`: that option retries a failed
    // POSIX group signal on the same trusted pid, while here the pid itself
    // is unverified, and killing it alone could still hit a reused pid.
    throw new Error(
      `teardown of pid ${rootPid} skipped: the census has no creation time for it, so it cannot be told from a reused pid; its tree is left alive${jobNote(job)}`,
    );
  }
  const members = collectTree(snapshotCensus, rootPid, opts.rootStartTime);

  // A root absent from the census is already dead; `taskkill` on its pid could
  // only reach a process that reused it since. The job round trip can take
  // seconds, and a terminated job usually takes the root with it, so after one
  // the root is checked again on a fresh census: `/T` on a pid reused in that
  // window would kill an unrelated process and its whole tree.
  if (root) {
    let rootUnchanged = true;
    if (job.attempted) rootUnchanged = await isSameProcess(census, root);
    if (rootUnchanged) await taskkill(rootPid);
  }

  const alive = members.filter((member) => isAliveWith(kill, member.pid));
  if (alive.length > 0) {
    // Re-read the table: only a pid that is still the same process (same
    // creation time) is killed, never one reused since the snapshot.
    for (const member of sameProcesses(alive, await census())) {
      try {
        kill(member.pid, 'SIGKILL');
      } catch {
        // Exited in the meantime
      }
    }
  }
  // The job usually ends the tree before the kill pass, so the snapshot alone
  // could report nothing killed.
  const result: KillSessionTreeResult = { signaled: members.length > 0 || job.terminated, snapshot: { rootPid, members } };
  if (jobError !== undefined) result.jobError = jobError;
  return result;
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
export async function waitForTreeExit(
  rootPid: number,
  snapshot: TreeSnapshot,
  timeoutMs: number,
  opts: WaitForTreeExitOptions = {},
): Promise<boolean> {
  const pollMs = opts.pollMs ?? 100;
  const kill = opts.kill ?? defaultKill;
  const deadline = Date.now() + timeoutMs;

  if (!isWindows()) {
    while (Date.now() < deadline) {
      try {
        kill(-rootPid, 0);
      } catch {
        return true; // Group is empty
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return false;
  }

  let alive = snapshot.members;
  while (Date.now() < deadline) {
    alive = alive.filter((member) => isAliveWith(kill, member.pid));
    if (alive.length === 0) return true;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  alive = alive.filter((member) => isAliveWith(kill, member.pid));
  if (alive.length === 0) return true;
  try {
    return sameProcesses(alive, await (opts.census ?? freshCensus)()).length === 0;
  } catch {
    return false;
  }
}
