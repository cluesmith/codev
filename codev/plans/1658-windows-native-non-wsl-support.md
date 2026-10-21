# Plan: Native (non-WSL) Windows Support

**Specification**: [codev/specs/1658-windows-native-non-wsl-support.md](../specs/1658-windows-native-non-wsl-support.md)

## Executive Summary

The spec selects, per area:

- **A1**: a platform endpoint abstraction. Shellpers use named pipes on Windows, gated by a
  Windows-only per-session HELLO secret. POSIX keeps its Unix socket and today's handshake.
- **B1 + census snapshot**: a single "kill session tree" primitive (POSIX group signals, Windows
  `taskkill /T /F` plus explicit per-PID kills from a pre-kill census snapshot). Tower is
  relaunched outside a kill-on-close job through built-in PowerShell CIM when needed.
- **C1**: on Windows, reconnect identity is the authenticated WELCOME, not process start time.
  Sweeps use one Windows census provider (inline PowerShell CIM: pid, ppid, cmdline, creation
  time). Tower stop/start learn Tower's PID from the owner lock and `/api/status`, not `lsof`.
- **D**: one Git Bash resolver, one PATHEXT shim resolver (promoted from `codev bootstrap-docs`),
  one MSYS path translator. Every plumbing launch site routes through them.
- **E1**: junction for directories, hard link or copy for files, real symlinks when allowed.
- **F**: PowerShell 5.1 for human shell terminals; agent terminals run their harness directly.

Owner ruling 1 fixes the phase order: audit → transport + lifecycle → forge/launcher routing →
POSIX residue sweep → CI leg. This plan keeps that order and splits the large buckets into
phases that each commit and verify on their own:

| Ruling-1 bucket | Plan phases |
|---|---|
| Audit | 1 |
| Transport + lifecycle | 2, 3 |
| Forge/launcher routing | 4, 5, 6 |
| (ConPTY gate and IDE server, both of which need working launchers) | 7, 8 |
| POSIX residue sweep | 9 |
| CI leg | 10 |

Every Windows change enters through the platform seam built in Phase 1, so every Windows branch
is unit-testable on macOS/Linux by forcing the seam to `win32`. Real-Windows behavior is
verified by the on-demand Windows workflow (also started in Phase 1) and by the owner's Windows
machine where CI cannot reach (interactive launchers, authenticated harness captures, the VS
Code extension, the joint IDE check).

### How Windows verification works across phases

The builder works on macOS. Windows facts come from three places:

1. **Seam-forced unit tests** on macOS/Linux, run in every phase.
2. **`windows.yml` dispatches** (`workflow_dispatch` only, never automatic, never required).
   Phase 1 creates it with a `probe` job and a `targeted` job that runs a vitest filter given as
   a dispatch input. Each later phase adds its Windows-only tests (`describe.runIf(win32)`) and
   dispatches the `targeted` job against the branch. Phase 10 adds the full suites.
3. **The owner's Windows machine** for what CI cannot do. These are listed per phase and
   collected into one manual test pass at the PR gate.

**Prerequisite for item 2 (needs an architect decision at plan approval).** GitHub only
dispatches a workflow whose file exists on the default branch. A branch's version of the file
then runs via `--ref`. So the dispatch-only `windows.yml` skeleton needs to land on `main` early,
as a tiny separate PR. It is inert on `main` (dispatch only). The alternative is that every
Windows check before the final PR runs on the owner's machine, which makes the per-phase
verification much slower. **This plan assumes the early landing**; if it is declined, Windows
checks for Phases 2 to 9 move to the owner's machine and the PR-gate pass.

### Standing constraints applied to every phase

- POSIX behavior does not change. POSIX implementations stay today's code. Each phase runs the
  macOS/Linux unit suite plus `check-types` (`pnpm build` first) before its commit.
- Framework content is mirrored in `codev/` and `codev-skeleton/`. Shipped skill edits touch all
  four copies (`.claude`/`.codex` × root/skeleton).
