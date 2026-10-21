# Spec 1658 audit: native Windows

Phase 1 deliverable. Two parts:

1. **Measured facts.** These come from `scripts/windows-probe.mjs` on real Windows hosts: the
   `windows.yml` `probe` job (Node 20/22/24, `windows-latest`) and the owner's machine. Each
   fact says where it came from.
2. **Site inventory.** Every POSIX-dependent site class in the runtime, re-audited on current
   `main` (2026-10-21, merge base `91ef2e3c7`), each tagged with the phase that fixes it.

Facts marked **PENDING** are filled in from the first `probe` dispatch, which can only run once
the early `windows.yml` PR has put the workflow on `main`, and from the owner's
`--survival` runs. Phase 2 does not start until they are filled in (plan, Phase 1 test plan).

## 1. Measured facts

### 1.1 Native dependencies (defines the supported Windows Node versions)

Source: `probe --deps`, one leg per Node version. Each install runs with `npm_config_node_gyp`
pointed at a failing stub, so a source-build fallback shows up as `nodeGypInvoked` instead of
quietly succeeding on the runner's toolchain.

| Dependency | Node 20 x64 | Node 22 x64 | Node 24 x64 | win32-arm64 |
|---|---|---|---|---|
| node-pty (`^1.1.0`) | PENDING | PENDING | PENDING | PENDING (bundled `prebuilds/` listing) |
| better-sqlite3 (`^12.10.0`) | PENDING | PENDING | PENDING | PENDING (release asset list) |

Install-script behavior when no prebuild matches: PENDING. This decides Phase 10's
install guard.

### 1.2 Named pipes

Source: `probe` `pipe` section. Listen and connect on
`\\.\pipe\codev-probe-<user>-<uuid>` with a shellper-format HELLO→WELCOME round trip.
Result: PENDING. On macOS the same code round-trips over a Unix socket in ~1 ms, so the
framing is transport-agnostic, as the spec assumes.

### 1.3 CIM census latency (sizes the Phase 3 cache and the `probeTowerHealth` budget)

Source: `probe` `census` section, three runs of the inline `Win32_Process` query.

| | Cold | Warm | Processes | With CommandLine | With CreationDate |
|---|---|---|---|---|---|
| windows-latest | PENDING | PENDING | PENDING | PENDING | PENDING |
| Owner machine | PENDING | PENDING | PENDING | PENDING | PENDING |

Port-owner lookup (`Get-NetTCPConnection`): PENDING ms; owner PID matches: PENDING.

### 1.4 Job objects and detached survival

Source: `probe` `job` and `detached` sections; owner `--survival start`/`check` per launcher.

| Launcher | In job | Kill-on-close | Breakaway allowed | Detached child survives launcher close |
|---|---|---|---|---|
| GitHub Actions runner | PENDING | PENDING | PENDING | PENDING (parent exit only) |
| Windows Terminal | PENDING | PENDING | PENDING | PENDING |
| PowerShell console (conhost) | PENDING | PENDING | PENDING | PENDING |
| VS Code integrated terminal | PENDING | PENDING | PENDING | PENDING |
| VS Code extension host | PENDING | PENDING | PENDING | PENDING |
| SSH session | PENDING | PENDING | PENDING | PENDING |

PowerShell language mode on each host (Add-Type needs FullLanguage): PENDING.

### 1.5 Git Bash and executables

Source: `probe` `gitBash` and `pathext` sections.

- Git Bash locations found, and whether System32 `bash.exe` is first on `PATH`: PENDING.
- Tools inside Git Bash. The forge scripts need `sed grep head tail sort date curl git` plus
  `jq`. The generated `.builder-start.sh` mints session ids with `uuidgen`, else
  `/proc/sys/kernel/random/uuid` (`spawn-worktree.ts`). Git for Windows is not known to ship
  `uuidgen`, so whether its `/proc` provides the UUID file is load-bearing for builder launch:
  PENDING. If neither works, Phase 6 mints the id in Node.
- PATHEXT resolution of `claude`, `codex`, `agy`, `afx`, `codev`, `npx`, `npm`, `gh`, `git`, `jq`,
  `codev-ide-server`: PENDING.

### 1.6 Root cause of the 2026-09-09 `afx tower start` hang

Source: `probe --tower` (Node 22 leg, built checkout) and the owner's machine.

PENDING. The probe captures `afx tower start`'s output and the new tail of `tower.log`. Leading
hypotheses from code reading, to be confirmed or rejected by that capture:

- the daemon dies on a POSIX-only call during boot (for example the `/health` census shelling
  out to `ps`, or the shellper `.sock` listen, which Windows rejects for a non-pipe path), and
  the CLI keeps waiting for readiness;
- or the readiness check itself (`lsof` in `utils/port.ts`) cannot run, so readiness is never
  observed.

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
