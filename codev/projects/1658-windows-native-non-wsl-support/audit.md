# Spec 1658 audit: native Windows

Phase 1 deliverable. Two parts:

1. **Measured facts.** These come from `scripts/windows-probe.mjs` on real Windows hosts: the
   `windows.yml` `probe` job (Node 20/22/24, `windows-latest`) and the owner's machine. Each
   fact says where it came from.
2. **Site inventory.** Every POSIX-dependent site class in the runtime, re-audited on current
   `main` (2026-10-21, merge base `91ef2e3c7`), each tagged with the phase that fixes it.

CI facts come from dispatches 39555516317, 39555898877 and 39556358109 (after PR #1849 put the
workflow on `main`). Facts still marked **PENDING** need the owner's Windows machine: the
launcher survival matrix and their own `--deps`/`--tower` runs. Phase 2 does not start until
those are filled in (plan, Phase 1 test plan).

## 1. Measured facts

### 1.1 Native dependencies (defines the supported Windows Node versions)

Source: `probe --deps` and `--tower-published latest`, one leg per Node version (run
39556358109, windows-latest). Installs run with a user's npm environment (default `cmd.exe`
script shell). A source build is detected from node-gyp's own log lines.

| Dependency | Node 20 x64 (ABI 115) | Node 22 x64 (ABI 127) | Node 24 x64 (ABI 137) | win32-arm64 |
|---|---|---|---|---|
| node-pty 1.1.0 | prebuilt, loads | prebuilt, loads | prebuilt, loads | prebuild bundled (`prebuilds/win32-arm64`) |
| better-sqlite3 12.10.0 | **no prebuild → node-gyp source build → install fails** | prebuilt, loads | prebuilt, loads | release assets for node-v127/v137 win32-arm64 |
| `npm install -g @cluesmith/codev@latest` (3.3.5) | **fails** (better-sqlite3) | installs, no source build | installs, no source build | not measured (no ARM64 runner) |

better-sqlite3 12.10.0 ships Node prebuilds only for ABIs 127, 137, 141 and 147 (Node 22, 24,
25, 26). Its install script is `prebuild-install || node-gyp rebuild --release`, so when no
prebuild matches it **falls back to a source build**. On a machine with a toolchain that build
can succeed silently; without one, it fails with a node-gyp error.

**Verdicts.**
- **Supported Windows Node versions: 22 and 24** (the prebuild set, per the spec's definition).
  Node 20 is unsupported on native Windows. Docs (Phase 11) say so, and Phase 10's install guard
  turns the node-gyp failure into a message naming 22/24.
- **ARM64:** both dependencies publish win32-arm64 prebuilds for Node 22/24, so ARM64 meets the
  spec's bar for support. It has not been exercised on hardware; docs state "prebuilds exist,
  not CI-tested".
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

### 1.3 CIM census latency (sizes the Phase 3 cache and the `probeTowerHealth` budget)

Source: `probe` `census` section, three runs of the inline `Win32_Process` query.

| | Cold | Warm | Processes | With CommandLine | With CreationDate |
|---|---|---|---|---|---|
| windows-latest (Node 20/22/24) | 3.6-4.3 s | 470-490 ms | 146-151 | 129-133 | all |
| Owner machine | PENDING | PENDING | PENDING | PENDING | PENDING |

Port-owner lookup (`Get-NetTCPConnection`): 1.3-1.7 s; owner PID matches: yes.

**Consequence.** A warm CIM census costs about half a second, roughly 10× `ps -A`, and the
first one in a fresh PowerShell costs about 4 s. Today `/health` awaits the census twice. Phase
3's TTL cache plus single-flight is required, not optional. The `probeTowerHealth` budget must
cover a cold census on first boot. The census, and anything else that spawns PowerShell, must
never sit on the reconnect hot path (C1 holds). Processes without a CommandLine (~12%) are
system processes the runner account cannot read. Shellpers run as the user, so they are
unaffected.

### 1.4 Job objects and detached survival

Source: `probe` `job` and `detached` sections; owner `--survival start`/`check` per launcher.

| Launcher | In job | Kill-on-close | Breakaway allowed | Detached child survives launcher close |
|---|---|---|---|---|
| GitHub Actions runner | yes | **yes** | yes (incl. silent) | yes (parent exit only; job close not observable in-run) |
| Windows Terminal | PENDING | PENDING | PENDING | PENDING |
| PowerShell console (conhost) | PENDING | PENDING | PENDING | PENDING |
| VS Code integrated terminal | PENDING | PENDING | PENDING | PENDING |
| VS Code extension host | PENDING | PENDING | PENDING | PENDING |
| SSH session | PENDING | PENDING | PENDING | PENDING |

PowerShell language mode on each host (Add-Type needs FullLanguage): runner = FullLanguage;
owner launchers PENDING.

Runner job flags `0x3C00` = KILL_ON_JOB_CLOSE | SILENT_BREAKAWAY_OK | BREAKAWAY_OK |
DIE_ON_UNHANDLED_EXCEPTION. One caveat: the flags come from `QueryInformationJobObject(NULL)` in
the child PowerShell, so they describe that process's job. Under silent breakaway that need not
be Node's own job. The interactive launchers are measured empirically (survival across a real
close), which avoids this ambiguity.

