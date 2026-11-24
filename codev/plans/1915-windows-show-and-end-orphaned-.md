# PIR Plan: Windows — keep agents in their session job, then show and end orphaned processes

Revision 2. It follows the owner's decision (option A, same PR) after the finding below.

## Understanding

On native Windows, when an agent's tool call times out, the agent's tooling ends the shell it
started but not that shell's children, so the children run on until the session ends. #1910
removes the main trigger. This issue asks Codev to show those processes and end them when the
human asks.

### The finding that changed the plan

The issue assumes a session's processes are in its Job Object. On this host most of them are
not (all measured 2026-11-23, Node 22.23.4, Git for Windows):

1. This builder's own session job (`QueryInformationJobObject` member list) held only the shellper,
   `conhost` and three launch-loop `bash.exe`. `claude.exe` and every tool-call process were
   outside it (`IsProcessInJob`).
2. **Cause:** session jobs are created with `JOB_OBJECT_LIMIT_BREAKAWAY_OK`
   (`packages/codev/src/lib/platform/windows/job-objects.ts:94,115`). Git Bash (the MSYS runtime)
   starts every native program with breakaway. I ran the same Git Bash in standalone jobs:
   - **Breakaway allowed (`0x800`):** `bash` stayed in the job; its `node` child did not.
   - **No breakaway (flags `0`):** `node` stayed in the job, and `node` and `cmd` both ran
     normally.
3. **Isolated Tower, real shellper session** running `node & cmd /c ping & (node &)`: only the
   `bash.exe` processes were members, including an orphaned bash subshell. `node`, `cmd` and
   `ping` were not.
4. **Survey with breakaway turned off** (each program started from Git Bash inside the job): all
   exited 0 —
   - `git --version`, `gh --version`, `python --version`
   - `node` starting `cmd`, `cmd /c ver`, `powershell -Command 1`
   - `codex --version`, `code --version`, `claude --version`
   - a real `claude -p` turn that ran a Bash tool call (`echo …; sleep 3`)

   Members seen while they ran: `bash`, `claude`, `codex`, `conhost`, `node`, `powershell`, `sh`,
   `sleep`. With breakaway allowed, only `bash` and `conhost`.

So today a job listing would never see agent tool-call orphans. Spec 1658's "terminating the job
ends the session" also does not cover native programs started from Git Bash. Spec 1658 kept
`BREAKAWAY_OK` (Phase 3b, ruling (c)) so that a launcher which explicitly asks for breakaway can
leave. Its Phase 6 found MSYS breakaway (the `afx dev` teardown miss) and fixed teardown with
snapshot-first ordering (`windows/process-tree.ts:188-191`). Nobody measured that this left
agents outside their job.

### The new hazard once breakaway is gone (re-tested as the architect asked)

**Inside today's breakaway-allowed job — `afx tower start` from inside a session:** Tower is
created through CIM (`tower.ts:323-345`) and was **not** in the session job.

**Inside a no-breakaway job — Tower started by a plain spawn from Git Bash**
(`node tower-server.js <port> & disown`, the session marker unset):
- Tower **was a member** of the job, with a dead parent.
- Its Job Object helper (`powershell.exe`), the shellper it created for a new session, that
  shellper's `conhost` and its child were all members too. Shellper jobs nest inside the outer job.
- `TerminateJobObject` on the job — what session teardown does — **ended Tower and that whole
  other session.**

Today that Tower would have broken away. Without breakaway, a Tower or shellper started from
inside a session is inside that session's job. This plan guards against it in three places:
- Tower start (it refuses)
- session teardown (it does not terminate a job that holds foreign infrastructure)
- the orphan listing (such processes are never listed or ended)

## Proposed Change — commits in this order

### Commit 1 (alone, revertable by itself): drop `BREAKAWAY_OK` from session jobs

- `job-objects.ts`: the `assign` op no longer writes `BREAKAWAY_OK`. The job keeps its other
  settings: no `KILL_ON_JOB_CLOSE` and no `SILENT_BREAKAWAY_OK`. Rewrite the module header and op
  comment: which process escaped, the measurements above, and why the Phase 3b ruling (c) choice is
  reversed (the owner's decision on #1915).
- `windows/process-tree.ts:188-191`: update the comment. The snapshot-first order stays; it still
  covers a process created outside the job and a job created by an older Tower.
- `codev/resources/arch.md` (Platform Layer → Process tree) and `lessons-learned.md` (the #1658
  entry on breakaway): record that session jobs allow no breakaway and why. A session-job member
  now cannot leave; anything that must outlive a session is created through CIM.
- Sessions created by a Tower before this change keep their old job. The change applies to sessions
  created after a Tower restart.

### Commit 2: keep Codev infrastructure out of session jobs, and protect it in teardown

- **Tower refuses to start inside a session's job.** At boot on Windows, if
  `CODEV_SHELLPER_SESSION` is set and Tower is in that session's job (`IsProcessInJob` against the
  named job, through a one-shot check), Tower logs and exits with the supported launch paths. This
  matches 1658's rule that a daemon inside the session's job is never started; `afx tower start`
  already uses CIM there.
