# PIR Plan: Windows — show and end orphaned processes in a session

## Understanding

On native Windows, when an agent's tool call times out, the agent's tooling ends the shell it
started but not that shell's children (no process groups / `setsid` parity). The children keep
running inside the session until the session ends. #1910 removes the main trigger (root-wide
file searches); this issue closes the visibility gap and gives the human a way to end them.

Every shellper on Windows is placed in a per-session Job Object named
`Local\codev-session-<shellperSessionId>` by Tower at create
(`packages/codev/src/terminal/session-manager.ts:866-887`), and every process the PTY starts
inherits it. Membership in that job is a kernel fact, so it is the boundary: a process outside
a session's job can never be listed or ended by this change.

The Job Object helper (`packages/codev/src/lib/platform/windows/job-objects.ts:57-185`) is a
long-lived PowerShell process with Win32 calls bound in memory, serving `assign` and
`terminate` over line-delimited JSON. It has no listing request. The process census
(`platform/windows/process-census.ts`) is a fresh `Get-CimInstance Win32_Process` PowerShell per
call (~0.5s CPU), and carries neither process name nor CPU time.

Measured on this host, this builder's own session tree is:

```
shellper (node)            parent: Tower (alive; dead after a Tower restart)
├── conhost.exe --headless parent: shellper
└── bash.exe               launch loop        parent: shellper
    └── bash.exe → bash.exe (function call / command substitution forks)
        └── claude.exe     the agent           parent: launch-loop bash
            └── cmd.exe / bash.exe ...         the agent's tool calls
```

A timed-out tool call's surviving child (for example `find /`) has as parent a bash that has
exited — that is exactly the orphan.

## Proposed Change

### 1. Two new helper requests (`job-objects.ts`)

- **`snapshot`** — `CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS)` + `Process32FirstW/NextW`:
  returns `[{pid, ppid, name}]` for every process. No command lines. This is the cheap
  pid/parent table (~7ms measured by the architect vs ~0.5s for the CIM census). It is shaped so
  the liveness sweep (`agent-state/liveness.ts`, which reads only pid and ppid) could switch to it
  later through a `WindowsJobHelper.snapshot()` method. **The liveness sweep is not changed in
  this PR.**
- **`job-processes`** `{name, pid: rootPid}` — opens the job with `JOB_OBJECT_QUERY`, verifies
  the session root is a member with `IsProcessInJob` (same guard `terminate` uses: a name may
  belong to a job this session never joined), reads the member pids with
  `QueryInformationJobObject(JobObjectBasicProcessIdList)`, then for each member — using the same
  Toolhelp snapshot function for ppid and image name — reads `GetProcessTimes` (creation time,
  kernel+user CPU) and the parent's creation time. Returns
  `[{pid, ppid, name, createdAt, cpuMs, parent: 'alive'|'gone'|'unknown', parentCreatedAt}]`.
  `parent:'unknown'` when the parent pid exists but cannot be opened (access denied).
- **`end-process`** `{name, pid: rootPid, target, createdAt}` — opens the target with
  `PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION`, and calls `TerminateProcess` only if
  (a) the session root is still in job `name`, (b) the target is in the same job
  (`IsProcessInJob`), (c) its creation time equals `createdAt`, and (d) the target is not the
  root. Otherwise returns `refused` with the reason. This puts the "never outside a session's job"
  guarantee in the kernel call path, not only in TypeScript.

Win32 binds added: `CreateToolhelp32Snapshot`, `Process32FirstW`, `Process32NextW`,
`QueryInformationJobObject`, `GetProcessTimes`, `TerminateProcess` (the `PROCESSENTRY32W` struct
is read from an `AllocHGlobal` buffer with `Marshal` offsets, like the existing
`JOBOBJECT_EXTENDED_LIMIT_INFORMATION` write). Still Reflection.Emit, nothing on disk. Client
methods `snapshot()`, `jobProcesses()`, `endProcess()` follow the existing never-throw
`JobResult` pattern.

### 2. Which processes count as orphaned (pure function, `lib/platform/windows/session-orphans.ts`)

`classifyOrphans(members, rootPid)` — a member **P** of the session's job is an orphan iff all hold:

1. P is not the session root (the shellper pid Tower recorded, matched by creation time), **and**
2. P's parent is not running: `parent === 'gone'` (no process with that pid), or the process
   now holding that pid was created after P (`parentCreatedAt > P.createdAt` — pid reuse), **and**
3. P itself could be opened and timed (`createdAt` known).

`parent:'unknown'` is **never** an orphan (fail safe). Each orphan is reported with its in-job
descendants (members reachable from it by live parent links), which are ended with it so ending
an orphan does not just create new ones.

**Why the session's own processes can never be listed or ended:**

