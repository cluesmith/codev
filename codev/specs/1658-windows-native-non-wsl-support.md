# Specification: Native (non-WSL) Windows Support

## Problem Statement

Codev runs on macOS and Linux only. On Windows the one working path today is WSL 2. On native
Windows, `afx tower start` hangs in its readiness wait because the daemon fails during startup
(field-tested 2026-09-09), and nothing after that point (persistent builders, forge, runnable
worktrees) has ever been exercised.

WSL 2 already serves most Windows users. The segment it cannot serve is **machines where WSL 2
is administratively blocked**: locked-down corporate IT that disables the Virtual Machine
Platform, Hyper-V, or the WSL optional component. For those users Codev is unusable. Native
support exists to unlock that segment, so the solution has to work on a locked-down machine. That
rules out designs that need admin rights, Developer Mode, or permissive PowerShell execution
policy where we can avoid them.

The issue started as a tracking map with a go/no-go criterion. The owner has since ruled **go**,
with **full parity** as the end state (see Constraints).

## Current State

Codev assumes a POSIX host throughout. A codebase audit (2026-10-12) found roughly 145
POSIX-dependent sites in the runtime package, clustered in five areas. The counts are
approximate; they size the work rather than enumerate it.

1. **Shellper transport (blocking).** Persistent terminal sessions ("shellpers") talk to Tower
   over Unix domain sockets in `~/.codev/run/shellper-<uuid>.sock`. Four mechanisms depend on
   socket files existing on disk:
   - listen/connect;
   - the post-spawn "wait for socket file" poll;
   - stale-socket cleanup (`isSocket()` plus unlink);
   - the attach fallback scan.

   Owner-only access comes from `0700` directory and `0600` socket modes, which Windows ignores.
   On Windows a non-`\\.\pipe\` path cannot be listened on at all, so no shellper, which means no
   persistent builders.
2. **Process lifecycle and introspection (blocking).**
   - **Process-group kills.** About 9 sites tear down a process group with `process.kill(-pid)`,
     including `PtySession.kill` (which every dev PTY goes through), the orphan sweep,
     architect-session reaping, and `afx cleanup`. About 20 SIGTERM→SIGKILL escalations assume
     SIGTERM is catchable; on Windows it is a hard kill, so graceful-shutdown handlers (such as
     releasing the Tower owner lock) never run.
   - **`ps`/`pgrep`/`lsof` shellouts.** About 11 sites use them: orphan and husk sweeps, fleet
     RSS, Tower stop and start port-to-PID lookup, and doctor.
   - **PID-reuse guard.** Process start time (the guard used on every shellper reconnect) has
     only darwin and linux branches. On Windows it returns null, so **every reconnect after a
     Tower restart is treated as PID reuse and fails**. The "detached shellpers survive a Tower
     restart" guarantee is unproven on Windows.
3. **Launchers.** All 64 forge concept scripts (five providers: GitHub, GitLab, Gitea, Linear,
   Jira) are POSIX `#!/bin/sh`. The owner ruling's count of 56 predates the Jira provider. The scripts are fine; the
   **launch sites** are not. Five places assume a POSIX shell:
   - Forge concepts run through `exec`/`execSync` with the default shell, which on Windows is
     `cmd.exe` and cannot run a shebang script.
   - Every builder starts as `/bin/bash .builder-start.sh`, a hardcoded absolute path.
   - `worktree.postSpawn` hooks run with `shell: true`, which on Windows is `cmd.exe`.
   - `afx dev` runs `/bin/sh -lc <devCommand>`.
   - `afx shell` and the dashboard's "new shell" fall back to `$SHELL` or `/bin/bash`.
