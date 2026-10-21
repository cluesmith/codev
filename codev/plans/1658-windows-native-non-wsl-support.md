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

One deviation from the spec's wording: the spec names the `tree-kill` package for B1. This plan
calls `taskkill` directly from a new primitive, because the pre-kill snapshot and per-PID
creation-time checks need control `tree-kill` does not offer (on Windows it is a thin
`taskkill /T /F` wrapper). The only `tree-kill` user today, `killProcessTree` in
`agent-farm/utils/shell.ts`, has no callers and is deleted along with the dependency (Phase 3).

Owner ruling 1 fixes the phase order: audit → transport + lifecycle → forge/launcher routing →
POSIX residue sweep → CI leg. This plan keeps that order and splits the large buckets into
phases that each commit and verify on their own:

| Ruling-1 bucket | Plan phases |
|---|---|
| Audit | 1 |
| Transport + lifecycle | 2, 3, 4 |
| Forge/launcher routing | 5, 6, 7 |
| (ConPTY gate and IDE server, both of which need working launchers) | 8, 9 |
| POSIX residue sweep | 10 |
| CI leg | 11 |

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
   dispatches the `targeted` job against the branch. Phase 11 adds the full suites.
3. **The owner's Windows machine** for what CI cannot do. These are listed per phase and
   collected into one manual test pass at the PR gate.

**Early `windows.yml` landing (owner ruling at plan approval, 2026-10-21T06:15:45Z: yes).**
GitHub only dispatches a workflow whose file exists on the default branch; a branch's version of
the file then runs via `--ref`. So right after Phase 1, the builder opens a small separate PR,
from a branch cut from `origin/main`, that lands the dispatch-only `windows.yml` skeleton on
`main`. It is manual dispatch only, never automatic, never a required check. This is the one
sanctioned exception to "one PR at the end". Windows checks in Phases 1 to 10 then run through
`targeted` dispatches as written.

### Standing constraints applied to every phase

- POSIX behavior does not change. POSIX implementations stay today's code. Where a phase
  changes a shared contract, it says whether POSIX adopts the change and tests that explicitly.
  Each phase runs the macOS/Linux unit suite plus `check-types` (`pnpm build` first) before its
  commit.
- Framework content is mirrored in `codev/` and `codev-skeleton/`. Shipped skill edits touch all
  four copies (`.claude`/`.codex` × root/skeleton).
