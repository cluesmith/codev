/**
 * Tower's lifecycle on Windows: `afx tower start` and `afx tower stop`.
 *
 * Starting from inside a codev session (Spec 1658 Phase 4):
 *
 * Every process in a Windows session runs in that session's Job Object, and a
 * Node `detached: true` child stays in it (libuv never requests breakaway;
 * audit 1.8). A Tower daemon started there, and every shellper it spawns,
 * would end when that one session is torn down. So when the launcher is inside
 * a session, the daemon is created through CIM `Win32_Process.Create`: the WMI
 * provider host creates it, outside any job of ours (measured, `JOB-CIM`).
 *
 * The signal is the session marker the shellper sets for its PTY
 * (SHELLPER_SESSION_ENV). An `IsProcessInJob` check is not used: without a
 * handle to the session's job it cannot tell a codev session job from the
 * runner's, libuv's or a terminal's own job, so it would misfire everywhere.
 *
 * The CIM-created daemon gets the environment and cwd a spawned one would
 * (the sanitized environment, Claude markers scrubbed) minus the marker, or it
 * and its shellpers would believe they run inside a session. If CIM is
 * unavailable, the start is refused with the supported launch paths named;
 * a daemon inside the session's job is never started.
 *
 * Stopping (Spec 1658 Phase 4):
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
import { execFile } from 'node:child_process';
import { SHELLPER_SESSION_ENV, isInsideCodevSession } from '../../../terminal/shellper-endpoint.js';
import { quoteWindowsArg } from '../../../lib/platform/windows/command-line.js';
import { encodeHelperCommand, sessionJobName } from '../../../lib/platform/windows/job-objects.js';
import { windowsPowerShellPath } from '../../../lib/platform.js';
import { TOWER_KEY_HEADER } from '@cluesmith/codev-types';
import { ensureLocalKey } from '@cluesmith/codev-core/auth';
import { defaultLockFile, readTowerOwner, releaseTowerOwnerIfMine, resolveProbeHost, type TowerOwner } from '../../db/tower-owner.js';
import { getProcessesOnPort } from '../../utils/port.js';
import { killSessionTree, type KillSessionTreeOptions, type KillSessionTreeResult } from '../../../lib/process-tree.js';
import { listProcessCensus, type ProcessCensusEntry } from '../../servers/process-census.js';
import { SHELLPER_MARKER, shellperTeardownIdentities } from '../../../terminal/shellper-cmdline.js';

const CIM_LAUNCH_TIMEOUT_MS = 30_000;

/** The supported ways to start Tower when CIM is unavailable; doctor names the same. */
export const SUPPORTED_TOWER_LAUNCH_PATHS =
  'start Tower from a terminal that is not a codev session (for example Windows Terminal or a PowerShell window), or let the VS Code extension start it';

/** The daemon's environment for a CIM launch: as given, without the session marker. */
export function daemonEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || key === SHELLPER_SESSION_ENV) continue;
    out[key] = value;
  }
  return out;
}

export function cimRefusalMessage(reason: string): string {
  return (
    'Tower cannot be started from inside a codev session on Windows: it would run in that ' +
    "session's job and stop when the session is torn down, and starting it outside the job " +
    `through CIM (Win32_Process.Create) failed: ${reason}. Instead, ${SUPPORTED_TOWER_LAUNCH_PATHS}.`
  );
}

/** Tower boot self-check text (logged once, and shown by doctor). */
export const TOWER_IN_SESSION_WARNING =
  'Tower is running inside a codev session; tearing down that session will stop Tower';

/**
 * Tower's boot self-check: the warning to log once, or null. Windows only. On
 * its own a warning: the marker is inherited and can be stale. Tower refuses
 * only when the marker's session job really holds it (`towerSessionJobRefusal`).
 */
export function towerBootSessionWarning(env: NodeJS.ProcessEnv, windows: boolean): string | null {
  if (!windows || !isInsideCodevSession(env)) return null;
  return `${TOWER_IN_SESSION_WARNING}. To avoid it, ${SUPPORTED_TOWER_LAUNCH_PATHS}.`;
}