- The mailbox invariant (Spec 1313) and server/client isolation (#1189) hold. No Windows code
  enters `codev-sdk` outside its `/node` adapter.
- Commits: `[Spec 1658][Phase: <id>] ...`, files staged explicitly. One PR at the end.

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "phase_1", "title": "Windows audit, probe harness, and platform seam"},
    {"id": "phase_2", "title": "Shellper named-pipe transport with per-session secret"},
    {"id": "phase_3", "title": "Process lifecycle and introspection on Windows"},
    {"id": "phase_4", "title": "Git Bash, executable shim, and MSYS path resolution with doctor prerequisites"},
    {"id": "phase_5", "title": "Launcher routing and shell roles"},
    {"id": "phase_6", "title": "Runnable-worktree links and worktree removal on Windows"},
    {"id": "phase_7", "title": "ConPTY render-gate validation captures"},
    {"id": "phase_8", "title": "Codev IDE server on native Windows"},
    {"id": "phase_9", "title": "POSIX residue sweep"},
    {"id": "phase_10", "title": "Windows CI leg and install docs"}
  ]
}
```

## Phase Breakdown

### Phase 1: Windows audit, probe harness, and platform seam

**Dependencies**: None

#### Objective

Turn the spec's assumptions into measured facts before any surgery, and give every later phase
a testable platform seam and a way to run code on Windows.

#### Files to Create / Modify

- `codev/projects/1658-windows-native-non-wsl-support/audit.md` (new): the measured facts and
  the site inventory, each site tagged with the phase that fixes it.
- `scripts/windows-probe.mjs` (new, repo root, not shipped in the package).
- `.github/workflows/windows.yml` (new): `workflow_dispatch` only; jobs `probe` and `targeted`
  (input: vitest filter). Node 20/22 × x64.
- `packages/codev/src/lib/platform.ts` (new): `hostPlatform()`, `isWindows()`, and a test-only
  override, so Windows branches can be exercised on any host.
- `packages/codev/src/lib/__tests__/platform.test.ts` (new).

#### Deliverables

- [ ] **Site inventory**, re-audited against current `main`, covering every site class in the
  spec's Current State. It includes the code that landed after the spec audit: the IDE server
  spawn/stop (`agent-farm/servers/ide-server.ts`, `ide-forward.ts`, from #1668) and, if merged by
  then, #1789 (`commands/ide.ts`, `lib/ide-version.ts`, `lib/ide-extensions.ts`), #1595 hooks, and
  #1672 lane card. Re-run at the start of Phases 5, 8 and 9 for anything merged since.
- [ ] **Probe script** measuring, on the host it runs on:
  - node-pty and better-sqlite3 prebuild availability for Node 20/22/24, win32-x64 and
    win32-arm64 (install from the registry with no toolchain, record pass/fail);
  - a named-pipe listen/connect round trip carrying a HELLO/WELCOME frame;
  - detached-child survival: spawn a detached child, end the launching process, check the child
    survives (an empirical kill-on-close job test that needs no native API);
  - PATHEXT resolution of `claude`, `codex`, `afx`, `codev-ide-server`;
  - Git Bash candidate locations and the System32 `bash.exe` trap;
  - the `afx tower start` hang: start the daemon with its stderr/log captured, record the first
    failure.
- [ ] **Launcher survival matrix**: CI runner (from the `probe` job); Windows Terminal,
  PowerShell console, VS Code integrated terminal and extension host, SSH (owner runs
  `windows-probe.mjs --survival` on their machine).
- [ ] **Root cause of the 2026-09-09 hang**, recorded in `audit.md` (carried to the review).
- [ ] Platform seam plus tests.

#### Acceptance Criteria

- [ ] `audit.md` lists every site class with its owning phase, the prebuild matrix (which
  defines the supported Windows Node versions and the ARM64 verdict), the launcher survival
  matrix, and the hang root cause.
- [ ] `windows.yml` `probe` job runs green from a dispatch (once the file is on `main`).
- [ ] Platform seam tests pass; POSIX unit suite and `check-types` green.

#### Test Plan

- Unit: platform seam defaults to `process.platform`; override and reset behave.
- Windows: dispatch `probe`; owner runs the survival mode on their launchers.
- If the audit contradicts a spec assumption (for example no prebuild for a supported Node
  version, or every launcher kills detached children), stop and report to the architect before
  Phase 2. Those facts change scope.

---

### Phase 2: Shellper named-pipe transport with per-session secret

**Dependencies**: Phase 1

#### Objective

Shellpers listen and reconnect on Windows over named pipes, and other local users can neither
read from nor control them. POSIX connections stay byte-identical.

#### Files to Create / Modify

- `packages/codev/src/terminal/shellper-endpoint.ts` (new): resolve endpoint (POSIX
  `<socketDir>/shellper-<id>.sock`; Windows `\\.\pipe\codev-shellper-<user>-<uuid>`), readiness
  probe, stale-endpoint cleanup (no-op on Windows), log path decoupled from the endpoint.
- `packages/codev/src/terminal/session-manager.ts`: socket-file wait → endpoint readiness probe;
  `isSocket`/`lstat` checks → endpoint probe; session id from the DB row, not the
  `shellper-<id>.sock` basename; attach fallback scan uses the DB registry on Windows;
  `.sock`→`.log` string replace → `shellper-endpoint` log path; `socketDir` scope marker uses
  `path.sep`.
- `packages/codev/src/terminal/shellper-protocol.ts`: optional HELLO `secret` field (sent only on
  Windows).
- `packages/codev/src/terminal/shellper-main.ts`, `shellper-process.ts`: read the secret from the
  environment, delete it from the env the PTY child inherits, write nothing to a connection
  until a valid HELLO, drop on mismatch.
- `packages/codev/src/terminal/shellper-client.ts`: send the secret; verify WELCOME (session id,
  pid).
- `packages/codev/src/agent-farm/db/migrations.ts`: nullable secret column on the session row in
  `global.db` (always null on POSIX).
- `packages/codev/src/agent-farm/servers/tower-terminals.ts`, `agent-farm/commands/attach.ts`:
  pass endpoint and secret through reconcile/attach.

#### Deliverables

- [ ] Endpoint abstraction; POSIX endpoint, log path and handshake unchanged.
- [ ] Windows secret: generated by Tower per session (crypto random), passed via environment,
  never argv; persisted for reconnect; stripped before the PTY child starts.
- [ ] Unauthenticated connection: zero bytes written, frames ignored, connection dropped.
- [ ] Tests.

#### Acceptance Criteria

- [ ] Golden test: POSIX endpoint path, log path and HELLO/WELCOME bytes are identical to today.
- [ ] With the seam forced to `win32` (over a POSIX socket in unit tests): a client without or
  with a wrong secret receives zero bytes, its frames have no effect, and it is dropped; the
  correct secret attaches.
- [ ] The secret never appears in argv or in the PTY child's environment.
- [ ] Windows (`targeted` dispatch): a real `\\.\pipe\` shellper is spawned, attached, detached
  and re-attached with replay.
- [ ] Windows (`targeted` dispatch, scenario 14): a second non-admin local user created on the
  runner opens the pipe and receives zero bytes; its frames have no effect.
- [ ] POSIX suite and `check-types` green.

#### Test Plan

- Unit: endpoint resolution per platform; log path; secret gating; WELCOME verification
  (wrong session id or pid → refuse); migration up on an existing DB.
- Windows CI: pipe round trip and reconnect; second-user access test.

---

### Phase 3: Process lifecycle and introspection on Windows

**Dependencies**: Phase 2

#### Objective

The load-bearing guarantee holds on Windows: builders survive a Tower stop/start, reconnect
refuses reused PIDs, teardown leaves no descendants, orphans and husks are reaped, and Tower
start/stop work without `lsof`/`pgrep`.

#### Files to Create / Modify

- `packages/codev/src/lib/process-tree.ts` (new): `killSessionTree(rootPid, opts)`. POSIX: today's
  group SIGTERM→SIGKILL. Windows: census snapshot of descendants (pid, ppid, creation time) →
  `taskkill /T /F` → explicit kill of each recorded descendant whose creation time still matches
  → tolerant of an already-dead root.
- `packages/codev/src/agent-farm/servers/process-census.ts`: provider interface; the POSIX
  provider is today's `ps` code; a Windows provider running an inline
  `powershell.exe -NoProfile -NonInteractive -Command` CIM `Win32_Process` query (JSON out:
  pid, ppid, cmdline, creation time, working set). Stays async. A failure is reported, never an
  empty census.
- Group-kill sites → `killSessionTree`: `terminal/pty-session.ts`, `terminal/session-manager.ts`
  (orphan sweep, reaping), `agent-farm/servers/architect-session-holder.ts`,
  `agent-farm/commands/cleanup.ts`, `commands/porch/checks.ts`.
- Start-time guard: `terminal/session-manager.ts`, `shellper-main.ts`, `shellper-process.ts`,
  `agent-farm/servers/tower-terminals.ts`, `tower-instances.ts`, `tower-routes.ts`,
  `analytics.ts`. On Windows, reconnect identity is the authenticated WELCOME from Phase 2;
  sweeps get creation time from the census.
- `agent-farm/servers/shellper-husk-sweep.ts`: Windows census, same age race guard.
- `agent-farm/commands/tower.ts`, `agent-farm/utils/port.ts`, `agent-farm/db/tower-owner.ts`,
  `agent-farm/servers/tower-routes.ts`: stop via a local-only HTTP shutdown request, then tree
  kill as fallback; Tower PID from the owner lock and `/api/status`; port owner via
  `Get-NetTCPConnection` only where still needed.
- `agent-farm/commands/tower.ts`: job escape. If Phase 1 found the launcher kills detached
  children, start the daemon through CIM `Win32_Process.Create`; if that is blocked, refuse with
  an error naming a supported launch path.
- Every detached spawn (Tower daemon, shellpers, helpers): `windowsHide: true`.

#### Deliverables

- [ ] `killSessionTree` and Windows census provider, with all group-kill sites migrated.
- [ ] Windows reconnect identity via WELCOME; PID-reuse refusal on Windows.
- [ ] Tower stop/start without `lsof`/`pgrep`; graceful shutdown path; job escape; hidden
  consoles.
- [ ] Tests.

#### Acceptance Criteria

- [ ] POSIX: existing lifecycle tests pass unchanged; `killSessionTree` on POSIX issues exactly
  today's signals (asserted).
- [ ] Unit (seam `win32`, injected exec): snapshot taken before kill; re-parented descendant
  killed; dead root still clears snapshot descendants; creation-time mismatch skips the PID;
  census failure surfaces as an error and a Tower log line.
- [ ] Windows (`targeted`): scenario 4 (builder survives `afx tower stop`/`start`, same agent
  PID, replay, input works), scenario 5 (PID reuse refused, row cleaned), scenario 6 (no
  descendants after kill, including re-parented and dead-root variants), scenario 7 (orphan
  reaped on next start), scenario 3's stop/start half (owner lock released).
- [ ] POSIX suite and `check-types` green.

#### Test Plan

- Unit: CIM JSON parser (fixtures, including CRLF and empty output); kill-tree decision logic;
  shutdown route is loopback-only.
- Windows CI: real node→bash→node trees; Tower restart survival.
- Owner machine: survival from Windows Terminal, PowerShell console, VS Code terminal (feeds the
  PR-gate pass).

---

### Phase 4: Git Bash, executable shim, and MSYS path resolution with doctor prerequisites

**Dependencies**: Phase 1

#### Objective

One resolver each for Git Bash, executable shims and MSYS paths, and a `codev doctor` that
reports the Windows prerequisites. This phase routes nothing yet; it builds and exposes the
pieces, so it is observable through doctor alone.

#### Files to Create / Modify

- `packages/codev/src/lib/git-bash.ts` (new): resolution order: `CLAUDE_CODE_GIT_BASH_PATH` /
  config override is honored as the explicit override, standard install locations
  (`%ProgramFiles%\Git\bin\bash.exe`, `%LocalAppData%\Programs\Git\bin\bash.exe`), then `PATH`.
  `%SystemRoot%\System32\bash.exe` is always rejected. Returns path and Git version.
- `packages/codev/src/lib/executable.ts` (new): `which`-style PATH/PATHEXT lookup promoted from
  `commands/bootstrap-docs.ts`, plus `resolveSpawnable(cmd)` that turns a `.cmd`/`.bat` shim into
  `%COMSPEC% /d /s /c` form or its underlying `node <entry>`. `bootstrap-docs.ts` imports it.
- `packages/codev/src/lib/msys-path.ts` (new): native→POSIX (`C:\x` → `/c/x`), POSIX→native
  (`/c/x` → `C:\x`), and the per-call opt-out env (`MSYS_NO_PATHCONV=1`,
  `MSYS2_ARG_CONV_EXCL=*`).
- `packages/codev/src/commands/doctor.ts`: Windows section: Git for Windows (found, version,
  bash path; never System32), jq (found or install hint), CRLF warning for user-authored
  `postSpawn`/`devCommand` script files.
- `.gitattributes` (root): `eol=lf` for shipped `.sh` (forge concepts in `codev-skeleton/` and
  `codev/`, templates).

#### Deliverables

- [ ] Three resolvers with unit tests; `bootstrap-docs` uses the shared lookup.
- [ ] Doctor Windows checks; missing Git Bash or jq is a named, actionable failure.
- [ ] LF pinning for shipped scripts.

#### Acceptance Criteria

- [ ] Resolver precedence tests (fake fs/env): override wins; install path before `PATH`;
  System32 never returned even when first on `PATH`; nothing found → error naming Git for
  Windows.
- [ ] Shim tests: `claude` → `claude.cmd` via PATHEXT; spawnable form is executable by
  `CreateProcess`.
- [ ] MSYS round-trip table, including UNC and spaces.
- [ ] Doctor (seam `win32`): scenario 2 outputs (jq missing; only System32 bash) name the missing
  prerequisite. On POSIX the doctor output is unchanged (snapshot).
- [ ] Windows (`targeted`): doctor reports the runner's Git Bash and jq.
- [ ] POSIX suite and `check-types` green.

#### Test Plan

Unit tests as above; one Windows dispatch running doctor and the resolver tests for real.

---

### Phase 5: Launcher routing and shell roles

**Dependencies**: Phases 3, 4

#### Objective

Every plumbing launch site runs through the resolved Git Bash with correct path translation,
agent terminals spawn their harness through the shim resolver, and human shell terminals open
PowerShell. After this phase, `afx tower start`, spawn, forge, porch and `afx dev` work on
Windows.

#### Files to Create / Modify

- `packages/codev/src/lib/forge.ts`: concepts execute via `<gitbash> -c` / `<gitbash> <script>`
  with the script path translated and MSYS conversion disabled for concept arguments; sync and
  async paths. Output paths in MSYS form are translated back where Node consumes them.
- `packages/codev/src/agent-farm/commands/spawn-worktree.ts`, `spawn.ts`: `.builder-start.sh`
  launched by the resolved Git Bash instead of `/bin/bash`; builder environment exports
  `CLAUDE_CODE_GIT_BASH_PATH`; the generated script's paths are POSIX-form.
- `packages/codev/src/agent-farm/utils/shell.ts`: `postSpawn` via Git Bash, worktree as cwd.
- `packages/codev/src/agent-farm/commands/dev.ts`: `devCommand` via Git Bash; teardown via
  `killSessionTree`.
- `packages/codev/src/commands/porch/checks.ts`: shell-string checks via Git Bash.
- `packages/codev/src/terminal/pty-manager.ts`: Windows base env (`USERPROFILE`, `SystemRoot`,
  `COMSPEC`, `PATHEXT`, Windows `PATH`); command resolved through `resolveSpawnable`; default
  shell PowerShell on Windows.
- `packages/codev/src/agent-farm/servers/tower-routes.ts`: dashboard "new shell" fallback →
  PowerShell on Windows.
- `packages/codev/src/agent-farm/utils/config.ts`: Windows default `shell.shell` =
  `powershell.exe`; a configured `bash` maps to the resolved Git Bash; `pwsh` honored as an
  opt-in.
- `apps/vscode/src/tower-starter.ts`, `apps/vscode/src/commands/spawn.ts`: spawn `afx` through
  the shim resolver (an extension-local copy if importing `codev` is not allowed by the
  extension's build boundary), `windowsHide`.
- Bare-command spawns found by the inventory, for example `commands/porch/index.ts` spawning
  `afx` for `afx open`, and consult's reviewer CLI launches (`agy` and any other spawned CLI):
  through `resolveSpawnable`. `afx open`'s browser opener (the `open` package) already handles
  Windows and is only verified.
- Fix for the hang root cause from Phase 1 if it lives here (otherwise it is fixed in the phase
  that owns its site, and this phase confirms `afx tower start` reaches ready).

#### Deliverables

- [ ] All five launch-site classes routed; no bare `bash`, `/bin/bash`, `/bin/sh` or
  `shell: true` remains on a Windows path (grep check recorded in `audit.md`).
- [ ] Shell roles per Area F; `bash` config never reaches System32.
- [ ] Tests.

#### Acceptance Criteria

- [ ] POSIX: every launch site produces exactly today's argv/env (asserted per site).
- [ ] Unit (seam `win32`, stubbed provider CLIs): every concept of every provider (GitHub,
  GitLab, Gitea, Linear, Jira) goes through the launcher with the expected bash argv, cwd and
  opt-out env, including slash-prefixed arguments such as `/repos/...`.
- [ ] Windows (`targeted`): `afx tower start` reaches ready; architect terminal runs its harness
  stub; `afx shell` opens PowerShell; GitHub concepts that are read-only run live with the
  runner token; `afx spawn` launches a builder via Git Bash; porch drives a stub BUGFIX builder
  through a phase transition; `postSpawn` multi-command hook runs (scenario 10, including the
  CRLF case); `afx dev` teardown leaves no dev-server process.
- [ ] POSIX suite and `check-types` green.

#### Test Plan

- Unit per site and per provider.
- Windows CI as above.
- Owner machine (PR-gate pass): scenarios 1, 3, 8 (all GitHub concepts live), 9, 13 (consult),
  15 (VS Code), plus `afx open` and `afx attach`.

---

### Phase 6: Runnable-worktree links and worktree removal on Windows

**Dependencies**: Phases 3, 5

#### Objective

Runnable worktrees work without Developer Mode, and `afx cleanup` reliably removes worktrees on
Windows without following links into their targets.

#### Files to Create / Modify

- `packages/codev/src/agent-farm/lib/worktree-links.ts` (new): probe symlink permission once;
  directories → symlink if allowed else junction; files → symlink if allowed, else hard link on
  the same volume, else copy (reported). POSIX → today's `symlinkSync` calls.
- `packages/codev/src/agent-farm/commands/spawn-worktree.ts`: the four `symlinkSync` sites call
  the helper; spawn output reports copies.
- `packages/codev/src/agent-farm/commands/cleanup.ts`: kill the session tree first; removal
  unlinks junction/link entries without traversal (`lstat`, never recurse into a reparse
  point); retry with backoff on `EBUSY`/`EPERM`/`ENOTEMPTY`; final failure names the blocking
  path.

#### Deliverables

- [ ] Link helper and removal hardening, with tests.

#### Acceptance Criteria

- [ ] POSIX: link calls and removal unchanged (asserted).
- [ ] Unit (seam `win32`, injected fs errors): `EPERM` on symlink → junction (dir) / hard link
  (file) / copy (cross-volume, reported); removal retries then reports the path; a junction
  target is never deleted.
- [ ] Windows (`targeted`): scenario 11 (Developer Mode off on the runner: junction + hard link;
  symlink path covered when the probe reports it allowed) and scenario 6a (removal with a held
  handle released after a delay; junction target intact).
- [ ] POSIX suite and `check-types` green.

#### Test Plan

Unit as above; Windows CI as above; owner machine: Developer Mode on → real symlinks.

---

### Phase 7: ConPTY render-gate validation captures

**Dependencies**: Phase 5

#### Objective

`afx send` holds and delivers correctly on Windows terminals, based on captured ConPTY data, not
assumptions (#1567).

#### Files to Create / Modify

- A capture recipe in `audit.md` (or a small extension of the existing capture tooling) for
  recording a ConPTY session through Tower.
- `packages/codev/src/agent-farm/__tests__/fixtures/` (new fixtures): `conpty-claude-*`,
  `conpty-codex-*` covering idle prompt, mid-turn, human typing in the composer, resize.
- New replay test alongside `render-gate.test.ts` /
  `bugfix-1664-composer-stability-gate.test.ts`.
- `packages/codev/src/agent-farm/servers/gate-profiles.ts`: changed **only** where the captures
  show different timing, each change citing its fixture.

#### Deliverables

- [ ] ConPTY fixtures for claude and codex (agy if available on the owner's machine).
- [ ] Replay tests asserting held/delivered for each state.
- [ ] Gate profile adjustments, if any, with POSIX behavior unchanged.

#### Acceptance Criteria

- [ ] Replay tests pass for every ConPTY fixture: mid-turn → held, human typing → held
  (`busy:composer-redraw` or `busy:recent-input`), idle prompt → delivered.
- [ ] Existing POSIX gate fixtures and tests pass unchanged.
- [ ] Owner machine: scenario 12 live.

#### Test Plan

Captures need authenticated harnesses, which CI does not have, so the **owner records them** on
their Windows machine with a recipe from this phase. This phase is blocked until those captures
exist; the builder asks the architect for them as soon as Phase 5 is committed, and continues
with Phases 8 and 9 meanwhile (none of them depend on Phase 7).

---

### Phase 8: Codev IDE server on native Windows

**Dependencies**: Phases 3, 4, 5; **#1789 merged to `main` and merged into this branch**
(PR #1806 is still open as of plan time). This project builds on #1789's code and does not
re-implement discovery, the version handshake or extension handover.

#### Objective

The spec's "Codev IDE server (#1789) on native Windows" success criteria and scenarios 15a/15b.

#### Files to Create / Modify

(Names as of PR #1806; re-audited when it merges.)

- `packages/codev/src/agent-farm/commands/ide.ts`: discovery of `codev-ide-server` through the
  shared `lib/executable.ts` resolver (PATHEXT `.cmd` shim); no new lookup.
- `packages/codev/src/agent-farm/lib/ide-version.ts`: line 1 of `--version` parsed CRLF-tolerant
  as bare `major.minor.patch`, compared with the 1.128.0 floor; refusal message names installed
  version and floor. Never the npm version.
- `packages/codev/src/agent-farm/servers/ide-server.ts`: spawn via `resolveSpawnable`,
  `windowsHide: true`, detached; stop via `killSessionTree` instead of the per-PID
  SIGTERM/SIGKILL loop on Windows (POSIX unchanged).
- `packages/codev/src/agent-farm/lib/ide-extensions.ts`: Tower-owned extensions directory under
  `%USERPROFILE%`; `--install-extension` and `--extensions-dir` receive native Windows paths,
  long paths unaltered.
- `packages/codev/src/agent-farm/servers/ide-forward.ts`: `/ide/?folder=<repo>` with the folder as
  a native Windows path.
- A stub server for tests: a `codev-ide-server.cmd` shim fixture that prints a version line and
  serves HTTP, so discovery/spawn/forward/stop are testable without the real package.

#### Deliverables

- [ ] Windows behavior for discovery, preflight, spawn, forward, extension install and stop.
- [ ] Unit tests and a Windows CI test against the stub shim.
- [ ] The joint-check procedure below, sent to the main architect for the codev-ide lane.

#### Acceptance Criteria

- [ ] Unit: PATHEXT discovery; version parse (`1.128.0\r\n<commit>`, below-floor refusal text);
  argv for `--extensions-dir`/`--install-extension` with a >260-char native path; stop uses tree
  kill on Windows and today's code on POSIX.
- [ ] Windows (`targeted`, stub shim): `afx ide start` without `--server-path` finds the shim,
  passes preflight, serves `/ide/?folder=C:\...` through Tower; `afx ide stop` leaves no stub or
  child process; below-floor stub is refused; nothing is written outside the user profile.
- [ ] POSIX suite and `check-types` green.

#### Joint check with the codev-ide lane (scenario 15b): where it lands

SPIR has no dev-approval gate; the gates are spec-approval, plan-approval and pr. So:

- **Formal joint check: at verify.** After the PR merges, the codev-ide architect brings the
  `@cluesmith/codev-ide-server-win32-x64` package from its CI run, and scenario 15a runs end to
  end on the owner's Windows machine against `main`. Defects found there are fixed in this
  project's verify phase.
- **Optional dry run: before the PR gate.** Once Phase 8 is committed, and if the codev-ide CI
  artifact exists, the same procedure can run on the owner's machine against this branch. Any
  defect found is fixed before merge. This is recommended but not blocking, since it depends on
  the other lane's artifact timing.

#### Test Plan

Unit and stub-shim CI as above; real package at the dry run and at verify.

---

### Phase 9: POSIX residue sweep

**Dependencies**: Phases 2 to 6 (so the residue left is only residue)

#### Objective

Remove the remaining shallow POSIX assumptions in runtime and tests, add the long-path and
native-dependency diagnostics, so the Windows unit suite can run.

#### Files to Create / Modify

- Runtime `/tmp` and `HOME` sites: `terminal/pty-manager.ts` (`HOME ?? '/tmp'`),
  `agent-farm/servers/tower-terminals.ts` (`HOME || '/tmp'`, temp-dir list),
  `agent-farm/servers/tower-utils.ts` (`startsWith('/tmp/')`),
  `agent-farm/utils/worktree-write-guard.ts` (allowlist adds `os.tmpdir()` and `USERPROFILE` on
  Windows, POSIX entries unchanged).
- `~` expansion via one helper (`os.homedir()`), replacing string-replace sites.
- Path handling: `split('/')`, `+ '/'` scope markers and `startsWith('/')` absolute checks →
  `path.sep`/`path.isAbsolute` where they handle host paths (the inventory says which).
- Command-output parsing: `split('\n')` → CRLF-tolerant at sites that parse external command
  output.
- `chmod`/mode sites: left as-is (no-op on Windows); owner-only protection on Windows relies on
  `%USERPROFILE%` privacy (decision 8), documented in Phase 10.
- `commands/doctor.ts`: long-path checks (workspace root depth vs MAX_PATH budget; Git
  `core.longpaths`).
- Native dependency load: a load failure of node-pty or better-sqlite3 on Windows prints the
  supported Node versions (from the Phase 1 matrix); never a source-build fallback.
- Tests (~70 files): `/tmp` → `os.tmpdir()`/`mkdtemp` in tests meant to run on Windows; helpers
  that deliberately use `/tmp` for the macOS `sun_path` limit keep it on POSIX; inherently POSIX
  tests get `it.skipIf(process.platform === 'win32')` with a reason.

#### Deliverables

- [ ] Runtime residue fixed; doctor long-path checks; native-dep message.
- [ ] Test-suite sweep.

#### Acceptance Criteria

- [ ] Grep check (recorded in `audit.md`): no unannotated `/tmp` in runtime code or in tests not
  skipped on win32.
- [ ] Doctor (seam `win32`): deep workspace warns; `core.longpaths` reported.
- [ ] Windows (`targeted`, full unit suite): runs to completion; every failure is fixed, or is a
  documented win32 skip with reason, or is flaky and annotated per protocol.
- [ ] Owner machine: scenario 6b (typical-depth workspace, builder worktree runs `npm install`).
- [ ] POSIX suite and `check-types` green.

#### Test Plan

Unit; full Windows unit suite via dispatch; owner long-path check.

---

### Phase 10: Windows CI leg and install docs

**Dependencies**: Phases 1 to 9

#### Objective

The on-demand Windows workflow runs the full suites, and the docs present the two supported
Windows paths.

#### Files to Create / Modify

- `.github/workflows/windows.yml`: add `unit`, `cli-e2e` and `post-release-e2e` jobs on
  `windows-latest` (Node 20/22 × x64). `workflow_dispatch` only. Not added to required checks.
- `codev/DEPENDENCIES.md`, `codev-skeleton/DEPENDENCIES.md`: native Windows (Git for Windows + jq,
  Node ≥ 20, 22 recommended, supported Node versions from the prebuild matrix, ARM64 verdict,
  `core.longpaths`, short workspace root, `%USERPROFILE%` privacy note, Developer Mode optional)
  and WSL 2 as the two paths, with limitations; Linux/WSL `build-essential` + `python3`.
- `README.md` install section.
- `codev/protocols/release/protocol.md` (and the skeleton copy if one exists): dispatch the
  Windows workflow before every release.
- PR checklist / builder-facing guidance where PR checklists live: dispatch on any PR touching
  platform code.
- `codev/resources/arch.md`: a short "Platform layer" entry (seam, endpoint, process tree,
  resolvers); `lessons-learned.md` entries from the work. Hot tier only if something displaces.
- Skills that mention shells or prerequisites (`afx`, `runnable-worktrees`) if their text
  changes: all four copies.

#### Deliverables

- [ ] Full on-demand workflow; docs mirrored across both trees.

#### Acceptance Criteria

- [ ] A manual dispatch runs `unit`, `cli-e2e` and `post-release-e2e` green on `windows-latest`
  (scenario 17). The workflow has no `push`/`pull_request` trigger and is not required.
- [ ] Docs mirrored (`codev/` and `codev-skeleton/` diff clean where they should match); skill
  copies in parity (the #1196/#1489 parity tests pass).
- [ ] macOS/Linux suites green (scenario 16).

#### Test Plan

Workflow dispatch; parity tests; doc review.

## PR-gate manual pass (owner's Windows machine)

Before the `pr` gate, the owner runs, on Windows 10 22H2 or 11 x64 with WSL disabled, the
scenarios CI cannot cover: 1, 3 (interactive), 4 (from Windows Terminal, PowerShell console and
VS Code), 8 (all GitHub concepts live), 9 (real PR via forge), 11 (Developer Mode on), 12, 13
(3-way consult from a Windows builder; unauthenticated agy skips), 15 (VS Code extension), 6b,
and the optional IDE dry run (15a with the real package). The builder supplies a checklist with
expected results; results are recorded in the review.

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| `windows.yml` cannot be dispatched before it is on `main` | High | High (slows every phase's Windows check) | Ask at plan approval to land the dispatch-only skeleton on `main` early; fallback is the owner's machine |
| Audit contradicts a spec assumption (no prebuilds, every launcher kills detached children, CIM blocked) | Medium | High | Phase 1 stops and reports before Phase 2; scope is the architect's call |
| Owner availability for captures and the manual pass | Medium | Medium | Phase 7 is off the critical path (8, 9 proceed); captures requested as soon as Phase 5 lands; one consolidated PR-gate pass |
| #1789 merges late or changes shape | Medium | Medium | Phase 8 is the only dependent; it waits, others proceed; re-audit on merge |
| A platform branch changes POSIX behavior | Low | High | Per-site POSIX argv/env/bytes assertions; full macOS/Linux suites every phase |
| Seam-forced unit tests pass but real Windows differs | High | Medium | Each phase has real-Windows checks via dispatch; nothing is called done on unit tests alone |
| Phase 5 is large (many launch sites) | Medium | Medium | Resolvers are already built and tested in Phase 4; sites are mechanical uses of them, each with a per-site POSIX assertion |
| Spec-level risks (kill-on-close jobs, `taskkill` gaps, ConPTY timing, MSYS mangling, System32 bash, CIM policy, pipe access, worktree handles, MAX_PATH, `.cmd` shims, CRLF) | per spec | per spec | Mitigations are the phase deliverables above (3, 3, 7, 4/5, 4, 3, 2, 6, 9, 4/5, 4/9) |

## Documentation Updates

- `codev/DEPENDENCIES.md` and `codev-skeleton/DEPENDENCIES.md`, `README.md` (Phase 10).
- Release protocol: dispatch the Windows workflow before release (Phase 10).
- `codev/resources/arch.md` platform-layer entry; `lessons-learned.md` (Phase 10, review).
- Skills, only if their text changes, in all four copies (Phase 10).
- Review: hang root cause, audit facts, flaky tests, PR-gate pass results.
