/**
 * Issue #1224: detect and reclaim live processes that hold an architect's
 * conversation session id, so an architect launch never bakes a colliding
 * `claude --resume <id>` into a permanent crash loop.
 *
 * Two holder classes were observed after a workspace restart (forensic timeline
 * on the issue):
 *   1. OUR OWN superseded shellper for the same architect identity — a remnant
 *      from before the restart, or a previous crash-looping instance. Its claude
 *      child dies within seconds of every respawn, so the child is absent most
 *      of the time; the durable evidence is the *shellper parent's* argv, which
 *      carries the session id in its JSON config (`"--session-id","<id>"`).
 *   2. A FOREIGN process — e.g. an interactive `claude` the user started by hand
 *      on their own tty (holder case in incident 3). This must NEVER be touched:
 *      it is not ours to kill.
 *
 * The policy: reclaim (kill + resume) only OUR OWN superseded shellper, proven
 * by shellper-main.js + matching session id + matching cwd + matching
 * CODEV_ARCHITECT_NAME. Anything else that holds the id is foreign → mint fresh.
 */

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isWindows } from '../../lib/platform.js';
import { killSessionTree } from '../../lib/process-tree.js';
import { listProcessCensus } from './process-census.js';
import {
  SHELLPER_MARKER,
  readJsonStringField,
  sameWindowsPath,
  shellperArgvText,
  shellperTeardownIdentities,
} from '../../terminal/shellper-cmdline.js';

export interface ProcessEntry {
  pid: number;
  /** The full joined argv (as `ps ... -o args=` reports it). */
  cmdline: string;
  /** Windows: creation time from the census (epoch ms), so a reap can check the pid is still this process. */
  creationTime?: number;
}

/**
 * The session-flag needle forms a live holder's argv can carry the id in:
 *   - `--session-id <id>` / `--resume <id>` — a claude CHILD's shell argv
 *   - `--session-id=<id>` / `--resume=<id>` — the `=`-joined shell variant
 *   - `"--session-id","<id>"` / `"--resume","<id>"` — the shellper PARENT's
 *     JSON config argv (Issue #1224: catches a remnant shellper whose child is
 *     dead between crash-loop respawns).
 */
export function sessionIdNeedles(sessionId: string): string[] {
  return ['--session-id', '--resume'].flatMap((flag) => [
    `${flag} ${sessionId}`,
    `${flag}=${sessionId}`,
    `"${flag}","${sessionId}"`,
  ]);
}

/** True when a process's argv references `sessionId` as a session-flag argument. */
export function cmdlineHoldsSession(cmdline: string, sessionId: string): boolean {
  const needles = sessionIdNeedles(sessionId);
  return needles.some((needle) => cmdline.includes(needle));
}

/** Canonicalize a path for comparison; fall back to the input when realpath fails. */
function realpathOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}


export interface ArchitectIdentity {
  /** Absolute workspace path the shellper runs in (`cwd` in its config). */
  workspacePath: string;
  /** The architect name (shellper config env `CODEV_ARCHITECT_NAME`). */
  architectName: string;
}

/**
 * True when `cmdline` is one of OUR OWN shellper processes for `identity`:
 * a `shellper-main.js` whose JSON config carries the matching workspace cwd and
 * `CODEV_ARCHITECT_NAME`. The cwd match tolerates symlink variants (macOS
 * `/tmp` vs `/private/tmp`), mirroring verifySessionOwnership.
 *
 * This is the airtight-identity gate before any kill: if any field cannot be
 * positively confirmed, this returns false and the caller must not reclaim.
 */
