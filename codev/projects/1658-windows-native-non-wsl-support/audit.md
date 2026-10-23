# Spec 1658 audit: native Windows

Phase 1 deliverable. Two parts:

1. **Measured facts.** These come from `scripts/windows-probe.mjs` on real Windows hosts: the
   `windows.yml` `probe` job (Node 20/22/24, `windows-latest`) and the owner's machine. Each
   fact says where it came from.
2. **Site inventory.** Every POSIX-dependent site class in the runtime, re-audited on current
   `main` (2026-10-21, merge base `91ef2e3c7`), each tagged with the phase that fixes it.

CI facts come from dispatches 39555516317, 39555898877 and 39556358109 (after PR #1849 put the
workflow on `main`). Owner facts come from their full probe (2026-10-21T06:59Z) and survival
runs in Windows Terminal and the VS Code terminal. The VS Code extension host row is deferred to
the PR-gate manual pass, since only the extension can launch from there.

## 1. Measured facts

### 1.1 Native dependencies (defines the supported Windows Node versions)

Source: `probe --deps` and `--tower-published latest`, one leg per Node version (run
39556358109, windows-latest). Installs run with a user's npm environment (default `cmd.exe`
script shell). A source build is detected from node-gyp's own log lines.

Owner machine (Windows 11 Home, Node 24.13): both dependencies prebuilt, no source build; the
published 3.3.5 installs globally in 24 s with no toolchain.

| Dependency | Node 20 x64 (ABI 115) | Node 22 x64 (ABI 127) | Node 24 x64 (ABI 137) | win32-arm64 |
|---|---|---|---|---|
| node-pty 1.1.0 | prebuilt, loads | prebuilt, loads | prebuilt, loads | prebuild bundled (`prebuilds/win32-arm64`) |
| better-sqlite3 12.10.0 | **no prebuild → node-gyp source build → install fails** | prebuilt, loads | prebuilt, loads | release assets for node-v127/v137 win32-arm64 |
| `npm install -g @cluesmith/codev@latest` (3.3.5) | **fails** (better-sqlite3) | installs, no source build | installs, no source build | **measured** on `windows-11-arm`, Node 22 and 24: both deps prebuilt, no source build; published package installs; Tower reaches ready |

better-sqlite3 12.10.0 ships Node prebuilds only for ABIs 127, 137, 141 and 147 (Node 22, 24,
25, 26). Its install script is `prebuild-install || node-gyp rebuild --release`, so when no
prebuild matches it **falls back to a source build**. On a machine with a toolchain that build
can succeed silently; without one, it fails with a node-gyp error.

**Verdicts.**
- **Supported Windows Node versions: 22 and 24** (the prebuild set, per the spec's definition).
  Node 20 is unsupported on native Windows. Docs (Phase 11) say so, and Phase 10's install guard
  turns the node-gyp failure into a message naming 22/24.
- **ARM64: supported** (Node 22/24). Measured on GitHub's `windows-11-arm` runner (run
  39560462785), not inferred: prebuilt installs, the published package installs, and Tower starts.
  Building the *repo* from source on ARM64 fails in the `artifact-canvas` bundler (tsdown/rolldown).
  That is a contributor concern, not a user one; `windows.yml` builds the checkout on x64 only.
- **Cross-platform note (outside this spec):** the same gap exists on macOS and Linux. Node 20
  has no better-sqlite3 12.10 prebuild anywhere, so `engines: >=20` silently implies a source
  build there. Reported to the architect as a possible separate item.

### 1.2 Named pipes

Source: `probe` `pipe` section. Listen and connect on
`\\.\pipe\codev-probe-<user>-<uuid>` with a shellper-format HELLO→WELCOME round trip.
Result (run 39555516317, windows-latest = Windows Server 2025, Node 20/22/24): **works on all
three**. Listen 2-7 ms; HELLO→WELCOME round trip 6-10 ms; pipe name
`\\.\pipe\codev-probe-runneradmin-<uuid>`. On macOS the same code round-trips over a Unix
socket in ~1 ms. The framing is transport-agnostic, as the spec assumes.

**Phase 2 measurements (windows.yml targeted, runs 39567735755 and 39568235990, windows-latest, Node 22).**
A real shellper on `\\.\pipe\codev-shellper-<user>-<uuid>` reconnects with replay from a fresh
`SessionManager`, and input still works. A reconnect expecting another session is identity-refused, and
a connection without the secret receives zero bytes. Scenario 14: a second, non-admin local user
cannot open the pipe at all (`EPERM`). Node's default pipe DACL already refuses it, so the
secret gate is a second layer rather than the only one. One finding fixed along the way: the shellper's
`closeSync(1)` does not close Tower's stdout pipe on Windows, so Tower now reads the shellper info as
soon as the JSON is complete instead of waiting for EOF.

