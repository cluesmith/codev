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
 * - Jobs allow no breakaway (#1915). Spec 1658 set BREAKAWAY_OK so a launcher
 *   that asks for breakaway could leave, but the MSYS runtime asks for it on
 *   every native program Git Bash starts: with it set, a session job held only
 *   the shellper, its console host and the launch loop's `bash.exe`, while the
 *   agent (`claude.exe`) and every tool-call process ran outside it, so neither
 *   teardown nor an orphan listing could see them (measured on the owner's
 *   host). Without it those programs start normally and stay in the job (git,
 *   gh, node, cmd, powershell, python, codex, code, claude, and a Claude tool
 *   call, measured). Node's `detached: true` never asked for breakaway anyway
 *   (libuv never passes CREATE_BREAKAWAY_FROM_JOB): there is no `setsid` parity
 *   on Windows, and a process that must outlive its session (the Tower daemon)
 *   is created through CIM. Never KILL_ON_JOB_CLOSE: the helper exiting or
 *   Tower restarting must never kill sessions. The helper creates jobs for
 *   shellper pids only, never for itself or Tower.
 * - Degradation is reported, never silent and never thrown at a session
 *   create: a helper that cannot bind (Constrained Language Mode, policy
 *   blocking powershell.exe), times out or keeps dying leaves sessions without a
 *   job, and teardown falls back to the snapshot kill.
 */

import { spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { windowsPowerShellPath } from '../../platform.js';

/** Job names live in the session-local namespace: Tower and `afx` share a logon session. */
export function sessionJobName(shellperSessionId: string): string {
  return `Local\\codev-session-${shellperSessionId}`;
}

/**
 * The helper program. Binds the kernel32 calls with Reflection.Emit, prints one
 * readiness line, then answers one JSON response per JSON request line:
 *
 * - `{id, op:'assign', name, pid}`: create job `name` (refusing a name that
 *   already exists), with no limit flags (no breakaway, no kill-on-close), assign `pid`, then hand `pid` its own
 *   query-only handle to the job. A job's NAME lives only while some handle to it is
 *   open (member processes do not keep it), so the helper's own handle is not
 *   enough: the helper exits with Tower. The handle duplicated into the
 *   session root keeps the job findable by name for that root's whole life.
 *   It is not inheritable, so the PTY never sees it.
 * - `{id, op:'terminate', name, pid}`: open job `name` and terminate it, only
 *   if `pid` (the session root) is a member (`member:false` otherwise);
 *   `found:false` when no such job exists (its root already exited).
 * - `{id, op:'snapshot'}` (#1915): every process's pid, parent pid and image
 *   name, from one kernel snapshot (`CreateToolhelp32Snapshot`). No command
 *   lines. A few milliseconds, against ~0.5s of CPU for the CIM census, so it is
 *   the table a frequent sweep can afford.
 * - `{id, op:'job-members', name, pid}` (#1915): the processes in job `name`,
 *   only if `pid` (the session root) is a member, each with its state, creation
 *   time and CPU time, its parent pid and image name from the snapshot, and its
 *   parent's state and creation time. A state is `alive`, `gone` (no such
 *   process, or it has exited) or `unknown` (it exists but cannot be opened).
 * - `{id, op:'in-job', name, pid}` (#1915): whether `pid` is in job `name`.
 * - `{id, op:'end-process', name, pid, target, created}` (#1915): terminate
 *   process `target` only if the session root `pid` is in job `name`, `target`
 *   is in the same job, is not the root, and still has creation time `created`
 *   (epoch ms). Answers `ended`, or `gone`, or a refusal `reason`.
 *
 * Errors carry the Win32 code. The readiness line reports a bind failure
 * instead of exiting silently, so the caller can name the cause.
 */
export const HELPER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
function Out-Line($obj) { [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 4)); [Console]::Out.Flush() }
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
    $m.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
  }
  Bind 'CreateJobObjectW' ([IntPtr]) @([IntPtr], [string])
  Bind 'OpenJobObjectW' ([IntPtr]) @([UInt32], [bool], [string])
  Bind 'SetInformationJobObject' ([bool]) @([IntPtr], [Int32], [IntPtr], [UInt32])
  Bind 'AssignProcessToJobObject' ([bool]) @([IntPtr], [IntPtr])
  Bind 'TerminateJobObject' ([bool]) @([IntPtr], [UInt32])
  Bind 'OpenProcess' ([IntPtr]) @([UInt32], [bool], [UInt32])
  Bind 'DuplicateHandle' ([bool]) @([IntPtr], [IntPtr], [IntPtr], [IntPtr].MakeByRefType(), [UInt32], [bool], [UInt32])
  Bind 'IsProcessInJob' ([bool]) @([IntPtr], [IntPtr], [bool].MakeByRefType())
  Bind 'CloseHandle' ([bool]) @([IntPtr])
  Bind 'QueryInformationJobObject' ([bool]) @([IntPtr], [Int32], [IntPtr], [UInt32], [IntPtr])
  Bind 'CreateToolhelp32Snapshot' ([IntPtr]) @([UInt32], [UInt32])
  Bind 'Process32FirstW' ([bool]) @([IntPtr], [IntPtr])
  Bind 'Process32NextW' ([bool]) @([IntPtr], [IntPtr])
  Bind 'GetProcessTimes' ([bool]) @([IntPtr], [Int64].MakeByRefType(), [Int64].MakeByRefType(), [Int64].MakeByRefType(), [Int64].MakeByRefType())
  Bind 'GetExitCodeProcess' ([bool]) @([IntPtr], [UInt32].MakeByRefType())
  Bind 'TerminateProcess' ([bool]) @([IntPtr], [UInt32])
  $K = $type.CreateType()
} catch {
  Out-Line @{ ready = $false; error = $_.Exception.Message; languageMode = $ExecutionContext.SessionState.LanguageMode.ToString() }
  exit 1
}
$JOB_ALL_ACCESS = [UInt32]0x1F001F
$JOB_QUERY = [UInt32]0x0004
# JOB_OBJECT_TERMINATE | JOB_OBJECT_QUERY
$JOB_TERMINATE_QUERY = [UInt32]0x000C
# PROCESS_TERMINATE | PROCESS_DUP_HANDLE | PROCESS_SET_QUOTA
$PROCESS_ACCESS = [UInt32]0x0141
$PROCESS_QUERY_LIMITED = [UInt32]0x1000
$CURRENT_PROCESS = [IntPtr](-1)
# Session jobs set no limit flags: no breakaway (#1915: Git Bash breaks every native
# program out of a job that allows it) and no kill-on-close (sessions outlive Tower).
$SESSION_JOB_LIMIT_FLAGS = 0
$ERROR_FILE_NOT_FOUND = 2
$ERROR_INVALID_PARAMETER = 87
$ERROR_ALREADY_EXISTS = 183
$ERROR_MORE_DATA = 234
# PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION
$PROCESS_TERMINATE_QUERY = [UInt32]0x1001
$STILL_ACTIVE = [UInt32]259
$TH32CS_SNAPPROCESS = [UInt32]2
$JOB_BASIC_PROCESS_ID_LIST = 3
$FILETIME_UNIX_EPOCH = [Int64]116444736000000000
# PROCESSENTRY32W: th32ParentProcessID and szExeFile sit after a pointer-sized field.
$PE_SIZE = 556; $PE_PPID = 24; $PE_EXE = 36
if ([IntPtr]::Size -eq 8) { $PE_SIZE = 568; $PE_PPID = 32; $PE_EXE = 44 }
# The last Win32 error is read by the statement right after each call, with a
# direct static call: anything PowerShell runs in between (even invoking a
# script function) can make its own P/Invoke calls and overwrite it.
$M = [Runtime.InteropServices.Marshal]
function Assign($name, $procId) {
  $existing = $K::OpenJobObjectW($JOB_ALL_ACCESS, $false, $name)
  if ($existing -ne [IntPtr]::Zero) { [void]$K::CloseHandle($existing); return @{ ok = $false; error = 'job name already exists'; code = $ERROR_ALREADY_EXISTS } }
  $job = $K::CreateJobObjectW([IntPtr]::Zero, $name)
  $code = $M::GetLastWin32Error()
  if ($job -eq [IntPtr]::Zero) { return @{ ok = $false; error = 'CreateJobObjectW failed'; code = $code } }
  if ($code -eq $ERROR_ALREADY_EXISTS) { [void]$K::CloseHandle($job); return @{ ok = $false; error = 'job name already exists'; code = $code } }
  try {
    # JOBOBJECT_EXTENDED_LIMIT_INFORMATION: LimitFlags sits at offset 16 on x86 and x64.
    $size = 112
    if ([IntPtr]::Size -eq 8) { $size = 144 }
    $info = $M::AllocHGlobal($size)
    try {
      for ($i = 0; $i -lt $size; $i += 4) { $M::WriteInt32($info, $i, 0) }
      $M::WriteInt32($info, 16, $SESSION_JOB_LIMIT_FLAGS)
      $set = $K::SetInformationJobObject($job, 9, $info, [UInt32]$size)
      $code = $M::GetLastWin32Error()
      if (-not $set) { return @{ ok = $false; error = 'SetInformationJobObject failed'; code = $code } }
    } finally { $M::FreeHGlobal($info) }
    $proc = $K::OpenProcess($PROCESS_ACCESS, $false, [UInt32]$procId)
    $code = $M::GetLastWin32Error()
    if ($proc -eq [IntPtr]::Zero) { return @{ ok = $false; error = 'OpenProcess failed'; code = $code } }
    try {
      $assigned = $K::AssignProcessToJobObject($job, $proc)
      $code = $M::GetLastWin32Error()
      if (-not $assigned) { return @{ ok = $false; error = 'AssignProcessToJobObject failed'; code = $code } }
      # Only after a successful assign, so a refused assign leaves no handle
      # (and no reserved name) behind. Query access is enough to keep the name.
      $held = [IntPtr]::Zero
      $duplicated = $K::DuplicateHandle($CURRENT_PROCESS, $job, $proc, [ref]$held, $JOB_QUERY, $false, [UInt32]0)
      $code = $M::GetLastWin32Error()
      if (-not $duplicated) { return @{ ok = $false; error = 'DuplicateHandle failed (the process is in a job that cannot be found by name)'; code = $code } }
    } finally { [void]$K::CloseHandle($proc) }
    return @{ ok = $true }
  } finally { [void]$K::CloseHandle($job) }
}
function Terminate($name, $procId) {
  $job = $K::OpenJobObjectW($JOB_TERMINATE_QUERY, $false, $name)
  $code = $M::GetLastWin32Error()
  if ($job -eq [IntPtr]::Zero) {
    if ($code -eq $ERROR_FILE_NOT_FOUND) { return @{ ok = $true; found = $false } }
    return @{ ok = $false; error = 'OpenJobObjectW failed'; code = $code }
  }
  try {
    # Only a job the session root is a member of is ours to end: the name may
    # belong to a job this session never joined (an assign refused because the
    # name existed).
    $proc = $K::OpenProcess($PROCESS_QUERY_LIMITED, $false, [UInt32]$procId)
    if ($proc -eq [IntPtr]::Zero) { return @{ ok = $true; found = $true; member = $false } }
    try {
      $inJob = $false
      $queried = $K::IsProcessInJob($proc, $job, [ref]$inJob)
      $code = $M::GetLastWin32Error()
      if (-not $queried) { return @{ ok = $false; error = 'IsProcessInJob failed'; code = $code } }
      if (-not $inJob) { return @{ ok = $true; found = $true; member = $false } }
    } finally { [void]$K::CloseHandle($proc) }
    $terminated = $K::TerminateJobObject($job, [UInt32]1)
    $code = $M::GetLastWin32Error()
    if (-not $terminated) { return @{ ok = $false; error = 'TerminateJobObject failed'; code = $code } }
    return @{ ok = $true; found = $true; member = $true }
  } finally { [void]$K::CloseHandle($job) }
}
function Get-ProcessTable {
  $snap = $K::CreateToolhelp32Snapshot($TH32CS_SNAPPROCESS, [UInt32]0)
  $code = $M::GetLastWin32Error()
  if ($snap -eq [IntPtr](-1)) { throw "CreateToolhelp32Snapshot failed (Win32 error $code)" }
  $entry = $M::AllocHGlobal($PE_SIZE)
  $table = New-Object 'System.Collections.Generic.List[object]'
  try {
    $M::WriteInt32($entry, 0, $PE_SIZE)
    $more = $K::Process32FirstW($snap, $entry)
    while ($more) {
      $table.Add(@{ pid = $M::ReadInt32($entry, 8); ppid = $M::ReadInt32($entry, $PE_PPID); name = $M::PtrToStringUni([IntPtr]($entry.ToInt64() + $PE_EXE)) })
      $more = $K::Process32NextW($snap, $entry)
    }
  } finally { $M::FreeHGlobal($entry); [void]$K::CloseHandle($snap) }
  return ,$table
}
# A process's state, and for a live one its creation time and CPU time (epoch ms, ms).
# An exited process whose handle someone still holds can be opened: the exit
# code tells it from a live one.
function Read-Process($procId) {
  $h = $K::OpenProcess($PROCESS_QUERY_LIMITED, $false, [UInt32]$procId)
  $code = $M::GetLastWin32Error()
  if ($h -eq [IntPtr]::Zero) {
    if ($code -eq $ERROR_INVALID_PARAMETER) { return @{ state = 'gone' } }
    return @{ state = 'unknown' }
  }
  try {
    $exit = [UInt32]0
    if (-not $K::GetExitCodeProcess($h, [ref]$exit)) { return @{ state = 'unknown' } }
    if ($exit -ne $STILL_ACTIVE) { return @{ state = 'gone' } }
    $created = [Int64]0; $exited = [Int64]0; $kernel = [Int64]0; $user = [Int64]0
    if (-not $K::GetProcessTimes($h, [ref]$created, [ref]$exited, [ref]$kernel, [ref]$user)) { return @{ state = 'unknown' } }
    return @{ state = 'alive'; created = [Int64][Math]::Floor(($created - $FILETIME_UNIX_EPOCH) / 10000); cpuMs = [Int64][Math]::Floor(($kernel + $user) / 10000) }
  } finally { [void]$K::CloseHandle($h) }
}
# $true when the process is in the job; $false when it is not, or cannot be opened.
function Test-JobMember($job, $procId) {
  $proc = $K::OpenProcess($PROCESS_QUERY_LIMITED, $false, [UInt32]$procId)
  if ($proc -eq [IntPtr]::Zero) { return $false }
  try {
    $inJob = $false
    $queried = $K::IsProcessInJob($proc, $job, [ref]$inJob)
    $code = $M::GetLastWin32Error()
    if (-not $queried) { throw "IsProcessInJob failed (Win32 error $code)" }
    return $inJob
  } finally { [void]$K::CloseHandle($proc) }
}
function Get-JobPids($job) {
  $capacity = 1024
  while ($true) {
    $size = 8 + $capacity * [IntPtr]::Size
    $buf = $M::AllocHGlobal($size)
    try {
      $queried = $K::QueryInformationJobObject($job, $JOB_BASIC_PROCESS_ID_LIST, $buf, [UInt32]$size, [IntPtr]::Zero)
      $code = $M::GetLastWin32Error()
      if ($queried) {
        $count = $M::ReadInt32($buf, 4)
        $ids = New-Object 'System.Collections.Generic.List[int]'
        for ($i = 0; $i -lt $count; $i++) { $ids.Add([int]$M::ReadIntPtr($buf, 8 + $i * [IntPtr]::Size).ToInt64()) }
        return ,$ids
      }
      if ($code -ne $ERROR_MORE_DATA) { throw "QueryInformationJobObject failed (Win32 error $code)" }
    } finally { $M::FreeHGlobal($buf) }
    $capacity = $capacity * 4
    if ($capacity -gt 65536) { throw 'the job holds too many processes to list' }
  }
}
function Open-JobForQuery($name) {
  $job = $K::OpenJobObjectW($JOB_QUERY, $false, $name)
  $code = $M::GetLastWin32Error()
  if ($job -ne [IntPtr]::Zero) { return @{ job = $job } }
  if ($code -eq $ERROR_FILE_NOT_FOUND) { return @{ result = @{ ok = $true; found = $false } } }
  return @{ result = @{ ok = $false; error = 'OpenJobObjectW failed'; code = $code } }
}
function JobMembers($name, $rootPid) {
  $opened = Open-JobForQuery $name
  if ($null -ne $opened.result) { return $opened.result }
  $job = $opened.job
  try {
    if (-not (Test-JobMember $job $rootPid)) { return @{ ok = $true; found = $true; member = $false } }
    $ids = Get-JobPids $job
    $byPid = @{}
    foreach ($row in (Get-ProcessTable)) { $byPid[$row.pid] = $row }
    $list = New-Object 'System.Collections.Generic.List[object]'
    foreach ($id in $ids) {
      $self = Read-Process $id
      $entry = @{ pid = $id; state = $self.state; parent = 'unknown' }
      if ($self.state -eq 'alive') { $entry.created = $self.created; $entry.cpuMs = $self.cpuMs }
      $row = $byPid[$id]
      if ($null -ne $row) {
        $entry.ppid = $row.ppid
        $entry.name = $row.name
        $parent = Read-Process $row.ppid
        $entry.parent = $parent.state
        if ($parent.state -eq 'alive') { $entry.parentCreated = $parent.created }
      }
      $list.Add($entry)
    }
    return @{ ok = $true; found = $true; member = $true; processes = $list.ToArray() }
  } finally { [void]$K::CloseHandle($job) }
}
function InJob($name, $procId) {
  $opened = Open-JobForQuery $name
  if ($null -ne $opened.result) { return $opened.result }
  try { return @{ ok = $true; found = $true; member = (Test-JobMember $opened.job $procId) } } finally { [void]$K::CloseHandle($opened.job) }
}
function EndProcess($name, $rootPid, $target, $created) {
  if ([int]$target -eq [int]$rootPid) { return @{ ok = $true; ended = $false; reason = 'it is the session root' } }
  $opened = Open-JobForQuery $name
  if ($null -ne $opened.result) {
    if ($opened.result.ok) { return @{ ok = $true; ended = $false; reason = 'the session job no longer exists' } }
    return $opened.result
  }
  $job = $opened.job
  try {
    if (-not (Test-JobMember $job $rootPid)) { return @{ ok = $true; ended = $false; reason = 'the session root is not in the job' } }
    $proc = $K::OpenProcess($PROCESS_TERMINATE_QUERY, $false, [UInt32]$target)
    $code = $M::GetLastWin32Error()
    if ($proc -eq [IntPtr]::Zero) {
      if ($code -eq $ERROR_INVALID_PARAMETER) { return @{ ok = $true; ended = $false; gone = $true } }
      return @{ ok = $false; error = 'OpenProcess failed'; code = $code }
    }
    try {
      $exit = [UInt32]0
      if ($K::GetExitCodeProcess($proc, [ref]$exit) -and $exit -ne $STILL_ACTIVE) { return @{ ok = $true; ended = $false; gone = $true } }
      $inJob = $false
      $queried = $K::IsProcessInJob($proc, $job, [ref]$inJob)
      $code = $M::GetLastWin32Error()
      if (-not $queried) { return @{ ok = $false; error = 'IsProcessInJob failed'; code = $code } }
      if (-not $inJob) { return @{ ok = $true; ended = $false; reason = 'it is not in the session job' } }
      $createdNow = [Int64]0; $exited = [Int64]0; $kernel = [Int64]0; $user = [Int64]0
      if (-not $K::GetProcessTimes($proc, [ref]$createdNow, [ref]$exited, [ref]$kernel, [ref]$user)) { return @{ ok = $true; ended = $false; reason = 'its creation time cannot be read' } }
      if ([Int64][Math]::Floor(($createdNow - $FILETIME_UNIX_EPOCH) / 10000) -ne [Int64]$created) { return @{ ok = $true; ended = $false; reason = 'the pid now belongs to another process' } }
      $terminated = $K::TerminateProcess($proc, [UInt32]1)
      $code = $M::GetLastWin32Error()
      if (-not $terminated) { return @{ ok = $false; error = 'TerminateProcess failed'; code = $code } }
      return @{ ok = $true; ended = $true }
    } finally { [void]$K::CloseHandle($proc) }
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
    elseif ($req.op -eq 'terminate') { $res = Terminate $req.name $req.pid }
    elseif ($req.op -eq 'snapshot') { $res = @{ ok = $true; processes = (Get-ProcessTable).ToArray() } }
    elseif ($req.op -eq 'job-members') { $res = JobMembers $req.name $req.pid }
    elseif ($req.op -eq 'in-job') { $res = InJob $req.name $req.pid }
    elseif ($req.op -eq 'end-process') { $res = EndProcess $req.name $req.pid $req.target $req.created }
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
  pid?: number;
  stdin: Writable;
  stdout: Readable;
  kill(): void;
  on(event: 'exit', listener: (code: number | null) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
}

/**
 * What `-EncodedCommand` carries: read one line from stdin, the helper program
 * as base64 UTF-8, and run it in this scope. The program itself no longer fits
 * a command line (Windows caps one at 32,767 characters, and the encoding
 * nearly triples it), and it still never touches the disk.
 */
export const HELPER_BOOTSTRAP =
  '$program = [Console]::In.ReadLine(); . ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($program))))';

/** The first stdin line a helper reads: the program, as base64 UTF-8. */
export function helperProgramLine(script: string = HELPER_SCRIPT): string {
  return `${Buffer.from(script, 'utf8').toString('base64')}\n`;
}

export function spawnPowerShellHelper(): HelperProcess {
  const child = spawn(
    windowsPowerShellPath(),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodeHelperCommand(HELPER_BOOTSTRAP)],
    { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true },
  );
  // An exited helper surfaces through 'exit'; the client also listens for stdin errors.
  child.stdin.on('error', () => {});
  child.stdin.write(helperProgramLine());
  return child as unknown as HelperProcess;
}

export interface JobResult {
  ok: boolean;
  /** The helper could not serve the request (as opposed to the request failing). */
  helperFailure?: boolean;
  /** The helper is disabled for good; that was already reported once, when it happened. */
  disabled?: boolean;
  /** terminate, job-members, in-job: false when no job had that name. */
  found?: boolean;
  /** terminate, job-members: whether the session root was in the job. in-job: whether the pid is. */
  member?: boolean;
  /** snapshot and job-members: the raw rows, validated by the method that asked. */
  processes?: unknown[];
  /** end-process: the target was terminated. */
  ended?: boolean;
  /** end-process: the target no longer exists. */
  gone?: boolean;
  /** end-process: why the target was not ended. */
  reason?: string;
  error?: string;
  /** Win32 error code, when a call failed. */
  code?: number;
}

/** One row of the kernel process snapshot. */
export interface SnapshotProcess {
  pid: number;
  ppid: number;
  /** Image file name, e.g. `find.exe`. Never a command line. */
  name: string;
}

/**
 * `alive`, `gone` (no such process, or it has exited), or `unknown` (it exists
 * but cannot be opened, e.g. another user's or an elevated process).
 */
export type ProcessState = 'alive' | 'gone' | 'unknown';

/** One process in a session job, as `job-members` reports it. */
export interface JobMemberProcess {
  pid: number;
  state: ProcessState;
  /** Creation time (epoch ms) and CPU time (ms), for a live process. */
  createdAt?: number;
  cpuMs?: number;
  /** From the snapshot; absent when the process was not in it. */
  ppid?: number;
  name?: string;
  parent: ProcessState;
  /** The live parent's creation time (epoch ms). */
  parentCreatedAt?: number;
}

export type SnapshotOutcome =
  | { ok: true; processes: SnapshotProcess[] }
  | { ok: false; error: string; helperFailure: boolean };

export type JobMembersOutcome =
  /** `found: false`: no such job. `member: false`: the root is not in it, so it is not this session's. */
  | { ok: true; found: boolean; member: boolean; processes: JobMemberProcess[] }
  | { ok: false; error: string; helperFailure: boolean };

export type EndProcessOutcome =
  | { ok: true; ended: true }
  | { ok: true; ended: false; gone: boolean; reason?: string }
  | { ok: false; error: string; helperFailure: boolean };

function asInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function asState(value: unknown): ProcessState {
  if (value === 'alive' || value === 'gone') return value;
  return 'unknown';
}

export function parseSnapshotRows(rows: unknown[]): SnapshotProcess[] {
  const processes: SnapshotProcess[] = [];
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const pid = asInt(r.pid);
    const ppid = asInt(r.ppid);
    if (pid === undefined || ppid === undefined) continue;
    processes.push({ pid, ppid, name: typeof r.name === 'string' ? r.name : '' });
  }
  return processes;
}