4. **node-pty / ConPTY.** node-pty supports Windows through ConPTY. The PTY base environment
   assumes POSIX variables (`HOME`, `SHELL`, a `/usr/bin` PATH) and lacks the Windows ones
   (`USERPROFILE`, `SystemRoot`, `COMSPEC`, `PATHEXT`). Commands such as `claude` and `afx` are
   `.cmd`/`.exe` shims on Windows, and spawning them without a shell does not search `PATHEXT`.
   The render gate (Spec 1313, #1573, #1664) classifies a byte stream whose echo, resize and
   exit timing under ConPTY has never been captured.
5. **POSIX residue (wide, shallow).**
   - `/tmp` hardcoding: 6 runtime sites and 565 occurrences across about 70 test files.
   - `HOME` without `USERPROFILE`, and `~` expansion via string replace.
   - About 30 `chmod`/mode sites, including the local auth key.
   - Path handling: `split('/')` and `+ '/'` scope markers (about 20 sites), and absolute-path
     checks via `startsWith('/')`.
   - About 50 `split('\n')` sites parsing command output that would carry CRLF.
   - Four `symlinkSync` sites for runnable worktrees, which need Developer Mode or admin rights
     on Windows.
   - `which`/`command -v` probes.
   - The worktree write guard's `/tmp` and `HOME` allowlist.

**CI** runs Ubuntu everywhere and macOS on the CLI e2e and post-release e2e matrices. No
workflow runs on Windows. **Docs** (`DEPENDENCIES.md`) say "use WSL2" with a one-line install
hint.

## Desired State

A Windows user on a machine where WSL 2 is blocked gets the same Codev behavior as a macOS or
Linux user, under two prerequisites: Git for Windows and jq.

- `afx tower start` comes up. Architect, builder and shell terminals open and are usable.
- Builders are **persistent**: shellpers survive a Tower stop and restart, and Tower reconnects
  to them.
- Forge concepts (all providers), porch, consult, `afx dev`, runnable worktrees and the VS Code
  extension work.
- The Tower-managed **Codev IDE server** (`afx ide`, #1789) works on native Windows. This covers
  discovery, version preflight, spawn, the `/ide/` forward, and sidebar extension install.
- Shell roles are split:
  - **PowerShell** is the interactive shell a human types into (shell terminals). Agent
    terminals run their harness directly, as on POSIX.
  - **Git Bash** is the only plumbing shell: forge concepts, the builder launch script,
    `postSpawn`, and `devCommand`.
- `codev doctor` on Windows checks the Windows prerequisites and explains anything missing.
- Docs present two supported Windows paths: **native + Git Bash** and **WSL 2**.
- An on-demand Windows CI workflow lets maintainers check Windows before a release, or whenever
  a change touches platform code.

The macOS and Linux paths behave exactly as before. Every Windows change is a platform branch
or an abstraction whose POSIX implementation is today's code.

## Success Criteria

Each criterion is verified on native Windows (Windows 10 22H2 or Windows 11, x64) with WSL
disabled, unless it says otherwise.

**Prerequisites and diagnosis**
- [ ] `codev doctor` on Windows reports three things:
  - Git for Windows: found, version, and resolved bash path.
  - jq: found, or not found with an install hint.
  - A warning for each user-authored `postSpawn`/`devCommand` script file that has CRLF line
    endings.

  It never reports System32 `bash.exe` (the WSL launcher) as Git Bash.
- [ ] Git Bash is resolved from the standard install locations, then `PATH`, then an explicit
  override. Codev never invokes bare `bash`. The resolved path is exported to spawned builders
  as `CLAUDE_CODE_GIT_BASH_PATH`; if the user already set that variable, Codev honors it as the
  override.
- [ ] Missing Git Bash or jq fails fast with an actionable message naming the prerequisite. It
  does not hang and does not fail with an obscure spawn error.

**Tower and terminals**
- [ ] The root cause of the 2026-09-09 `afx tower start` hang is identified and recorded in the
  review. `afx tower start` reaches ready, and `afx tower stop` stops it. Both work without
  `lsof`/`pgrep`.
- [ ] Terminal roles are distinct:
  - **Agent terminals** (architect, builder) run the configured harness command (`claude` by
    default) directly, as on POSIX, with `.cmd`/`.exe` shims resolved.
  - **Human shell terminals** (`afx shell`, the dashboard's "new shell", and any terminal that
    needs a host shell) open in PowerShell by default.

  Typing, resize, scrollback, and exit all behave correctly in the dashboard and the VS Code
  extension.
- [ ] `afx send` delivers onto a Windows architect or builder: it is held while the recipient is
  mid-turn or a human is typing, and delivered at an empty prompt. This rests on render-gate
  validation captures from real ConPTY sessions of each supported harness (at minimum claude and
  codex). Gate profiles are adjusted where those captures show different timing.

**Persistence and lifecycle (the load-bearing guarantee)**
- [ ] A spawned builder survives `afx tower stop` followed by `afx tower start`. Tower
  reconnects to the same shellper with output continuity (replay), and the builder's agent
  process is the same PID as before the restart.
- [ ] Reconnect still refuses to attach when the PID has been reused, and it does so on Windows
  too.
- [ ] Killing a builder, a dev PTY, or `afx cleanup` leaves **no descendant processes** of the
  killed session: the whole tree is gone, including `node`, `bash.exe` and harness children.
  This holds even when an intermediate process exited before teardown and its children were
  re-parented, and when the session root is already dead.
- [ ] `afx cleanup` actually removes the worktree directory on Windows despite transient open
  handles (antivirus, indexer, a just-killed process's cwd), or fails with a clear error naming
  the blocking path. Removal deletes junction/link entries without traversing into or deleting
  their targets.
- [ ] Orphaned and husk shellpers are detected and reaped on Windows, as on POSIX, including the
  process-age race guard the POSIX sweep uses.
- [ ] Other non-admin local users cannot **read session data from, or control,** a shellper. An
  unauthenticated connection receives zero bytes, and every frame it sends is ignored before the
  connection is dropped. OS-level non-connectability is not required (decision 7).

**Launchers and forge**
- [ ] Paths flow correctly in both directions across the Git Bash boundary: Windows paths passed
  into bash (`cwd`, arguments) and MSYS-form paths emitted by bash/git (`/c/Users/...`) parsed
  back into native paths before Node uses them.
- [ ] Every forge concept for every shipped provider runs on Windows through Git Bash (GitHub
  exercised live; others via the same launcher plus unit coverage). This includes concepts whose
  arguments are paths or slash-prefixed strings, which MSYS path conversion would otherwise
  mangle.
- [ ] `afx spawn` (worktree mode and the other spawn modes) launches the builder through Git
  Bash, and porch drives a SPIR/BUGFIX builder through at least one phase transition.
- [ ] `postSpawn` hooks and `afx dev` run through Git Bash with the worktree as cwd. `afx dev`
  teardown leaves no orphaned dev-server process.
- [ ] Runnable-worktree links work without Developer Mode, through a documented fallback for
  files and directories. When Developer Mode is on, real symlinks are used.
- [ ] A workspace at a typical depth (for example `C:\Users\<name>\src\<repo>`) supports builder
  worktrees and their dependency trees without the admin-only `LongPathsEnabled` setting. Doctor
  reports when the workspace root is deep enough to risk MAX_PATH overruns, and whether Git's
  per-user `core.longpaths` is set.

**Codev IDE server (#1789) on native Windows**
- [ ] `afx ide start` without `--server-path` finds `codev-ide-server` on `PATH`. On Windows that
  is an npm `.cmd` shim, resolved through `PATHEXT` by the same shared shim resolver as every
  other command (Area D).
- [ ] The version preflight reads line 1 of `codev-ide-server --version` as a bare
  `major.minor.patch` (the VS Code base) and compares it against the declared floor (1.128.0).
  It never compares the npm package version. A server below the floor is refused with a message
  naming the installed version and the floor.
- [ ] Tower spawns the server headless: the console window is hidden, under the same rule as
  every other background process.
- [ ] `/ide/?folder=<repo>` is served through Tower, with the folder given as a native Windows
  path.
- [ ] The embedded sidebar extension is installed with `--install-extension` into a Tower-owned
  Windows extensions directory, and the server is spawned with `--extensions-dir`. Both flags
  receive native Windows paths, including paths longer than 260 characters.
- [ ] `afx ide stop` tears down the whole process tree. No server or extension-host process
  survives.
- [ ] Nothing the IDE integration writes lands outside the user profile.

**Breadth**
- [ ] `consult` (all three reviewers, with non-blocking skip semantics intact), porch checks,
  `afx open`, and `afx attach` work on Windows.
- [ ] The local auth key and other owner-only files are protected on Windows by an equivalent of
  the POSIX `0600` modes, not silently left world-readable.
- [ ] On a supported Node version (≥ 20, x64), `npm install -g @cluesmith/codev` succeeds on
  Windows without a C/C++ toolchain. If a native dependency lacks a Windows prebuild for the
  user's Node version, install or first run fails with a message naming the supported Node
  versions. It never silently falls back to a source build.

**Non-regression and CI**
- [ ] The macOS and Linux unit, integration, CLI e2e and post-release e2e suites pass unchanged.
- [ ] A Windows CI workflow (`windows-latest`) runs the unit, CLI e2e, and post-release e2e
  suites **on demand only** (manual dispatch). It never runs automatically on PRs or pushes and
  is never a required check.
- [ ] Shellper connections on macOS/Linux are unchanged: the same Unix-socket endpoint, the same
  handshake, and no secret. The Windows-only per-session secret never applies on POSIX. Upgrade
  compatibility with sessions started by an older release is therefore a non-issue on POSIX,
  and there is no existing Windows install base to stay compatible with.
- [ ] The test suite no longer hardcodes `/tmp` or POSIX-only helpers in tests that are meant to
  run on Windows. Tests that are inherently POSIX-only are explicitly skipped on win32, with a
  reason. Test helpers that use `/tmp` *deliberately* to keep Unix-socket paths under the
  104-byte macOS `sun_path` limit keep doing so on POSIX. macOS's `os.tmpdir()` (`/var/folders/...`)
  is long enough to overflow that limit.

**Docs**
- [ ] The install docs present native Windows (Git for Windows + jq, plus Node ≥ 20, 22
  recommended) and WSL 2 as the two supported Windows paths, with the known limitations of each.
  The Linux/WSL docs state the `build-essential` + `python3` prerequisite (node-pty compiles from
  source on Linux), which is the issue's near-term docs follow-up.

## Constraints

**Owner rulings (2026-10-12, issue #1658 comments). These are fixed, equivalent to Baked
Decisions. Quoted in substance:**

1. **Protocol: SPIR. One SPIR, phased.** Not a parent spec with child lanes. The plan carries
   the phases from the map: audit → transport + lifecycle → forge/launcher routing → POSIX
   residue sweep → CI leg. Each phase has its own verification.
2. **Scope: full parity.** Native Windows must deliver the same guarantees as macOS/Linux:
   persistent builders, detached shellpers surviving a Tower restart, runnable worktrees, forge,
   consult, porch. A first cut with best-effort builders is not acceptable as the end state.
3. **Forge layer: Git Bash is a hard requirement on native Windows. No script rewrite.**
   PowerShell twins and a Node port of the concept scripts are off the table. The forge phase
   comes down to five things:
   - Resolve the Git Bash binary.
   - Route the launch sites through it.
   - Translate Windows paths to bash paths for `cwd` and script arguments.
   - Add `jq` and Git Bash to doctor.
   - Document both as prerequisites.
4. **Shell roles on Windows.** PowerShell is the default *interactive* shell for architect and
   shell terminals (`.codev/config.json`). Git Bash is the only *plumbing* shell: forge concepts,
   the builder launch script, `postSpawn`. No PowerShell twins of any script.
5. **Git Bash resolution.** Resolve the Git for Windows bash explicitly (standard install paths,
   then PATH, then an override setting). Never invoke bare `bash`: System32 `bash.exe` launches
   WSL. Spawn sets or honors Claude Code's `CLAUDE_CODE_GIT_BASH_PATH`, so builders and Codev
   agree on one binary.
6. **Prerequisites and docs.** Git for Windows and jq are hard Windows prerequisites, checked by
   `codev doctor`, including a CRLF warning for user-authored `postSpawn` scripts. WSL 2 stays a
   documented, supported alternative; docs present native + Git Bash and WSL 2 as two paths.
7. **Windows CI leg.** *(Superseded at the spec gate, 2026-10-21. See "Decisions at the spec
   gate" below: the workflow is on-demand only.)* Original text: add
   `windows-latest` to the unit, CLI e2e, and post-release e2e workflows. It starts as
   non-required during stabilization and is then promoted to a required check.

The ruling also named known items the spec must address:
- MSYS path translation on arguments, with a per-call opt-out.
- Signals don't cross the bash/native boundary, so Job Objects or `taskkill` are needed at the
  process-group kill sites.
- A symlink fallback for runnable worktrees when Developer Mode is off.
- ConPTY render-gate validation captures.

**Technical constraints**
- **POSIX behavior must not change.** Windows support enters through platform branches or
  abstractions whose POSIX implementation is today's code, byte for byte where practical.
- **The framework tree split applies.** Changes to shipped framework content (skeleton docs,
  `DEPENDENCIES.md`, config defaults written by `codev init`/`adopt`, skills) are mirrored in
  `codev/` and `codev-skeleton/`. Shipped skill edits touch all four copies (`.claude` and
  `.codex`, root and skeleton).
- **Mailbox invariant (Spec 1313).** All message delivery still goes through the mailbox and
  render gate, and Windows does not get a bypass. Lock order stays per-agent → per-terminal.
- **Server/client isolation (#1189).** codev-core and codev-sdk do not import each other. The
  sdk stays environment-agnostic, so any Windows logic lives server-side or in the sdk's
  `/node` adapter.
- **One global state DB and one Tower per machine.** Unchanged on Windows.
- **Locked-down-machine target.** No requirement may depend on these unless a documented
  fallback exists:
  - admin rights;
  - Developer Mode;
  - a PowerShell *script* execution policy;
  - WSL;
  - installing a compiler toolchain.
- **Node ≥ 20.** Native dependencies (node-pty, better-sqlite3) must install on Windows x64
  without a local build toolchain, or the docs must state the toolchain requirement.

## Assumptions

- node-pty ^1.1 and better-sqlite3 ^12 ship Windows x64 prebuilt binaries for the supported
  Node versions. This is verified in the audit phase. The supported Windows Node versions are
  defined as those with prebuilds; a compiler toolchain is never a prerequisite, because that
  contradicts the locked-down target.
- Node's `net` module supports Windows named pipes (`\\.\pipe\...`) for both server and client,
  and the shellper HELLO/WELCOME framing is transport-agnostic.
- Git for Windows ships `bash`, `sed`, `grep`, `head`, `tail`, `sort`, `date`, `curl` and `git`,
  which covers every external tool the forge scripts use except `jq` and the provider CLIs `gh`,
  `glab`, `tea` and Atlassian's `acli` (Jira). The provider CLIs are separate installs on every
  platform already.
- Windows 10 1809+ (ConPTY) is the floor. Windows 10 22H2 and Windows 11 x64 are the tested
  targets. x64 is the supported architecture. Windows on ARM64 is supported only if node-pty and
  better-sqlite3 ship win32-arm64 prebuilds, verified in the audit phase. Otherwise the docs
  state ARM64 is unsupported, because a source build needs a compiler toolchain.
- The VS Code extension already branches for Windows where it touches the OS (for example
  Explorer reveal). It needs only launcher fixes (`afx`/`.cmd` shims), not a redesign.
- GitHub-hosted `windows-latest` runners include Git for Windows, so the on-demand CI
  workflow exercises the same Git Bash path users have.
- Windows PowerShell 5.1 (`powershell.exe`) ships with every supported Windows version. Codev
  uses it as needed for OS integration that Node does not expose: the process census, the
  port-owner lookup, and relaunching Tower outside a kill-on-close job. These are inline
  commands (`-NoProfile -NonInteractive -Command`), never `.ps1` scripts, so script execution
  policy does not apply. They are not twins of forge scripts; ruling 4's Git-Bash-only rule
  governs *scripts*.
- Claude Code honors `CLAUDE_CODE_GIT_BASH_PATH` on Windows, so a builder's own Bash tool uses
  the same Git Bash Codev resolved.
- Windows' 260-character MAX_PATH limit can only be lifted machine-wide with admin rights
  (`LongPathsEnabled`), so the target machines are assumed to have it **off**. Node's own `fs`
  handles long paths internally. Git needs the per-user (no-admin) `core.longpaths=true`. Other
  tools in the chain (npm installs inside a worktree, some harness CLIs) may not cope, so worktree
  depth must stay within MAX_PATH by construction or be diagnosed.
- Ruling 4's "PowerShell is the default interactive shell for architect and shell terminals" is
  read as follows. The `.codev/config.json` *shell* role defaults to PowerShell on Windows. Agent
  terminals still run their configured harness command directly (`shell.architect: claude`), as
  they do on POSIX. A terminal that needs a host shell uses PowerShell. Confirmed at the spec gate
  (decision 4): the architect spawns builders with no user intervention.

**Dependencies on other work**
- **#1789 (Tower-managed Codev IDE server) merges first.** This project builds on its code
  (discovery, version handshake, extensions handover) and adds the Windows behavior. It does not
  re-implement any of it.
- **The Codev IDE server package**, published by the codev-ide lane:
  - Meta-package `@cluesmith/codev-ide`, with bin `codev-ide-server`.
  - Windows platform package `@cluesmith/codev-ide-server-win32-x64`.
  - Both ship in the first publish (1.0.0), are built against this spec's assumptions, and are
    versioned independently of `@cluesmith/codev`.
  - Tower compares the VS Code base on `--version` line 1 against the 1.128.0 floor, never the
    npm version.
- **Facts agreed with the codev-ide architect**, which this project relies on and does not
  re-derive:
  - On Windows, `codev-ide-server` on `PATH` is an npm `.cmd` shim.
  - Line 1 of `--version` stays a bare `major.minor.patch`.
  - The server runs headless.
  - It exits cleanly on process-tree teardown.
  - `--extensions-dir` and `--install-extension` accept native and long Windows paths.
  - It writes only under the user profile.

## Solution Approaches

The owner rulings already settle the forge-layer fork (Git Bash) and the shell roles. The open
design space is in the **transport**, **process lifecycle and introspection**, and **link
fallback**. Each has competing approaches below.

### Area A: Shellper transport

**A1: Platform endpoint abstraction over named pipes (recommended).**
- **Endpoint.** A shellper's endpoint becomes a platform-resolved value:
  - POSIX: the existing `.sock` path.
  - Windows: `\\.\pipe\codev-shellper-<uuid>`, namespaced by user so two users on one machine
    cannot collide.
- **Framing.** HELLO/WELCOME and all frames stay unchanged.
- **File-based operations.** Each gets a Windows equivalent:
  - "Wait for socket file" becomes "connect-probe until ready".
  - `isSocket()` checks become endpoint probes.
  - Stale cleanup is a no-op, because pipes vanish with their server.
  - Every place that derives identity from the endpoint string, such as parsing the session id
    out of the `shellper-<id>.sock` basename, reads it from a platform-neutral source instead.
  - The attach fallback scan enumerates `\\.\pipe\` or relies on the DB registry, which is
    already the primary mechanism.
- **Logs.** The per-session log moves to a real file path decoupled from the endpoint, since
  today it is derived by string-replacing `.sock`.
- **Access control.** The pipe must not be readable or connectable by other users. Two options:
  1. Restrict the pipe's DACL to the current user. This needs native interop, because Node does
     not expose pipe security attributes.
  2. Gate every connection on a per-session secret in HELLO. Tower generates the secret and
     passes it to the shellper through its environment or stdin, never on argv (argv is visible
     to other users through process queries). It is persisted in the user-private global DB for
     reconnects. The shellper sends nothing to an unauthenticated client.

  We recommend option 2. It needs no native code, and it also defends against an
  already-connected read-only client, because the server writes nothing before HELLO is
  verified. Name squatting is mitigated by unguessable UUID names and by the client verifying the
  WELCOME (session id and pid). Under the secret gate another user *can* open a handle to the
  pipe but gets nothing from it. **Decided at the spec gate: option 2, Windows only.** POSIX
  keeps its `0600` socket and today's handshake unchanged.
- **Pros:** smallest conceptual change; one framing; reuses the existing persistence model.
- **Cons:** each file-based assumption needs a platform branch.
- **Risk:** medium.

**A2: Loopback TCP with token auth on all platforms.**
- One transport everywhere.
- **Cons:** it changes the proven POSIX path (violating the non-regression constraint); uses
  ports; is reachable by every local user; and needs auth everywhere.
- **Risk:** high, for no POSIX benefit. Rejected.

**A3: Keep sessions in-process on Windows (no shellper).**
- **Cons:** violates full parity, because builders die with Tower. Rejected by ruling 2.

### Area B: Process lifecycle (tree teardown and detached survival)

**B1: Tree kill via `taskkill /T /F`, through the tree-kill package already in the dependency
tree, at every process-group kill site (recommended for teardown).**
- **Teardown.** A single "kill session tree" primitive replaces `process.kill(-pid, sig)`:
  - POSIX keeps group signals and SIGTERM→SIGKILL escalation.
  - Windows does a tree kill.
- **Graceful paths.** Where a graceful step matters, Windows uses an explicit protocol message
  instead of a signal, because SIGTERM is a hard kill there. Two examples:
  - shellper shutdown (an existing wire message);
  - Tower stop, through an HTTP shutdown request so the daemon can clean up. The owner lock
    already self-clears on a dead PID at the next start, so the hard-kill fallback degrades
    safely and needs no extra machinery.
- **Pros:** no native code.
- **Cons:** `taskkill /T` walks parent links, so a process whose parent already exited (a
  re-parented grandchild) can escape. If the root itself is already dead, `taskkill /T` fails
  outright and walks nothing.
- **Closing the gap.** Teardown takes a descendant snapshot from the census (pid/ppid/creation
  time) *before* killing. It then kills each recorded descendant explicitly, using creation time
  to avoid killing a reused PID. So "no descendants survive" does not rest on `taskkill`'s walk
  alone. The orphan/husk sweep is the backstop for anything spawned after the snapshot.
- **Risk:** medium.

**B2: Job Objects per session.**
- **Pros:** kernel-enforced, complete tree teardown, including re-parented descendants.
- **Cons:** needs native interop (a compiled addon or a prebuilt helper). That conflicts with
  the no-toolchain constraint and adds a binary that AppLocker may block on locked-down machines.
- **Risk:** high.

**Recommendation:** B1 plus a census snapshot. B2 is the fallback if CI proves leaks the snapshot
and sweep cannot catch.

**Detached survival.** Shellpers are spawned detached so they outlive Tower. On Windows, a
detached child still outlives its parent, **unless** Tower itself runs inside a job with
kill-on-close (some terminal hosts and IDEs do this). Then the shellpers die with it, because
Node cannot request job breakaway. The spec requires the following:
- **Survival is required, not best-effort**, on every documented launch path:
  - `afx tower start` from PowerShell / Windows Terminal;
  - from the VS Code extension;
  - from CI.
- **Measure first.** The audit phase determines which common launchers (Windows Terminal,
  PowerShell console, VS Code integrated terminal and extension host, SSH sessions, CI runners)
  actually place children in a kill-on-close job.
- **If Tower's launcher is a kill-on-close job**, `afx tower start` launches the daemon
  **outside the job** through the built-in PowerShell. A process created via CIM/WMI
  `Win32_Process.Create` is parented by the WMI service, not the caller, so it is not in the
  caller's job. No native code is needed. A warning alone is not parity.
- **If that relaunch is itself blocked by policy**, `afx tower start` refuses with an
  actionable error naming a supported launch path. It never starts a Tower whose builders would
  silently die with the launcher.

### Area C: Process introspection (census, start time, port owner)

POSIX uses `ps`/`pgrep`/`lsof`/`/proc`. Windows needs equivalents for four things: the process
census (pid, ppid, cmdline), process start time, the port-to-PID owner, and liveness.
`process.kill(pid, 0)` already works for liveness.

**C1: Make identity endpoint-based, and confine introspection to sweeps (recommended).**
- **Identity.** On Windows, the reconnect identity check is the authenticated WELCOME (session
  id and pid) over the pipe. The UUID-named, secret-gated endpoint *is* the identity proof, so
  reconnect does not need process start time. This is stronger than a start-time comparison.
- **Tower PID.** Tower stop and start learn Tower's PID from the owner lock and from the
  `/api/status` response, not from port-ownership lookups.
- **Sweeps.** The remaining census needs (orphan and husk sweeps, the teardown snapshot in Area
  B, fleet RSS, doctor) use a single Windows census provider. The provider must return **pid,
  ppid, command line, and creation time**. The POSIX husk sweep and the registered-PID set both
  *skip* any process whose start time cannot be read, so a provider without creation time makes
  the Windows sweep a silent no-op. CIM's `Win32_Process` supplies all four fields.
- **No degraded mode at parity.** The census provider is load-bearing for the "no descendants"
  and "orphans reaped" criteria. If it is unavailable (for example blocked by policy), that is a
  reported failure: doctor flags it, and Tower logs that sweeps are disabled. It is not a
  supported configuration.
- **Pros:** the load-bearing guarantee (reconnect) has no external-tool dependency.
- **Cons:** two identity mechanisms (start time on POSIX, handshake on Windows).
- **Risk:** low to medium.

**C2: Port the existing introspection one-for-one.**
- Every call keeps its current shape, with Windows command equivalents.
- **Cons:** reconnect and Tower stop would then depend on a PowerShell/CIM call or a bundled
  binary on the hot path.
- **Risk:** medium.

**The census provider (decided at the spec gate)** is the built-in Windows PowerShell: an
inline `powershell.exe -NoProfile -NonInteractive -Command` CIM query against `Win32_Process`
(pid, ppid, command line, creation time). The same mechanism serves port-owner lookup
(`Get-NetTCPConnection`). Inline commands are not governed by script execution policy. No
bundled binary and no new dependency.

Note that `wmic` is removed on current Windows 11, and Git Bash's MSYS `ps` cannot see native
command lines.

### Area D: Launchers, Git Bash, and path translation

Every plumbing launch site routes through one resolved Git Bash binary:
- forge concepts (sync and async);
- the builder launch script;
- `postSpawn`;
- `devCommand`;
- porch check commands that are shell strings.

**Resolution** follows ruling 5: install paths, then PATH, then override, with System32 excluded.

**Paths.**
- `cwd` is passed as a native Windows path; Git Bash accepts it.
- Arguments that embed Windows paths are converted to POSIX form where bash needs them.
- MSYS automatic argument conversion is disabled per call, through its opt-out environment
  variables, where arguments must pass through unmangled (for example slash-prefixed API paths
  or `/repos/...` strings given to `gh api`).

**Output paths.** Paths that bash or git print in MSYS form (`/c/...`) are converted back to
native form before Node consumes them. Otherwise Node reads `/c/...` as a drive-relative
`C:\c\...`.

**Executable shims.** ConPTY spawns through `CreateProcess`, which cannot execute a `.cmd`/`.bat`
file directly. The `.cmd`/`.exe` shims that commands like `claude` and `afx` become on
Windows are resolved through `PATHEXT` before spawn, both for PTY commands and for the VS Code
extension's `afx` calls. A Windows-aware `PATH`/`PATHEXT` executable lookup already exists in
the codebase (the consult-availability probe in `codev bootstrap-docs`). That lookup is the
starting point: it is promoted to a shared helper rather than written again.

**Considered and rejected:** running each launch site with `shell: <gitbash>` piecemeal, without
a shared resolver. That spreads the System32-WSL trap across every site.

### Area E: Runnable-worktree links without Developer Mode

**E1 (recommended).**
- **Directories:** use a junction (no privilege needed).
- **Files:** use a hard link when on the same volume, otherwise copy.
- Real symlinks are used when the probe shows they are allowed (Developer Mode or admin).
- A copy is reported in spawn output, because it does not track later edits to the source.
- Worktree removal deletes the link entries themselves and never recurses through a junction
  into its target.
- Worktree removal on Windows retries with backoff on EBUSY/EPERM from transient handles after
  the session tree is killed, and reports the blocking path if it still fails.

**E2: Require Developer Mode.**
- Violates the locked-down-machine target. Rejected.

### Area F: Interactive shell default

On Windows the default for `shell.shell`, and the dashboard and `afx shell` fallback, is
PowerShell: the built-in Windows PowerShell 5.1 (`powershell.exe`), with no auto-detection of
PowerShell 7. A user who prefers PowerShell 7 sets `shell.shell: "pwsh"` in
`.codev/config.json`. Architect and builder commands are unchanged (`claude`), apart from shim
resolution. The architect spawns builders with no human intervention, exactly as on POSIX.

**Console windows.** Every background process Codev starts on Windows (the Tower daemon,
shellpers, the IDE server, detached helpers) is spawned with its console window hidden. No
empty console window appears on the desktop, so closing one cannot kill Tower.

An existing `.codev/config.json` carrying `shell: "bash"` (today's scaffold default) is
interpreted on Windows as **Git Bash**, never as System32 `bash.exe`, so existing configs cannot
launch WSL.

## Open Questions

### Decisions at the spec gate (user feedback, 2026-10-21)

These were open questions in the reviewed draft. They are now settled.

1. **Windows CI:** create the Windows CI workflow, but run it **on demand only** (manual
   dispatch). It never runs automatically and is never a required check. This supersedes ruling
   7's non-required-then-required plan, so no promotion criterion is needed.
2. **Process census and other OS integration:** use the built-in Windows PowerShell as needed
   ("don't reinvent the wheel"). Inline CIM queries serve the census (with creation time),
   port-owner lookup, and relaunching outside a kill-on-close job. No bundled binary, no native
   addon.
3. **Kill-on-close job:** measure which launchers do this. Where one does, relaunch Tower outside
   the job through built-in PowerShell (CIM `Win32_Process.Create`). Refuse with an actionable
   error only if that relaunch is blocked (see Area B).
4. **Agent terminals:** the architect and builder terminals launch their harness directly, and
   the architect spawns builders with **no user intervention**, exactly as on POSIX. PowerShell
   is the default only for plain human shell terminals (the `shell` role). This resolves the
   ruling-4 reading.
5. **PowerShell version:** the built-in Windows PowerShell 5.1, everywhere. There is no
   PowerShell 7 dependency or auto-detection; users may opt in via `shell.shell: "pwsh"`.
6. **CPU architecture:** x64 is supported. ARM64 is supported only if the native dependencies
   ship win32-arm64 prebuilds; otherwise it is documented as unsupported.
7. **Pipe access control:** a per-session secret, **Windows only**. Other users can open the
   pipe but receive nothing and control nothing. No OS-level pipe ACL and no native code. POSIX
   connections are unchanged.
8. **Owner-only files:** rely on Windows user folders (`%USERPROFILE%`) being private to their
   owner by default. No explicit ACLs. This is documented in the install docs.
9. **Doctor scope:** doctor does **not** report Developer Mode or `core.autocrlf`. Link fallback
   is reported by `afx spawn` when it happens, shipped scripts are pinned to LF, and doctor keeps
   only ruling 6's CRLF warning for user-authored `postSpawn`/`devCommand` scripts. The long-path
   diagnosis in the success criteria stays.
10. **Console windows:** always hidden for background processes.
11. **Upgrade compatibility:** not required. POSIX shellper connections are unchanged (decision
    7 is Windows-only), and there are no existing Windows sessions to stay compatible with.
12. **Codev IDE server in scope on native Windows** (owner direction, 2026-10-21, relayed by the
    main architect from the codev-ide architect). Tower's IDE integration from #1789 (discovery,
    version preflight, spawn, `/ide/` forward, extension install) must work on native Windows.
    It is not a follow-up or an unsupported platform. The codev-ide lane ships
    `@cluesmith/codev-ide-server-win32-x64` in its first publish (1.0.0). #1789 merges first,
    and this project builds on its code (see "Dependencies on other work").

### Remaining

None blocking. The owner confirms the above at the spec-approval gate.

## Test Scenarios

**Functional (on Windows unless noted)**
1. A fresh native install (Git for Windows, jq, Node 22, `npm install -g @cluesmith/codev`)
   gives a `codev doctor` with all-green Windows prerequisites, and `codev init` creates a
   project.
2. Doctor with jq missing, and doctor with only System32 `bash.exe` present: each gives a clear
   failure naming the missing prerequisite. The WSL launcher is not accepted.
3. `afx tower start` reaches ready; the dashboard loads; the architect terminal runs the
   configured harness and accepts input; `afx shell` opens PowerShell; resize reflows; `afx tower stop` exits cleanly and
   releases the owner lock.
4. **Persistence:**
   - Spawn a builder.
   - Record the builder agent's PID.
   - Run `afx tower stop`, then `afx tower start`.
   - Expected: the builder terminal reconnects with replayed output, its PID is unchanged, and
     input still works.
5. **PID reuse:** make a registered shellper's PID belong to a different process, or put a stale
   DB row in place. Reconnect must refuse, and the row must be cleaned.
6. **Teardown:** kill a builder; `afx cleanup` a builder; stop `afx dev` on a dev server that
   spawns children. In each case, no descendant processes survive. Also: an intermediate
   process exits first (re-parenting its children), and the session root is already dead when
   teardown runs. No descendants survive in either case.
6a. **Worktree removal:** `afx cleanup` succeeds while a just-killed process briefly holds a
    handle in the worktree. A worktree containing junction links is removed without touching the
    junction targets.
6b. **Long paths:** a workspace under `C:\Users\<name>\src\<repo>` with `LongPathsEnabled` off
    spawns a builder whose worktree runs `npm install`.
7. **Orphan sweep:** an unregistered shellper (for example after a Tower crash) is detected and
   reaped at the next start.
8. **Forge:** run every GitHub concept live, including ones passing `/repos/...`-style arguments.
   Run GitLab/Gitea/Linear/Jira concepts through the same launcher in unit tests with stubbed CLIs.
9. **Spawn → porch:** a BUGFIX builder spawned on Windows runs `porch next`/`porch done` through
   a phase transition and opens a PR via the forge.
10. **postSpawn** with a multi-command bash hook; also with a CRLF hook file, where doctor warns
    and the hook either still runs or fails with a clear message.
11. **Runnable worktree:**
    - Developer Mode off: a directory link becomes a junction and a file link becomes a hard
      link or copy (reported).
    - Developer Mode on: real symlinks.
12. **`afx send`:**
    - to a busy Windows builder: held;
    - at an idle prompt: delivered;
    - while a human is typing in the composer: held.
13. **Consult:** a 3-way consult runs from a Windows builder; an unauthenticated agy skips
    without blocking.
14. **Access control:** a second local non-admin user who opens a shellper pipe receives zero
    bytes, and frames it sends have no effect.
15. **VS Code extension:** start Tower, spawn a builder, open its terminal, and reveal a file,
    all on Windows.
15a. **Codev IDE server:**
    - `afx ide start` on Windows finds the `codev-ide-server` `.cmd` shim, passes the version
      floor, and serves `/ide/?folder=<repo>` through Tower.
    - It installs the sidebar extension into a Windows extensions directory.
    - `afx ide stop` leaves no server or extension-host process.
    - Negative case: a server whose `--version` line 1 is below 1.128.0 is refused with the
      versioned message.
15b. **Joint check with the codev-ide lane:** the codev-ide architect brings the win32-x64
     package from its CI run, and the owner's Windows machine is the test machine. The plan
     decides whether this runs at dev-approval or at verify. Scenario 15a is executed
     end-to-end there.

**Non-functional**
16. The macOS and Linux suites pass unchanged, so there is no POSIX regression.
17. The on-demand Windows CI workflow runs green from a manual dispatch. A Windows-only flaky
    test is annotated, not silently retried.
18. Render-gate captures: ConPTY capture fixtures for each validated harness are checked in and
    replayed by unit tests, the same way existing gate captures are.

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Shellpers die with Tower when Tower runs inside a kill-on-close job (terminal host or IDE) | Medium | High (breaks the persistence guarantee) | Measure the launchers; relaunch Tower outside the job via built-in PowerShell CIM; refuse only if that is blocked; never a silent warning |
| `taskkill /T` misses re-parented descendants, or walks nothing when the root is already dead | Medium | Medium | Pre-kill census snapshot with explicit per-PID kills; orphan/husk sweep as backstop; teardown tests assert no survivors; Job Objects as fallback (Area B2) |
| ConPTY timing differs from POSIX PTYs, so the render gate misclassifies (lost or force-held mail) | High | High | Assume nothing (#1567 lesson): capture real ConPTY sessions per harness, replay them as fixtures, adjust gate profiles from the data |
| MSYS path conversion mangles forge arguments | High | Medium | Per-call opt-out of automatic conversion; explicit translation helper; concept-by-concept tests with slash-prefixed arguments |
| System32 `bash.exe` invoked by accident, launching WSL or failing on WSL-blocked machines | Medium | High | Single resolver; never bare `bash`; doctor rejects System32; config `shell: bash` maps to Git Bash on Windows |
| Locked-down policy (AppLocker, Constrained Language Mode) blocks the inline PowerShell CIM queries | Medium | Medium | Keep introspection off the reconnect hot path (C1); a blocked census is a reported failure (doctor + Tower log), not a silent degrade |
| Pipe readable or connectable by other local users | Low | High | Per-session HELLO secret, kept off argv; server sends nothing pre-auth; UUID pipe names; client verifies WELCOME |
| Native deps lack Windows prebuilds for a Node version | Low | Medium | Verify in the audit phase; supported Node versions are defined as those with prebuilds; clear failure otherwise (no toolchain fallback); CI leg catches regressions |
| Worktree removal fails on open handles (antivirus, indexer, lingering cwd) | High | Medium | Kill the session tree first; retry with backoff; report the blocking path; never recurse through junctions |
| MAX_PATH overruns in nested `.builders/<id>/` plus dependency trees (raising the limit needs admin) | Medium | High | Doctor depth check and `core.longpaths` check; docs recommend a short workspace root; keep Codev-generated paths short |
| `.cmd` shims cannot be spawned directly under ConPTY | High | High | Resolve shims through `PATHEXT` and launch them through `%COMSPEC% /c` or the underlying Node entry point |
| On-demand-only Windows CI means a Windows regression can merge unnoticed until someone dispatches the workflow | High | Medium | Dispatch before every release and on any PR touching platform code (documented in the release protocol and the PR checklist); flaky tests annotated per protocol |
| A platform branch changes POSIX behavior | Low | High | POSIX implementations stay today's code; full macOS/Linux suites gate every phase |
| CRLF line endings (Git `autocrlf`) break bash scripts or output parsing | Medium | Medium | `.gitattributes` `eol=lf` for shipped `.sh` scripts; CRLF-tolerant output parsing; doctor CRLF warning for user scripts |

## References

- Issue #1658, including the owner rulings of 2026-10-12 (two comments)
- Spec 1313 (mailbox-first `afx send`, render gate); #1365 (submit lock); #1473 (input settle);
  #1567 (assume nothing about terminal timing); #1573, #1664 (gate profiles, composer-region
  stability)
- #1645 (forge scripts are POSIX-clean, pipefail note); #1189 (server/client isolation)
- `codev/DEPENDENCIES.md` (current "use WSL2" guidance)
- `codev/resources/lessons-learned.md` [From 0005]: prefer Node built-ins over shell commands for
  cross-platform safety
- Claude Code on Windows: Git Bash for its Bash tool, honoring `CLAUDE_CODE_GIT_BASH_PATH`