### 1.3 CIM census latency (sizes the Phase 3 cache and the `probeTowerHealth` budget)

Source: `probe` `census` section, three runs of the inline `Win32_Process` query.

| | Cold | Warm | Processes | With CommandLine | With CreationDate |
|---|---|---|---|---|---|
| windows-latest (Node 20/22/24) | 3.6-4.3 s | 470-490 ms | 146-151 | 129-133 | all |
| Owner machine (Win 11 Home 26200, Node 24.13) | 753 ms | 443-445 ms | 313 | 68 | all |

Port-owner lookup (`Get-NetTCPConnection`): 1.3-1.7 s on the runner, 1.9 s on the owner
machine; owner PID matches: yes.

**Consequence.** A warm CIM census costs about half a second, roughly 10× `ps -A`, and the
first one in a fresh PowerShell costs about 4 s. Today `/health` awaits the census twice. Phase
3's TTL cache plus single-flight is required, not optional. The `probeTowerHealth` budget must
cover a cold census on first boot. The census, and anything else that spawns PowerShell, must
never sit on the reconnect hot path (C1 holds). Processes without a CommandLine (~12%) are
system processes the runner account cannot read. On the owner's non-admin account only 68 of
313 processes expose a CommandLine: a standard user sees only their own processes' command lines.
Shellpers and their trees run as that user, so the sweeps still see everything they need. A
process's command line being null therefore means "not ours", never "an empty command".

### 1.4 Job objects and detached survival

**Verdict:** detached children survive every launcher measured: Windows Terminal, the VS Code
terminal, and the CI runner (parent exit). None of them needs the CIM `Win32_Process.Create`
relaunch. Phase 4 keeps the job-escape path for launchers that do kill (decision 3), driven by
the empirical check, and the extension-host row is confirmed at the PR-gate pass.

Source: `probe` `job` and `detached` sections; owner `--survival start`/`check` per launcher.

| Launcher | In job | Kill-on-close | Breakaway allowed | Detached child survives launcher close |
|---|---|---|---|---|
| GitHub Actions runner | yes | **yes** | yes (incl. silent) | yes (parent exit only; job close not observable in-run) |
| Windows Terminal | not measured | not measured | not measured | **yes** (owner, 2026-10-21T06:57Z, PowerShell tab) |
| PowerShell console (conhost) | not measured | not measured | not measured | optional: on Windows 11 with Windows Terminal as the default console host this is the Windows Terminal row |
| VS Code integrated terminal | not measured | not measured | not measured | **yes** (owner, 2026-10-21T07:04Z, VS Code window closed) |
| VS Code extension host | not measured | not measured | not measured | deferred: the probe cannot launch from the extension host; covered by the PR-gate manual pass once the extension starts Tower on Windows (Phase 6) |
| SSH session | not measured | not measured | not measured | untested: owner does not start Tower over SSH; documented as untested |

PowerShell language mode on each host (Add-Type needs FullLanguage): runner = FullLanguage;
owner machine = FullLanguage.

The owner's full probe reports the same job flags `0x3C00` (kill-on-close plus silent
breakaway), yet the Windows Terminal survival test shows detached children surviving a close.
That is what SILENT_BREAKAWAY_OK means: children are created outside the job automatically, so
kill-on-close does not reach them. The flag reading alone therefore cannot predict survival.
The empirical survival column is authoritative.

Runner job flags `0x3C00` = KILL_ON_JOB_CLOSE | SILENT_BREAKAWAY_OK | BREAKAWAY_OK |
DIE_ON_UNHANDLED_EXCEPTION. One caveat: the flags come from `QueryInformationJobObject(NULL)` in
the child PowerShell, so they describe that process's job. Under silent breakaway that need not
be Node's own job. The interactive launchers are measured empirically (survival across a real
close), which avoids this ambiguity.

### 1.5 Git Bash and executables

Source: `probe` `gitBash` and `pathext` sections.

