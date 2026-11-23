/**
 * Tower's listing of orphaned processes in its sessions (#1915). Windows only.
 * Read-only: session jobs allow no breakaway, so an orphan ends with its
 * session (closing the terminal, or `afx cleanup`); nothing here ends a
 * process. See `lib/platform/windows/session-orphans.ts` for which processes
 * count as orphaned.
 *
 * Never protected processes. Before classifying a session's job, Tower builds
 * the set it must never list or end, with every descendant by live parent
 * links:
 * - itself, its Job Object helper and its recorded IDE server,
 * - the root of every session it knows, in every workspace,
 * - the members of another session's job, when that session's root sits in
 *   this job (a session nested inside it),
 * - any Tower or shellper found in the job by command line (a husk Tower no
 *   longer knows is left to `afx tower sweep-husks`), with its job's members.
 * The command lines come from the process census, read only when the job has
 * an orphan candidate; they are used to decide and are never returned or
 * logged.
 */

import type { JobMemberProcess, JobMembersOutcome } from '../../lib/platform/windows/job-objects.js';
import { classifyOrphans, withLiveDescendants } from '../../lib/platform/windows/session-orphans.js';
import { isCodevInfrastructure, protectedInfrastructure } from '../../lib/platform/windows/codev-infrastructure.js';
import type { ProcessCensusEntry } from '../../lib/platform/processes.js';
import type { OrphansListing, SessionKind, SessionOrphans } from '../lib/session-orphans-api.js';

/** A shellper-backed session Tower holds. */
export interface OrphanSessionRef {
  workspacePath: string;
  terminalId: string;
  agent: string;
  kind: SessionKind;
  /** The shellper pid. */
  rootPid: number;
  jobName: string;
}

/** The helper calls the listing needs (Tower's `WindowsJobHelper` satisfies it). */
export interface OrphanJobHelper {
  jobMembers(name: string, rootPid: number): Promise<JobMembersOutcome>;
}

export interface OrphanDeps {
  /** Null when there is no job helper (it is reported as such). */
  helper: () => OrphanJobHelper | null;
  /** Every shellper-backed session Tower knows, in every workspace. */
  sessions: () => OrphanSessionRef[];
  /** Tower's own pid, its helper's and its IDE server's. */
  infrastructurePids: () => number[];
  /** The process census, with command lines. */
  census: () => Promise<ProcessCensusEntry[]>;
  /** The job name a shellper's command line carries, or null. */
  shellperJobName: (cmdline: string) => string | null;
}

interface SessionCheck {
  job: boolean;
  error?: string;
  members: JobMemberProcess[];
  orphans: ReturnType<typeof classifyOrphans>;
}

async function otherJobMembers(helper: OrphanJobHelper, jobName: string, rootPid: number): Promise<number[]> {
  const listed = await helper.jobMembers(jobName, rootPid);
  if (!listed.ok || !listed.member) return [];
  return listed.processes.map((p) => p.pid);
}

/** One session's orphans, with the protected set applied. */
async function checkSession(session: OrphanSessionRef, all: OrphanSessionRef[], helper: OrphanJobHelper, deps: OrphanDeps): Promise<SessionCheck> {
  const listed = await helper.jobMembers(session.jobName, session.rootPid);
  if (!listed.ok) return { job: true, error: `the job could not be listed: ${listed.error}`, members: [], orphans: [] };
  if (!listed.found || !listed.member) return { job: false, members: [], orphans: [] };
  const members = listed.processes;
  const inJob = new Set(members.map((m) => m.pid));

  const seeds = new Set<number>();
  for (const pid of deps.infrastructurePids()) if (inJob.has(pid) && pid !== session.rootPid) seeds.add(pid);
  for (const other of all) {
    if (other.terminalId === session.terminalId || other.rootPid === session.rootPid || !inJob.has(other.rootPid)) continue;
    seeds.add(other.rootPid);
    for (const pid of await otherJobMembers(helper, other.jobName, other.rootPid)) seeds.add(pid);
  }
  let protectedPids = withLiveDescendants(members, seeds);
  let orphans = classifyOrphans(session.rootPid, members, protectedPids);
  if (orphans.length === 0) return { job: true, members, orphans };

  // A candidate exists: rule out any Tower or shellper in the job by command line.
  let census: ProcessCensusEntry[];
  try {
    census = await deps.census();
  } catch (err) {
    return { job: true, error: `could not check the job for Codev processes, so nothing is listed: ${(err as Error).message}`, members, orphans: [] };
  }
  const infrastructure = protectedInfrastructure(census, session.rootPid, inJob);
  const byPid = new Map(census.map((entry) => [entry.pid, entry]));
  for (const pid of [...infrastructure]) {
    const entry = byPid.get(pid);
    if (!entry || !isCodevInfrastructure(entry.cmdline)) continue;
    const jobName = deps.shellperJobName(entry.cmdline);
    if (jobName !== null) for (const member of await otherJobMembers(helper, jobName, pid)) infrastructure.add(member);
  }
  protectedPids = withLiveDescendants(members, [...protectedPids, ...infrastructure]);
  orphans = classifyOrphans(session.rootPid, members, protectedPids);
  return { job: true, members, orphans };
}

function selected(all: OrphanSessionRef[], inWorkspace: (workspacePath: string) => boolean): OrphanSessionRef[] {
  return all.filter((s) => inWorkspace(s.workspacePath));
}

/** The orphans of every session in the selected workspaces. */
export async function listOrphans(deps: OrphanDeps, inWorkspace: (workspacePath: string) => boolean = () => true): Promise<OrphansListing> {
  const all = deps.sessions();
  const helper = deps.helper();
  const sessions: SessionOrphans[] = [];
  for (const session of selected(all, inWorkspace)) {
    const base = { workspacePath: session.workspacePath, terminalId: session.terminalId, agent: session.agent, kind: session.kind };
    if (!helper) {
      sessions.push({ ...base, job: false, error: 'no job helper is running', orphans: [] });
      continue;
    }
    const check = await checkSession(session, all, helper, deps);
    const row: SessionOrphans = { ...base, job: check.job, orphans: check.orphans };
    if (check.error !== undefined) row.error = check.error;
    sessions.push(row);
  }
  return { supported: true, sessions };
}
