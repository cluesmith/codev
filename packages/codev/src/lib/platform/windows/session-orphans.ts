/**
 * Which processes in a session's job count as orphaned (#1915). Pure
 * functions; Tower supplies the job listing and the protected set.
 *
 * When an agent's tool call times out, the agent's tooling ends the shell it
 * started but not that shell's children, which keep running in the session's
 * job with no living parent. Session jobs allow no breakaway (#1915), so the
 * job holds everything the session started, and membership is a kernel fact:
 * a process outside the job is never considered.
 *
 * A member is an orphan when all hold:
 * - it is alive and its creation time could be read,
 * - it is not the session root, and not protected (Tower, Tower's helper and
 *   IDE server, every session root Tower knows, any Tower or shellper found
 *   in the job, the members of another session's job, and the descendants of
 *   all of these; computed by the caller),
 * - its parent is gone, or the process now holding the parent's pid was
 *   created after it (the pid was reused). A parent that exists but cannot
 *   be opened (`unknown`) never makes an orphan.
 *
 * A console host (`conhost.exe`, `OpenConsole.exe`) is never listed: it lives
 * exactly as long as a process is attached to its console and exits on its own
 * after, and ending it would cut that console from whatever still uses it
 * (measured: a Tower started by `cmd start /b` keeps the console host of the
 * `cmd` that started it, whose parent is gone).
 *
 * The session's console host, launch loop and agent each have a live parent
 * all the way back to the root, so none of them can match. A background
 * process the user started on purpose and whose shell has exited does match:
 * it is listed, and ended only when the human asks.
 */

import type { JobMemberProcess } from './job-objects.js';

/** A process as the listing shows it. Never a command line. */
export interface ListedProcess {
  pid: number;
  /** Image name, e.g. `find.exe`. */
  name: string;
  /** Creation time, epoch ms. */
  createdAt: number;
  cpuMs: number;
}

export interface OrphanProcess extends ListedProcess {
  /** Its unprotected job-member descendants, linked by live parents; ended with it. */
  descendants: ListedProcess[];
}

type LiveMember = JobMemberProcess & { createdAt: number };

function isLive(member: JobMemberProcess): member is LiveMember {
  return member.state === 'alive' && member.createdAt !== undefined;
}

const CONSOLE_HOSTS = new Set(['conhost.exe', 'openconsole.exe']);

/** A console host, by image name. */
export function isConsoleHost(member: JobMemberProcess): boolean {
  return CONSOLE_HOSTS.has((member.name ?? '').toLowerCase());
}

function listed(member: LiveMember): ListedProcess {
  return { pid: member.pid, name: member.name ?? '', createdAt: member.createdAt, cpuMs: member.cpuMs ?? 0 };
}

/** True when `member`'s parent is not running: gone, or its pid reused by a later process. */
export function hasDeadParent(member: LiveMember): boolean {
  if (member.parent === 'gone') return true;
  if (member.parent !== 'alive' || member.parentCreatedAt === undefined) return false;
  return member.parentCreatedAt > member.createdAt;
}

/** Live parent links between members: parent pid → children created after it. */
function liveChildren(members: LiveMember[]): Map<number, LiveMember[]> {
  const byPid = new Map(members.map((m) => [m.pid, m]));
  const children = new Map<number, LiveMember[]>();
  for (const member of members) {
    if (member.ppid === undefined || hasDeadParent(member)) continue;
    const parent = byPid.get(member.ppid);
    if (!parent || parent.createdAt > member.createdAt) continue;
    const siblings = children.get(parent.pid);
    if (siblings) siblings.push(member);
    else children.set(parent.pid, [member]);
  }
  return children;
}

/**
 * `seeds` and every member reachable from them by live parent links. Used to
 * extend a protected set over the job listing.
 */
export function withLiveDescendants(members: JobMemberProcess[], seeds: Iterable<number>): Set<number> {
  const children = liveChildren(members.filter(isLive));
  const result = new Set<number>();
  const queue = [...seeds];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    if (result.has(pid)) continue;
    result.add(pid);
    for (const child of children.get(pid) ?? []) queue.push(child.pid);
  }
  return result;
}

/** The orphans in one session's job listing, each with its descendants, oldest first. */
export function classifyOrphans(rootPid: number, members: JobMemberProcess[], protectedPids: Set<number>): OrphanProcess[] {
  const candidates = members.filter(isLive).filter((m) => m.pid !== rootPid && !protectedPids.has(m.pid) && !isConsoleHost(m));
  const children = liveChildren(candidates);
  const orphans: OrphanProcess[] = [];
  for (const member of candidates) {
    if (!hasDeadParent(member)) continue;
    const descendants: ListedProcess[] = [];
    const seen = new Set([member.pid]);
    const queue = [...(children.get(member.pid) ?? [])];
    while (queue.length > 0) {
      const next = queue.shift()!;
      if (seen.has(next.pid)) continue;
      seen.add(next.pid);
      descendants.push(listed(next));
      queue.push(...(children.get(next.pid) ?? []));
    }
    orphans.push({ ...listed(member), descendants });
  }
  return orphans.sort((a, b) => a.createdAt - b.createdAt);
}