- **Owner machine (the realistic case):** Git for Windows with bash 4.4.23 (x86_64-pc-msys),
  resolved from the standard path `C:\Program Files\Git\bin\bash.exe`. **System32 `bash.exe` is
  FIRST on `PATH`** (listed several times), and `Git\bin` is not on `PATH` at all; only
  `Git\usr\bin` is, second. Bare `bash` on this machine launches WSL. This is direct evidence
  for ruling 5: resolution must start from the install paths (or a valid override) and never from
  `PATH` order. `jq` and `gh` are not installed: doctor must flag `jq`, and `gh` is the user's
  forge CLI, as on every platform.
- Git Bash on the runner: `C:\Program Files\Git\bin\bash.exe`, GNU bash 5.3.15
  (x86_64-pc-cygwin). `PATH` order: `Git\usr\bin\bash.EXE`, `Git\bin\bash.EXE`, then
  **`C:\Windows\system32\bash.EXE`**. So the WSL launcher is on a stock `PATH`, which is the trap
  ruling 5 exists for. Here it is third, not first. On a machine without Git in `PATH`, it would be
  the only `bash`.
- Tools inside Git Bash. The forge scripts need `sed grep head tail sort date curl git` plus
  `jq`. The generated `.builder-start.sh` mints session ids with `uuidgen`, else
  `/proc/sys/kernel/random/uuid` (`spawn-worktree.ts`). Git for Windows is not known to ship
  `uuidgen`, so whether its `/proc` provides the UUID file is load-bearing for builder launch.
  **Result: neither exists** (`uuidgen` absent, `/proc/sys/kernel/random/uuid` unreadable). Today's
  generated script would mint an empty session id under Git Bash. **Phase 6 mints the id in Node**
  and passes it into the script. All the forge tools (`sed grep head tail sort date curl git`)
  are present; `jq` came from Chocolatey on the runner, so on a user machine it is a separate
  install, as ruling 6 says.
- PATHEXT resolution on the runner: `npx`/`npm` resolve to `.CMD` shims (confirming the shim
  problem for every npm-installed bin, including `afx`, `codev`, `claude`, `codev-ide-server`);
  `gh`, `git`, `jq` resolve to `.EXE`. The harness CLIs are not installed on the runner, so their
  resolution is checked on the owner's machine: `claude` resolves to
  `C:\Users\<user>\.local\bin\claude.EXE`, a native `.exe` (the native installer), not a `.cmd`
  shim. The shim resolver must handle both. `codex`, `agy`, `afx`, `codev` are not installed
  there.

### 1.6 Root cause of the 2026-09-09 `afx tower start` hang

Source: `probe --tower` (Node 22 leg, built checkout) and the owner's machine.

**Not reproduced on the current release with fresh state.** On windows-latest, with an isolated
state dir and port, `afx tower start` reached ready in all three configurations measured:

- the built checkout on Node 22: daemon ready in 649 ms;
- published 3.3.5 from a global install on Node 22 (620 ms) and on Node 24 (711 ms).

On Node 20 the published package cannot be installed at all (1.1), so there is no `afx` to hang.

What the captures rule out: boot does not die on the `ps` census or the shellper socket dir.
The orphan sweep runs (its `ps` call fails and is swallowed, so "0 killed" is not a real sweep;
Phase 3). Readiness is observed over HTTP, so `lsof` is not on the start path.

What they found instead: **`afx tower stop` cannot stop Tower on Windows.** It looks up the
port owner with `lsof` (`utils/port.ts`) through `cmd.exe` ("The system cannot find the path
specified."), concludes "Tower is not running", and exits 0 with the daemon still alive (the
probe then kills it by PID). That is fixed in Phase 4.

**The owner's machine agrees** (Windows 11 Home, Node 24.13, published 3.3.5 from a fresh
global install): ready in 549 ms, and `tower stop` hits the same `lsof` defect, leaving the daemon
alive.

**Deliberate reproduction of the leading candidate (run 39560462785).** Start Tower, run the
broken `afx tower stop` (the daemon stays alive), then run `afx tower start` again on the same
port and state dir. Measured on x64 and ARM64, from the checkout and from published 3.3.5: the
second start **does not hang**. It finds the live Tower over HTTP, prints "Tower already running"
and exits 0 in about 2.3 s. So "a Tower left running by the broken stop" is **ruled out** as the
hang mechanism, at least with a healthy leftover daemon.

**The 2026-09-09 release itself (run 39562480678).** 3.3.3 was the latest published release on
2026-09-09 (published 09-05; 3.3.4 followed on 09-17). Installed globally and probed the same
way, on x64 and ARM64, Node 22 and 24: it reaches ready (3.1-3.5 s) and the restart sequence does
not hang either. On Node 20, 3.3.3 does not install, like 3.3.5.