### 1.5 Git Bash and executables

Source: `probe` `gitBash` and `pathext` sections.

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
  resolution is checked on the owner's machine.

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

Remaining candidates for the 2026-09-09 field hang, which the owner's `--tower` run on their
machine can separate:
- an older release (code since 2026-09-09 has changed the start path);
- pre-existing `~/.agent-farm` state from an earlier attempt, for example a stale owner lock or
  a Tower that the broken `tower stop` left running and that still holds port 4100;
- something specific to that machine (home path, port reservation, antivirus).

The second candidate is consistent with the `tower stop` defect above: a Tower that never
stopped can block the next start's readiness on the default port. If the owner's run also
starts cleanly, the review records the hang as not reproducible on the current release, with
Phase 4 removing the `tower stop` defect that could cause it.

### 1.7 Repo build on Windows (dev-only, not a user concern)

`packages/codev`'s `build`, `copy-dashboard` and `copy-skeleton` scripts use `rm -rf` and `cp -r`.
pnpm runs package scripts with `cmd.exe` on Windows, so building the repo there needs
`npm_config_script_shell` set to Git Bash. `windows.yml` sets it. Users installing from npm are
unaffected; this matters only for building from source.

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
- `afx dev`: `agent-farm/commands/dev.ts:102` (`/bin/sh -lc`).
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

### Runnable worktrees → Phase 7

- `symlinkSync`: `agent-farm/commands/spawn-worktree.ts:95,112,136,143`.
- Removal: `agent-farm/commands/cleanup.ts`.

### ConPTY → Phase 8

- `agent-farm/servers/render-gate.ts`, `gate-profiles.ts`, `mailbox-delivery.ts`; fixtures in
  `agent-farm/__tests__/fixtures/`.

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

### Re-audit of lanes landed since the spec

- #1668 IDE server: covered above (Phase 9).
- #1789: not on `main` at audit time; re-audit at the start of Phase 9.
- #1595 (hooks) and #1672 (lane card): not found on `main` at audit time; re-audit at the
  start of Phases 6, 9 and 10.

## 3. Plan adjustments from this audit

- Phase 5 `.gitattributes` targets `packages/codev/scripts/forge/**/*.sh` (where the scripts
  live), plus any shipped `.sh` under `codev-skeleton/`.
- Doctor's Tower Environment check (`ps eww`) cannot be ported, because CIM does not expose a
  process's environment. On Windows it reports "not available on Windows" (Phase 3).
- Builder session-id minting may need a Node fallback if Git Bash has neither `uuidgen` nor
  `/proc/sys/kernel/random/uuid` (Phase 6, decided by fact 1.5).
- Test files live in `packages/codev/src/__tests__/` (flat), not `lib/__tests__/`; the platform
  seam test is `src/__tests__/platform.test.ts`.
