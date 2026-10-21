/**
 * Per-session Job Objects on Windows (Spec 1658, Phase 3b, Area B2).
 *
 * A process orphaned by a non-Node launcher (`cmd start /b`) has a dead parent,
 * so neither the teardown snapshot nor `taskkill /T` can link it to its
 * session. A Job Object can: every process a shellper's PTY starts inherits the
 * shellper's job, and `TerminateJobObject` ends them all, parent links or not.
 *
 * - No binary and nothing compiled to disk. The Win32 calls are bound inside
 *   PowerShell with `System.Reflection.Emit`, so the assembly exists only in
 *   memory. Windows PowerShell's `Add-Type` is not used: it compiles a DLL into
 *   `%TEMP%` and loads it from disk, which application control can block.
 * - One long-lived helper per Tower, started at boot, binds once and serves
 *   line-delimited JSON over stdin/stdout, so a session create pays a round trip
 *   to a warm helper, not a PowerShell start.
 * - Jobs carry BREAKAWAY_OK (a `detached: true` child leaves the session, as
 *   `setsid` does on POSIX) and never KILL_ON_JOB_CLOSE: the helper exiting or
 *   Tower restarting must never kill sessions. The helper creates jobs for
 *   shellper pids only, never for itself or Tower.
 * - Degradation is reported, never silent and never thrown at a session
 *   create: a helper that cannot bind (Constrained Language Mode, policy
 *   blocking powershell.exe), times out or keeps dying leaves sessions without a
 *   job, and teardown falls back to the snapshot kill.
 */

import { spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

/** Job names live in the session-local namespace: Tower and `afx` share a logon session. */
export function sessionJobName(shellperSessionId: string): string {
  return `Local\\codev-session-${shellperSessionId}`;
}

/**
 * The helper program. Binds the kernel32 calls with Reflection.Emit, prints one
 * readiness line, then answers one JSON response per JSON request line:
 *
 * - `{id, op:'assign', name, pid}`: create job `name` (refusing a name that
 *   already exists), set BREAKAWAY_OK, assign `pid`, close the handle. The job
 *   lives while any process is in it.
 * - `{id, op:'terminate', name}`: open job `name` and terminate it;
 *   `found:false` when no such job exists (every member already exited).
 *
 * Errors carry the Win32 code. The readiness line reports a bind failure
 * instead of exiting silently, so the caller can name the cause.
 */
export const HELPER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
function Out-Line($obj) { [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress)); [Console]::Out.Flush() }
try {
  $asm = [AppDomain]::CurrentDomain.DefineDynamicAssembly((New-Object Reflection.AssemblyName 'CodevJob'), [Reflection.Emit.AssemblyBuilderAccess]::Run)
  $type = $asm.DefineDynamicModule('CodevJob').DefineType('CodevJob.Native', 'Public, Class')
  $ctor = [Runtime.InteropServices.DllImportAttribute].GetConstructor(@([string]))
  $fields = [Reflection.FieldInfo[]]@(
    [Runtime.InteropServices.DllImportAttribute].GetField('SetLastError'),
    [Runtime.InteropServices.DllImportAttribute].GetField('CharSet'))
  $values = [object[]]@($true, [Runtime.InteropServices.CharSet]::Unicode)
  function Bind($name, [Type]$ret, [Type[]]$params) {
    $m = $type.DefineMethod($name, 'Public, Static, PinvokeImpl', $ret, $params)
    $m.SetCustomAttribute((New-Object Reflection.Emit.CustomAttributeBuilder($ctor, @('kernel32.dll'), $fields, $values)))
  }
  Bind 'CreateJobObjectW' ([IntPtr]) @([IntPtr], [string])
  Bind 'OpenJobObjectW' ([IntPtr]) @([UInt32], [bool], [string])
  Bind 'SetInformationJobObject' ([bool]) @([IntPtr], [Int32], [IntPtr], [UInt32])
  Bind 'AssignProcessToJobObject' ([bool]) @([IntPtr], [IntPtr])
  Bind 'TerminateJobObject' ([bool]) @([IntPtr], [UInt32])
  Bind 'OpenProcess' ([IntPtr]) @([UInt32], [bool], [UInt32])
  Bind 'CloseHandle' ([bool]) @([IntPtr])
  $K = $type.CreateType()
} catch {
  Out-Line @{ ready = $false; error = $_.Exception.Message; languageMode = $ExecutionContext.SessionState.LanguageMode.ToString() }
  exit 1
}
$JOB_ALL_ACCESS = [UInt32]0x1F001F
$JOB_TERMINATE = [UInt32]0x0008
$PROCESS_SET_QUOTA_TERMINATE = [UInt32]0x0101
$BREAKAWAY_OK = 0x0800
$ERROR_ALREADY_EXISTS = 183
function LastError { [Runtime.InteropServices.Marshal]::GetLastWin32Error() }
function Assign($name, $procId) {
  $existing = $K::OpenJobObjectW($JOB_ALL_ACCESS, $false, $name)
  if ($existing -ne [IntPtr]::Zero) { [void]$K::CloseHandle($existing); return @{ ok = $false; error = 'job name already exists'; code = $ERROR_ALREADY_EXISTS } }
  $job = $K::CreateJobObjectW([IntPtr]::Zero, $name)
  $code = LastError
  if ($job -eq [IntPtr]::Zero) { return @{ ok = $false; error = 'CreateJobObjectW failed'; code = $code } }
  if ($code -eq $ERROR_ALREADY_EXISTS) { [void]$K::CloseHandle($job); return @{ ok = $false; error = 'job name already exists'; code = $code } }
  try {
    # JOBOBJECT_EXTENDED_LIMIT_INFORMATION: LimitFlags sits at offset 16 on x86 and x64.
    $size = 112
    if ([IntPtr]::Size -eq 8) { $size = 144 }
    $info = [Runtime.InteropServices.Marshal]::AllocHGlobal($size)
    try {
      for ($i = 0; $i -lt $size; $i += 4) { [Runtime.InteropServices.Marshal]::WriteInt32($info, $i, 0) }
      [Runtime.InteropServices.Marshal]::WriteInt32($info, 16, $BREAKAWAY_OK)
      if (-not $K::SetInformationJobObject($job, 9, $info, [UInt32]$size)) { return @{ ok = $false; error = 'SetInformationJobObject failed'; code = (LastError) } }
    } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($info) }
    $proc = $K::OpenProcess($PROCESS_SET_QUOTA_TERMINATE, $false, [UInt32]$procId)
    if ($proc -eq [IntPtr]::Zero) { return @{ ok = $false; error = 'OpenProcess failed'; code = (LastError) } }
    try {
      if (-not $K::AssignProcessToJobObject($job, $proc)) { return @{ ok = $false; error = 'AssignProcessToJobObject failed'; code = (LastError) } }
    } finally { [void]$K::CloseHandle($proc) }
    return @{ ok = $true }
  } finally { [void]$K::CloseHandle($job) }
}
function Terminate($name) {
  $job = $K::OpenJobObjectW($JOB_TERMINATE, $false, $name)
  if ($job -eq [IntPtr]::Zero) { return @{ ok = $true; found = $false } }
  try {
    if (-not $K::TerminateJobObject($job, [UInt32]1)) { return @{ ok = $false; error = 'TerminateJobObject failed'; code = (LastError) } }
    return @{ ok = $true; found = $true }
  } finally { [void]$K::CloseHandle($job) }
}
Out-Line @{ ready = $true; languageMode = $ExecutionContext.SessionState.LanguageMode.ToString() }
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq '') { continue }
  $id = $null
  try {
    $req = $line | ConvertFrom-Json
    $id = $req.id
    if ($req.op -eq 'assign') { $res = Assign $req.name $req.pid }
    elseif ($req.op -eq 'terminate') { $res = Terminate $req.name }
    else { $res = @{ ok = $false; error = "unknown op $($req.op)" } }
  } catch {
    $res = @{ ok = $false; error = $_.Exception.Message }
  }
  $res.id = $id
  Out-Line $res
}
`;

/** `-EncodedCommand` takes base64 of UTF-16LE; stdin stays free for requests. */
export function encodeHelperCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/** The process a helper runs in. Production spawns powershell.exe; tests inject a fake. */
export interface HelperProcess {
  stdin: Writable;
  stdout: Readable;
  kill(): void;
  on(event: 'exit', listener: (code: number | null) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
}

export function spawnPowerShellHelper(): HelperProcess {
  return spawn(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodeHelperCommand(HELPER_SCRIPT)],
    { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true },
  ) as unknown as HelperProcess;
}

export interface JobResult {
  ok: boolean;
  /** terminate: false when no job had that name. */
  found?: boolean;
  error?: string;
  /** Win32 error code, when a call failed. */
  code?: number;
}

export type JobAssignOutcome =
  | { assigned: true }
  | { assigned: false; reason: string };

export interface WindowsJobHelperOptions {
  spawnHelper?: () => HelperProcess;
  /** Reported once per degradation cause. */
  log?: (message: string) => void;
  /** Per-request budget. Default 5s. */
  requestTimeoutMs?: number;
  /** Budget for the helper's bind and readiness line. Default 20s (a cold PowerShell). */
  readyTimeoutMs?: number;
  /** Restarts allowed within `restartWindowMs` before the helper stays degraded. Default 3. */
  maxRestarts?: number;
  restartWindowMs?: number;
  now?: () => number;
}

interface Pending {
  resolve: (result: JobResult) => void;
  timer: NodeJS.Timeout;
}

/**
 * Client for one helper process. `start()` is idempotent and single-flight;
 * requests issued before readiness wait for it. An exit restarts the helper
 * lazily on the next request, at most `maxRestarts` times in `restartWindowMs`,
 * then the helper is disabled for this client's life. Requests never reject:
 * every failure comes back as `{ ok: false, error }`.
 */
export class WindowsJobHelper {
  private readonly spawnHelper: () => HelperProcess;
  private readonly log: (message: string) => void;
  private readonly requestTimeoutMs: number;
  private readonly readyTimeoutMs: number;
  private readonly maxRestarts: number;
  private readonly restartWindowMs: number;
  private readonly now: () => number;

  private proc: HelperProcess | null = null;
  private ready: Promise<string | null> | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private starts: number[] = [];
  private disabledReason: string | null = null;
  private loggedCauses = new Set<string>();

  constructor(opts: WindowsJobHelperOptions = {}) {
    this.spawnHelper = opts.spawnHelper ?? spawnPowerShellHelper;
    this.log = opts.log ?? (() => {});
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 5000;
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 20_000;
    this.maxRestarts = opts.maxRestarts ?? 3;
    this.restartWindowMs = opts.restartWindowMs ?? 5 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  /** Why jobs are unavailable for good, or null while the helper can still serve. */
  get degradedReason(): string | null {
    return this.disabledReason;
  }

  /** Start the helper and wait for its bind. Resolves null when ready, else the failure. */
  start(): Promise<string | null> {
    if (this.disabledReason !== null) return Promise.resolve(this.disabledReason);
    if (this.ready) return this.ready;

    const recent = this.starts.filter((t) => this.now() - t < this.restartWindowMs);
    // The first start is not a restart.
    if (recent.length > this.maxRestarts) {
      this.disable(`the job helper exited ${recent.length} times within ${Math.round(this.restartWindowMs / 1000)}s`);
      return Promise.resolve(this.disabledReason);
    }
    this.starts = [...recent, this.now()];
    this.ready = this.launch();
    return this.ready;
  }

  private launch(): Promise<string | null> {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (failure: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(failure);
      };

      let proc: HelperProcess;
      try {
        proc = this.spawnHelper();
      } catch (err) {
        this.disable(`the job helper could not start: ${(err as Error).message}`);
        settle(this.disabledReason);
        return;
      }
      this.proc = proc;
      const timer = setTimeout(() => {
        this.reportOnce('ready-timeout', `the job helper did not report ready within ${this.readyTimeoutMs}ms`);
        this.reset(proc);
        settle('the job helper did not report ready in time');
      }, this.readyTimeoutMs);

      let buffer = '';
      let sawReady = false;
      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (chunk: string) => {
        buffer += chunk;
        let newline = buffer.indexOf('\n');
        while (newline !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');
          if (line === '') continue;
          let message: Record<string, unknown>;
          try {
            message = JSON.parse(line);
          } catch {
            continue; // Not protocol output
          }
          if (!sawReady && 'ready' in message) {
            sawReady = true;
            if (message.ready === true) {
              settle(null);
            } else {
              // A bind failure does not improve on retry (Constrained Language Mode, policy).
              this.disable(`the job helper could not bind its Win32 calls (language mode ${String(message.languageMode)}): ${String(message.error)}`);
              settle(this.disabledReason);
            }
            continue;
          }
          this.answer(message);
        }
      });
      // A helper that cannot start or dies before its readiness line will do
      // the same on every retry (powershell.exe blocked, a language mode that
      // refuses even the error report), so either disables it. Restarts are
      // for a helper that exits after serving.
      proc.on('error', (err) => {
        this.reset(proc);
        if (!sawReady) this.disable(`the job helper could not start: ${err.message}`);
        settle(this.disabledReason ?? `the job helper failed: ${err.message}`);
      });
      proc.on('exit', (code) => {
        this.reset(proc);
        if (!sawReady) this.disable(`the job helper exited (code ${code}) before it was ready`);
        settle(this.disabledReason ?? 'the job helper exited');
      });
      proc.stdin.on('error', () => {
        // Surfaced through 'exit'
      });
    });
  }

  private answer(message: Record<string, unknown>): void {
    const id = message.id;
    if (typeof id !== 'number') return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    const result: JobResult = { ok: message.ok === true };
    if (typeof message.found === 'boolean') result.found = message.found;
    if (typeof message.error === 'string') result.error = message.error;
    if (typeof message.code === 'number') result.code = message.code;
    pending.resolve(result);
  }

  /** Forget a dead or abandoned process: fail its requests, and let the next request restart it. */
  private reset(proc: HelperProcess): void {
    if (this.proc !== proc) return;
    this.proc = null;
    this.ready = null;
    try {
      proc.kill();
    } catch {
      // Already gone
    }
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, error: 'the job helper exited' });
      this.pending.delete(id);
    }
  }

  private disable(reason: string): void {
    if (this.disabledReason === null) {
      this.disabledReason = reason;
      this.log(`Per-session job objects disabled: ${reason}. Sessions start without a job; teardown uses the process-tree snapshot.`);
    }
  }

  private reportOnce(cause: string, message: string): void {
    if (this.loggedCauses.has(cause)) return;
    this.loggedCauses.add(cause);
    this.log(`Job helper: ${message}`);
  }

  private async request(op: Record<string, unknown>): Promise<JobResult> {
    const failure = await this.start();
    if (failure !== null) return { ok: false, error: failure };
    const proc = this.proc;
    if (!proc) return { ok: false, error: 'the job helper exited' };
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.reportOnce('request-timeout', `a request got no answer within ${this.requestTimeoutMs}ms`);
        resolve({ ok: false, error: `no answer within ${this.requestTimeoutMs}ms` });
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, timer });
      proc.stdin.write(JSON.stringify({ ...op, id }) + '\n');
    });
  }

  /**
   * Put `pid` in a new job named `name`. Never throws: a refusal (the name
   * already exists, so the job is not ours) or failure leaves the session
   * without a job, and the reason is returned for the caller to log.
   */
  async assign(name: string, pid: number): Promise<JobAssignOutcome> {
    const result = await this.request({ op: 'assign', name, pid });
    if (result.ok) return { assigned: true };
    let reason = result.error ?? 'unknown failure';
    if (result.code !== undefined) reason = `${reason} (Win32 error ${result.code})`;
    return { assigned: false, reason };
  }

  /** Terminate job `name`. `found: false` when no process is left in it. */
  terminate(name: string): Promise<JobResult> {
    return this.request({ op: 'terminate', name });
  }

  /** Stop the helper. Jobs are not affected: they carry no kill-on-close. */
  stop(): void {
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    this.ready = null;
    try {
      proc.stdin.end();
    } catch {
      // Already closed
    }
    try {
      proc.kill();
    } catch {
      // Already gone
    }
  }
}

let towerHelper: WindowsJobHelper | null = null;

/** Tower's helper, set at boot on Windows. Null on POSIX and outside Tower. */
export function getTowerJobHelper(): WindowsJobHelper | null {
  return towerHelper;
}

export function setTowerJobHelper(helper: WindowsJobHelper | null): void {
  towerHelper = helper;
}

/**
 * Terminate job `name` with Tower's helper when it runs, else with a one-shot
 * helper (an `afx cleanup` with Tower down). Teardown is not a hot path, so the
 * cold start is acceptable there.
 */
export async function terminateSessionJob(name: string, helper: WindowsJobHelper | null = towerHelper): Promise<JobResult> {
  if (helper) return helper.terminate(name);
  const oneShot = new WindowsJobHelper();
  try {
    return await oneShot.terminate(name);
  } finally {
    oneShot.stop();
  }
}