| Process | Why excluded |
|---|---|
| Shellper (session root) | Rule 1, explicitly by pid + creation time. Needed because after a Tower restart its parent (old Tower) *is* dead. `end-process` also refuses the root in the helper. |
| Console host (`conhost.exe --headless` / `OpenConsole.exe`) | Its parent is the shellper, which is alive for as long as the session is listed (the listing requires the root to be a live job member). Rule 2 fails. |
| Launch loop (bash, incl. its forked bash subshells) | Parent is the shellper (alive), or a bash of the loop that is alive while its child runs. Rule 2 fails. |
| Agent (`claude.exe` etc.) | Parent is the launch loop's bash, alive while it waits on the agent. Rule 2 fails. |
| Any process outside the job | Never enumerated (`JobObjectBasicProcessIdList` only returns members), and `end-process` refuses a non-member in the kernel check. |

Every one of those sits on an unbroken chain of live parents back to the root, and rule 2 only
matches a process whose chain is broken at its own parent. The only way one of them could match
is if its parent genuinely exited — e.g. the launch loop crashed while the agent kept running —
and then the agent truly is orphaned; even so, it is only *listed*, never ended without the human
running the command and confirming the listed pid.

**A background process the user deliberately started** from an agent's or shell terminal's shell
(e.g. `nohup server &` whose shell then exited) also has no living parent, so it **is listed**.
That is intended: it is shown, never ended automatically. Ending requires the explicit command,
which prints exactly what it will end (name, pid, age, CPU) and asks for confirmation; the user
leaves it alone by not running it, or by naming a single session that doesn't contain it.

A session without a job (helper degraded, or assign refused) is reported as "no job — orphans
cannot be listed"; there is deliberately no fallback to a parent-link guess, since without job
membership nothing proves a process belongs to the session.

### 3. Tower routes (`servers/tower-routes.ts`, new `servers/session-orphans.ts`)

Following the husk-sweep precedent (`GET /api/shellpers/husks` + `POST .../sweep`):

- `GET /api/orphans[?workspace=<path>]` — for every shellper-backed session Tower holds (in that
  workspace, or all workspaces), call `jobProcesses` on Tower's warm helper and classify. Response
  per session: workspace, agent label (builder id / architect name / shell), terminal id,
  `job: true|false`, error if any, and orphans `{pid, name, createdAt, cpuMs, descendants[]}`.
  On non-Windows: `{supported: false, sessions: []}`.
- `POST /api/orphans/end` `{workspace, terminalId?, targets:[{terminalId, pid, createdAt}]}` —
  ends exactly the previewed targets. For each, re-lists the session's job, re-checks the target
  is still an orphan (or an orphan's descendant) with the same creation time, then calls
  `end-process`. Per-target result: `ended` | `gone` | `refused: <reason>`. Nothing is ended that
  was not in the request. Logged by pid and name only.

Tower owns the sessions (shellper pid, start time, shellper session id, agent label) and the warm
helper, so no one-shot PowerShell start per call.

### 4. `afx orphans` (new `agent-farm/commands/orphans.ts`, wired in `cli.ts`)

```
afx orphans [agent]          list orphans in this workspace's sessions (or one agent's session)
afx orphans [agent] --apply  list, confirm, then end them
            -y / --yes       skip the confirmation
```

Same preview/`--apply`/`-y` UX as `afx tower sweep-husks` and `afx workspace recover`. `agent` is
a builder id or architect name in the current workspace; omitted means every session in the
workspace. Output columns: SESSION, PID, NAME, AGE, CPU (descendants indented under their
orphan). Never prints command lines. On macOS/Linux: prints "Windows only: on macOS and Linux a
timed-out command's children end with it" and exits 0. Tower down: error like `sweep-husks`.

### 5. `afx status` and `codev doctor`

- `afx status` (Windows only): after the builders table, an **Orphaned processes** section listing
  per session the same columns, shown only when there is at least one orphan or a session without
  a job; one-line hint `afx orphans --apply` to end them. A failed/slow query (2s budget) prints a
  single "orphan listing unavailable: <reason>" line and never fails the command. `--json` gains
  an `orphans` field.
- `codev doctor` (Windows only, in the existing Process Census section): queries
  `GET /api/orphans` (all workspaces). Tower not running → "- Orphaned processes: skipped (Tower
  not running)". Orphans found → a warning listing count per session with recommendation
  `afx orphans --apply` in that workspace. None → ✓.

### 6. Documentation

`codev/DEPENDENCIES.md` and `codev-skeleton/DEPENDENCIES.md` (currently identical, kept
identical): a "Processes left behind by a timed-out command" paragraph under *Native Windows*:
cause, what `afx status`/`codev doctor` show, `afx orphans`, that nothing is ended automatically,
and that a deliberately started background process is listed too. Also the `afx` skill
(`.claude/skills/afx` and the skeleton copy, if both exist) gains the subcommand, and
`codev/resources/commands/agent-farm.md` if it documents `sweep-husks`.

## Files to Change

- `packages/codev/src/lib/platform/windows/job-objects.ts` — helper script: new binds, `Snapshot`,
  `JobProcesses`, `EndProcess` functions and dispatch; client methods + result types.
- `packages/codev/src/lib/platform/windows/session-orphans.ts` — new: `classifyOrphans()` (pure)
  and `listSessionOrphans()/endSessionOrphans()` over a helper.
- `packages/codev/src/agent-farm/servers/session-orphans.ts` — new: route handlers, session
  enumeration from Tower's terminal registry + session manager.
