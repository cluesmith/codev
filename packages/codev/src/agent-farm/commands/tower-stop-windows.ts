/**
 * `afx tower stop` on Windows (Spec 1658 Phase 4).
 *
 * POSIX stops Tower with SIGTERM, which runs its graceful shutdown. On Windows
 * every signal is a hard kill (TerminateProcess), so a SIGTERM would skip the
 * shutdown path: the owner lock stays behind and timers never stop. Instead:
 *
 * 1. Ask Tower to shut down over HTTP (`POST /api/shutdown`: keyed, not
 *    tunnel-borne, from this machine). Its answer names its pid; wait for that
 *    pid to exit.
 * 2. If Tower did not answer or did not exit in time, kill the listening pid
 *    alone. Never its tree: shellpers are Tower's children by ppid, and
 *    sessions survive a Tower stop by design (`taskkill /T` would end them).
 *
 * The Tower pid comes from the owner lock and the shutdown answer; the port
 * listener (`Get-NetTCPConnection`) is consulted only when those cannot be
 * trusted, so a reused pid is never killed on the lock's word alone.
 *
 * `--force-kill-all-child-processes` kills every shellper's session tree
 * (with its job) and Tower's own tree, through the process census.
 */

import http from 'node:http';
import { TOWER_KEY_HEADER } from '@cluesmith/codev-types';
import { ensureLocalKey } from '@cluesmith/codev-core/auth';
import { defaultLockFile, readTowerOwner, releaseTowerOwnerIfMine, resolveProbeHost, type TowerOwner } from '../db/tower-owner.js';
import { getProcessesOnPort } from '../utils/port.js';
import { killSessionTree, type KillSessionTreeOptions, type KillSessionTreeResult } from '../../lib/process-tree.js';
import { listProcessCensus, type ProcessCensusEntry } from '../servers/process-census.js';
import { SHELLPER_MARKER, shellperTeardownIdentities } from '../../terminal/shellper-cmdline.js';

/** How long a stop waits for Tower to exit after asking, before the hard kill. */
export const WINDOWS_STOP_EXIT_TIMEOUT_MS = 8000;
const SHUTDOWN_REQUEST_TIMEOUT_MS = 5000;

export interface WindowsStopDeps {
  readOwner: () => TowerOwner | null;
  /** Pids listening on the port. */
  listeners: (port: number) => number[];
  /** Ask Tower to shut down; resolves its pid, or null when it did not accept. */
  requestShutdown: (host: string, port: number) => Promise<number | null>;
  isAlive: (pid: number) => boolean;
  /** Hard-kill one pid. */
  kill: (pid: number) => void;
  releaseLock: (pid: number) => void;
  census: () => Promise<ProcessCensusEntry[]>;
  killTree: (pid: number, opts: KillSessionTreeOptions) => Promise<KillSessionTreeResult>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log: { info: (m: string) => void; warn: (m: string) => void; success: (m: string) => void };
}

export interface WindowsStopResult {
  /** The Tower pids that were stopped (gracefully or not). */
  stopped: number[];
  graceful: boolean;
}

function isAliveDefault(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** POST /api/shutdown with the local key. Null on any failure or refusal. */
export function postShutdownRequest(host: string, port: number): Promise<number | null> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = {};
    try {
      headers[TOWER_KEY_HEADER] = ensureLocalKey();
    } catch {
      // No key: the request is refused and the caller falls back.
    }
    const req = http.request(
      { hostname: host, port, path: '/api/shutdown', method: 'POST', timeout: SHUTDOWN_REQUEST_TIMEOUT_MS, headers },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          if (body.length < 4096) body += chunk;
        });
        res.on('end', () => {
          if (res.statusCode !== 202) {
            resolve(null);
            return;
          }
          try {
            const pid = (JSON.parse(body) as { pid?: unknown }).pid;
            if (typeof pid === 'number' && pid > 0) {
              resolve(pid);
              return;
            }
          } catch {
            // Not Tower's answer
          }
          resolve(null);
        });
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}

export function defaultWindowsStopDeps(log: WindowsStopDeps['log']): WindowsStopDeps {
  const lockFile = defaultLockFile();
  return {
    readOwner: () => {
      try {
        return readTowerOwner(lockFile);
      } catch {
        return null;
      }
    },
    listeners: getProcessesOnPort,
    requestShutdown: postShutdownRequest,
    isAlive: isAliveDefault,
    kill: (pid) => process.kill(pid, 'SIGKILL'),
    releaseLock: (pid) => releaseTowerOwnerIfMine(lockFile, pid),
    census: () => listProcessCensus({ fresh: true }),
    killTree: killSessionTree,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: Date.now,
    log,
  };
}