- **Teardown guard** (`killWindowsTree`). Before `TerminateJobObject`, read the job's member list
  through a new helper op. Teardown already takes a fresh census, and its command lines mark two
  kinds of process:
  - a **foreign shellper:** `shellper-main.js`, not this session's root
  - a **Tower:** `tower-server.js`, or the owner-lock pid

  If the job holds either, it is not terminated. The job error is logged instead, and teardown
  kills only the root's snapshot tree with every protected process and its subtree removed. This
  is what keeps Tower, other sessions and a restarted Tower's shellpers alive through a session
  end. It also protects `afx cleanup` and the husk sweep, which use the same function.

### Commit 3+: the listing and ending (the issue's request)

**Helper requests** (`job-objects.ts`, Reflection.Emit, nothing on disk):
- **`snapshot`:** `CreateToolhelp32Snapshot` returns `[{pid, ppid, name}]`. It is the cheap
  pid/parent table, shaped so the liveness sweep can use it later. **The liveness sweep is not
  changed.**
- **`job-members` `{name, pid: rootPid}`:**
  - checks the root is a member, as `terminate` does
  - reads `JobObjectBasicProcessIdList`
  - for each member and its parent: `GetProcessTimes` (creation time, CPU time) and the Toolhelp
    ppid and name
  - returns `parent: 'alive' | 'gone' | 'unknown'` (unknown = the pid exists but cannot be
    opened)

  Teardown uses the same request.
- **`end-process` `{name, pid: rootPid, target, createdAt}`:** calls `TerminateProcess` only if
  - the root is still a member of job `name`
  - the target is a member of the same job
  - the target's creation time equals `createdAt`
  - the target is not the root

  Otherwise it answers `refused` with a reason.

**Which processes count as orphaned** (pure function, `lib/platform/windows/session-orphans.ts`).

Tower first builds the **protected set** for session A:

| Protected | How identified |
|---|---|
| The running Tower | `process.pid` |
| Tower's Job Object helper | its pid, from `WindowsJobHelper` |
| The IDE server | its recorded pid, plus `ide-server` command-line marker |
| Every session root Tower knows, in every workspace | shellper pid + start time, from its sessions |
| Any member of job A that is a shellper (Tower knows it or not, e.g. a husk) | `shellper-main.js` in its command line |
| Any member of job A that is a Tower | `tower-server.js` in its command line |
| Every member of another session's job | the job named by that shellper's `sessionId` — this covers a session nested inside A |
| The descendants of all the above | live parent links |

Command lines are read from a census taken only when job A has at least one orphan candidate. They
are used to classify and are never printed or logged.

Then member **P** of job A is an **orphan** iff all hold:
- P is not A's root and not in the protected set,
- P's parent is gone, or the process now holding that pid was created after P (pid reuse),
- P's own creation time could be read.

`parent: 'unknown'` is never an orphan. Each orphan carries its unprotected in-job descendants,
which are ended with it.

**Why each process is never listed or ended:**

| Process | Why |
|---|---|
| A's shellper | It is the root; `end-process` also refuses the root inside the helper |
| A's console host, launch loop, agent | Each has a live parent all the way back to the root, so rule 2 fails |
| Tower (any way it started) | Protected by pid and command line |
| Tower's Job Object helper | Protected by pid. A one-shot helper spawned by `afx cleanup` or `codev doctor` has a live parent (`afx`) while it runs |
| The IDE server | Protected by pid and command line |
| Another session's shellper, agent and tools | Members of their own job, so subtracted. An unknown shellper (husk) is protected too; husks belong to `afx tower sweep-husks` |
| `afx dev` processes | `afx dev` creates its own Tower terminal, so its processes are in the dev session's job, not the caller's. A dev server that daemonizes and loses its parent is listed under the dev session, like any deliberate background process |
| Anything outside job A | Never enumerated; refused by the helper's membership check |

**A background process the user started on purpose** (e.g. `server &` whose shell exited) has no
living parent either, so it **is listed**. It is never ended automatically. Ending it takes the
explicit command, which first shows name, pid, age and CPU, then asks.