export function parseJobMemberRows(rows: unknown[]): JobMemberProcess[] {
  const processes: JobMemberProcess[] = [];
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const pid = asInt(r.pid);
    if (pid === undefined || pid <= 0) continue;
    const member: JobMemberProcess = { pid, state: asState(r.state), parent: asState(r.parent) };
    const createdAt = asInt(r.created);
    const cpuMs = asInt(r.cpuMs);
    const ppid = asInt(r.ppid);
    const parentCreatedAt = asInt(r.parentCreated);
    if (member.state === 'alive' && createdAt !== undefined) member.createdAt = createdAt;
    if (member.state === 'alive' && cpuMs !== undefined) member.cpuMs = cpuMs;
    if (ppid !== undefined) member.ppid = ppid;
    if (typeof r.name === 'string') member.name = r.name;
    if (member.parent === 'alive' && parentCreatedAt !== undefined) member.parentCreatedAt = parentCreatedAt;
    processes.push(member);
  }
  return processes;
}

function failureText(result: JobResult): string {
  let error = result.error ?? 'unknown failure';
  if (result.code !== undefined) error = `${error} (Win32 error ${result.code})`;
  return error;
}

export type JobAssignOutcome =
  | { assigned: true }
  /**
   * `helperFailure`: the helper itself could not serve (not ready, disabled,
   * timed out, exited), which it reports once; otherwise this one request was
   * refused or failed in Win32, and the caller reports it.
   */
  | { assigned: false; reason: string; helperFailure: boolean };