/** "PID 5" or "PIDs 5, 6". */
export function pidList(pids: number[]): string {
  if (pids.length === 1) return `PID ${pids[0]}`;
  return `PIDs ${pids.join(', ')}`;
}

async function waitForExit(deps: WindowsStopDeps, pids: number[], timeoutMs: number): Promise<number[]> {
  const deadline = deps.now() + timeoutMs;
  let survivors = pids.filter((pid) => deps.isAlive(pid));
  while (survivors.length > 0 && deps.now() < deadline) {
    await deps.sleep(200);
    survivors = survivors.filter((pid) => deps.isAlive(pid));
  }
  return survivors;
}

/** The owner recorded for this port, if its pid is alive. */
function liveOwnerFor(deps: WindowsStopDeps, port: number): TowerOwner | null {
  const owner = deps.readOwner();
  if (!owner || owner.port !== port || !deps.isAlive(owner.pid)) return null;
  return owner;
}

export async function stopTowerWindows(port: number, deps: WindowsStopDeps): Promise<WindowsStopResult> {
  const owner = liveOwnerFor(deps, port);
  const host = resolveProbeHost(owner?.bindHost);

  const answeredPid = await deps.requestShutdown(host, port);
  if (answeredPid !== null) {
    const survivors = await waitForExit(deps, [answeredPid], WINDOWS_STOP_EXIT_TIMEOUT_MS);
    if (survivors.length === 0) {
      return { stopped: [answeredPid], graceful: true };
    }
    try {
      deps.kill(answeredPid);
    } catch {
      // Exited between the check and the kill
    }
    deps.releaseLock(answeredPid);
    deps.log.warn(`Tower did not exit within ${WINDOWS_STOP_EXIT_TIMEOUT_MS / 1000}s; killed PID ${answeredPid} (sessions keep running)`);
    return { stopped: [answeredPid], graceful: false };
  }

  // No answer: a wedged Tower, or none. Only a process that holds the port is
  // Tower's; the lock's pid alone might since have been reused.
  const listening = deps.listeners(port);
  if (listening.length === 0) return { stopped: [], graceful: false };
  for (const pid of listening) {
    try {
      deps.kill(pid);
    } catch {
      // Exited in the meantime
    }
    deps.releaseLock(pid);
  }
  deps.log.warn(`Tower did not accept a shutdown request; killed ${pidList(listening)} (sessions keep running)`);
  return { stopped: listening, graceful: false };
}

/**
 * Kill Tower's tree and every shellper session tree on the machine, matching
 * the POSIX `pgrep -f shellper-main` sweep. Returns how many trees were
 * killed, Tower's included.
 */
export async function forceKillTowerWindows(port: number, deps: WindowsStopDeps): Promise<number> {
  const towerPids = new Set<number>(deps.listeners(port));
  const owner = liveOwnerFor(deps, port);
  if (owner && towerPids.size === 0) towerPids.add(owner.pid);

  let census: ProcessCensusEntry[];
  try {
    census = await deps.census();
  } catch (err) {
    deps.log.warn(`Process census unavailable (${(err as Error).message}); killing Tower only`);
    census = [];
  }
  const shellperPids = census
    .filter((entry) => entry.cmdline.includes(SHELLPER_MARKER) && entry.pid !== process.pid)
    .map((entry) => entry.pid);
  const { startTimes, jobNames } = shellperTeardownIdentities(census, shellperPids);

  let killed = 0;
  for (const pid of shellperPids) {
    try {
      const { signaled, jobError } = await deps.killTree(pid, { rootStartTime: startTimes.get(pid), jobName: jobNames.get(pid) });
      if (jobError !== undefined) deps.log.warn(`Shellper pid ${pid}: ${jobError}`);
      if (signaled) killed++;
    } catch (err) {
      deps.log.warn(`Shellper pid ${pid}: ${(err as Error).message}`);
    }
  }
  for (const pid of towerPids) {
    const created = census.find((entry) => entry.pid === pid)?.creationTime;
    try {
      await deps.killTree(pid, { rootStartTime: created });
    } catch (err) {
      // A rejected teardown may still have acted (taskkill without a snapshot).
      deps.log.warn(`Tower pid ${pid}: ${(err as Error).message}`);
    }
    // Counted by outcome, not by the teardown's report: Tower is gone or not.
    if (!deps.isAlive(pid)) killed++;
    deps.releaseLock(pid);
  }
  return killed;
}
