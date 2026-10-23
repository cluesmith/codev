# Review: Native (non-WSL) Windows Support

**Spec**: [codev/specs/1658-windows-native-non-wsl-support.md](../specs/1658-windows-native-non-wsl-support.md)
**Plan**: [codev/plans/1658-windows-native-non-wsl-support.md](../plans/1658-windows-native-non-wsl-support.md)

> In progress. This document is started early, during Phase 1, so owner rulings are recorded
> when they are made. It is completed in the review phase.

## Root cause of the 2026-09-09 `afx tower start` hang

**Owner ruling (2026-10-21T07:41:34Z, relayed by main): criterion discharged as not reproducible.
No further hunt.**

Evidence, from `codev/projects/1658-windows-native-non-wsl-support/audit.md` §1.6:

- The hang does not reproduce on **3.3.3**, the release current on 2026-09-09 (published 09-05;
  3.3.4 followed on 09-17), or on the current **3.3.5**. Both were installed globally from npm and
  reach ready in about 3 s. Covered: GitHub's `windows-latest` (x64) and `windows-11-arm` (ARM64),
  Node 22 and 24; and the owner's Windows 11 Home machine (3.3.5, Node 24). Runs 39556358109,
  39560462785 and 39562480678.
- The leading mechanism was **ruled out by direct test**. It was a Tower left alive by a broken
  `afx tower stop`, which then blocks the next start on the same port. The sequence start →
  `tower stop` → start again does not hang: the second start detects the live Tower over HTTP
  and exits 0.
- On Node 20, neither release can be installed on Windows (no better-sqlite3 prebuild), so a
  Node 20 attempt fails at install, not at start.
- The only untested candidate is the state of the 2026-09-09 machine itself, which is not
  available.

A real defect turned up along the way: **`afx tower stop` cannot stop Tower on Windows.** Its
`lsof` port lookup fails under `cmd.exe`, so it prints "Tower is not running" and exits 0 with the
daemon still alive. Phase 4 fixes this.

## Session-tree teardown on Windows: what leaks and why it is bounded (Phase 3)

Measured on Windows CI (targeted runs 39572306380 through 39574693242), with real process trees:

- **Node children die with their Node parent.** libuv places every non-detached child that a
  Node process spawns in a kill-on-close job. When a Node root is killed, its Node-spawned
  descendants are already gone before teardown looks for them (the dead-root test).
- **A Git Bash `&` does not orphan.** MSYS keeps the background job's Windows parent alive, so
  the descendant stays linked to the session and the pre-kill census snapshot reaches it.
- **`detached: true` escapes on both platforms.** It calls `setsid` on POSIX and breaks away from
  the job on Windows. That matches POSIX, so it is not a gap.

So the leak is limited to descendants orphaned by **non-Node launchers**. The proven case is
`cmd /c start "" /b <program>`: cmd exits at once, the program keeps a dead parent pid, and
neither the snapshot nor `taskkill /T` can link it back to the session. The orphan and husk
sweeps reap only shellpers, so they cannot catch it either. That is the spec's B2 trigger.
**Architect ruling (2026-10-21T09:20Z): Option C.** Phase 3 ships with the re-parented test
pinned as a known gap (`it.fails`), and Phase 3b adds a per-session Job Object created through
inline PowerShell.

Two fixes the Windows runs forced along the way:
- Teardown reads the census fresh. The 2 s TTL cache had missed children started a moment
  earlier, and still showed processes that had just been killed.
- ConPTY's `conhost.exe --headless` stays a child of the shellper after the PTY's program exits,
  so the husk predicate no longer counts the console host as a child.

## Windows limitations (collected for the docs, Phase 11)

- Doctor's Tower Environment check is not available on Windows: CIM cannot read another
  process's environment (Phase 3).
- The process census, and so teardown snapshots and the sweeps, need `powershell.exe` with CIM
  access. If it is blocked, doctor reports it and Tower logs it; that is not a supported
  configuration (Phase 3).
