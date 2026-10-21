/**
 * `afx tower start` from inside a codev session on Windows (Spec 1658 Phase 4).
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
 */

import { execFile } from 'node:child_process';
import { SHELLPER_SESSION_ENV, isInsideCodevSession } from '../../terminal/shellper-endpoint.js';
import { quoteWindowsArg } from '../../terminal/shellper-cmdline.js';
import { encodeHelperCommand } from '../../lib/windows-job.js';

const CIM_LAUNCH_TIMEOUT_MS = 30_000;

/** The supported ways to start Tower when CIM is unavailable; doctor names the same. */
export const SUPPORTED_TOWER_LAUNCH_PATHS =
  'start Tower from a terminal that is not a codev session (for example Windows Terminal or a PowerShell window), or let the VS Code extension start it';

export { isInsideCodevSession };

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
 * Tower's boot self-check: the warning to log once, or null. Windows only. A
 * warning, never a refusal: the marker is inherited and can be stale, and the
 * launcher is what refuses.
 */
export function towerBootSessionWarning(env: NodeJS.ProcessEnv, windows: boolean): string | null {
  if (!windows || !isInsideCodevSession(env)) return null;
  return `${TOWER_IN_SESSION_WARNING}. To avoid it, ${SUPPORTED_TOWER_LAUNCH_PATHS}.`;
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
      'powershell.exe',
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
