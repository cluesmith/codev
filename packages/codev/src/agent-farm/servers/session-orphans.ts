/**
 * Tower's listing and ending of orphaned processes in its sessions (#1915).
 * Windows only. See `lib/platform/windows/session-orphans.ts` for which
 * processes count as orphaned.
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
 *
 * Ending re-lists the session and ends only a process named in the request
 * that is still an orphan (or an orphan's descendant) with the same creation
 * time, through the helper's `end-process`, which re-checks job membership and
 * creation time in the kernel call path. Nothing is ever ended without a
 * request naming it.
 */

import type { JobMemberProcess, JobMembersOutcome, EndProcessOutcome } from '../../lib/platform/windows/job-objects.js';
import { classifyOrphans, withLiveDescendants } from '../../lib/platform/windows/session-orphans.js';
import { isCodevInfrastructure, protectedInfrastructure } from '../../lib/platform/windows/codev-infrastructure.js';
import type { ProcessCensusEntry } from '../../lib/platform/processes.js';
import type {
  OrphanEndResult,
  OrphanEndTarget,
  OrphansEndResponse,
  OrphansListing,
  SessionKind,
  SessionOrphans,
} from '../lib/session-orphans-api.js';

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
  endProcess(name: string, rootPid: number, target: number, createdAt: number): Promise<EndProcessOutcome>;
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

/**
 * End exactly the requested processes that are still orphans (or orphans'
 * descendants) of their session, with the creation time the listing showed.
 */
export async function endOrphans(
  deps: OrphanDeps,
  targets: OrphanEndTarget[],
  inWorkspace: (workspacePath: string) => boolean = () => true,
  log: (message: string) => void = () => {},
): Promise<OrphansEndResponse> {
  const all = deps.sessions();
  const helper = deps.helper();
  const results: OrphanEndResult[] = [];
  const byTerminal = new Map<string, OrphanEndTarget[]>();
  for (const target of targets) {
    const list = byTerminal.get(target.terminalId);
    if (list) list.push(target);
    else byTerminal.set(target.terminalId, [target]);
  }

  for (const [terminalId, sessionTargets] of byTerminal) {
    const session = selected(all, inWorkspace).find((s) => s.terminalId === terminalId);
    const refuse = (reason: string) => sessionTargets.forEach((t) => results.push({ ...t, outcome: 'refused', reason }));
    if (!session) {
      refuse('no such session in this workspace');
      continue;
    }
    if (!helper) {
      refuse('no job helper is running');
      continue;
    }
    const check = await checkSession(session, all, helper, deps);
    if (check.error !== undefined) {
      refuse(check.error);
      continue;
    }
    const allowed = new Map<number, { createdAt: number; name: string }>();
    for (const orphan of check.orphans) {
      allowed.set(orphan.pid, orphan);
      for (const d of orphan.descendants) allowed.set(d.pid, d);
    }
    for (const target of sessionTargets) {
      const current = allowed.get(target.pid);
      if (!current || current.createdAt !== target.createdAt) {
        results.push({ ...target, outcome: 'refused', reason: 'it is no longer an orphan of this session' });
        continue;
      }
      const outcome = await helper.endProcess(session.jobName, session.rootPid, target.pid, target.createdAt);
      if (!outcome.ok) {
        results.push({ ...target, outcome: 'failed', reason: outcome.error });
      } else if (outcome.ended) {
        log(`Ended orphaned process ${current.name} (pid ${target.pid}) in session ${session.agent} (${session.terminalId})`);
        results.push({ ...target, outcome: 'ended' });
      } else if (outcome.gone) {
        results.push({ ...target, outcome: 'gone' });
      } else {
        results.push({ ...target, outcome: 'refused', reason: outcome.reason ?? 'refused by the job helper' });
      }
    }
  }
  return { supported: true, results };
}

/** Validates a POST body's targets; null when malformed. */
export function parseEndTargets(body: unknown): OrphanEndTarget[] | null {
  if (body === null || typeof body !== 'object') return null;
  const raw = (body as { targets?: unknown }).targets;
  if (!Array.isArray(raw)) return null;
  const targets: OrphanEndTarget[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') return null;
    const t = item as Record<string, unknown>;
    if (typeof t.terminalId !== 'string' || !Number.isInteger(t.pid) || !Number.isInteger(t.createdAt)) return null;
    targets.push({ terminalId: t.terminalId, pid: t.pid as number, createdAt: t.createdAt as number });
  }
  return targets;
}