- Per-session Job Objects need Windows 8+ for nested jobs, and Full Language Mode to bind the
  Win32 calls; otherwise their absence is reported (Phase 3b).
- A Node `detached: true` child ends with its session on Windows. Measured (runs 39581676362 and
  39582608788): libuv never requests job breakaway, so the session job keeps it, and there is
  no setsid parity. In-tree inventory of detached spawns (architect check, 2026-10-21, so it
  need not be redone): the shellper spawn in `session-manager.ts` runs from Tower, not from a
  session; `ide-server.ts` is spawned by Tower and follows Tower; porch `index.ts` and
  `checks.ts` use `detached` only to group-kill porch's own children, which must not outlive the
  session, so the job is an improvement there; `utils/shell.ts` was deleted in Phase 3. The one
  real casualty is the Tower daemon start in `tower.ts` (a Tower started from inside a session),
  which Phase 4 handles.
- A process created through CIM `Win32_Process.Create` from inside a session escapes the
  session job (measured, `JOB-CIM`): the WMI provider host creates it. Phase 4's daemon start
  relies on this.
- A session job is found by name only while its shellper is alive. A job's name lives as long
  as some handle to it is open, and the shellper holds the only long-lived one (duplicated in
  by the helper, so a helper exit or a Tower restart does not lose it). If the shellper itself
  dies and leaves descendants, terminate-by-name finds nothing, and those orphans fall back to
  the Phase 3 snapshot kill and the orphan and husk sweeps. The Phase 3b acceptance "a
  `cmd start /b` orphan does not survive `killSession`" is the shellper-alive case.
- A shellper whose Tower died between spawning it and connecting is not in a job if a
  restarted Tower reconnects within the 30 s PTY-less deadline: the reconnect HELLO spawns
  the PTY, and no assign is made on reconnect. Its teardown falls back to the snapshot path.

## Tower lifecycle on Windows (Phase 4)

- `afx tower stop` asks Tower to shut down over HTTP (`POST /api/shutdown`: keyed, not
  tunnel-borne, and from this machine, meaning loopback or one of its own interface addresses
  for a bridge-mode Tower), because a Windows signal is a hard kill that skips the shutdown path (the owner
  lock would stay behind). If Tower does not answer or does not exit within 8 s, the listening
  pid alone is killed. **Deviation from the plan text:** the plan named `killSessionTree` as the
  fallback, but shellpers are Tower's children by ppid, so a tree kill (`taskkill /T`) would end
  every session; sessions survive a Tower stop by design. Only the force flag kills trees.