A session with no job (helper degraded, assign refused) is reported as "no job — orphans cannot
be listed". There is no guessing from parent links.

**Tower routes** (same shape as the husk sweep):
- `GET /api/orphans[?workspace=]` returns, per session, the agent label, terminal id, whether it
  has a job, and the orphans `{pid, name, createdAt, cpuMs, descendants[]}`. On macOS and Linux it
  returns `{supported: false}`.
- `POST /api/orphans/end {workspace, targets: [{terminalId, pid, createdAt}]}`:
  - before ending, re-lists the session and re-checks each target fresh, protected set included
  - per-target result: `ended`, `gone`, or `refused: <reason>`
  - never ends anything not named in the request
  - logs pid and name only

**`afx orphans`** (new; mirrors `afx tower sweep-husks`):

```
afx orphans                    list orphans in every session of this workspace (read-only)
afx orphans <agent>            list one session's orphans (builder id or architect name)
afx orphans <agent> --apply    list, confirm, then end them
afx orphans --all --apply      same, every session in the workspace
            -y / --yes         skip the confirmation (allowed with <agent> or --all)
```

- `--apply` requires `<agent>` or `--all`, so a bare `afx orphans --apply -y` is refused.
- Columns: SESSION, PID, NAME, AGE, CPU. Never command lines.
- macOS and Linux: prints "Windows only" and exits 0.
- Tower down: an error, like `sweep-husks`.

**`afx status` and `codev doctor`** (Windows only, behind `isWindows()`):
- **`afx status`:** an *Orphaned processes* section, shown only when there is something to show,
  with a hint to run `afx orphans <agent> --apply`. A 2s budget; failure prints one line and never
  fails the command. `--json` gains `orphans`.
- **`codev doctor`:** in the existing Process Census section, a warning per session with orphans.
  If Tower is not running, the check is skipped with that reason.

**Docs.** In `codev/DEPENDENCIES.md` and `codev-skeleton/DEPENDENCIES.md` (identical), Native
Windows section:
- session jobs no longer let programs leave, so everything an agent starts ends with its session,
  as on macOS and Linux
- a process that must outlive the session has to be started outside it
- what `afx status` and `codev doctor` show
- `afx orphans`
- nothing is ended automatically, and deliberately started background processes are listed too

Also the afx skill and the command reference, in both trees where they are mirrored.

## Files to Change

- `packages/codev/src/lib/platform/windows/job-objects.ts`: commit 1 (flag and comments); then the
  `snapshot`, `job-members` and `end-process` ops and their client methods.
- `packages/codev/src/lib/platform/windows/process-tree.ts`: comment (commit 1); teardown guard
  (commit 2).
- `packages/codev/src/agent-farm/servers/tower-server.ts`: boot refusal inside a session job.
- `packages/codev/src/lib/platform/windows/session-orphans.ts`: new; classification and protected
  set.
- `packages/codev/src/agent-farm/servers/session-orphans.ts`: new; route handlers and session
  enumeration.
- `packages/codev/src/agent-farm/servers/tower-routes.ts:217-250`: two routes.
- `packages/codev/src/agent-farm/lib/tower-client.ts` (and the sdk client where
  `findHuskCandidates` lives), plus types in `packages/types`.
- `packages/codev/src/agent-farm/commands/orphans.ts`: new; wiring in the afx CLI.
- `packages/codev/src/agent-farm/commands/status.ts` and
  `packages/codev/src/commands/doctor.ts:1803-1841`.
- `codev/resources/arch.md` and `codev/resources/lessons-learned.md`.
- `codev/DEPENDENCIES.md` and `codev-skeleton/DEPENDENCIES.md`; the afx skill and command
  reference.
- Tests below.

## Risks & Alternatives Considered

- **A program that insists on breaking away will fail to start in a Codev terminal.** With no
  breakaway, `CreateProcess` with `CREATE_BREAKAWAY_FROM_JOB` fails with access denied. Every
  program in the survey above started normally (MSYS evidently retries without breakaway).
  - **Not tested:** agy (not installed on this host), Codex as a full agent session (only
    `--version`), browsers launched by Playwright or `start <url>`, and GUI apps launched from a
    terminal.
  - I will add each failure I find during implementation and dev-approval to the PR and
    `DEPENDENCIES.md`.
- **Behaviour change: GUI apps and background processes started from a session now end with it.**
  Example: `code .` when VS Code is not already running, or a dev server started with `&` from an
  agent's shell. That matches macOS and Linux process groups, minus `setsid`/`nohup`, which Windows
  does not have. Documented, with the workaround: start such a program from outside Codev.