/** Defaults, exported so tests can check they fit inside a session create's assign budget. */
export const HELPER_READY_TIMEOUT_MS = 12_000;
export const HELPER_REQUEST_TIMEOUT_MS = 5000;

export interface WindowsJobHelperOptions {
  spawnHelper?: () => HelperProcess;
  /** Reported once per degradation cause. */
  log?: (message: string) => void;
  /** Per-request budget. Default 5s. */
  requestTimeoutMs?: number;
  /** Budget for the helper's bind and readiness line. Default 12s (a cold PowerShell measured 3.6-4.8s). */
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
    this.requestTimeoutMs = opts.requestTimeoutMs ?? HELPER_REQUEST_TIMEOUT_MS;
    this.readyTimeoutMs = opts.readyTimeoutMs ?? HELPER_READY_TIMEOUT_MS;
    this.maxRestarts = opts.maxRestarts ?? 3;
    this.restartWindowMs = opts.restartWindowMs ?? 5 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  /** The helper process's pid while one runs (it is Codev's own, never listed as an orphan). */
  get pid(): number | null {
    return this.proc?.pid ?? null;
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
      let timer: NodeJS.Timeout | undefined;
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
      timer = setTimeout(() => {
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
        const wasCurrent = this.proc === proc;
        this.reset(proc);
        if (!sawReady) {
          this.disable(`the job helper exited (code ${code}) before it was ready`);
        } else if (wasCurrent) {
          // Not a stop(): sessions created until the restart run without a job.
          this.reportOnce('exit', `the job helper exited (code ${code}); it restarts on the next request`);
        }
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
    if (typeof message.member === 'boolean') result.member = message.member;
    if (Array.isArray(message.processes)) result.processes = message.processes;
    if (typeof message.ended === 'boolean') result.ended = message.ended;
    if (typeof message.gone === 'boolean') result.gone = message.gone;
    if (typeof message.reason === 'string') result.reason = message.reason;
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
    this.failPending();
  }

  private failPending(): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, error: 'the job helper exited', helperFailure: true });
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
    if (failure !== null) {
      const result: JobResult = { ok: false, error: failure, helperFailure: true };
      if (failure === this.disabledReason) result.disabled = true;
      return result;
    }
    const proc = this.proc;
    if (!proc) {
      this.reportOnce('exit', 'the job helper exited; it restarts on the next request');
      return { ok: false, error: 'the job helper exited', helperFailure: true };
    }
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.reportOnce('request-timeout', `a request got no answer within ${this.requestTimeoutMs}ms`);
        resolve({ ok: false, error: `no answer within ${this.requestTimeoutMs}ms`, helperFailure: true });
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
    return { assigned: false, reason, helperFailure: result.helperFailure === true };
  }

  /**
   * Terminate job `name` if `rootPid` is in it. `found: false` when no job has
   * that name; `member: false` when the job is not this session's.
   */
  terminate(name: string, rootPid: number): Promise<JobResult> {
    return this.request({ op: 'terminate', name, pid: rootPid });
  }

  /** Every process's pid, parent pid and image name, from one kernel snapshot. */
  async snapshot(): Promise<SnapshotOutcome> {
    const result = await this.request({ op: 'snapshot' });
    if (!result.ok) return { ok: false, error: failureText(result), helperFailure: result.helperFailure === true };
    return { ok: true, processes: parseSnapshotRows(result.processes ?? []) };
  }

  /** The processes in job `name`, if `rootPid` (the session root) is in it. */
  async jobMembers(name: string, rootPid: number): Promise<JobMembersOutcome> {
    const result = await this.request({ op: 'job-members', name, pid: rootPid });
    if (!result.ok) return { ok: false, error: failureText(result), helperFailure: result.helperFailure === true };
    return { ok: true, found: result.found === true, member: result.member === true, processes: parseJobMemberRows(result.processes ?? []) };
  }

  /** Whether `pid` is in job `name`; `found: false` when no such job exists. */
  async inJob(name: string, pid: number): Promise<{ ok: true; found: boolean; member: boolean } | { ok: false; error: string }> {
    const result = await this.request({ op: 'in-job', name, pid });
    if (!result.ok) return { ok: false, error: failureText(result) };
    return { ok: true, found: result.found === true, member: result.member === true };
  }

  /**
   * Terminate `target`, only if it is in job `name` with the session root
   * `rootPid`, is not the root, and still has creation time `createdAt`.
   */
  async endProcess(name: string, rootPid: number, target: number, createdAt: number): Promise<EndProcessOutcome> {
    const result = await this.request({ op: 'end-process', name, pid: rootPid, target, created: createdAt });
    if (!result.ok) return { ok: false, error: failureText(result), helperFailure: result.helperFailure === true };
    if (result.ended === true) return { ok: true, ended: true };
    const outcome: EndProcessOutcome = { ok: true, ended: false, gone: result.gone === true };
    if (result.reason !== undefined) outcome.reason = result.reason;
    return outcome;
  }

  /** Stop the helper. Jobs are not affected: they carry no kill-on-close. */
  stop(): void {
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    this.ready = null;
    this.failPending();
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
/**
 * The members of job `name` with Tower's helper when it runs, else with a
 * one-shot helper, like `terminateSessionJob`.
 */
export async function sessionJobMembers(name: string, rootPid: number, helper: WindowsJobHelper | null = towerHelper): Promise<JobMembersOutcome> {
  if (helper) return helper.jobMembers(name, rootPid);
  const oneShot = new WindowsJobHelper();
  try {
    return await oneShot.jobMembers(name, rootPid);
  } finally {
    oneShot.stop();
  }
}

export async function terminateSessionJob(name: string, rootPid: number, helper: WindowsJobHelper | null = towerHelper): Promise<JobResult> {
  if (helper) return helper.terminate(name, rootPid);
  const oneShot = new WindowsJobHelper();
  try {
    return await oneShot.terminate(name, rootPid);
  } finally {
    oneShot.stop();
  }
}