- Tower started from inside a codev session (the shellper sets `CODEV_SHELLPER_SESSION` in its
  PTY's environment on Windows) is created through CIM `Win32_Process.Create`, with the
  sanitized environment minus the marker and the same cwd. Measured: it survives the launching
  session's teardown together with a shellper it spawned, and runs in the same Windows logon
  session as the launcher (`TOWER-CIM-SESSION 2,2`), so session-local job names still resolve.
- `IsProcessInJob` is not used as a cross-check: without a handle to the session's own job it
  cannot tell a codev job from the runner's, libuv's or a terminal's, so the env marker is the
  only signal (code comment in `tower-start-windows.ts`).
- `Win32_ProcessStartup.EnvironmentVariables` take precedence over, but are merged with, the
  user's and the system's environment. A CIM-created Tower can therefore carry variables from
  the user/system environment that the launcher had unset. The marker and the Claude session
  markers are not in those scopes, so the checks that matter hold. A user-scope `CODEV_*`
  variable (for example `CODEV_TOWER_PORT`) reaches a CIM-created Tower as it reaches any
  process, so there is no behaviour difference there.
- `POST /api/shutdown` is accepted only keyed, from loopback, and not tunnel-borne. The tunnel
  client runs inside Tower and forwards cloud requests over loopback with the real key, so the
  first two alone let a cloud-side actor stop Tower (found by the architect in review). The
  route refuses the tunnel proxy marker, and the proxy blocks the path too. It is registered on
  every platform: the conditions are the same everywhere.
- `afx tower start` probes readiness on loopback, so with `BRIDGE_MODE=1` and a specific
  non-loopback `BRIDGE_TOWER_HOST` it reports a readiness timeout although the daemon is up.
  This holds on every platform and predates this spec; `tower stop` handles that Tower
  gracefully (Phase 4 iteration 2). Worth its own issue.
- Follow-up (not needed by the Phase 4 criteria): a Tower that is alive but neither answers HTTP
  nor holds its port is reported "not running" by `tower stop`, because the owner lock's pid
  alone is not trusted (pid reuse). A census-verified lock pid (`tower-server.js` in the command
  line and a matching creation time) would cover it.
- Owner-machine launcher checks (Windows Terminal, PowerShell console, VS Code terminal,
  extension host) are part of the PR-gate manual pass.

## ConPTY render-gate validation (Phase 8)

**Plan deviation (architect ruling, 2026-10-22, reported to the owner for override).** The plan
made this phase wait on captures the owner records on a Windows machine, and continue with
Phases 9 and 10 meanwhile; strict porch cannot advance past a phase that is not done, so the two
could not both hold. The phase closed on the harness: a recorder
(`scripts/spec-1658-conpty-capture.mts`) and a replay of each capture through the production
`deliverAgentMail` on the capture's own clock (`__tests__/helpers/conpty-replay.ts`). The Windows
ConPTY fixtures are a PR-gate deliverable, landing in a follow-up commit on this branch. Until
they do, the replay suite skips with a reason naming the empty fixture directory (unit-tested),
rather than passing over nothing.

**Proven on macOS** with real claude 2.1.306 under a POSIX PTY: idle delivered at once, a typed
draft held `user-text` on every pass, mid-turn with an empty composer delivered after one 250 ms
composer sample, resize delivered at the new size. The ConPTY question the fixtures answer is
whether ConPTY's re-rendering keeps the composer region's fingerprint stable while an agent
streams; if it does not, mid-turn mail holds for the length of a turn.

**"Busy" means a human at the line.** Spec scenario 12 and the phase criteria originally said a
busy or mid-turn builder holds mail. Since #1664 only a human at the line holds; an agent mid-turn
with an empty composer is delivered and queues the message. The spec and plan text were amended
to say so.

**Codex captures are blocked on #1858.** codex-cli 0.162.1 renders its status line as
`GPT-6.1-Sol default · <cwd>`; the gate's region-end pattern matches only lowercase `gpt` /
`high:`, so every codex composer classifies `no-region-end` and all mail to a codex agent holds,
on every platform. Found by the recorder's dry run; filed separately as #1858, not fixed here.
codex fixtures may be absent at the PR gate; claude fixtures are required.

**Recorder safety.** codex 0.162.1 opens with an update offer whose first option runs an
installer. The recorder accepts only the folder-trust dialog, confirms only a yes/trust option
and never one naming update/install, and dismisses the update offer with its own Esc.

**Carry-forwards.** The spec's capture criterion names "at minimum claude and codex", so #1858
gates that spec criterion, not only codex convenience; verify must not drop it quietly. The
pre-existing `*.txt` gate fixtures carry no `binary` attribute, so a Windows checkout with
`core.autocrlf=true` would rewrite their raw PTY bytes (CI runners default to false and would not
notice): a `.gitattributes` rule for that directory belongs with the Phase 10 residue sweep. The
recorder runs the agent with the production agent env (`sanitizeAgentEnv`), so it should be run
from the same kind of console Tower is started from.

**Also in this phase:** `detectHarnessFromCommand` reads a Windows backslash or quoted path by
its basename (a directory named `claude` no longer decides the harness), and the #1664 delivery
harness launches through `ptyCommand`, so it runs on Windows for live scenario 12.

## Codev IDE server on native Windows (Phase 9)

**Built in two halves (architect ruling, 2026-10-22).** #1789's PR (#1806) was still open when the
phase began. The first half built on what main had: spawn, stop, readiness, the forward, and a
stub server behind `.cmd` shims. After #1806 merged, the second half built on #1789's own code:
discovery, the version floor, the sidebar install. The phase stayed open in porch until both
were in.

**Every server subprocess goes through one resolver.** `ideServerSpawnable` decides how the
spawn, `--version` and `--install-extension` run on Windows. A JS launcher, which is what package
discovery finds, runs under Tower's Node. Anything else, a `.cmd` shim included, goes through the
shared shim resolver, with no console window. Discovery uses the shared executable resolver
(`PATHEXT`), and npm runs through the shim resolver. POSIX is unchanged throughout.

**Windows defects found by running the real thing, not by the unit tests:**
- `buildIdeServerEnv` wrote `PATH` next to Windows' inherited `Path` key. The child would have
  seen one of the two, so the server could lose the user's `PATH`. It now reuses the inherited key.
- Server CLI commands ran detached. A detached `cmd.exe` has no console, so a plain `.cmd` shim's
  `--version` output reached no pipe. They are no longer detached on Windows, and a timeout kills
  the tree, since Windows has no process groups.
- `scripts/build-ide-extension.mjs` spawned bare `pnpm`, which fails with ENOENT on Windows. Every
  Windows build broke after #1789. It now runs pnpm's own entry (`npm_execpath`) under Node.
- With the server down, an `/ide/` request's respawn check ran the synchronous PowerShell port
  query and stalled Tower's event loop for seconds, every terminal included. The async liveness
  checks now use a loopback connect on Windows. Adoption, stop and status read the port owners
  with an asynchronous query. The forward test file went from ~5 s with a timeout to 58 ms.

**Stop and failed starts never lose a process.** Stop kills process trees. The recorded pid counts
as a root only when a live listener descends from it, so a reused pid is never killed. If anything
survives, the record is kept and the stop fails, naming the survivors, so it can be retried. A
server that never starts listening has its tree killed before the start fails, because no record
exists to stop it later. (CMAP iter 1, codex.)

**Test coverage trade.** #1789's unit suites drive `#!/bin/sh` stub servers and assert POSIX
modes and separators, so those tests are POSIX-only. The Windows behavior they stand for is
covered on a real Windows host by `ide-server-stub.windows.test.ts`: discovery without
`--server-path`, floor accept and refusal, sidebar install with native paths over 260 characters,
spawn, forward, stop and a never-ready server for both shim shapes. The adopt/restart-required
and serialization logic is not re-run on Windows. It is platform-neutral apart from spawning.

**Carry-forwards.** The POSIX start path also leaves a never-ready server running untracked. That
is the same defect class, outside this phase's Windows scope, raised with the architect. The joint
check with the real `@cluesmith/codev-ide-server-win32-x64` package (scenario 15b) runs at verify,
or earlier as an optional dry run.

**#1595 lifecycle reporter (checked here, no change).** The hook posts and is silent under Git
Bash, from a path with a space. A deleted script still exits 0 silently. When Claude Code finds no
Git Bash it falls back to PowerShell, where the bash-syntax hook fails to parse: fail-open, and
the reporter is inert. Architect ruling: no Windows work in 1658, since Git Bash is a hard
prerequisite. A PowerShell-safe hook form is a filing candidate for the owner.

## Flaky Tests

- **Unidentified intermittent failure under `porch done` (Phase 1, 2026-10-21).** The porch
  `tests` check failed twice (51 s, against ~38-40 s for passing runs) and passed on the next
  attempt. Six direct runs passed: `npm test` from the root, `vitest run` in the package, porch's
  `PROJECT_ID`/`PROJECT_TITLE` env set, and a script reproducing porch's detached-process-group
  spawn. Porch prints only a failed check's **stderr**, which held the harmless expected output of
  the `bugfix-1455` pr-create tests. The failing test's name was in stdout, which porch does not
  show. Next time, read `packages/codev/node_modules/.vite/vitest/<hash>/results.json` right after
  the failed check: it records per-file pass/fail. Porch hiding a failed check's stdout is worth a
  separate issue.