**Conclusion for the review:** the 2026-09-09 hang does not reproduce on the release current that
day (3.3.3) or on the current release (3.3.5), on CI (x64 and ARM64) or on the owner's machine, and
the leading candidate mechanism is ruled out by direct test. The root cause cannot be identified from the current release. How the spec's
"root cause identified" criterion is discharged is put to the architect (Phase 1 rebuttal). Candidates
originally considered (the first, an older release, is now tested and ruled out):
- an older release (code since 2026-09-09 has changed the start path);
- pre-existing `~/.agent-farm` state from an earlier attempt, for example a stale owner lock or
  a Tower that the broken `tower stop` left running and that still holds port 4100;
- something specific to that machine (home path, port reservation, antivirus).

The second candidate is now ruled out (above), except for an *unhealthy* leftover daemon (alive but
not answering HTTP), which the probe cannot construct. Phase 4 removes the `tower stop` defect
regardless, and its Windows tests cover start → stop → start. The third candidate (that
machine's own state: home path, port reservation, antivirus, leftover state from earlier
attempts) cannot be tested without that machine.

### 1.7 Repo build on Windows (dev-only, not a user concern)

`packages/codev`'s `build`, `copy-dashboard` and `copy-skeleton` scripts use `rm -rf` and `cp -r`.
pnpm runs package scripts with `cmd.exe` on Windows, so building the repo there needs
`npm_config_script_shell` set to Git Bash. `windows.yml` sets it. Users installing from npm are
unaffected; this matters only for building from source.

### 1.8 Per-session Job Objects (Phase 3b cost gate)

**Porch slot:** porch's `phase_4` slot carries plan phases 3b and then 4 (architect ruling,
Option C). Phase 3b commits are tagged `[Phase: phase_3b]`: a891d303c..cfedc4f1e (its own
3-way review: `1658-phase_3b-iter1-rebuttals.md`). Phase 4 commits are tagged
`[Phase: phase_4]`: b980eceaf..HEAD at `porch done` (the first is b980eceaf). Porch's
consultation for the slot covers both ranges.

**Verdict:** the cost gate passes. Warm per-session assign is milliseconds, far under the ~1 s
target.

Source: `windows-job.windows.test.ts` (`JOB-*` lines), `windows.yml` targeted runs 39580989425,
39581288482 and 39581676362 (windows-latest, Node 22).

| Measure | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| Cold helper start plus Reflection.Emit bind | 4277 ms | 3585 ms | 4021 ms |
| Second cold start in the same job (warm disk cache) | 295 ms | 362 ms | 381 ms |
| Warm assign round trips (first, then four more) | 140, 2, 1, 1, 1 ms | 168, 3, 3, 3, 3 ms | 152, 3, 3, 3, 2 ms |
| Assign while the target sits in libuv's job inside the runner's job (nested) | assigned | assigned | assigned |

Measured facts that shaped the design:

- **A job's name lives only while a handle to it is open.** Member processes do not keep the
  name. With the helper closing its handle after the assign, a later `OpenJobObjectW` by name
  failed (run 1). The helper now duplicates a non-inheritable job handle into the session root
  (the shellper), so the name lives as long as the shellper. It survives a helper stop and is
  found by a fresh helper (run 3).
- **A `detached: true` child does not leave the job** (`JOB-DETACHED
  detached_grandchild_survived=false`). libuv does not pass `CREATE_BREAKAWAY_FROM_JOB`, so
  `JOB_OBJECT_LIMIT_BREAKAWAY_OK` is never exercised by Node. `SILENT_BREAKAWAY_OK` would let
  every child leave, which defeats the job. There is no setsid parity for Node-detached
  children; this is raised with the architect.
- **A CIM `Win32_Process.Create` launch from inside a session job escapes it** (`JOB-CIM
  cim_launched_survived=true`). The WMI provider host creates the process, so it never inherits
  the caller's job.
- `TerminateJobObject` ends a `cmd start /b` orphan whose parent is gone (the Phase 3 gap).
- A stopped helper does not kill job members (no `KILL_ON_JOB_CLOSE`).

## 2. Site inventory (current `main`)

Counts are from grep over `packages/{codev,core,sdk}/src` and `apps/vscode/src`, tests excluded.
They size the work; each phase re-greps its own class before claiming it done.

### Shellper transport → Phase 2