- The mailbox invariant (Spec 1313) and server/client isolation (#1189) hold. No Windows code
  enters `codev-sdk` outside its `/node` adapter.
- Commits: `[Spec 1658][Phase: <id>] ...`, files staged explicitly. One PR at the end, plus the
  early `windows.yml` PR above.

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "phase_1", "title": "Windows audit, probe harness, and platform seam"},
    {"id": "phase_2", "title": "Shellper named-pipe transport, per-session secret, and reconnect identity"},
    {"id": "phase_3", "title": "Process census and session-tree teardown"},
    {"id": "phase_4", "title": "Tower lifecycle and detached survival on Windows"},
    {"id": "phase_5", "title": "Git Bash, executable shim, and MSYS path resolution with doctor prerequisites"},
    {"id": "phase_6", "title": "Launcher routing and shell roles"},
    {"id": "phase_7", "title": "Runnable-worktree links and worktree removal on Windows"},
    {"id": "phase_8", "title": "ConPTY render-gate validation captures"},
    {"id": "phase_9", "title": "Codev IDE server on native Windows"},
    {"id": "phase_10", "title": "POSIX residue sweep and native-dependency install guard"},
    {"id": "phase_11", "title": "Windows CI leg and install docs"}
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
  spec's Current State. It includes code that landed after the spec audit: the IDE server
  spawn/stop (`agent-farm/servers/ide-server.ts`, `ide-forward.ts`, from #1668) and, if merged by
  then, #1789 (`commands/ide.ts`, `lib/ide-version.ts`, `lib/ide-extensions.ts`), #1595 hooks, and
  #1672 lane card. It also lists the sites the plan review surfaced: `commands/tower.ts`
  (dev-mode `npx`, the `forceKillAllChildProcesses` `pgrep` branch, `towerLog --follow`'s
  `tail -f`), `porch/checks.ts` group-exit wait and `detached` grouping, the cmdline matchers in
  `session-manager.ts`, `shellper-husk-sweep.ts` and `architect-session-holder.ts`. Re-run at
  the start of Phases 6, 9 and 10 for anything merged since.
- [ ] **Probe script** measuring, on the host it runs on:
  - native dependency install behavior: for node-pty and better-sqlite3 at the pinned versions,
    Node 20/22/24, win32-x64 and win32-arm64, whether a prebuilt binary is used and what the
    install script does when none matches (falls back to `node-gyp` or fails);
  - a named-pipe listen/connect round trip carrying a HELLO/WELCOME frame;
  - **CIM census latency**: cold and warm wall time of the inline `Win32_Process` query, to size
    the Phase 3 cache and the `probeTowerHealth` budget;
  - detached-child survival: spawn a detached child, end the launching process, check the child
    survives (an empirical kill-on-close job test that needs no native API);
  - PATHEXT resolution of `claude`, `codex`, `afx`, `npx`, `codev-ide-server`;
  - Git Bash candidate locations and the System32 `bash.exe` trap;
  - the `afx tower start` hang: start the daemon with its stderr/log captured, record the first
    failure.
- [ ] **Launcher survival matrix**: CI runner (from the `probe` job); Windows Terminal,
  PowerShell console, VS Code integrated terminal and extension host, SSH (owner runs
  `windows-probe.mjs --survival` on their machine).
- [ ] **Root cause of the 2026-09-09 hang**, recorded in `audit.md` (carried to the review).
- [ ] Platform seam plus tests.

#### Acceptance Criteria

- [ ] `audit.md` lists every site class with its owning phase, the prebuild and install-script
  matrix (which defines the supported Windows Node versions and the ARM64 verdict), the CIM
  latency numbers, the launcher survival matrix, and the hang root cause.
- [ ] `windows.yml` `probe` job runs green from a dispatch once the early PR has landed it on
  `main`.
- [ ] Platform seam tests pass; POSIX unit suite and `check-types` green.

#### Test Plan

- Unit: platform seam defaults to `process.platform`; override and reset behave.
- Windows: dispatch `probe`; owner runs the survival mode on their launchers.
- If the audit contradicts a spec assumption (for example no prebuild for a supported Node
  version, every launcher kills detached children, or CIM latency too high for any cache to
  hide), stop and report to the architect before Phase 2. Those facts change scope.

---

### Phase 2: Shellper named-pipe transport, per-session secret, and reconnect identity

**Dependencies**: Phase 1

#### Objective

Shellpers listen and reconnect on Windows over named pipes, other local users can neither read
from nor control them, and reconnect identity on Windows is the authenticated WELCOME. POSIX
connections stay byte-identical.

#### Files to Create / Modify

- `packages/codev/src/terminal/shellper-endpoint.ts` (new): resolve endpoint (POSIX
  `<socketDir>/shellper-<id>.sock`; Windows `\\.\pipe\codev-shellper-<user>-<uuid>`), readiness
  probe, stale-endpoint cleanup (no-op on Windows), log path decoupled from the endpoint (POSIX
  log path unchanged).
- `packages/codev/src/terminal/session-manager.ts`: socket-file wait → endpoint readiness probe;
  `isSocket`/`lstat` checks → endpoint probe; session id from the DB row, not the
  `shellper-<id>.sock` basename; attach fallback scan uses the DB registry on Windows;
  `.sock`→`.log` string replace → `shellper-endpoint` log path; `socketDir` scope marker uses
  `path.sep`. **Reconnect identity**: on Windows the start-time check (`getProcessStartTime`,
  which returns null on win32 and so fails closed today) is replaced by WELCOME verification;
  POSIX keeps the start-time check unchanged.
- `packages/codev/src/terminal/shellper-protocol.ts`: optional HELLO `secret`, and optional
  WELCOME `shellperPid` and `sessionId` (today WELCOME's `pid` is the PTY child, not the
  shellper). All three are sent only on Windows; POSIX frames are unchanged.
- `packages/codev/src/terminal/shellper-main.ts`, `shellper-process.ts`: read the secret from the
  environment, delete it from the env the PTY child inherits, write nothing to a connection
  until a valid HELLO, drop on mismatch. The shellper's config (argv JSON) keeps carrying
  `socketDir`, so the Tower-instance scope marker still appears in its command line on Windows.
- `packages/codev/src/terminal/shellper-client.ts`: send the secret; verify WELCOME
  (`sessionId`, `shellperPid` against the DB row). Reconnect returns a distinct
  **identity-refused** result rather than a bare `null`, so callers can tell a confirmed
  mismatch from a transient connect failure.
- `packages/codev/src/agent-farm/servers/tower-terminals.ts`: `reconcileTerminalSessions` and
  `getTerminalsForWorkspace` clean the row on identity-refused even when the PID is alive (the
  #1686 keep-row-if-alive guard stays for transient failures), so scenario 5 works.
- `packages/codev/src/agent-farm/db/migrations.ts`: nullable secret column on the session row in
  `global.db` (always null on POSIX).
- `packages/codev/src/agent-farm/commands/attach.ts`: pass endpoint and secret through attach.

#### Deliverables

- [ ] Endpoint abstraction; POSIX endpoint, log path and handshake unchanged.
- [ ] Windows secret: generated by Tower per session (crypto random), passed via environment,
  never argv; persisted for reconnect; stripped before the PTY child starts.
- [ ] Unauthenticated connection: zero bytes written, frames ignored, connection dropped.
- [ ] Windows reconnect identity via WELCOME, with identity-refused distinguished from transient
  failure.
- [ ] Tests.

#### Acceptance Criteria

- [ ] Golden test: POSIX endpoint path, log path and HELLO/WELCOME bytes are identical to today;
  POSIX reconnect still runs the start-time check.
- [ ] With the seam forced to `win32` (over a POSIX socket in unit tests): a client without or
  with a wrong secret receives zero bytes, its frames have no effect, and it is dropped; the
  correct secret attaches; a WELCOME with the wrong `sessionId` or `shellperPid` yields
  identity-refused, and the reconcile path deletes the row even though the PID is alive.
- [ ] The secret never appears in argv or in the PTY child's environment.
- [ ] Windows (`targeted`): a real `\\.\pipe\` shellper is spawned by one `SessionManager`, that
  manager is discarded, and a fresh `SessionManager` reconnects with replay. (Reconnect across
  a real `afx tower stop`/`start` is Phase 4.)
- [ ] Windows (`targeted`, scenario 14): a second non-admin local user created on the runner
  opens the pipe and receives zero bytes; its frames have no effect.
- [ ] POSIX suite and `check-types` green.

#### Test Plan

- Unit: endpoint resolution per platform; log path; secret gating; WELCOME verification;
  identity-refused vs transient in reconcile; migration up on an existing DB.
- Windows CI: pipe round trip and cross-manager reconnect; second-user access test.

---

### Phase 3: Process census and session-tree teardown

**Dependencies**: Phase 2

#### Objective

A Windows census provider with creation time, and a teardown primitive that leaves no
descendants, wired into every process-group kill and wait site and into the orphan/husk sweeps.

#### Files to Create / Modify

- `packages/codev/src/agent-farm/servers/process-census.ts`: provider interface;
  `ProcessCensusEntry` gains an optional `creationTime`. The POSIX provider is today's `ps` code.
  The Windows provider runs an inline `powershell.exe -NoProfile -NonInteractive -Command` CIM
  `Win32_Process` query (JSON out: pid, ppid, cmdline, creation time, working set). Because the
  census sits on `/health` (`tower-routes.ts`, two awaits) and `/health` latency sizes
  `probeTowerHealth`'s budget in `tower-owner.ts` (the owner-lock guard), the Windows provider
  has a short TTL cache plus single-flight coalescing, with TTL and the probe budget derived
  from the Phase 1 latency numbers.
- **Failure contract**: Windows only. On Windows a census failure is reported (thrown to sweep
  callers, logged by Tower, flagged by doctor), never an empty list. POSIX keeps today's
  `[]`-on-failure behavior, asserted by a test.
- `packages/codev/src/lib/process-tree.ts` (new):
  - `killSessionTree(rootPid, opts)`. POSIX: today's group SIGTERM→SIGKILL. Windows: census
    snapshot of descendants (pid, ppid, creation time) → `taskkill /T /F` → explicit kill of
    each recorded descendant whose creation time still matches → tolerant of an already-dead
    root.
  - `waitForTreeExit(rootPid, snapshot, timeoutMs)`: POSIX is today's `process.kill(-pgid, 0)`
    loop; Windows polls the snapshot PIDs (with creation time) until gone or timeout.
- Group-kill sites → `killSessionTree`: `terminal/pty-session.ts`, `terminal/session-manager.ts`
  (orphan sweep, reaping), `agent-farm/servers/architect-session-holder.ts`,
  `agent-farm/commands/cleanup.ts`, `commands/porch/checks.ts`.
- `commands/porch/checks.ts`: `waitForGroupExit` → `waitForTreeExit`, so the 5 s grace still
  applies on Windows. The `detached: true` spawn (#1814: keeps test workers from holding stdout
  open) has no process-group meaning on Windows; there the check spawns with `windowsHide` and
  its tree is tracked from the snapshot instead.
- `agent-farm/servers/shellper-husk-sweep.ts`: on Windows, creation time comes from the census
  entry, not a per-PID `getStartTime` call (the seam is reshaped so one census serves the whole
  sweep; no N-spawn loop). Same age race guard.
- Cmdline matchers (`session-manager.ts` `findShellperProcesses`, `shellper-husk-sweep.ts`,
  `architect-session-holder.ts` `extractJsonStringField`): JSON-unescape before comparing, so
  `C:\\Users\\...` in a shellper's argv JSON matches `C:\Users\...`; scope by `socketDir`
  (carried in argv per Phase 2).
- `agent-farm/utils/shell.ts`: delete the uncalled `killProcess`/`killProcessTree`;
  `packages/codev/package.json`: drop `tree-kill`.

#### Deliverables

- [ ] Windows census provider (cached, coalesced) and `creationTime`.
- [ ] `killSessionTree` + `waitForTreeExit`, all group sites migrated.
- [ ] Sweeps on Windows; JSON-aware cmdline matching.
- [ ] Dead teardown code and `tree-kill` removed.
- [ ] Tests.

#### Acceptance Criteria

- [ ] POSIX: existing lifecycle tests pass unchanged; `killSessionTree`/`waitForTreeExit` on POSIX
  issue exactly today's signals and probes (asserted); census failure on POSIX still yields `[]`.
- [ ] Unit (seam `win32`, injected exec): snapshot taken before kill; re-parented descendant
  killed; dead root still clears snapshot descendants; creation-time mismatch skips the PID;
  census failure surfaces as an error and a Tower log line; concurrent census calls within the
  TTL spawn one query; husk sweep makes one census call per sweep; escaped-backslash cmdline
  matches.
- [ ] Windows (`targeted`): scenario 6 (no descendants after kill, including re-parented and
  dead-root variants), scenario 7 (an unregistered shellper is detected and reaped by the sweep),
  porch check timeout kills its tree and honors the grace period.
- [ ] POSIX suite and `check-types` green.

#### Test Plan

- Unit: CIM JSON parser (fixtures, including CRLF and empty output); kill-tree decision logic;
  cache and single-flight; matcher unescaping.
- Windows CI: real node→bash→node trees.

---

### Phase 4: Tower lifecycle and detached survival on Windows

**Dependencies**: Phases 2, 3

#### Objective

`afx tower start` and `stop` work on Windows without `lsof`/`pgrep`, with a graceful shutdown,
hidden console windows, and shellpers that survive a Tower restart on every documented launch
path.

#### Files to Create / Modify

- `agent-farm/commands/tower.ts`:
  - stop via a local-only HTTP shutdown request, then `killSessionTree` as fallback;
  - Tower PID from the owner lock and `/api/status`;
  - the `forceKillAllChildProcesses` branch (`pgrep -P`, `pgrep -f shellper-main`) uses the
    census and `killSessionTree` on Windows;
  - job escape: if Phase 1 found the launcher kills detached children, start the daemon through
    CIM `Win32_Process.Create`; if that is blocked, refuse with an error naming a supported
    launch path.
- `agent-farm/servers/tower-routes.ts`: loopback-only shutdown route.
- `agent-farm/utils/port.ts`, `agent-farm/db/tower-owner.ts`: no `lsof` on Windows; port owner via
  `Get-NetTCPConnection` only where still needed; `probeTowerHealth` budget per Phase 3.
- Every detached spawn (Tower daemon, shellpers, helpers): `windowsHide: true`.
- The hang root cause from Phase 1, if it lives in this area.

#### Deliverables

- [ ] Tower start/stop on Windows; graceful shutdown; job escape; hidden consoles.
- [ ] Tests.

#### Acceptance Criteria

- [ ] POSIX: `afx tower start`/`stop` behavior and tests unchanged.
- [ ] Unit: shutdown route rejects non-loopback; job-escape decision (survival measured /
  relaunch blocked → refusal text) with injected exec.
- [ ] Windows (`targeted`): scenario 3's stop/start half (ready reached, owner lock released),
  scenario 4 (spawned builder stub survives `afx tower stop`/`start`, same PID, replay, input
  works), scenario 5 end to end (PID reuse refused, row cleaned).
- [ ] Owner machine: survival from Windows Terminal, PowerShell console, VS Code terminal and
  extension host (feeds the PR-gate pass).
- [ ] POSIX suite and `check-types` green.

#### Test Plan

Unit as above; Windows CI restart-survival test; owner launcher checks.

---

### Phase 5: Git Bash, executable shim, and MSYS path resolution with doctor prerequisites

**Dependencies**: Phase 1

#### Objective

One resolver each for Git Bash, executable shims and MSYS paths, and a `codev doctor` that
reports the Windows prerequisites. This phase routes nothing yet; it builds and exposes the
pieces, so it is observable through doctor alone.

#### Files to Create / Modify

- `packages/codev/src/lib/git-bash.ts` (new): resolution per ruling 5 as amended
  (2026-10-21T06:15:45Z): the explicit override (config setting, or `CLAUDE_CODE_GIT_BASH_PATH`
  if the user set it) wins when it points at a real Git Bash; otherwise standard install
  locations (`%ProgramFiles%\Git\bin\bash.exe`, `%LocalAppData%\Programs\Git\bin\bash.exe`),
  then `PATH`. `%SystemRoot%\System32\bash.exe` is always rejected; an override pointing at it
  or at a non-Git bash fails loudly (no silent fallback). Returns path and Git version.
- `packages/sdk/src/node/executable.ts` (new): `which`-style PATH/PATHEXT lookup promoted from
  `commands/bootstrap-docs.ts`, plus `resolveSpawnable(cmd)` that turns a `.cmd`/`.bat` shim into
  `%COMSPEC% /d /s /c` form or its underlying `node <entry>`. It lives in `codev-sdk/node`, the
  sanctioned home for node-requiring shared client code, because both `packages/codev` (already a
  dependent) and `apps/vscode` (which cannot import `@cluesmith/codev`, and already imports
  `readLocalKey` from `codev-sdk/node`) need it. `bootstrap-docs.ts` imports it.
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

- [ ] Resolver precedence tests (fake fs/env): a valid override wins over an installed Git;
  install path before `PATH`; System32 never returned even when first on `PATH`; an override at
  System32 or at a non-Git bash fails loudly; nothing found → error naming Git for Windows.
- [ ] Shim tests: `claude` → `claude.cmd` via PATHEXT; spawnable form is executable by
  `CreateProcess`. The sdk boundary test still passes (no `vscode` import, zero runtime deps).
- [ ] MSYS round-trip table, including UNC and spaces.
- [ ] Doctor (seam `win32`): scenario 2 outputs (jq missing; only System32 bash) name the missing
  prerequisite. On POSIX the doctor output is unchanged (snapshot).
- [ ] Windows (`targeted`): doctor reports the runner's Git Bash and jq.
- [ ] POSIX suite and `check-types` green.

#### Test Plan

Unit tests as above; one Windows dispatch running doctor and the resolver tests for real.

---

### Phase 6: Launcher routing and shell roles

**Dependencies**: Phases 3, 4, 5

#### Objective

Every plumbing launch site runs through the resolved Git Bash with correct path translation,
agent terminals spawn their harness through the shim resolver, and human shell terminals open
PowerShell. After this phase, spawn, forge, porch and `afx dev` work on Windows.

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
- `packages/codev/src/agent-farm/commands/tower.ts`: dev-mode `npx` through `resolveSpawnable`;
  `towerLog --follow` uses a Node file follower on Windows instead of `tail -f`.
- `packages/codev/src/terminal/pty-manager.ts`: Windows base env (`USERPROFILE`, `SystemRoot`,
  `COMSPEC`, `PATHEXT`, Windows `PATH`); command resolved through `resolveSpawnable`; default
  shell PowerShell on Windows.
- `packages/codev/src/agent-farm/servers/tower-routes.ts`: dashboard "new shell" fallback →
  PowerShell on Windows.
- `packages/codev/src/agent-farm/utils/config.ts`: Windows default `shell.shell` =
  `powershell.exe`; a configured `bash` maps to the resolved Git Bash; `pwsh` honored as an
  opt-in.
- `apps/vscode/src/tower-starter.ts`, `apps/vscode/src/commands/spawn.ts`: spawn `afx` through
  `codev-sdk/node`'s `resolveSpawnable`, with `windowsHide`.
- Bare-command spawns found by the inventory, for example `commands/porch/index.ts` spawning
  `afx` for `afx open`, and consult's reviewer CLI launches (`agy` and any other spawned CLI):
  through `resolveSpawnable`. `afx open`'s browser opener (the `open` package) already handles
  Windows and is only verified.

#### Deliverables

- [ ] All plumbing launch-site classes routed; no bare `bash`, `/bin/bash`, `/bin/sh`, `tail`
  or `shell: true` remains on a Windows path (grep check recorded in `audit.md`).
- [ ] Shell roles per Area F; `bash` config never reaches System32.
- [ ] Tests.

#### Acceptance Criteria

- [ ] POSIX: every launch site produces exactly today's argv/env (asserted per site).
- [ ] Unit (seam `win32`, stubbed provider CLIs): every concept of every provider (GitHub,
  GitLab, Gitea, Linear, Jira) goes through the launcher with the expected bash argv, cwd and
  opt-out env, including slash-prefixed arguments such as `/repos/...`.
- [ ] Windows (`targeted`): `afx tower start` reaches ready with the architect terminal running
  its harness stub; `afx shell` opens PowerShell; read-only GitHub concepts run live with the
  runner token; `afx spawn` launches a builder via Git Bash; porch drives a stub BUGFIX builder
  through a phase transition; a multi-command `postSpawn` hook runs (scenario 10, including the
  CRLF case); `afx dev` teardown leaves no dev-server process.
- [ ] POSIX suite and `check-types` green.

#### Test Plan

- Unit per site and per provider.
- Windows CI as above.
- Owner machine (PR-gate pass): scenarios 1, 3, 8 (all GitHub concepts live), 9, 13 (consult),
  15 (VS Code), plus `afx open` and `afx attach`.

---

### Phase 7: Runnable-worktree links and worktree removal on Windows

**Dependencies**: Phases 3, 6

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

### Phase 8: ConPTY render-gate validation captures

**Dependencies**: Phase 6

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
exist. The builder asks the architect for them as soon as Phase 6 is committed, and continues
with Phases 9 and 10 meanwhile (neither depends on Phase 8).

---

### Phase 9: Codev IDE server on native Windows

**Dependencies**: Phases 3, 4, 5, 6; **#1789 merged to `main` and merged into this branch**
(PR #1806 is still open as of plan time). This project builds on #1789's code and does not
re-implement discovery, the version handshake or extension handover.

#### Objective

The spec's "Codev IDE server (#1789) on native Windows" success criteria and scenarios 15a/15b.

#### Files to Create / Modify

(Names as of PR #1806; re-audited when it merges.)

- `packages/codev/src/agent-farm/commands/ide.ts`: discovery of `codev-ide-server` through the
  shared `codev-sdk/node` executable resolver (PATHEXT `.cmd` shim); no new lookup.
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
- [ ] The joint-check procedure below (already sent to the main architect for the codev-ide
  lane at plan time).

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
- **Optional dry run: before the PR gate.** Once Phase 9 is committed, and if the codev-ide CI
  artifact exists, the same procedure can run on the owner's machine against this branch. Any
  defect found is fixed before merge. This is recommended but not blocking, since it depends on
  the other lane's artifact timing.

#### Test Plan

Unit and stub-shim CI as above; real package at the dry run and at verify.

---

### Phase 10: POSIX residue sweep and native-dependency install guard

**Dependencies**: Phases 2 to 7 (so the residue left is only residue)

#### Objective

Remove the remaining shallow POSIX assumptions in runtime and tests, add the long-path
diagnostics, and make native-dependency installation on Windows fail clearly instead of
building from source, so the Windows unit suite can run.

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
  `%USERPROFILE%` privacy (decision 8). Doctor warns on Windows when `CODEV_AGENT_FARM_DIR`
  relocates state outside the user profile, since that loses the protection.
- `commands/doctor.ts`: long-path checks (workspace root depth vs MAX_PATH budget; Git
  `core.longpaths`).
- **Native-dependency install guard.** A runtime load error comes too late: by then an install
  script may already have tried a source build. So, using Phase 1's install-script findings:
  - `packages/codev/package.json` `engines.node` is narrowed to the audited supported set if it
    is narrower than `>=20`, so npm warns before install;
  - the package ships npm config (or documents the flag, if config cannot be shipped for a
    global install) that disables source-build fallback for the prebuild-based dependency, so a
    missing prebuild fails install instead of compiling;
  - `scripts/postinstall.mjs` (runs after dependencies) verifies on Windows that both bindings
    load and, if not, prints the supported Node versions and exits non-zero;
  - first-run load failure prints the same message.
- Tests (~70 files): `/tmp` → `os.tmpdir()`/`mkdtemp` in tests meant to run on Windows; helpers
  that deliberately use `/tmp` for the macOS `sun_path` limit keep it on POSIX; inherently POSIX
  tests get `it.skipIf(process.platform === 'win32')` with a reason.

#### Deliverables

- [ ] Runtime residue fixed; doctor long-path and state-dir checks.
- [ ] Native-dependency install guard.
- [ ] Test-suite sweep.

#### Acceptance Criteria

- [ ] Grep check (recorded in `audit.md`): no unannotated `/tmp` in runtime code or in tests not
  skipped on win32.
- [ ] Doctor (seam `win32`): deep workspace warns; `core.longpaths` reported; relocated state
  dir warns.
- [ ] Windows (`targeted`): installing the packed branch tarball globally on an unsupported Node
  version, with the compiler made unreachable (`node-gyp` replaced by a failing stub on `PATH`),
  fails with the supported-versions message and never invokes the stub.
- [ ] Windows (`targeted`, full unit suite): runs to completion; every failure is fixed, or is a
  documented win32 skip with reason, or is flaky and annotated per protocol.
- [ ] Owner machine: scenario 6b (typical-depth workspace, builder worktree runs `npm install`);
  global install on a machine with no toolchain.
- [ ] POSIX suite and `check-types` green; POSIX install unaffected.

#### Test Plan

Unit; full Windows unit suite and install-guard test via dispatch; owner long-path and install
checks.

---

### Phase 11: Windows CI leg and install docs

**Dependencies**: Phases 1 to 10

#### Objective

The on-demand Windows workflow runs the full suites against **this branch's** artifacts, and the
docs present the two supported Windows paths.

#### Files to Create / Modify

- `.github/workflows/windows.yml`: add `unit`, `cli-e2e` and `post-release-e2e` jobs on
  `windows-latest` (Node 20/22 × x64). `workflow_dispatch` only. Not added to required checks.
  The e2e jobs build and `pnpm pack` the dispatched ref on the runner and install that tarball,
  so they test branch artifacts, not only an already-published release; an optional dispatch
  input selects a published version instead. Paths use `${{ runner.temp }}`, not `/tmp`; steps
  that reuse Bash scripts run under `shell: bash` (the runner's Git Bash, the same one users
  have).
- `packages/codev/scripts/verify-install.mjs`: on Windows, binaries are `<prefix>\<bin>.cmd`
  (npm's global layout has no `bin/` subdirectory there) and are invoked through
  `resolveSpawnable` with `execFileSync` argument arrays instead of shell-quoted strings. POSIX
  behavior unchanged.
- `.github/workflows/post-release-e2e.yml`, `e2e.yml`: unchanged triggers and matrices; only
  shared steps are factored if the Windows jobs reuse them.
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

- [ ] Full on-demand workflow testing branch artifacts; Windows-aware `verify-install.mjs`.
- [ ] Docs mirrored across both trees.

#### Acceptance Criteria

- [ ] A manual dispatch runs `unit`, `cli-e2e` and `post-release-e2e` green on `windows-latest`
  against the branch's packed tarball (scenario 17). The workflow has no `push`/`pull_request`
  trigger and is not required.
- [ ] `verify-install.mjs` passes on macOS/Linux unchanged and on Windows.
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
a global install with no toolchain, and the optional IDE dry run (15a with the real package).
The builder supplies a checklist with expected results;
results are recorded in the review.

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| `windows.yml` cannot be dispatched before it is on `main` | High | High (slows every phase's Windows check) | Early dispatch-only PR right after Phase 1 (owner ruling); until it merges, Phase 1's probe runs on the owner's machine |
| Audit contradicts a spec assumption (no prebuilds, every launcher kills detached children, CIM blocked or too slow) | Medium | High | Phase 1 stops and reports before Phase 2; scope is the architect's call |
| PowerShell CIM census latency on `/health` trips the owner-lock probe budget (a new start hang) | Medium | High | Phase 1 measures; Phase 3 caches and coalesces; probe budget re-derived from measurements |
| Owner availability for captures and the manual pass | Medium | Medium | Phase 8 is off the critical path (9, 10 proceed); captures requested as soon as Phase 6 lands; one consolidated PR-gate pass |
| #1789 merges late or changes shape | Medium | Medium | Phase 9 is the only dependent; it waits, others proceed; re-audit on merge |
| A platform branch changes POSIX behavior | Low | High | Per-site POSIX argv/env/bytes assertions; explicit POSIX decision where a shared contract changes; full macOS/Linux suites every phase |
| Seam-forced unit tests pass but real Windows differs | High | Medium | Each phase has real-Windows checks; nothing is called done on unit tests alone |
| Phase 6 is large (many launch sites) | Medium | Medium | Resolvers are already built and tested in Phase 5; sites are mechanical uses of them, each with a per-site POSIX assertion |
| Spec-level risks (kill-on-close jobs, `taskkill` gaps, ConPTY timing, MSYS mangling, System32 bash, CIM policy, pipe access, worktree handles, MAX_PATH, `.cmd` shims, CRLF) | per spec | per spec | Mitigations are the phase deliverables above (4, 3, 8, 5/6, 5, 3, 2, 7, 10, 5/6, 5/10) |

## Documentation Updates

- `codev/DEPENDENCIES.md` and `codev-skeleton/DEPENDENCIES.md`, `README.md` (Phase 11).
- Release protocol: dispatch the Windows workflow before release (Phase 11).
- `codev/resources/arch.md` platform-layer entry; `lessons-learned.md` (Phase 11, review).
- Skills, only if their text changes, in all four copies (Phase 11).
- Review: hang root cause, audit facts, flaky tests, PR-gate pass results.
