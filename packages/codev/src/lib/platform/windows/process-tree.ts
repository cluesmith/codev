/**
 * Session-tree teardown on native Windows (Spec 1658, Area B1): census snapshot
 * of the root's descendants, session Job Object termination, `taskkill /T /F`,
 * then a creation-time-checked kill of each recorded survivor. See
 * `process-tree.ts` for the whole picture. The Windows implementation of the
 * processes capability (`platform/processes.windows.ts`) calls in here; this
 * module imports only types from `process-tree.ts`, so it never reaches the
 * capability accessor (no cycle).
 */

import { execFile } from 'node:child_process';
import { windowsSystem32Path } from '../../platform.js';
import { windowsCensus } from './process-census.js';
import type { ProcessCensusEntry } from '../processes.js';
import { WindowsJobHelper, getTowerJobHelper, type JobMembersOutcome } from './job-objects.js';
import { protectedInfrastructure } from './codev-infrastructure.js';
import type {
  KillSessionTreeOptions,
  KillSessionTreeResult,
  TreeMember,
  TreeSnapshot,
  WaitForTreeExitOptions,
} from '../../process-tree.js';

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
  return windowsCensus({ fresh: true });
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

/** Terminate the session job (named, and holding the root). */
async function terminateJobFor(rootPid: number, jobName: string, terminateJob: NonNullable<KillSessionTreeOptions['terminateJob']>): Promise<JobTeardown> {
  const result = await terminateJob(jobName, rootPid);
  if (result.ok) return { terminated: result.member === true, attempted: true };
  if (result.disabled) return { terminated: false, attempted: false };
  let error = `job ${jobName} not terminated: ${result.error ?? 'unknown failure'}`;
  if (result.code !== undefined) error = `${error} (Win32 error ${result.code})`;
  return { terminated: false, attempted: true, error };
}

/**
 * The Tower and shellper processes (other than the root) in the root's tree or
 * its session job, with their descendants (#1915). Session jobs allow no
 * breakaway, so a Tower started from inside a session by a plain spawn is a
 * member of that session's job, with every shellper it creates: terminating
 * the job, or `taskkill /T` along live parent links, would end Tower and other
 * sessions with this one.
 */
function infrastructureGuard(census: ProcessCensusEntry[], rootPid: number, tree: TreeMember[], jobPids: number[]): Set<number> {
  const candidates = new Set([...tree.map((member) => member.pid), ...jobPids]);
  return protectedInfrastructure(census, rootPid, candidates);
}

/**
 * What the job listing says the teardown may do with the session job (#1915):
 * - `member`: the job exists and holds the root; it may be terminated once
 *   the guard finds no Tower or other session in it.
 * - `none`: no job is named, none exists, the root is not in it, or jobs are
 *   disabled (reported once already): nothing to terminate, and no job round
 *   trip, so no root re-check either.
 * - `unlisted`: the listing failed. Fail closed: the job is never terminated,
 *   since nothing then shows it holds no Tower or other session; the tree
 *   teardown still runs.
 */
type JobState =
  | { kind: 'member'; pids: number[] }
  | { kind: 'none' }
  | { kind: 'unlisted'; error: string };

function jobState(listing: JobMembersOutcome | null): JobState {
  if (listing === null) return { kind: 'none' };
  if (!listing.ok) {
    if (listing.disabled) return { kind: 'none' };
    return { kind: 'unlisted', error: listing.error };
  }
  if (!listing.found || !listing.member) return { kind: 'none' };
  return { kind: 'member', pids: listing.processes.map((p) => p.pid) };
}

/** What became of the session job, for an error raised after it was handled. */
function jobNote(job: JobTeardown): string {
  if (job.error !== undefined) return `; ${job.error}`;
  if (job.terminated) return '; its session job was terminated';
  return '';
}

export async function killWindowsTree(rootPid: number, opts: KillSessionTreeOptions): Promise<KillSessionTreeResult> {
  // One job helper per teardown: Tower's warm one, else a single one-shot for
  // both the listing and the terminate (a cold PowerShell start each would
  // double the teardown's wait on a loaded machine).
  const pool: { oneShot: WindowsJobHelper | null } = { oneShot: null };
  const helper = (): WindowsJobHelper => {
    const tower = getTowerJobHelper();
    if (tower) return tower;
    pool.oneShot ??= new WindowsJobHelper();
    return pool.oneShot;
  };
  try {
    return await killWindowsTreeWith(rootPid, opts, {
      jobMembers: opts.jobMembers ?? ((name, root) => helper().jobMembers(name, root)),
      terminateJob: opts.terminateJob ?? ((name, root) => helper().terminate(name, root)),
    });
  } finally {
    pool.oneShot?.stop();
  }
}