- `packages/codev/src/agent-farm/servers/tower-routes.ts:217-250` — two routes.
- `packages/codev/src/agent-farm/lib/tower-client.ts` (+ sdk client if that is where
  `findHuskCandidates` lives) — `listOrphans()`, `endOrphans()`; types in `codev-types`.
- `packages/codev/src/agent-farm/commands/orphans.ts` — new command; `agent-farm/cli.ts` wiring.
- `packages/codev/src/agent-farm/commands/status.ts` — Windows orphan section + JSON field.
- `packages/codev/src/commands/doctor.ts:1803-1841` — orphan line in the Windows section.
- `codev/DEPENDENCIES.md`, `codev-skeleton/DEPENDENCIES.md` — Windows section.
- afx skill / command reference docs (both trees where mirrored).
- Tests listed below.

## Risks & Alternatives Considered

- **Risk: ending a process the user wanted.** Mitigation: never automatic; preview + confirm;
  `end-process` only ends the exact pid + creation time that was shown, re-verified in the kernel.
- **Risk: pid reuse between preview and end.** Mitigation: creation-time match in the helper.
- **Risk: Toolhelp snapshot and job pid list are taken microseconds apart.** A process that
  starts/exits in between is simply absent or `gone`; a member missing from the snapshot gets
  `parent:'unknown'` and is not listed. Re-verified at end time anyway.
- **Risk: PowerShell struct marshalling bugs (PROCESSENTRY32W layout, x86/x64/ARM64).** Mitigation:
  Windows integration test exercising it on the runner; the on-demand workflow runs x64 and ARM64
  probe legs.
- **Risk: helper degraded.** Listing reports the helper's degraded reason per session; doctor
  already reports helper availability.
- **Alternative: run the listing CLI-side** (census of shellper command lines + one-shot helper,
  as `afx cleanup` does). Rejected for status/doctor: a cold PowerShell (~4s) per `afx status`,
  and the CLI lacks the agent labels. Tower-down listing is not supported in this change (Tower
  down is short-lived; `afx orphans` says to start Tower).
- **Alternative: use the CIM census for ppid.** Rejected: ~0.5s CPU per call, no CPU time, and
  carries command lines we must not print; the Toolhelp snapshot is the shareable cheap table the
  architect asked for.
- **Alternative: `taskkill /T` on the orphan.** Rejected: it follows ppid links without a job
  check; `end-process` per pid with the job check is the stated guarantee.
- **Out of scope (per issue + architect):** automatic ending, liveness-sweep migration, changes to
  agent tooling, macOS/Linux behaviour.

## Test Plan

**Unit (all platforms, CI):**
- `classifyOrphans`: root with dead parent is never an orphan; conhost/launch loop/agent with
  live parents are not; member with `parent:'gone'` is; pid-reuse (`parentCreatedAt > createdAt`)
  is; `parent:'unknown'` is not; descendants attached to their orphan; a live-parent child of an
  orphan is a descendant, not a second orphan.
- Helper client: `snapshot`/`jobProcesses`/`endProcess` request/response parsing with the fake
  `HelperProcess` (pattern in `windows-job.test.ts`), including timeouts/degraded.
- Route handlers with a fake helper and session registry: workspace filtering, a session with no
  job, end re-verification (target no longer orphan → `refused`, creation time changed → `refused`,
  target not in request → untouched).
- `afx orphans`: preview only without `--apply`; confirm declined → nothing ended; `-y`; POSIX
  message; Tower down. `afx status` rendering and JSON field; doctor line (skipped/✓/warn).

**Windows integration (`*.windows.test.ts`, run by the on-demand workflow's targeted job):**
- Start a real shellper session via `SessionManager` with a job helper (as
  `shellper-named-pipe.windows.test.ts` does). In it run a command that plants a child whose
  parent then exits (`cmd /c start /b node leaf.cjs`, the pattern in `windows-job.windows.test.ts`).
  Assert the listing shows exactly the leaf (not the shellper, conhost or the shell), the end
  request ends it, and the shellper and the session's shell are still alive afterwards.
- A process outside any session job, also with a dead parent: never listed; an `end-process`
  naming it is refused by the helper and the process survives.
- `snapshot` returns this process with its correct parent and a cost line (`JOB-COST snapshot`).
- Dispatch `gh workflow run windows.yml --ref builder/pir-1915 -f purpose='#1915 orphan listing/ending' -f suites=true -f filter=orphan`
  and link the run in the PR.

**Manual (reviewer at `dev-approval`, on this Windows host):**
1. In a builder or shell terminal in the worktree's Tower, run `bash -c 'sleep 3000 & exit'`
   (or a `find / -name x` that is interrupted by closing its shell).
2. `afx status` → an *Orphaned processes* section shows `sleep.exe` with age and CPU, and no
   command line. `codev doctor` → warning naming that session.
3. `afx orphans` → preview only. `afx orphans --apply` → lists, asks, ends it; `afx status` no
   longer shows it; the agent and the terminal keep working.
4. Full suite run once (one at a time with bugfix-1910), Tower PID recorded before and after;
   #1923 flakes re-run once.