- `terminal/session-manager.ts`: socket dir `0o700` (`:275`); `.sock`→`.log` replace (`:295`,
  `:751`, `:1050`); `lstat`/`isSocket` (`:511`, `:560`); fallback scan by `shellper-*.sock`
  filename (`:712-732`); endpoint construction (`:1037`); unlink stale socket (`:676`, `:983`,
  `:1033`); `socketDir` scope marker with `'/'` (`:932`).
- Reconnect start-time guard, which fails closed when start time is null, so always on win32
  (`:497`, `:551-556`).
- `terminal/shellper-protocol.ts` (HELLO/WELCOME), `shellper-client.ts`, `shellper-main.ts`,
  `shellper-process.ts` (WELCOME `pid` is the PTY child, `:382-398`).
- `agent-farm/servers/tower-terminals.ts`: the #1686 keep-row-if-alive guard
  (`reconcileTerminalSessions`, `getTerminalsForWorkspace`).
- `agent-farm/commands/attach.ts`.

### Process lifecycle and introspection → Phases 3 and 4

- **Group kills (7 sites, 5 files) → Phase 3:** `terminal/pty-session.ts:801,803`,
  `terminal/session-manager.ts:874,1334`, `agent-farm/servers/architect-session-holder.ts:217`,
  `agent-farm/commands/cleanup.ts:99`, `commands/porch/checks.ts:96`. Group-exit probe
  `porch/checks.ts:41` (`waitForGroupExit`); group creation via `detached: true` at `:81`.
- **SIGKILL escalations:** 35 occurrences. Each is reviewed when its site moves to
  `killSessionTree`; graceful paths become protocol messages (shellper shutdown, Tower HTTP
  shutdown).
