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
 *   anything started after the snapshot.
 */

import { execFile } from 'node:child_process';
import { isWindows } from './platform.js';
import { listProcessCensus, type ProcessCensusEntry } from '../agent-farm/servers/process-census.js';

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
  /** Seam: the process census (must read the table fresh, never a cached copy). */
  census?: () => Promise<ProcessCensusEntry[]>;
  /** Seam (Windows): `taskkill /T /F /PID <pid>`; must not reject. */
  taskkill?: (pid: number) => Promise<void>;
  /** Seam: signal delivery. */
  kill?: (pid: number, signal: NodeJS.Signals | 0) => void;
}

export interface KillSessionTreeResult {
  /** True when something was signaled (POSIX) or there was a live tree to kill (Windows). */
  signaled: boolean;
  snapshot: TreeSnapshot;
}

const TASKKILL_TIMEOUT_MS = 10_000;

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
    execFile('taskkill', ['/T', '/F', '/PID', String(pid)], { timeout: TASKKILL_TIMEOUT_MS, windowsHide: true }, () => {
      resolve();
    });
  });
}

/**
 * Kill `rootPid` and its descendants.
 *
 * POSIX runs synchronously before the returned promise settles, so the signals
 * leave in the same tick as the old inline `process.kill(-pid)` calls. On
 * Windows a census failure still runs `taskkill /T /F` on the root, then
 * rejects so the caller can report that the snapshot pass did not run.
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
 * the ppid, and that pid may since have been reused. The calling process is
 * never included.
 */
export function collectTree(census: ProcessCensusEntry[], rootPid: number): TreeMember[] {
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

  const queue: TreeMember[] = [{ pid: rootPid, creationTime: root?.creationTime ?? null }];
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

async function killWindowsTree(rootPid: number, opts: KillSessionTreeOptions): Promise<KillSessionTreeResult> {
  const census = opts.census ?? freshCensus;
  const taskkill = opts.taskkill ?? runTaskkill;
  const kill = opts.kill ?? defaultKill;

  let members: TreeMember[];
  try {
    members = collectTree(await census(), rootPid);
  } catch (err) {
    await taskkill(rootPid);
    throw new Error(`teardown of pid ${rootPid} ran taskkill only, without a descendant snapshot: ${(err as Error).message}`);
  }

  await taskkill(rootPid);

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
  return { signaled: members.length > 0, snapshot: { rootPid, members } };
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