async function killWindowsTreeWith(
  rootPid: number,
  opts: KillSessionTreeOptions,
  jobs: Required<Pick<KillSessionTreeOptions, 'jobMembers' | 'terminateJob'>>,
): Promise<KillSessionTreeResult> {
  const census = opts.census ?? freshCensus;
  const taskkill = opts.taskkill ?? runTaskkill;
  const kill = opts.kill ?? defaultKill;

  // The snapshot is taken BEFORE the job ends. A session job allows no
  // breakaway (#1915), but a session created by an older Tower still has a job
  // that does (the MSYS runtime breaks native programs out of it), and a
  // process outside the job survives it while its parents inside die; a
  // snapshot taken afterwards would no longer link it to the root.
  let snapshotCensus: ProcessCensusEntry[] | null = null;
  let censusError: Error | null = null;
  try {
    snapshotCensus = await census();
  } catch (err) {
    censusError = err as Error;
  }

  // One listing of the session job drives the job half of teardown (#1915).
  const state = jobState(opts.jobName === undefined ? null : await jobs.jobMembers(opts.jobName, rootPid));

  // Codev infrastructure inside the root's tree or job must outlive this
  // session: then the job is not terminated and `taskkill /T` is not run; the
  // session's own processes are killed one by one instead.
  let protectedPids = new Set<number>();
  if (snapshotCensus !== null) {
    const jobPids = state.kind === 'member' ? state.pids : [];
    protectedPids = infrastructureGuard(snapshotCensus, rootPid, collectTree(snapshotCensus, rootPid, opts.rootStartTime), jobPids);
  }
  const guarded = protectedPids.size > 0;

  // The job holds exactly this session's processes (the name carries the
  // session id, an existing name is never joined, and the helper terminates
  // it only when the root is a member), so it needs no creation-time check: a
  // reused pid's process is not in it. It is terminated only when the listing
  // and the census both show it holds no Tower or other session.
  let job: JobTeardown = { terminated: false, attempted: false };
  if (guarded) {
    const pids = [...protectedPids].sort((a, b) => a - b).join(', ');
    const what = opts.jobName === undefined ? 'its tree' : `job ${opts.jobName}`;
    job.error = `${what} holds Tower or another session's shellper (pids ${pids}), which must outlive this session: ended only this session's own process tree, one by one`;
  } else if (state.kind === 'unlisted') {
    job.error = `job ${opts.jobName} not terminated: its processes could not be listed (${state.error}), so nothing shows it holds no Tower or other session; ended this session's tree only`;
  } else if (state.kind === 'member' && snapshotCensus === null) {
    job.error = `job ${opts.jobName} not terminated: without a process census it cannot be checked for Tower or another session`;
  } else if (state.kind === 'member') {
    job = await terminateJobFor(rootPid, opts.jobName!, jobs.terminateJob);
  }
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
  // Guarded: only what hangs off the root by live parent links, minus the
  // protected. Other job members are left, even this session's orphans: a
  // process the census could not recognize might be Tower's.
  let members = collectTree(snapshotCensus, rootPid, opts.rootStartTime);
  if (guarded) members = members.filter((member) => !protectedPids.has(member.pid));

  // A root absent from the census is already dead; `taskkill` on its pid could
  // only reach a process that reused it since. The job round trip can take
  // seconds, and a terminated job usually takes the root with it, so after one
  // the root is checked again on a fresh census: `/T` on a pid reused in that
  // window would kill an unrelated process and its whole tree.
  if (root && !guarded) {
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

/** `waitForTreeExit` on Windows: probes each snapshot member; at the deadline, survivors are checked against a fresh census. */
export async function waitForWindowsTreeExit(
  _rootPid: number,
  snapshot: TreeSnapshot,
  timeoutMs: number,
  opts: WaitForTreeExitOptions = {},
): Promise<boolean> {
  const pollMs = opts.pollMs ?? 100;
  const kill = opts.kill ?? defaultKill;
  const deadline = Date.now() + timeoutMs;

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