- **`ps`/`pgrep`/`lsof` shellouts → Phase 3 unless noted:**
  - `agent-farm/servers/process-census.ts:62` (`ps -A`, the `/health` census);
  - `terminal/session-manager.ts:925` (`ps -eo pid,args`, orphan scan) and `:1481`
    (`ps -o lstart`, start time; linux reads `/proc`);
  - `agent-farm/commands/cleanup.ts:78`;
  - `agent-farm/servers/architect-session-holder.ts:114`;
  - `agent-farm/servers/tower-utils.ts:234` (`ps -A -o args`, #1224 session-holder check);
  - `agent-farm/commands/tower.ts:407,422` (`pgrep -P`, `pgrep -f shellper-main`) → **Phase 4**;
  - `agent-farm/utils/port.ts:26` (`lsof -ti`) → **Phase 4**;
  - `commands/doctor.ts:238,263-264` (`pgrep -f`, `ps eww` for the Tower Environment check).
    Phase 3 provides the census. The `ps eww` *environment* read has no CIM equivalent (CIM
    does not expose another process's environment), so on Windows doctor reports that check
    as not available rather than guessing.
- **Start-time consumers:** `shellper-husk-sweep.ts:54,68,102,117,160` (per-PID seam → census
  `creationTime`, Phase 3), `tower-routes.ts:507`, `tower-instances.ts`, `analytics.ts`.
- **Census cmdline matchers (JSON-escaped backslashes) → Phase 3:**
  `session-manager.ts` `findShellperProcesses`, `shellper-husk-sweep.ts`,
  `architect-session-holder.ts` `extractJsonStringField`.
- **Detached spawns needing `windowsHide` → Phase 4** (plus the IDE server, Phase 9).
- **Dead code → Phase 3:** `agent-farm/utils/shell.ts:194` `killProcess` and `:221`
  `killProcessTree` (no callers), and the `tree-kill` dependency.

### Launchers → Phases 5 and 6

- Forge: `lib/forge.ts` (`exec`/`execSync`, default shell). 64 concept scripts in
  `packages/codev/scripts/forge/` (shipped in the package, not in `codev-skeleton/`), so
  Phase 5's `.gitattributes` `eol=lf` rule targets `packages/codev/scripts/forge/**/*.sh`.
- Builder launch: `/bin/bash` at `agent-farm/commands/spawn.ts:728`, `spawn-worktree.ts:1173,1194`;
  generated scripts `spawn-worktree.ts:1162,1253`.
- `shell: true`: `agent-farm/utils/shell.ts:56` (`postSpawn`), `commands/porch/checks.ts:83`.
- `afx dev`: `agent-farm/commands/dev.ts:102` (`/bin/sh -lc`); and the VS Code extension's dev
  runner, `apps/vscode/src/commands/dev-shared.ts:130` (`command: '/bin/sh'`), which builds its own
  dev terminal rather than calling `afx dev`.
- `afx bench`: `agent-farm/commands/bench.ts:51,71` (`shell: '/bin/sh'`).
- Bare `consult` spawn: `commands/bootstrap-docs.ts:300`.
- Shell fallbacks: `terminal/pty-manager.ts:66` (`$SHELL ?? /bin/bash`),
  `agent-farm/servers/tower-routes.ts:3268`.
- Bare commands → `resolveSpawnable`, **Phase 6:** `commands/porch/index.ts:696` (`afx open`),
  `agent-farm/commands/tower.ts:276` (`npx`, dev mode), `apps/vscode/src/tower-starter.ts:48,99`,
  `apps/vscode/src/commands/spawn.ts:46`.
- `tail -f`: `agent-farm/commands/tower.ts:508` → Node follower, Phase 6.
- `which`/`command -v` probes → the shared executable resolver (Phase 5 builds it, Phase 6
  routes): `commands/doctor.ts:303`, `commands/consult/index.ts:432,1001`,
  `agent-farm/utils/shell.ts:139`. `bootstrap-docs.ts:284` holds the PATHEXT lookup Phase 5
  promotes.
- Config default `shell: 'bash'`: `agent-farm/utils/config.ts:30`.

#### Phase 6 completion grep (launcher routing)

Grep over `packages/{codev,core,sdk}/src` and `apps/vscode/src`, tests excluded, for
`'/bin/sh'`, `'/bin/bash'`, `shell: true`, `shell: '/bin/sh'`, `spawn('tail'`, bare
`spawn('afx'|'npx'|'consult'|'codev'|'bash'`, `which ` and `command -v`. Every remaining hit
is on a POSIX-only branch or is not a launch:

- POSIX branches behind `isWindows()`: `pty-manager.ts` (`$SHELL ?? /bin/bash`),
  `tower-routes.ts` (dashboard shell `$SHELL`), `spawn-worktree.ts` (`builderScriptLaunch`,
  `startShellSession`), `dev.ts` (`devCommandLaunch`), `utils/shell.ts` (`runStreaming`
  `shell: true`, `commandExists` `which`), `porch/checks.ts` (`shell: true`), `tower.ts`
  (`tail -f`), `bench.ts` (`sysctl`/`lscpu`/`free`, `which consult`), `doctor.ts` and
  `consult/index.ts` (`which`, `command -v agy`), `import.ts` (`which claude`).
- Not a launch: `shell-launch.ts` name tables that MAP POSIX shell names to Git Bash; the
  generated launch script's `command -v uuidgen` (runs inside Git Bash, with a Node fallback
  on Windows).
- `apps/vscode/src/commands/dev-shared.ts` still sends `/bin/sh -lc <devCommand>` to Tower;
  a Windows Tower maps any client POSIX shell request onto the resolved Git Bash
  (`windowsShellRequest` in `handleTerminalCreate`), so the extension needs no Git Bash
  resolver of its own.
- `utils/shell.ts` `run()` keeps `exec` (cmd.exe on Windows). Its callers are plain `git`,
  `gh` and `porch` invocations with double-quoted arguments, which cmd.exe runs as-is
  (`porch` is an npm `.cmd` shim, which cmd.exe executes). No pipes, `$VAR` or POSIX
  redirects pass through it.

Routed in Phase 6: forge concepts (sync and async), the builder launch script and
`afx spawn --shell`, `postSpawn`, `devCommand`, porch shell-string checks (all Git Bash);
PTY commands at both spawn points (`ptyCommand`), the dev-mode `npx` daemon, consult's
reviewer CLIs, bootstrap-docs' `consult`, porch's `afx open`, `afx bench`'s `consult`,
`codev import`'s `claude`, the agent-session launcher (`spawnAgentProcess`), and the VS Code
extension's `afx`/`codev` spawns (shim resolver); `afx tower log --follow` (Node follower).

### Runnable worktrees → Phase 7

- `symlinkSync`: `agent-farm/commands/spawn-worktree.ts:95,112,136,143`.
- Removal: `agent-farm/commands/cleanup.ts`.

### ConPTY → Phase 8

- `agent-farm/servers/render-gate.ts`, `gate-profiles.ts`, `mailbox-delivery.ts`; fixtures in
  `agent-farm/__tests__/fixtures/`.

#### Capture recipe (owner, Windows machine)

CI has no authenticated agent, so the ConPTY fixtures are recorded by hand. Needs: the branch
checked out and built (`pnpm install`, `pnpm build` in `packages/codev`), and `claude` / `codex`
installed and signed in (`claude -p "say OK"`, `codex exec "say OK"` succeed). From
`packages/codev`, in PowerShell:

```powershell
node --experimental-strip-types scripts/spec-1658-conpty-capture.mts --app claude --state all -- --model haiku
node --experimental-strip-types scripts/spec-1658-conpty-capture.mts --app codex --state all
# agy too, if it is installed and signed in:
node --experimental-strip-types scripts/spec-1658-conpty-capture.mts --app agy --state all
```

Each run starts a fresh session per state in a scratch directory under `%TEMP%`, accepts the
first-run folder-trust dialog, and writes `conpty-captures\conpty-<app>-<state>.capture.jsonl.gz`.
The states: `idle` (expect delivered), `draft` (a typed, unsent line: expect held), `midturn` (a
turn streaming, composer empty: expect delivered, Issue #1664), `resize` (two resizes, then
expect delivered). `midturn` spends one short model turn. If an account email or organisation
name shows on the agent's screen, pass it with `--redact <value>` (repeatable); the user name,
profile directory, scratch directory and host name are scrubbed automatically, with same-length
placeholders, and a capture that still contains one is refused rather than written.

The files go to `packages/codev/src/agent-farm/__tests__/fixtures/gate/conpty/`; the replay test
is `spec-1658-conpty-gate-replay.test.ts`. The same recorder runs on macOS and Linux, which is how
it was proven (claude 2.1.306: idle delivered at once, draft held `user-text`, mid-turn delivered
after one 250 ms composer sample, resize delivered); those captures are not committed, because
the replay suite accepts only `platform: win32`.

Live check for scenario 12, on the same machine, against the production path without Tower:
`node --experimental-strip-types scripts/bugfix-1664-streaming-delivery-harness.mts --scenario streaming`
and `--scenario draft` (claude by default; `--harness codex` for codex).

### IDE server → Phase 9

- On `main` (#1668): `agent-farm/servers/ide-server.ts` (spawn `:138`, detached, no
  `windowsHide`; per-PID SIGTERM/SIGKILL stop `:180-196`), `ide-forward.ts`.
- From #1789 (PR #1806, open at audit time): `agent-farm/commands/ide.ts`,
  `agent-farm/lib/ide-version.ts`, `agent-farm/lib/ide-extensions.ts`,
  `scripts/verify-install.mjs` changes. Re-audit when it merges.

### POSIX residue → Phase 10

- `/tmp` in runtime: `terminal/pty-manager.ts:69`, `agent-farm/utils/worktree-write-guard.ts:164`,
  `agent-farm/servers/tower-utils.ts:107`, `agent-farm/servers/tower-terminals.ts:216,693`.
- `HOME` without `USERPROFILE`: `pty-manager.ts`, `worktree-write-guard.ts`, `tower-terminals.ts`.
- `~` expansion by string: `agent-farm/servers/tower-instances.ts:363`,
  `agent-farm/servers/tower-routes.ts:2602,2667`.
- `chmod`/mode sites: 30 (left as-is per decision 8).
- `split('\n')`: 57 sites; `startsWith('/')`: 9; `split('/')`: 13. Each is classified in Phase 10
  as host-path / command-output / not-a-path, and only the first two change.
- Tests: `/tmp` across ~70 test files.

#### Phase 10 result (2026-10-23)

- **`/tmp` grep check** (`node scripts/spec-1658-tmp-residue-check.mjs`, not shipped): passes.
  - Runtime: 6 non-comment `/tmp` sites, each on a POSIX-only branch or list carrying a POSIX annotation: `pty-manager.ts:73` (POSIX base env), `worktree-write-guard.ts:183-184` (POSIX allowlist; Windows allows `os.tmpdir()`), `tower-utils.ts:115` (POSIX temp roots), `tower-terminals.ts:243` (POSIX fallback root; Windows uses `homedir()`) and `:639` (`POSIX_TEMP_ROOTS`).
  - Tests: 78 files annotated: 70 `opaque` (never reaches the disk), 7 `posix-only` (the `/tmp` tests are skipped on win32, reason at the skip), 1 `sun_path` (`helpers/socket-temp-root.ts`: `/tmp` on POSIX for the 104-byte socket limit, `os.tmpdir()` on Windows).
  - Every other disk-reaching `/tmp` moved to `os.tmpdir()` or the sun_path helper.
- **`startsWith('/')`** (8 runtime sites): all already host-aware or not host paths. `templates.ts:120` checks `path.sep` too, `msys-path.ts` is an MSYS path by definition, the 5 `workspacePath` guards in tower-websocket/tower-routes also accept `^[A-Za-z]:[\\/]`, and `contextual-panel/messages.ts` rejects `\\` and drive paths. No change.
- **`split('/')`** (10 runtime sites):
  - not-a-path: URL pathnames (`tower-websocket.ts:317`, `tower-routes.ts:2931`), `owner/repo` shorthand (`sync.ts:62`).
  - command-output: `git --show-prefix` (`tree-snapshot.ts:212`).
  - already normalized: `governance-bootstrap.ts:246` (splits on `path.sep` first), `review-queue/reconcile.ts:93`.
  - repo-relative forward-slash resource paths from Tower: `contextual-panel/webview/main.ts:50`, `views/file-path-tree.ts:53`.
  - host-path: `host-paths.ts` (the Phase 10 helper itself). No other change.
- **`split('\n')`** (57 runtime sites):
  - command-output (git, ps, CIM JSON, lsof, gh): Git for Windows and these tools emit LF, and the Windows parsers added in Phases 3 and 4 already split on `/\r?\n/`. No change.
  - in-memory or PTY text (message bodies, PTY partial lines, prompts): not file content. No change.
  - file content: CRLF is real on Windows (Git for Windows checks out with `core.autocrlf=true`; Windows editors write CRLF).
    - Fixed in Phase 10: `porch/artifacts.ts` `isPreApprovedContent` (frontmatter regex now `\r?\n`; a CRLF spec or plan was never recognized as pre-approved) and `prompt-behavior-metrics.ts`.
    - Already CRLF-safe (verified by the Windows run): decisions parse/splice (detects and preserves the file's line ending), `governance-bootstrap.ts` `toLines`, `team.ts` frontmatter, consult `.env`, `reset/context.ts` (reads afx-written launch scripts), and `forge.ts` executable sniffing (`.sh` pinned to LF by `.gitattributes`).
    - Carry-forward, not changed: `overview.ts:97` (builder `status.yaml` line regexes; the ones checked end in `\s*$` and tolerate `\r`, but the parser has not been audited end to end), `managed-block.ts:109` (inserts an LF block into a CRLF CLAUDE.md: mixed endings, cosmetic), `framework-ref-audit.ts:72` (findings display with `\\`).
- **Builder-worktree matchers** (`.builders/` with `/` only): fixed in `builder-worktree-identity.ts`, `send.ts`, `state.ts`, `notifications.ts`, `tower-routes.ts` (7 sites) and `consult/index.ts`. Carry-forward: `db/consolidate.ts:60` (legacy migration marker, not reached on a fresh Windows install).
- **Walk-up loops**: `agent-farm/utils/config.ts` `findWorkspaceRoot` stopped only at `'/'` and never terminated at a Windows drive root. Fixed, with a regression test that runs the walk in a child with a deadline. No other `!== '/'` loop sentinel exists in runtime code.

### Re-audit of lanes landed since the spec

- #1668 IDE server: covered above (Phase 9).
- #1789: not on `main` at audit time; re-audit at the start of Phase 9.
- #1595 (hooks) and #1672 (lane card): not found on `main` at audit time; re-audit at the
  start of Phases 6, 9 and 10.

Phase 1 review (codex) found the four launch sites above, which the first inventory missed. All
are Phase 6 (launcher routing). Phase 6's completion grep covers `/bin/sh`, `/bin/bash`,
`shell: true`, `shell: '/bin/sh'` and bare spawns of npm-installed bins across `packages/` AND
`apps/`.

## 3. Plan adjustments from this audit

- Phase 5 `.gitattributes` targets `packages/codev/scripts/forge/**/*.sh` (where the scripts
  live), plus any shipped `.sh` under `codev-skeleton/`.
- Doctor's Tower Environment check (`ps eww`) cannot be ported, because CIM does not expose a
  process's environment. On Windows it reports "not available on Windows" (Phase 3).
- Builder session-id minting may need a Node fallback if Git Bash has neither `uuidgen` nor
  `/proc/sys/kernel/random/uuid` (Phase 6, decided by fact 1.5).
- Test files live in `packages/codev/src/__tests__/` (flat), not `lib/__tests__/`; the platform
  seam test is `src/__tests__/platform.test.ts`.