- **Tower or a shellper inside a session job** (measured above): handled by the boot refusal, the
  teardown guard and the protected set. All three are tested.
- **A Tower started with the session marker removed** (as the Windows test harness does,
  `tower-lifecycle.windows.test.ts:96`): the boot check cannot see it, but the teardown guard
  still protects it.
- **Older sessions keep breakaway** until they are recreated after the Tower restart. For those,
  listing works as well as it does today.
- **Ending the wrong process:** never automatic; preview and confirm; pid + creation time
  re-verified inside the helper; the protected set is recomputed at end time.
- **Alternative B (ancestry ledger):** rejected by the owner in favour of A. A ledger is lossy for
  short-lived parents, needs a new sweep, and does not fix teardown.

## Test Plan

**Unit (all platforms, Linux CI):**
- `classifyOrphans` and the protected set: root with a dead parent; conhost, launch loop and agent
  with live parents; parent gone; pid reuse; parent unknown; descendants. Never listed:
  - Tower's pid, the helper's pid, the IDE server
  - a known session root
  - an unknown shellper (husk) and its subtree
  - a Tower found by command line, and its subtree
  - a member of another session's (nested) job, and its tree
- Teardown guard (`process-tree.test.ts`, faked census and helper): a job holding a foreign
  shellper or a Tower is not terminated, and only the root's tree minus protected subtrees is
  killed. A clean job is terminated as before.
- Helper client parsing for `snapshot`, `job-members` and `end-process`, using the fake
  `HelperProcess`.
- Routes: workspace filter; no-job session; re-verification at end (target now protected, target
  no longer an orphan, creation time changed, target not named).
- `afx orphans`:
  - read-only by default
  - `--apply` without `<agent>`/`--all` refused
  - confirm declined
  - `-y`
  - macOS/Linux message; Tower down
- `afx status` section and `--json`; doctor lines (skipped, ✓, warn); POSIX shows nothing.

**Windows integration (`*.windows.test.ts`; on-demand workflow, `filter` input confirmed in
`.github/workflows/windows.yml:34`):**
- **Job flags (commit 1):** a session job has no breakaway. A `node` started from Git Bash in a
  real shellper session is a member, and terminating the session ends it.
- **Orphan listed and ended:** a real `SessionManager` session plants an orphan
  (`cmd /c start /b node leaf.cjs`). It is listed and ended; the shellper and the session's shell
  stay alive.
- **Process outside every job:** never listed; `end-process` naming it is refused, and it
  survives.
- **Tower inside a session job:**
  - spawned plainly from the session with the marker set: refuses to boot
  - spawned with the marker removed: its session's teardown leaves Tower and Tower's other
    session alive
  - listing session A never shows that Tower, its helper, or its sessions' processes
- **Nested session:** a shellper created inside session A's job is never listed under A, and
  ending A's orphans does not touch it.
- **Cost:** `snapshot` returns this process with its correct parent; a cost line is printed
  (`JOB-COST snapshot`).
- Dispatch on the branch, link the run in the PR:
  `gh workflow run windows.yml --ref builder/pir-1915 -f purpose='#1915 session job breakaway + orphan listing' -f suites=true -f filter=<the new and touched .windows. tests>`

**Dev-approval on this host, real sessions.** Setup:
- an isolated Tower from the worktree build, with its own `CODEV_AGENT_FARM_DIR` and port, and a
  throwaway workspace
- the main Tower is never restarted; its PID is recorded before and after

Steps:
1. Start an architect session and spawn a Claude Code builder in the throwaway workspace. Check
   that `claude.exe` and its tool-call processes are members of each session job.
2. Have the builder run tool calls. Then have it run a long command with a short Bash tool timeout
   (`find / -name nonexistent-1915`, 5s timeout). After the timeout, the `find` keeps running with
   its parent gone.
3. `afx status` shows it under that builder (name, age, CPU, no command line). `codev doctor`
   warns. `afx orphans <builder>` previews it; `--apply` ends it; the builder and architect keep
   working.
4. `afx cleanup` on the builder ends its whole tree with nothing left behind. The architect
   session and the isolated Tower survive. Restart the isolated Tower: the architect's shellper
   survives, and a new session works.
5. Full suite, run once (one at a time with bugfix-1910), Tower PID recorded before and after.
   #1923 flakes are re-run once.

**Untested on this host, stated plainly in the PR:** agy (not installed) and a full Codex agent
session. Codex as a builder will be tried at dev-approval; if it cannot be run, the PR says so.
