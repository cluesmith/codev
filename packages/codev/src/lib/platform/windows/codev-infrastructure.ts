/**
 * Recognizing Codev's own long-lived processes in a session job (#1915).
 *
 * Session jobs allow no breakaway, so a Tower started from inside a session by
 * a plain spawn (not `afx tower start`, which creates it through CIM) is a
 * member of that session's job, and so are its Job Object helper, its IDE
 * server and every shellper it creates (measured). Terminating the job, or
 * ending a process listed as orphaned there, would take all of them down.
 * Teardown and the orphan listing protect any process this module recognizes,
 * with its descendants.
 *
 * A Tower or a shellper is a Node process whose script is `tower-server` or
 * `shellper-main` (`.js` built, `.ts` under tsx in development). Matching the
 * executable and the script path, not any mention of the name, keeps a `grep`
 * or an editor opened on those files from counting.
 */

import type { ProcessCensusEntry } from '../processes.js';
import { collectTree } from './process-tree.js';

const NODE_EXECUTABLE = /^\s*"?(?:[^"]*[\\/])?node(?:\.exe)?"?(?:\s|$)/i;
const INFRASTRUCTURE_SCRIPT = /(?:^|[\s"\\/])(?:tower-server|shellper-main)\.(?:js|ts)(?:"|\s|$)/i;

/** True when `cmdline` is a Tower or a shellper. */
export function isCodevInfrastructure(cmdline: string): boolean {
  return NODE_EXECUTABLE.test(cmdline) && INFRASTRUCTURE_SCRIPT.test(cmdline);
}

/**
 * The processes among `candidates` (pids) that are a Tower or a shellper other
 * than `rootPid`, with all their descendants in `census`. The root itself (a
 * session's own shellper) is never in the set.
 */
export function protectedInfrastructure(census: ProcessCensusEntry[], rootPid: number, candidates: Iterable<number>): Set<number> {
  const byPid = new Map(census.map((entry) => [entry.pid, entry]));
  const protectedPids = new Set<number>();
  for (const pid of candidates) {
    if (pid === rootPid || protectedPids.has(pid)) continue;
    const entry = byPid.get(pid);
    if (!entry || !isCodevInfrastructure(entry.cmdline)) continue;
    protectedPids.add(pid);
    for (const member of collectTree(census, pid)) protectedPids.add(member.pid);
  }
  protectedPids.delete(rootPid);
  return protectedPids;
}