/**
 * Why Tower must not start, when it sits in the job of the session its marker
 * names (#1915), or null. Session jobs allow no breakaway, so a Tower started
 * there by a plain spawn is a member: every shellper it creates would join
 * that job too, and ending the session would end Tower and all of them. The
 * marker alone proves nothing (it is inherited and can be stale), so this asks
 * the job itself. Null when the marker is absent, the job no longer exists, or
 * the check cannot be made (a degraded helper is reported by the helper).
 */
export async function towerSessionJobRefusal(
  env: NodeJS.ProcessEnv,
  inJob: (name: string, pid: number) => Promise<{ ok: true; found: boolean; member: boolean } | { ok: false; error: string }>,
  pid: number = process.pid,
): Promise<string | null> {
  const marker = env[SHELLPER_SESSION_ENV];
  if (typeof marker !== 'string' || marker === '') return null;
  const result = await inJob(sessionJobName(marker), pid);
  if (!result.ok || !result.member) return null;
  return (
    "Tower refuses to start inside a codev session's job: ending that session would end Tower and every " +
    `session it serves. Use \`afx tower start\` (it starts Tower outside the job), or ${SUPPORTED_TOWER_LAUNCH_PATHS}.`
  );
}

/**
 * Reads `{commandLine, cwd, env}` from stdin, creates the process hidden, and
 * prints `{returnValue, pid}` (or `{error}`). Data travels on stdin, never in
 * the script, so nothing needs quoting for PowerShell.
 * EnvironmentVariables take precedence over the user's and the system's.
 */
export const CIM_LAUNCH_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try {
  $req = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ EnvironmentVariables = [string[]]$req.env; ShowWindow = [UInt16]0 }
  $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = [string]$req.commandLine; CurrentDirectory = [string]$req.cwd; ProcessStartupInformation = $startup }
  [Console]::Out.WriteLine((@{ returnValue = [int]$r.ReturnValue; pid = [int]$r.ProcessId } | ConvertTo-Json -Compress))
} catch {
  [Console]::Out.WriteLine((@{ error = $_.Exception.Message } | ConvertTo-Json -Compress))
}
`;

export interface CimLaunchRequest {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export type CimLaunchResult = { pid: number } | { error: string };

/** Seam: run the CIM script with `input` on stdin; resolves its stdout. */
export type PowerShellRunner = (script: string, input: string) => Promise<string>;

export const runPowerShellScript: PowerShellRunner = (script, input) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      windowsPowerShellPath(),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodeHelperCommand(script)],
      { timeout: CIM_LAUNCH_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(stdout);
      },
    );
    child.stdin?.end(input);
  });

/** Create the daemon through CIM. Never throws: a failure comes back as `{ error }`. */
export async function launchViaCim(req: CimLaunchRequest, run: PowerShellRunner = runPowerShellScript): Promise<CimLaunchResult> {
  const commandLine = [req.command, ...req.args].map(quoteWindowsArg).join(' ');
  const env = Object.entries(req.env)
    .filter(([key, value]) => key !== '' && !key.includes('=') && !value.includes('\0'))
    .map(([key, value]) => `${key}=${value}`);
  let stdout: string;
  try {
    stdout = await run(CIM_LAUNCH_SCRIPT, JSON.stringify({ commandLine, cwd: req.cwd, env }));
  } catch (err) {
    return { error: `powershell.exe failed: ${(err as Error).message}` };
  }
  const line = stdout.trim().split(/\r?\n/).pop() ?? '';
  let parsed: { returnValue?: unknown; pid?: unknown; error?: unknown };
  try {
    parsed = JSON.parse(line);
  } catch {
    return { error: `unexpected output: ${line.slice(0, 200)}` };
  }
  if (typeof parsed.error === 'string') return { error: parsed.error };
  if (parsed.returnValue !== 0) return { error: `Win32_Process.Create returned ${String(parsed.returnValue)}` };
  if (typeof parsed.pid !== 'number' || parsed.pid <= 0) return { error: 'Win32_Process.Create returned no process id' };
  return { pid: parsed.pid };
}

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