export function isOwnArchitectShellper(cmdline: string, identity: ArchitectIdentity): boolean {
  if (!cmdline.includes(SHELLPER_MARKER)) return false;

  const cfgName = readJsonStringField(cmdline, 'CODEV_ARCHITECT_NAME');
  if (cfgName !== identity.architectName) return false;

  const cfgCwd = readJsonStringField(cmdline, 'cwd');
  if (!cfgCwd) return false;
  if (isWindows()) return sameWindowsPath(cfgCwd, identity.workspacePath);
  const wanted = new Set([identity.workspacePath, realpathOrSelf(identity.workspacePath)]);
  const got = new Set([cfgCwd, realpathOrSelf(cfgCwd)]);
  const cwdMatches = [...got].some((g) => wanted.has(g));
  if (!cwdMatches) return false;

  return true;
}

/**
 * Snapshot every running process as {pid, cmdline}. `ps -ww` prevents argv
 * truncation (the shellper config blob is large) on both BSD and coreutils.
 * Throws on `ps` failure; callers decide how to degrade.
 */
function listPosixProcessEntries(): ProcessEntry[] {
  const out = execFileSync('ps', ['-ww', '-eo', 'pid=,args='], {
    encoding: 'utf-8',
    timeout: 5000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const entries: ProcessEntry[] = [];
  for (const line of out.split('\n')) {
    const trimmed = line.trimStart();
    const sp = trimmed.indexOf(' ');
    if (sp <= 0) continue;
    const pid = parseInt(trimmed.slice(0, sp), 10);
    if (Number.isNaN(pid) || pid <= 0) continue;
    entries.push({ pid, cmdline: trimmed.slice(sp + 1) });
  }
  return entries;
}

/**
 * Snapshot every running process as {pid, cmdline} for the matchers here.
 * POSIX reads `ps`; Windows reads the census (Spec 1658), with each command
 * line argv-unquoted so the shellper's JSON config reads as plain JSON. Rejects
 * on failure; callers decide how to degrade.
 */
export async function listProcessEntries(): Promise<ProcessEntry[]> {
  if (!isWindows()) return listPosixProcessEntries();
  const census = await listProcessCensus();
  return census.map((entry) => ({
    pid: entry.pid,
    cmdline: shellperArgvText(entry.cmdline),
    creationTime: entry.creationTime,
  }));
}

export interface SessionHolderClassification {
  /** PIDs of OUR OWN superseded shellpers holding this session (safe to reap). */
  reclaimable: number[];
  /** True when some holder is NOT positively ours — must not be touched. */
  foreign: boolean;
}

/**
 * Classify every live holder of `sessionId` into reclaimable-own vs foreign.
 * A holder is reclaimable only when it is one of our own architect shellpers
 * (identity-matched); any other holder (a bare `claude`, a shellper for a
 * different identity, an unparseable match) is foreign.
 *
 * On `ps` failure returns `{reclaimable: [], foreign: false}` — no positive
 * evidence, so the caller resumes as it would have before this guard existed.
 */
export function classifyArchitectSessionHolder(opts: {
  sessionId: string;
  identity: ArchitectIdentity;
  /** Exclude this pid (e.g. Tower's own) from consideration. */
  selfPid?: number;
  /** The process snapshot (see `listProcessEntries`). */
  list: () => ProcessEntry[];
}): SessionHolderClassification {
  const list = opts.list;
  let entries: ProcessEntry[];
  try {
    entries = list();
  } catch {
    return { reclaimable: [], foreign: false };
  }

  const reclaimable: number[] = [];
  let foreign = false;
  for (const { pid, cmdline } of entries) {
    if (opts.selfPid !== undefined && pid === opts.selfPid) continue;
    if (!cmdlineHoldsSession(cmdline, opts.sessionId)) continue;
    if (isOwnArchitectShellper(cmdline, opts.identity)) {
      reclaimable.push(pid);
    } else {
      foreign = true;
    }
  }
  return { reclaimable, foreign };
}

/**
 * Find PIDs of OUR OWN architect shellpers for `identity`, regardless of which
 * session they hold. Used by remove-architect to reap a live-process-without-a-
 * registry-row zombie (Issue #1224 symptom B) — there is no stored session id to
 * key on, so identity (shellper-main.js + cwd + CODEV_ARCHITECT_NAME) is the key.
 */
export async function findOwnArchitectShellpers(opts: {
  identity: ArchitectIdentity;
  selfPid?: number;
  list?: () => ProcessEntry[] | Promise<ProcessEntry[]>;
}): Promise<number[]> {
  const list = opts.list ?? listProcessEntries;
  let entries: ProcessEntry[];
  try {
    entries = await list();
  } catch {
    return [];
  }
  const pids: number[] = [];
  for (const { pid, cmdline } of entries) {
    if (opts.selfPid !== undefined && pid === opts.selfPid) continue;
    if (isOwnArchitectShellper(cmdline, opts.identity)) pids.push(pid);
  }
  return pids;
}

/** Whether a pid is still alive (signal 0 probe). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH → gone; EPERM → alive but not ours to signal (treat as alive).
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Kill a shellper's whole session tree (on POSIX the leader is detached, so its
 * process group; falls back to the single pid). Resolves once the teardown has
 * run: on Windows that includes the census snapshot and taskkill, which the
 * reap must not outrun. Rejects when the Windows census failed, so the reap can
 * report it.
 */
async function killProcessGroup(pid: number, signal: NodeJS.Signals, startTime?: number, jobName?: string): Promise<void> {
  const { jobError } = await killSessionTree(pid, { signal, fallbackToPid: true, rootStartTime: startTime, jobName });
  if (jobError !== undefined) throw new Error(jobError);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Reap the given superseded-shellper PIDs: SIGTERM the process group, poll for
 * death, then SIGKILL any survivor. Resolves once every pid is gone (or the
 * SIGKILL grace elapses). The wait matters: the killed shellper's child must
 * release the session lock before the caller's fresh `claude --resume` runs,
 * else the collision recurs.
 *
 * Rejects, after every kill and the death polls have run, when any teardown
 * failed (on Windows, a failed census), so a caller never reports a reap that
 * did not happen.
 *
 * Seams (`isAlive`, `kill`, `wait`) keep it unit-testable without real signals.
 */
export async function reapShellpers(
  pids: number[],
  opts?: {
    isAlive?: (pid: number) => boolean;
    kill?: (pid: number, signal: NodeJS.Signals) => void | Promise<void>;
    /** Windows: each pid's census creation time, so teardown refuses a reused pid. */
    startTimes?: Map<number, number>;
    /** Windows: each pid's session Job Object, terminated with it (Spec 1658 Phase 3b). */
    jobNames?: Map<number, string>;
    wait?: (ms: number) => Promise<void>;
    graceMs?: number;
    killGraceMs?: number;
    pollMs?: number;
  },
): Promise<void> {
  if (pids.length === 0) return;
  const isAlive = opts?.isAlive ?? pidAlive;
  const startTimes = opts?.startTimes;
  const jobNames = opts?.jobNames;
  const kill = opts?.kill ?? ((pid: number, signal: NodeJS.Signals) => killProcessGroup(pid, signal, startTimes?.get(pid), jobNames?.get(pid)));
  const wait = opts?.wait ?? sleep;
  const graceMs = opts?.graceMs ?? 3000;
  const killGraceMs = opts?.killGraceMs ?? 2000;
  const pollMs = opts?.pollMs ?? 100;

  const pollUntilDead = async (deadlineMs: number): Promise<void> => {
    let waited = 0;
    while (waited < deadlineMs && pids.some((pid) => isAlive(pid))) {
      await wait(pollMs);
      waited += pollMs;
    }
  };

  // Every kill runs and the poll still happens when a teardown fails; the
  // failures are reported once the reap is over.
  const failures: string[] = [];
  const killAll = (targets: number[], signal: NodeJS.Signals) => Promise.all(targets.map(async (pid) => {
    try {
      await kill(pid, signal);
    } catch (err) {
      failures.push(`pid ${pid}: ${(err as Error).message}`);
    }
  }));

  await killAll(pids, 'SIGTERM');
  await pollUntilDead(graceMs);

  const survivors = pids.filter((pid) => isAlive(pid));
  if (survivors.length > 0) {
    await killAll(survivors, 'SIGKILL');
    // Confirm SIGKILL actually took effect before returning: the caller resumes
    // `claude --resume <id>` next, and a holder still in the kernel's exit path
    // has not yet released the session lock — returning early would re-open the
    // very collision race this reap exists to close (codex review, Issue #1224).
    await pollUntilDead(killGraceMs);
  }

  if (failures.length > 0) {
    throw new Error(`shellper teardown incomplete: ${failures.join('; ')}`);
  }
}

export type ArchitectLogger = (level: 'INFO' | 'WARN' | 'ERROR', message: string) => void;

/**
 * Reconcile a stored architect session id against the live process table before
 * launch, resolving whether the caller may resume it.
 *
 * - A FOREIGN holder → `{ foreignHolder: true }`: the caller must mint fresh
 *   (the session is genuinely in use by something we must not touch).
 * - Only OUR OWN superseded shellper(s) hold it → reap them and return
 *   `{ foreignHolder: false }`: the session is now free, resume it (mint-or-
 *   RECLAIM, preserving the conversation instead of abandoning it).
 * - No holder → `{ foreignHolder: false }`: resume as usual.
 */
export async function reconcileArchitectSessionHolder(opts: {
  sessionId: string;
  identity: ArchitectIdentity;
  selfPid?: number;
  log?: ArchitectLogger;
  list?: () => ProcessEntry[] | Promise<ProcessEntry[]>;
  reap?: (pids: number[]) => Promise<void>;
}): Promise<{ foreignHolder: boolean; reclaimedPids: number[] }> {
  // Snapshot first (asynchronously: on Windows it is a PowerShell census), then
  // classify. A failed snapshot classifies as "no holder", as before.
  const list = opts.list ?? listProcessEntries;
  let snapshot: ProcessEntry[] | null = null;
  try {
    snapshot = await list();
  } catch (err) {
    if (isWindows()) {
      opts.log?.('WARN', `Architect '${opts.identity.architectName}' session-holder check skipped: ${(err as Error).message}`);
    }
  }
  const { reclaimable, foreign } = classifyArchitectSessionHolder({
    sessionId: opts.sessionId,
    identity: opts.identity,
    selfPid: opts.selfPid,
    list: () => {
      if (snapshot === null) throw new Error('process snapshot unavailable');
      return snapshot;
    },
  });

  const shortId = opts.sessionId.slice(0, 8);
  if (foreign) {
    opts.log?.(
      'WARN',
      `Architect '${opts.identity.architectName}' session ${shortId}… is held by a foreign process; minting a fresh session (holder left untouched) in ${opts.identity.workspacePath}`,
    );
    return { foreignHolder: true, reclaimedPids: [] };
  }

  if (reclaimable.length === 0) {
    return { foreignHolder: false, reclaimedPids: [] };
  }

  opts.log?.(
    'WARN',
    `Architect '${opts.identity.architectName}' session ${shortId}… is held by our own superseded shellper(s) [${reclaimable.join(', ')}]; reaping to reclaim the conversation in ${opts.identity.workspacePath}`,
  );
  const { startTimes, jobNames } = shellperTeardownIdentities(snapshot ?? [], reclaimable);
  const reap = opts.reap ?? ((pids: number[]) => reapShellpers(pids, { startTimes, jobNames }));
  try {
    await reap(reclaimable);
  } catch (err) {
    // The holder may still be alive: resuming would collide, so mint fresh.
    opts.log?.(
      'WARN',
      `Architect '${opts.identity.architectName}' session ${shortId}… could not be reclaimed (${(err as Error).message}); minting a fresh session in ${opts.identity.workspacePath}`,
    );
    return { foreignHolder: true, reclaimedPids: [] };
  }
  return { foreignHolder: false, reclaimedPids: reclaimable };
}
