# Review: Native (non-WSL) Windows Support

**Spec**: [codev/specs/1658-windows-native-non-wsl-support.md](../specs/1658-windows-native-non-wsl-support.md)
**Plan**: [codev/plans/1658-windows-native-non-wsl-support.md](../plans/1658-windows-native-non-wsl-support.md)

## Summary

Codev now runs on native Windows 10/11 (x64, ARM64 where prebuilds exist) without WSL, at parity
with macOS and Linux: shellper sessions over named pipes with a per-session secret, census-based
session-tree teardown plus a per-session Job Object, a Tower lifecycle that survives restarts,
Git Bash as the only plumbing shell, Windows-safe worktree links and removal, the Codev IDE server,
a POSIX residue sweep with a native-dependency install guard, and a dispatch-only Windows CI leg.
Twelve phases (1-11 plus 3b), 218 commits. The full Windows suite runs green on Node 22 and 24
(codev 7522 passed / 156 skipped, run 39921687151), and POSIX is unchanged (7570 passed / 108
skipped). Two items remain owner-side before the PR gate: the claude ConPTY fixtures and the
manual pass on the owner's Windows machine (see "Open at the PR gate" below).

## Spec Compliance

Verified on GitHub `windows-latest` unless noted. "Owner pass" means the PR-gate manual pass on
the owner's Windows machine, which CI cannot cover.

**Prerequisites and diagnosis**
- [x] `codev doctor` reports Git for Windows (version, bash path), jq (or install hint), and a CRLF
  warning per user `postSpawn`/`devCommand` script; System32 `bash.exe` is never reported as Git
  Bash (Phase 5).
- [x] Git Bash resolution: valid override wins, then standard install locations, then `PATH`;
  System32/Sysnative/SysWOW64/WindowsApps always rejected; a bad override fails loudly; never bare
  `bash`; `CLAUDE_CODE_GIT_BASH_PATH` exported to builders (Phases 5, 6).
- [x] Missing Git Bash or jq fails fast with a message naming the prerequisite (Phases 5, 6).

**Tower and terminals**
- [x] Hang root cause: discharged by owner ruling as not reproducible (Phase 1; see the appendix).
  `afx tower start` reaches ready and `afx tower stop` stops it without `lsof`/`pgrep` (Phase 4).
- [x] Agent terminals run the harness directly with `.cmd`/`.exe` resolved; human shell terminals
  default to PowerShell (Phase 6). Typing, resize, scrollback and exit in the dashboard and the VS
  Code extension: CI-covered at the PTY level; interactive check is in the owner pass.
- [ ] `afx send` onto a Windows agent from real ConPTY captures: the harness and replay are built
  and proven on macOS (Phase 8). **Not yet met:** claude Windows fixtures are a PR-gate
  deliverable; codex captures are blocked on #1858 (codex status-line drift, every platform).

**Persistence and lifecycle**
- [x] A builder survives `afx tower stop` + `afx tower start` with replay and the same agent PID
  (Phases 2, 4).
- [x] Reconnect refuses a reused PID on Windows: identity is the WELCOME's session id + shellper
  pid against the stored row, since Windows has no start-time check (Phase 2).
- [x] Killing a builder, a dev PTY or `afx cleanup` leaves no descendants, including re-parented
  and dead-root cases (Phases 3, 3b, 6). Limit: a session whose shellper itself died falls back to
  the snapshot path (documented in the appendix).
- [x] `afx cleanup` removes the worktree despite transient handles, or fails naming the path;
  junctions and links are unlinked without traversal (Phase 7).
- [x] Orphan and husk shellpers are reaped on Windows with the process-age race guard (Phase 3).
- [x] Other local users cannot read or control a shellper: unauthenticated connections get zero
  bytes and are dropped; a second non-admin user also gets EPERM from the default pipe DACL
  (Phase 2, scenario 14).

**Launchers and forge**
- [x] Paths translate both ways across the Git Bash boundary (Phase 5, `msys-path.ts`; Phase 6).
- [x] Every forge concept runs through Git Bash; GitHub live on CI, others via the same launcher
  plus unit coverage; jira preset fixed for native `jq.exe` (Phases 6, 10). All GitHub concepts
  live from the owner's machine is in the owner pass.
- [x] `afx spawn` launches through Git Bash and porch drives a phase transition (Phase 6).
- [x] `postSpawn` and `afx dev` run through Git Bash with the worktree cwd; `afx dev` teardown
  leaves no orphan (Phase 6).
- [x] Runnable-worktree links without Developer Mode (junction / hard link / copy), real symlinks
  when allowed (Phase 7). Developer-Mode-on is in the owner pass.
- [x] Typical-depth workspaces work without `LongPathsEnabled`; doctor reports depth risk and
  `core.longpaths` (Phase 10).

**Codev IDE server**
- [x] Discovery via `PATH`/`PATHEXT` through the shared shim resolver (Phase 9).
- [x] Version preflight reads line 1 as `major.minor.patch` against the 1.128.0 floor and refuses
  below it with both versions named (Phase 9).
- [x] Headless spawn, console hidden (Phase 9).
- [x] `/ide/?folder=<native path>` served through Tower, including paths over 260 characters
  (Phase 9).
- [x] Sidebar extension installed with `--install-extension` / `--extensions-dir` into a
  Tower-owned directory with native paths over 260 characters (Phase 9).
- [x] `afx ide stop` tears down the whole tree (Phase 9).
- [x] Nothing written outside the user profile (Phase 9). The joint check with the real
  `codev-ide-server-win32-x64` package (scenario 15b) runs at verify.

**Breadth**
- [x] `consult`, porch checks, `afx open` and `afx attach` work on Windows (Phases 6, 10). A 3-way
  consult from a Windows builder is in the owner pass.
- [x] Owner-only files: protected by user-profile privacy, per the spec-gate decision (no extra
  ACL work; Phase 10 doctor reports a relocated state dir).
- [x] Install on a supported Node needs no toolchain; an unsupported Node is refused by
  `preinstall` naming the supported versions, before node-gyp runs (Phase 10). Global install
  with no toolchain on the owner's machine is in the owner pass.

**Non-regression and CI**
- [x] macOS/Linux unit, integration, CLI e2e and post-release e2e unchanged (every phase; POSIX
  goldens pin the shellper HELLO/WELCOME/argv).
- [x] Dispatch-only `windows.yml` runs unit, CLI e2e and post-release e2e; never on PRs or pushes,
  never required (Phases 1, 11).
- [x] POSIX shellper endpoint, handshake and no-secret path unchanged (Phase 2).
- [x] No hardcoded `/tmp` in Windows-meant tests; POSIX-only tests skip on win32 naming the
  assumption; `sun_path`-motivated `/tmp` kept on POSIX (Phase 10, checked by
  `scripts/spec-1658-tmp-residue-check.mjs`).

**Docs**
- [x] DEPENDENCIES.md (both trees) presents native Windows and WSL 2 with limitations; Linux/WSL
  `build-essential` + `python3` stated (Phase 11).

### Open at the PR gate

1. Claude ConPTY fixtures committed to `packages/codev/src/agent-farm/__tests__/fixtures/gate/conpty/`
   (recorded on a Windows machine with `scripts/spec-1658-conpty-capture.mts`). The directory does
   not exist yet; the replay suite skips with a reason until it does. Codex fixtures may wait on
   #1858.
2. The PR-gate manual pass on the owner's Windows machine (plan section "PR-gate manual pass");
   results are recorded here when run.

### Known gap: codex agents and the render gate (#1858)

codex-cli 0.162.1 renders its status line as `GPT-6.1-Sol default · <cwd>`, and the gate's
composer region-end pattern matches only lowercase `gpt` / `high:`. Every codex composer
classifies `no-region-end`, so **all `afx send` mail to a codex agent holds, on every platform**,
Windows included. This is not a Windows defect and is not fixed here (filed as #1858). Until it
is fixed and codex ConPTY captures are recorded, the spec's "at minimum claude and codex"
validation is met for claude only. Whether that ships as a recorded scope amendment or waits on
#1858 is the owner's decision, pending at the time of writing.

### Known gap: bare user-tool spawns find a program in the cwd first (Windows release blocker)

**Architect ruling (2026-10-23): a Windows release blocker, not a follow-up nicety.** Native
Windows support must not be announced until this is fixed. On Windows, a spawn by bare name
(libuv for Node spawns, cmd.exe for `execSync` strings) looks in the current directory before
`PATH`. Many codev spawns run with a worktree or a cloned repo as cwd, so a `git.exe`, `gh.exe`,
`npm.cmd` or `node.exe` committed to that repo would run under codev. This PR fixes the system
programs: `powershell.exe`, `taskkill` and `cmd.exe` now go by full System32 path through
`windowsSystem32Path` / `windowsPowerShellPath`. The user tools are not fixed. The fix routes
each site through `spawnOnHost` / `spawnSyncOnHost` / `findOnHostPath` (`lib/shell-launch.ts`):
the `codev-sdk/node/executable` resolver searches `PATH` and never the cwd. The architect files
it as the first follow-up after #1859 merges, since it depends on that resolver.

Inventory at head 47523751f: direct `child_process` calls whose command is a string literal,
in non-test source, by file and line. Call sites that take the command from a variable
(harness commands, which go through `ptyCommand`/`spawnOnHost`) are not listed; neither are
wrappers, of which none exist for git today.

User tools (36 sites, the follow-up's scope):
- `packages/codev/src/agent-farm/commands/self-refresh.ts`: 484 `execFileSync(git)`
- `packages/codev/src/agent-farm/commands/team.ts`: 26 `execSync(git ...)`
- `packages/codev/src/agent-farm/utils/config.ts`: 43 `execSync(git ...)`
- `packages/codev/src/agent-farm/utils/worktree-write-guard.ts`: 151 `execSync(git ...)`
- `packages/codev/src/commands/consult/index.ts`: 1639, 1640, 1808, 1825, 1840, 1845, 1950,
  2344, 2377 `execFileSync(git)`; 2074, 2125, 2240 `execSync(git ...)`
- `packages/codev/src/commands/doctor.ts`: 1104 `spawnSync(git)`
- `packages/codev/src/commands/init.ts`: 176 `execSync(git ...)`, 192 `execSync(codev ...)`
- `packages/codev/src/commands/porch/artifacts.ts`: 390, 411, 424, 455 `execFileSync(git)`
- `packages/codev/src/commands/update.ts`: 429 `spawn(claude)`
- `packages/codev/src/lib/default-branch.ts`: 15 `execSync(git ...)`
- `packages/codev/src/lib/github.ts`: 288 `execFile(gh)`
- `packages/codev/src/lib/gitignore.ts`: 168, 218 `spawnSync(git)`
- `packages/codev/src/lib/governance-bootstrap.ts`: 254, 275 `execFileSync(git)`
- `packages/codev/src/lib/protocol-drift-audit.ts`: 200 `spawnSync(npm)`
- `packages/codev/src/lib/tree-snapshot.ts`: 91, 107, 125, 184, 359 `execFileSync(git)`

POSIX-only tools, listed so the follow-up confirms each is unreachable on Windows (most sit
behind an `isWindows()` branch today):
- `ps`: `agent-farm/commands/cleanup.ts` 91, `agent-farm/servers/architect-session-holder.ts`
  114, `agent-farm/servers/process-census.ts` 74, `agent-farm/servers/tower-utils.ts` 251,
  `terminal/session-manager.ts` 1142, 1722
- `pgrep` and `tail`: `agent-farm/commands/tower.ts` 483, 599; `which`:
  `agent-farm/commands/bench.ts` 229, `agent-farm/utils/shell.ts` 157, `commands/import.ts` 329;
  `sysctl`: `bench.ts` 50, 72; `du`: `lib/migration-backup-audit.ts` 79; `command -v`:
  `commands/consult/index.ts` 1027 (POSIX branch; Windows uses `findOnHostPath`)

Repo scripts (contributor tooling, not shipped): `scripts/windows-install-guard-check.mjs` 73
`spawnSync(npm)`, `scripts/windows-probe.mjs` 443 `spawnSync(taskkill)`.

The inventory came from a regex over `child_process` calls (string-literal first argument,
possibly on the next line), with SQL `db.exec(...)` matches dropped.

## Deviations from Plan

- **Phase 2:** schema v19 adds `shellper_session_id` as well as the secret column. The shellper
  session id differs from the terminal id and was otherwise recoverable only from the `.sock`
  basename.
- **Phase 3:** `taskkill` is called directly from a new `killSessionTree` primitive rather than
  the `tree-kill` package named in the spec, because the pre-kill snapshot and per-PID creation
  time checks need control `tree-kill` does not give. `tree-kill` and its dead caller were removed.
- **Phase 3b (added):** architect ruling Option C after Phase 3 measured the `cmd start /b`
  re-parenting gap. Ran inside porch's `phase_4` slot with its own 3-way consult.
- **Phase 4:** the `tower stop` fallback kills the listening pid alone, not `killSessionTree`;
  shellpers are Tower's children by ppid, so a tree kill would end every session.
- **Phase 8:** closed on the harness (recorder + replay through the production gate), with the
  Windows fixtures moved to a PR-gate deliverable; strict porch cannot advance past an
  owner-blocked phase. Spec scenario 12 and the phase criteria were amended to the #1664 reading
  (only a human at the line holds mail).
- **Phase 9:** built in two halves around #1806's merge (architect ruling). The never-ready
  server leak was fixed on POSIX too as a same-defect sibling site.
- **Phase 10:** `engines.node` stays `>=20` (engines is not per-platform); the npm-config
  source-build item was not shippable, because the `preinstall` gate covers it.
- **Phase 11:** the Windows matrix is Node 22 and 24, not 20 and 22 (Node 20 cannot install on
  Windows; `install-guard` covers the refusal). The PR-time dispatch rule went into this repo's
  CLAUDE.md/AGENTS.md rather than the protocol prompts, which ship to adopters who have no
  `windows.yml`.
- **Windows-only vitest defaults:** 30 s test / 60 s hook timeouts on Windows only.

## Consultation Feedback

Three-way CMAP per phase iteration: Gemini runs via the Antigravity CLI (`agy`), Codex and Claude via their SDKs. Gemini produced real reviews only for the spec and plan; on every implementation round it was skipped non-blockingly because `agy` exited with code 3 (not signed in), recorded as verdict COMMENT. No CONSULT_ERROR occurred. Several outputs carry a "working tree changed" banner (#1649); the builder traced every one to its own consult log redirects or `.builder-state.md`, never a reviewer write.

### Specify Phase (Round 1)

#### Gemini (COMMENT)
- **Concern**: npm `.cmd` shims cannot be launched directly through ConPTY's `CreateProcessW` → **Addressed**: added to Area D with a risk row.
- **Concern**: MSYS output paths (`/c/...`) need normalizing back to native drive paths → **Addressed**: added to Area D and a success criterion.
- **Concern**: `taskkill /T` on an already-dead root walks no children → **Addressed**: covered by the pre-kill census snapshot; added to scenario 6.
- **Concern**: junction deletion must not traverse into the target → **Addressed**: added to Area E, success criteria and scenario 6a.
- **Concern**: HELLO secret must not travel in argv (visible via CIM) → **Addressed**: env/stdin delivery made explicit in Area A.
- **Concern**: prefix pipe names with a user id to avoid namespace collisions → **Addressed**: not in the spec rebuttal, but Phase 2 ships `\\.\pipe\codev-shellper-<user>-<uuid>`.
- **Concern**: open-question recommendations (CI promotion rule, inline CIM census, prefer `pwsh`) → **N/A**: decided by the owner at the spec gate.

#### Codex (REQUEST_CHANGES)
- **Concern**: HELLO secret gates data, not connection, contradicting "other users cannot connect" → **Addressed**: criterion now "unauthenticated connection gets zero bytes, frames have no effect"; DACL raised as OQ 6.
- **Concern**: detect-and-warn for kill-on-close jobs is not the baked persistence guarantee → **Addressed**: survival required on documented launch paths; relaunch outside the job or refuse (OQ 3).
- **Concern**: `taskkill /T` plus a degraded sweep cannot guarantee no descendants → **Addressed**: pre-kill census snapshot with creation-time guard; census unavailability is a reported failure.
- **Concern**: Build Tools fallback contradicts the locked-down target → **Addressed**: supported Node versions defined as those with prebuilds; clear failure, never a silent source build.
- **Concern**: agent vs human shell terminal semantics conflated → **Addressed**: criteria, Desired State and scenario 3 now separate them; OQ 10 for owner confirmation.
- **Concern**: critical CI and census questions must be resolved at the gate → **Addressed**: OQ 1/2 kept Critical for the gate with a proposed N-green-runs promotion rule.

#### Claude (REQUEST_CHANGES)
- **Concern**: Area C1 drops process start time, making the husk/orphan sweep a no-op (`findHuskShellpers`, `computeRegisteredShellperPids`) → **Addressed**: census must return creation time; OQ 2 reframed.
- **Concern**: `git worktree remove --force` fails on Windows open handles (EPERM/EBUSY) → **Addressed**: success criterion, retry-with-backoff, junction-safe deletion, scenario 6a, risk row.
- **Concern**: long-path support needs admin yet was "nice to know" → **Addressed**: assumption (`LongPathsEnabled` off, per-user `core.longpaths`), criterion, scenario 6b, risk row.
- **Concern**: `tea` missing from forge CLI inventory → **Addressed**: assumptions list `gh`, `glab`, `tea`.
- **Concern**: `tower-terminals.ts:51` parses session id from the `.sock` basename → **Addressed**: added to Area A endpoint dependencies.
- **Concern**: owner lock already self-clears on graceful stop → **Addressed**: noted in Area B.

### Plan Phase (Round 1)

#### Gemini (APPROVE)
- **Concern**: WELCOME `pid` is the PTY child pid, and WELCOME has no `sessionId` → **Addressed**: Phase 2 adds Windows-only `shellperPid` and `sessionId`.
- **Concern**: #1686 keep-row-if-alive guard blocks the PID-reuse cleanup scenario → **Addressed**: Phase 2 adds a distinct identity-refused result that cleans the row.
- **Concern**: pipe path lacks `socketDir`, and JSON-escaped backslashes break cmdline matchers → **Addressed**: `socketDir` kept in shellper config (Phase 2); matchers JSON-unescape (Phase 3).
- **Concern**: `tower.ts` dev-mode `npx`, `pgrep` force-kill branch, `tail -f` → **Addressed**: `pgrep` in Phase 4; `npx` and a Node log follower in Phase 6.

#### Codex (REQUEST_CHANGES)
- **Concern**: Git Bash precedence contradicted the ruled order (override won) → **Addressed**: Phase 5 uses install locations, then PATH, then override; raised with the architect.
- **Concern**: runtime load error does not prevent a native source build → **Addressed**: Phase 1 measures install scripts; Phase 10 adds install-time guard and a failing `node-gyp` stub CI test.
- **Concern**: `verify-install.mjs` and post-release e2e are POSIX-only → **Addressed**: Phase 11 names them (`.cmd` bins, argv arrays, `runner.temp`, packs the dispatched ref).
- **Concern**: early `windows.yml` PR conflicts with "one PR" → **Addressed**: made an explicit architect decision; plan written for both outcomes.

#### Claude (REQUEST_CHANGES)
- **Concern**: Phase 2 re-attach criterion unachievable without the Phase 3 start-time guard → **Addressed**: WELCOME identity swap moved into Phase 2; restart reconnect moved to new Phase 4.
- **Concern**: CIM census lands unmeasured on the `/health` path guarding the owner lock → **Addressed**: Phase 1 measures latency; Phase 3 adds TTL cache + single-flight and re-derives the probe budget.
- **Concern**: census "report failure" contract would also change POSIX → **Addressed**: Windows-only; POSIX keeps `[]`-on-failure, test-pinned.
- **Concern**: name `creationTime` on `ProcessCensusEntry` and the husk-sweep seam reshape → **Addressed**: both named; test asserts one census per sweep.
- **Concern**: VS Code resolver home already settled → **Addressed**: resolver lives in `codev-sdk/node`.
- **Concern**: `porch/checks.ts` group semantics half-covered (`waitForGroupExit`, `detached`) → **Addressed**: `waitForTreeExit`, 5 s grace kept, snapshot-tracked tree + `windowsHide`.
- **Concern**: non-blocking (split Phase 3, delete dead `killProcess`/`tree-kill`, doctor warning for relocated state dir, who opens the workflow PR) → **Addressed**: all taken; plan grew to 11 phases.

### Phase 1 (Round 1)

#### Gemini (COMMENT)
- Skipped (agy unavailable, exit 3).

#### Codex (REQUEST_CHANGES)
- **Concern**: historical Tower-start hang root cause recorded as hypotheses only → **Rebutted**: leading candidate deliberately reproduced and ruled out; discharge put to the owner, who later ruled it discharged as not reproducible.
- **Concern**: extension-host and SSH launch survival untested → **Rebutted**: extension host cannot launch Tower before Phase 6 (deferred to PR-gate pass); SSH not an owner path, documented untested.
- **Concern**: probe section failures still exit 0 → **Addressed**: probe exits non-zero; later steps use `!cancelled()`.
- **Concern**: ARM64 inferred from assets, not measured → **Addressed**: measured on `windows-11-arm` (Node 22/24).
- **Concern**: inventory misses VS Code dev and bench `/bin/sh`, bare `consult` spawn → **Addressed**: added under Phase 6; completion grep spans `apps/`.

#### Claude (APPROVE)
- **Concern**: add/add merge pending with `main` (#1849) → **Addressed**: merged (`9c300aa11`), blobs verified identical.
- **Concern**: reproduce the hang deliberately via the broken `afx tower stop` → **Addressed**: done (see Codex).
- **Concern**: survival matrix lacks the conhost row → **N/A**: acknowledged gap, deferred to the PR-gate pass.
- **Concern**: `setHostPlatformForTests` unguarded; override cannot cross spawn boundaries → **Addressed**: guarded by `isUnderTestRunner()`; limit documented.

### Phase 1 (Round 2)

#### Gemini (COMMENT)
- Skipped (agy unavailable, exit 3).

#### Codex (REQUEST_CHANGES)
- **Concern**: `runIsolatedTower()` timeouts/nonzero exits still reported `ok: true` → **Addressed**: Tower sections set `failure`; known-bad Node 20 leg is `continue-on-error` with reason.
- **Concern**: release 3.3.3 (2026-09-09) exists and is testable → **Addressed**: tested on x64/ARM64 Node 22/24, no hang; `audit.md` §1.6 updated.

#### Claude (APPROVE)
- **Concern**: HEAD's `windows.yml` not yet dispatched green → **Addressed**: run 39562480678 green.
- **Concern**: `limitFlags` comment overclaims under `SILENT_BREAKAWAY_OK` → **Addressed**: comment corrected.
- **Concern**: conhost row still unmeasured → **N/A**: deferred to PR-gate pass.
- **Concern**: hang criterion is an owner decision → **N/A**: escalated; owner ruled it discharged.

### Phase 1 (Round 3)

#### Gemini (COMMENT)
- Skipped (agy unavailable, exit 3).

#### Codex (APPROVE)
- No concerns raised.

#### Claude (APPROVE)
- **Concern**: survival checks use PID liveness without identity proof → **N/A**: carried forward to Phase 4 (thread log).
- **Concern**: null CommandLine also hides same-user elevated processes → **N/A**: carried forward to Phase 3 (thread log).
- **Concern**: `targeted` workflow job never ran → **Rebutted**: run 39555516317 ran it green (thread log).
- **Concern**: nits (`--survival` arg handling, `isSystem32` coverage, no `check-types` script) → **N/A**: carried forward; `check-types` is `pnpm build` (thread log).

### Phase 2 (Round 1)

#### Gemini (COMMENT)
- Skipped (agy unavailable, exit 3).

#### Codex (APPROVE)
- No concerns raised.

#### Claude (APPROVE)
- **Concern**: `ShellperRowAuth` inserted between `DbTerminalSession`'s doc comment and the interface in `tower-types.ts` → **Addressed**: no rebuttal file, but the tree now has `ShellperRowAuth` above the `DbTerminalSession` comment.
- **Concern**: confidence caveat (POSIX suite not executed) and pre-existing mid-file import → **N/A**: informational, not defects.

### Phase 3 (Round 1)

#### Gemini (COMMENT)
- Skipped (agy unavailable, exit 3).

#### Codex (REQUEST_CHANGES)
- **Concern**: `reapShellpers()` fires Windows `killSessionTree()` without awaiting → **Addressed**: kills awaited before death polls; delayed-teardown test.
- **Concern**: `killWindowsTree()` taskkills an unverified (possibly reused) root pid → **Addressed**: root must be census-alive with matching creation time; census-failure case documented as caller-trusted.

#### Claude (COMMENT)
- **Concern**: `collectTree` dead-root path has no creation-time anchor → **Addressed**: `rootStartTime` filters earlier-created ppid matches; tested.
- **Concern**: orphan-sweep budget equals census timeout on Windows → **Addressed**: `orphanSweepBudgetMs()` adds the census timeout; timed-out census rejects.
- **Concern**: `it.fails` pin also passes on setup failure → **Addressed**: Phase 3b criterion requires verifying setup before un-pinning.
- **Concern**: `killed` counters count rejected teardowns → **Addressed**: only `signaled` outcomes counted; rejections logged.
- **Concern**: doctor Tower Environment check unavailable on Windows → **Addressed**: added to review doc Windows limitations.

### Phase 3 (Round 2)

#### Gemini (COMMENT)
- Skipped (agy unavailable, exit 3).

#### Codex (REQUEST_CHANGES)
- **Concern**: husk/architect reap callers discard known creation times (`rootStartTime`) → **Addressed**: husk sweep, architect reconcile and zombie reap pass census creation times.
- **Concern**: `PtySession`, shellper PTY kill and porch checks also omit `rootStartTime` → **Rebutted**: they hold an open process handle, so Windows cannot reuse the pid.
- **Concern**: `architect-session-holder.ts` swallows census/teardown failures → **Addressed**: `reapShellpers` rejects after best-effort kills; callers log or mint fresh.

#### Claude (APPROVE)
- **Concern**: reused-root refusal returns silently, indistinguishable from clean teardown → disposition not recorded.
- **Concern**: `cleanup.ts` passes cached-census creation time (needs call-site comment) → disposition not recorded.
- **Concern**: `isReusedRoot` accepts a root with no `creationTime` → **Addressed**: fixed in round 3 (fails closed).
- **Concern**: re-parented descendants and stale `tree-kill` in `arch.md` → **N/A**: Phase 3b and Phase 11 respectively.

### Phase 3 (Round 3)

#### Gemini (COMMENT)
- Skipped (agy unavailable, exit 3).

#### Codex (REQUEST_CHANGES)
- **Concern**: `isReusedRoot()` treats missing `creationTime` as valid when `rootStartTime` is supplied → **Addressed**: fails closed; test added.

#### Claude (APPROVE)
- **Concern**: empty census stdout with PowerShell exit 0 parses as `[]` → disposition not recorded.
- **Concern**: up to three ~10 s census queries per teardown can overshoot the 20 s sweep budget → disposition not recorded.
- **Concern**: `pty-session.ts` `kill()` swallows teardown rejection without logging → disposition not recorded.
- **Concern**: `it.fails`-pinned re-parented gap → **N/A**: architect-deferred to Phase 3b.

### Phase 3b (Round 1)

#### Gemini (COMMENT)
- Skipped (agy unavailable, exit 3).

#### Codex (REQUEST_CHANGES)
- **Concern**: teardown terminates a Job Object the session refused to join (`ERROR_ALREADY_EXISTS`) → **Addressed**: `terminate` acts only when `IsProcessInJob(root, job)`; Windows test.
- **Concern**: `OpenJobObjectW` failures reported as "not found" → **Addressed**: only `ERROR_FILE_NOT_FOUND` maps to `found:false`.
- **Concern**: failed assign leaks the duplicated handle into the shellper → **Addressed**: assign first, then duplicate with `JOB_OBJECT_QUERY`.
- **Concern**: crash-loop teardown drops `jobError` → **Addressed**: logged.
- **Concern**: header says `detached: true` leaves the job → **Addressed**: rewritten to the measured fact and ruling.

#### Claude (REQUEST_CHANGES)
- **Concern**: helper death after readiness loses a session's job with no log line → **Addressed**: `reportOnce('exit')` and `!proc` branch log; test asserts one line.
- **Concern**: 20 s ready + 5 s request can outrun the 30 s PTY-less deadline → **Addressed**: single `JOB_ASSIGN_BUDGET_MS` at the call site; ready timeout 12 s; ordering pinned by test.
- **Concern**: husk sweep and architect reap omit `jobName` → **Addressed**: `shellperTeardownIdentities` passes job names to every reap path.
- **Concern**: `signaled` almost always false once the job ends the tree → **Addressed**: terminated member job counts as signaled.
- **Concern**: stale `windows-job.ts` header → **Addressed**: same fix as Codex.
- **Concern**: duplicate-before-assign keeps a member-less job name live → **Addressed**: same fix as Codex.
- **Concern**: nits (misleading `jobError` when jobs disabled, crash-loop drop, `stop()` not draining, `PreserveSig`) → **Addressed**: all fixed.
- **Concern**: `shellper-main` deadline handler untested; null request id waits full timeout → **Rebutted**: no test seam in the entry script; own writer always sends an id.
- **Concern**: reconnect can spawn a deferred PTY without a job → **N/A**: recorded in review doc Windows limitations.

### Phase 4 (Round 1)

#### Gemini (COMMENT)
- Skipped (agy unavailable, exit 3).

#### Codex (REQUEST_CHANGES)
- **Concern**: persistence test compares only shellper pid, not agent pid → **Addressed**: stub pid recorded and asserted alive across stop/restart and in replay.

#### Claude (APPROVE)
- **Concern**: wedged Tower (alive, not listening) reported "not running" → **N/A**: documented follow-up in the review doc.
- **Concern**: EPERM treated as dead in CIM start, alive in stop → **Addressed**: both treat EPERM as alive.
- **Concern**: `servers/tower-routes.ts` imports from `commands/` → **Addressed**: `isInsideCodevSession` moved to `terminal/shellper-endpoint.ts`.
- **Concern**: force path sweeps shellpers with no Tower listening → **Rebutted**: that is the flag's purpose.
- **Concern**: dev-mode CIM launch relies on `cmd.exe` parsing → **Rebutted**: dev-only, all arguments are code-built paths.

### Phase 4 (Round 2)

#### Gemini (COMMENT)
- Skipped (agy unavailable, exit 3).

#### Codex (REQUEST_CHANGES)
- **Concern**: bridge-mode Tower on a LAN address gets 403 from `/api/shutdown`, falls back to hard kill → **Addressed**: route accepts own interface addresses (`isLocalMachineAddress`); Windows bridge-mode test.

#### Claude (APPROVE)
- **Concern**: replay match would also pass a respawned stub → **Addressed**: asserts exactly one banner.
- **Concern**: no PTY output check under the CIM-created Tower → **Addressed**: waits for the stub banner.
- **Concern**: census-blocked force path reports "not running" after a taskkill → **Addressed**: Tower trees counted by outcome; tested both ways.
- **Concern**: dev-mode CIM branch has no unit coverage → **Addressed**: test checks `cmd.exe /d /c npx tsx <server>`.
- **Concern**: wedged Tower → **N/A**: documented follow-up.

### Phase 4 (Round 3)

#### Gemini (COMMENT)
- Skipped (agy unavailable, exit 3).

#### Codex (APPROVE)
- No concerns raised.

#### Claude (APPROVE)
- **Concern**: "loopback-only" wording stale in review doc and `tower-stop-windows.ts` header → **Addressed**: no rebuttal file; header and the review doc's stop description now say "from this machine" (one later review-doc bullet still says "from loopback").
- **Concern**: bridge-mode readiness limitation recorded only in a test comment → **Addressed**: no rebuttal file; now in the review doc's Phase 4 section.
- **Concern**: scenario 3 `not.toContain('Tower is not running')` cannot fail → **Addressed**: no rebuttal file; assertion no longer in the tree.
- **Concern**: IPv6 zone-suffix edge in `isLocalMachineAddress` → **Addressed**: no rebuttal file; `tower-routes.ts` strips the `%zone` suffix.

### Phase 5 (Round 1)

#### Gemini (COMMENT)
- Skipped (agy unavailable, exit 3).

#### Codex (REQUEST_CHANGES)
- **Concern**: doctor reports jq `ok` when `jq --version` fails → **Addressed**: failed probe is `fail` with install hint; test.
- **Concern**: CRLF hook scan splits on whitespace, missing quoted paths → **Addressed**: quote-aware `splitShellWords`; tests.

#### Claude (APPROVE)
- **Concern**: Git install probe too narrow (`ProgramW6432`, `git.exe` on PATH) → **Addressed**: both probed; tests.
- **Concern**: memoize `resolveGitBash` → **N/A**: deferred to Phase 6 (done there via `gitBashFor`).
- **Concern**: header comments, hardcoded `'win32'`, structural `worktree` cast → **Addressed**: all fixed.
- **Concern**: double escaping only for npm shims → **Rebutted**: matches cross-spawn's rule; third-party `%*` shims noted for Phase 6.

### Phase 5 (Round 2)

#### Gemini (COMMENT)
- Skipped (agy unavailable, exit 3).

#### Codex (APPROVE)
- No concerns raised.

#### Claude (APPROVE)
- **Concern**: carry-forwards (PATHEXT-cased paths, `cmd /c` `%` expansion, `CLAUDE_CODE_GIT_BASH_PATH` as override, `fromMsysPath` throws) → **N/A**: carried into Phase 6 (thread log).

### Phase 6 (Round 1)

#### Gemini (COMMENT)
- Skipped (agy unavailable, exit 3).

#### Codex (REQUEST_CHANGES)
- **Concern**: doctor spawns Codex/OpenCode/agy `.cmd` shims bare → **Addressed**: routed through `spawnSyncOnHost`/`spawnOnHost`; Windows-seam tests.

#### Claude (APPROVE)
- **Concern**: role file path stays native inside `$(cat ...)`, no test of non-empty substitution → **Rebutted** (path kept native) / **Addressed** (stub records argv; test asserts role text).
- **Concern**: `init`/`adopt` bake `powershell.exe` into committed config → **Addressed**: Windows scaffolds omit `shell.shell`.
- **Concern**: unreachable `tail` after Windows follower; `followFile` swallows errors → **Addressed** (explicit return) / **Rebutted** (silent read errors deliberate for a follower).
- **Concern**: forge override `/path/x.sh --flag` reaches `bash -c` with a backslash path → **Rebutted**: overrides are user bash, same contract as POSIX.
- **Concern**: `PATH_INPUTS` criterion undocumented → **Addressed**: added to doc comment.

### Phase 6 (Round 2)

#### Gemini (COMMENT)
- Skipped (agy unavailable, exit 3).

#### Codex (APPROVE)
- No concerns raised.

#### Claude (APPROVE)
- No concerns raised.

### Phase 7 (Round 1)

#### Gemini (COMMENT)
- Skipped (agy unavailable, exit 3).

#### Codex (REQUEST_CHANGES)
- **Concern**: `cleanup.ts` swallows `WorktreeRemovalError`, then deletes branch/state → **Addressed**: Windows removal failure is `fatal` before prune, branch and state deletion; test.

#### Claude (APPROVE)
- **Concern**: serial per-entry removal slow on large `node_modules` → **N/A**: carry-forward for the review doc.
- **Concern**: Phase 7 limitations missing from review doc → **N/A**: recorded in thread for the review phase.
- **Concern**: real-tree test creates a `dir` symlink with no win32 handling → **Addressed**: junction on Windows.
- **Concern**: error wording implies held handle for every code; no `reportLink` copy-warning test → **Addressed**; `lstat` no-retry **Rebutted** (busy entries fail at unlink/rmdir).

### Phase 7 (Round 2)

#### Gemini (COMMENT)
- Skipped (agy unavailable, exit 3).

#### Codex (APPROVE)
- No concerns raised.

#### Claude (APPROVE)
- **Concern**: no global deadline/progress on serial removal retries → **N/A**: carry-forward for the review doc (thread log).
- **Concern**: process-wide unkeyed symlink-probe cache → **N/A**: carry-forward; degrades safely (thread log).
- **Concern**: review doc lacks Phase 5/6/7 sections → disposition not recorded (review doc still has none).

### Phase 8 (Round 1)

#### Gemini (COMMENT)
- Skipped (agy unavailable, exit 3).

#### Codex (APPROVE)
- No concerns raised.

#### Claude (APPROVE)
- **Concern**: recorder uses full `process.env`, not production's PTY env → **Addressed**: premise corrected (agents get `sanitizeAgentEnv`); recorder now uses it.
- **Concern**: harness docstring overstates fidelity → **Addressed**: stubs and missing retry margin stated.
- **Concern**: header `appVersion` bypasses scrub → **Addressed**: scrubbed.
- **Concern**: #1858 gates the "claude and codex" criterion → **N/A**: carry-forward in review doc.
- **Concern**: `*.txt` gate fixtures lack `binary` attribute → **N/A**: Phase 10 carry-forward.

### Phase 9 (Round 1)

#### Gemini (COMMENT)
- Skipped (agy unavailable, exit 3).

#### Codex (REQUEST_CHANGES)
- **Concern**: readiness timeout leaves an untracked server tree → **Addressed**: tree killed before throwing; POSIX sibling fixed too per architect ruling; tests on both.
- **Concern**: `stopWindowsIdeServer` deletes the record when processes survive → **Addressed**: record kept, throws naming survivors; `/api/ide` DELETE answers 500.

#### Claude (APPROVE)
- **Concern**: synchronous PowerShell port queries inside Tower can exceed health budget → **Addressed**: `getProcessesOnPortAsync` on all IDE paths.
- **Concern**: stale `isPortLive` docstring, mock-only profile assertion, `/tmp` fallback, no review section → **Addressed**: all fixed.
- **Concern**: broad `skipIf(win32)` on #1789 POSIX suites → **Rebutted**: kept, Windows equivalents exist; trade recorded in review doc.

### Phase 9 (Round 2)

#### Gemini (COMMENT)
- Skipped (agy unavailable, exit 3).

#### Codex (REQUEST_CHANGES)
- **Concern**: stop deletes the record without killing when the listener query returns `[]` → **Addressed**: failed query returns `null` (record kept); port-closed server identified by connection-token path and killed; four-case tests.

#### Claude (APPROVE)
- **Concern**: failed port query reads as "nothing listening" → **Addressed**: same fix as Codex.
- **Concern**: never-ready error claims "stopped" even when kill failed → **Addressed**: reports stopped only when gone; POSIX non-ESRCH logged.
- **Concern**: exit wait lacks creation-time re-check → **Addressed**: survivors re-checked against fresh census; tested.

### Phase 9 (Round 3)

#### Gemini (COMMENT)
- Skipped (agy unavailable, exit 3).

#### Codex (REQUEST_CHANGES)
- **Concern**: `stopUnreadyIdeServer` treats any non-refused `killSessionTree` result as stopped → **Addressed**: waits on the kill snapshot via `waitForTreeExit`; three-outcome seam tests.

#### Claude (APPROVE)
- **Concern**: same unverified "stopped" → **Addressed**: as above.
- **Concern**: start on a new port can fail with a stop-shaped message → **Addressed**: start-context error message.
- **Concern**: cmd `^` escapes could defeat the token-path match → **Addressed**: `^` stripped before comparing; tested.

### Phase 10 (Round 1)

#### Gemini (COMMENT)
- Skipped (agy unavailable, exit 3).

#### Codex (REQUEST_CHANGES)
- **Concern**: `node-pty` load failures unwrapped in `pty-session.ts`/`shellper-main.ts` → **Addressed**: `withNativeLoadExplanation`, `conpty.node` patterns; tests.
- **Concern**: doctor reads effective repo `core.longpaths`, not per-user → **Addressed**: queries `--global`.

#### Claude (APPROVE)
- **Concern**: `SUPPORTED_WINDOWS_NODE` (22/24) vs ABI table admitting 25/26 → **Rebutted**: deliberate, message names documented LTS lines.
- **Concern**: `spec-1658-tmp: opaque` annotation self-declared → **Rebutted**: green Windows run is the evidence.
- **Concern**: `porch done` glob change alters POSIX → **N/A**: disclosed in review as same-cause fix.
- **Concern**: POSIX `encodeClaudeProjectDir` unverified → **N/A**: carry-forward in review.
- **Concern**: three CRLF carry-forwards named, not fixed → disposition not recorded.

### Phase 10 (Round 2)

#### Gemini (COMMENT)
- Skipped (agy unavailable, exit 3).

#### Codex (REQUEST_CHANGES)
- **Concern**: direct `new Database(...)` paths bypass the native-load explanation → **Addressed**: central `openDatabase` in `lib/sqlite.ts`; degrade callers rethrow; command-level test.

#### Claude (APPROVE)
- **Concern**: Windows `encodeClaudeProjectDir` validated against itself → **N/A**: carry-forward; benign failure mode.
- **Concern**: `file_tabs` `LIKE` prefix assumes native-form rows → **Rebutted**: writer traced, paths stored native.
- **Concern**: Phase 11 docs must say Windows needs Node 22/24 → **N/A**: Phase 11 scope (done there).

### Phase 10 (Round 3)

#### Gemini (COMMENT)
- Skipped (agy unavailable, exit 3).

#### Codex (APPROVE)
- No concerns raised.

#### Claude (APPROVE)
- **Concern**: ABI allow-list derives from better-sqlite3 only; node-pty on Node 25/26 relies on postinstall backstop → disposition not recorded.
- **Concern**: `/tmp` residue checker is manual, not CI-enforced → disposition not recorded.

### Phase 11 (Round 1)

#### Gemini (COMMENT)
- Skipped (agy unavailable, exit 3).

#### Codex (REQUEST_CHANGES)
- **Concern**: `DEPENDENCIES.md` (both trees) says architect terminals open PowerShell → **Addressed**: only shell terminals default to PowerShell.
- **Concern**: `arch.md` still lists `tree-kill` → **Addressed**: now names `killSessionTree`.

#### Claude (APPROVE)
- **Concern**: workflow comment overstates `version` path (probes always run) → **Addressed**: comment fixed.
- **Concern**: orphaned lesson after `lessons-learned.md` footer → **Addressed**: moved under Debugging.
- **Concern**: green `suites=true` run predates last two commits → **Addressed**: re-dispatched.
- **Concern**: hardcoded Git Bash path in workflow env → **Rebutted**: runner image's standard path.
- **Concern**: multi-package `winget install` line; missing-SDK-export unhandled rejection → **Addressed**: split lines; `FAIL:` and exit 1.
- **Concern**: cli-e2e uploads no report → **Rebutted**: job log carries reporter output.

### Phase 11 (Round 2)

#### Gemini (COMMENT)
- Skipped (agy unavailable, exit 3).

#### Codex (REQUEST_CHANGES)
- **Concern**: `verify-install.mjs` inherits Git Bash `npm_config_script_shell`, masking `cmd.exe` install failures → **Addressed**: step runs under `env -u npm_config_script_shell`.

#### Claude (APPROVE)
- **Concern**: Windows `unit` job omits apps/* and artifact-canvas → **Addressed**: stated as a limitation in the review.
- **Concern**: review doc has no Phase 11 section → **Addressed**: added.
- **Concern**: plan's "`version` alone" wording → **Rebutted**: workflow comment is accurate; plan deviation note covers it.
- **Concern**: reviewer ran the skill-hash generator → **N/A**: no change produced.

### Phase 11 (Round 3)

#### Gemini (COMMENT)
- Skipped (agy unavailable, exit 3).

#### Codex (APPROVE)
- No concerns raised.

#### Claude (APPROVE)
- **Concern**: `DEPENDENCIES.md` says Node 22/24 "only" while the gate admits 25/26 → **Addressed**: reworded.
- **Concern**: CLAUDE.md/AGENTS.md PR-time dispatch omits `-f install_guard=true` → **Addressed**: added.

### Review (PR) Round 1 (porch PR consultation, head f6458b7d5)

#### Gemini (COMMENT)
- Skipped (agy unavailable, exit 3).

#### Codex (REQUEST_CHANGES)
- **Concern**: claude ConPTY fixtures absent; the `afx send` criterion is unchecked → **N/A**: already a declared pr-gate condition (owner's Windows machine).
- **Concern**: codex captures blocked on #1858 without an approved waiver → **N/A**: recorded as a known gap (Spec Compliance); the scope decision is with the owner.
- **Concern**: the owner's manual-pass table is blank → **N/A**: a declared pr-gate condition.

#### Claude (REQUEST_CHANGES)
- **Concern**: the root's `taskkill /T /F` is identity-checked against the snapshot taken before the job round trip (seconds); a pid reused in that window loses an unrelated tree → **Addressed**: after a job round trip the root is re-checked on a fresh census (present, same creation time) before `taskkill`; a census failure skips the tree kill. New unit test for the reused-pid case.
- **Concern**: `powershell.exe` / `taskkill` spawned by bare name with the worktree as cwd; Windows searches the cwd before `PATH`, so a planted binary in a cloned repo runs → **Addressed**: `windowsSystem32Path` / `windowsPowerShellPath` in the platform seam; the census, job helper, CIM launch, both port queries, `taskkill` and the CIM `cmd.exe` all use full System32 paths. The wider class (bare `git`, `gh` and other user tools spawned with a worktree cwd) was ruled a Windows release blocker for a follow-up after #1859 (Known gaps, with the site inventory).
- **Concern**: POSIX CI pending on the final head → **N/A**: verified before the gate request.
- **Concern**: `WINDOWS_PREBUILD_NODE_ABIS` fail-closes future Node releases → **Rebutted**: deliberate; a Node without a better-sqlite3 prebuild cannot install, and the guard's message names the supported versions.
- **Concern**: Gemini absent from every implementation round → **N/A**: recorded under Methodology Improvements.

### Review (PR) Round 2 (porch PR consultation, head 5dca14060)

#### Gemini (COMMENT)
- Skipped (agy unavailable, exit 3).

#### Codex (REQUEST_CHANGES)
- **Concern**: bare user-tool spawns stay cwd-first → **Rebutted**: architect ruling (b); a Windows release blocker recorded under Known gaps, with its inventory, for the first follow-up after #1859.
- **Concern**: ConPTY fixtures, the manual pass, and the #1858 scope → **N/A**: declared pr-gate conditions.
- **Concern**: no Windows run on the final head with `install_guard` → **Addressed**: dispatched on the final head with `suites=true` and `install_guard=true`; the PR's Testing section links it.

#### Claude (COMMENT)
- **Concern**: the `isSameProcess` comment overstated when a census failure is reported → **Addressed**: comment corrected.

### Review (PR) Round 3 (porch PR consultation, head 2d85e6fd8)

#### Gemini (COMMENT)
- Skipped (agy unavailable, exit 3).

#### Codex (REQUEST_CHANGES)
- **Concern**: fixtures, manual pass, #1858 scope → **N/A**: pr-gate conditions held by the owner.
- **Concern**: confirm the final-head Windows run → **Addressed**: run 39927653580; see "Windows runs after the PR opened" below.

#### Claude (COMMENT)
- **Concern**: stale PR Testing claim → **Addressed**: updated.
- **Concern**: POSIX required checks pending → **N/A**: verified on a stationary head before the gate request.
- **Concern**: `HUMAN_HOLD_DETAILS` admits `composer-redraw`, so a real held fixture could pass for the ConPTY pathology → **Accepted, deferred to the fixtures commit**: each capture gets its own expected detail when the claude captures land (no real captures exist to apply it to yet).

### Integration review Round 1 (architect, head 1b78fc076)

- **Concern**: `readShellperInfo`'s resolve-on-data was a Windows-motivated change applied to POSIX → **Addressed**: gated behind `isWindows()`; POSIX resolves only at EOF as before, pinned by a test (valid JSON followed by trailing bytes must fail on POSIX). A fake shellper that never closed stdout was fixed to close it, as a real POSIX shellper does.
- **Concern**: the sdk `/node` charter does not match `node/executable` → **Addressed**: the sdk `package.json` description and arch.md (package table plus an "sdk charter" paragraph) name the shared Node-side utility role.
- **Concern**: #1858 should be a known gap in the review doc → **Addressed**: "Known gap: codex agents and the render gate (#1858)" under Spec Compliance.

### Windows run 39924678195 (Node 24, head a9b2dbae6)

- `forge-jira-preset` "fills closedAt and createdAt" returned `[]` with exit 0 once (Node 22 and earlier runs green). The cause is not proven, but the script had a real masking defect, added in Phase 10: `jq … | tr -d '\r'` takes `tr`'s exit status, so a failing `jq` read as "nothing closed". → **Addressed**: jq now runs alone in its substitution, so a failure stops the script; new test. A recurrence would now show its cause.

## Lessons Learned

### What Went Well

- **Landing the dispatch-only `windows.yml` early (PR #1849, Phase 1).** Every later phase could
  prove itself on a real Windows host from the branch. Most real defects were found there, not by
  unit tests.
- **Measuring before designing.** The Phase 1 probe and the Phase 3 measurements (libuv's
  kill-on-close job, MSYS `&`, `detached: true` not breaking away, CIM escaping the job) decided
  the design of Phases 3b and 4 from facts rather than documentation.
- **One seam, POSIX byte-identical.** Every Windows branch went behind `isWindows()` with POSIX
  argv and handshake bytes pinned by goldens, so POSIX stayed green through 218 commits.
- **Refusing to skip intermittents without a cause.** Two Phase 11 Windows flakes, and the Phase 7
  and Phase 9 porch-check failures, were traced to concrete test bugs and fixed rather than skipped.

### Challenges Encountered

- **Silent Windows failures.** `codev` was an exit-0 no-op for every subcommand, and the full unit
  suite hung for two hours on a drive-root walk-up. Neither had a unit test that could catch it.
  Both were found only once checks asserted output, not just exit codes, and the suite ran to
  completion on Windows.
- **Process lifetime semantics.** Windows has no process groups, keeps a dead parent's pid as
  ppid, and ties job names to open handles. It took a census with creation times, a snapshot
  before kill, and a per-session job (with the handle duplicated into the shellper) to reach
  POSIX parity.
- **Owner-blocked and dependency-blocked phases under strict porch.** Phase 8 (owner captures) and
  Phase 9 (#1806 open) could not wait in place. Both were resolved by architect rulings that split
  the phase and recorded the deviation.
- **Full-suite load.** About 400 added tests turned #1800's latent session-manager timing races
  into consistent porch-check failures.

### What Would Be Done Differently

- Run the complete Windows unit suite at the end of Phase 1, before any feature phase. The 508
  failures found in Phase 10 would have been spread across the phases that caused them.
- Treat "exit 0 with empty output" as a failure in every smoke check from the start.
- Ask for owner-side artifacts (ConPTY captures, the manual pass) to be scheduled at plan
  approval, not discovered as phase blockers.

### Methodology Improvements

- Porch shows only a failed check's stderr; the failing test's name is in stdout. Showing (or
  saving) stdout would have identified the Phase 1 and Phase 7 intermittents.
- Strict porch has no way to park a phase on an external dependency while later phases proceed.
  A recorded "waiting on" state would replace the deviation rulings Phases 8 and 9 needed.
- Gemini (agy) skipped in every round of this project. Multi-month SPIR work effectively ran as a
  2-way consult; an alert when a reviewer skips repeatedly would surface that earlier.

## Architecture Updates

- Routed (cold): `codev/resources/arch.md` "Platform Layer (Spec 1658)": the platform seam,
  named-pipe shellper transport with per-session secret, census and `killSessionTree`, per-session
  Job Object, Git Bash / shim / MSYS resolvers, worktree links, Tower stop over HTTP. Also
  "Supported Platforms" (native Windows 10/11 x64 and ARM64) and the `tree-kill` removal (Phase 11).
- Hot tier unchanged: `arch-critical.md` is at its cap, and the Windows facts are subsystem
  detail a builder needs only when touching platform code, which the arch.md map already routes
  to ("Agent Farm Internals", "Integration Points").

## Lessons Learned Updates

- Routed (cold, Architecture): a native dependency's supported platforms are its prebuild
  matrix, not `engines`.
- Routed (cold, Architecture): on Windows, `detached: true` is not `setsid`; children stay in
  the parent's Job Object.
- Routed (cold, Testing): seam-forced win32 tests prove branch logic, never the platform; only
  real Windows runs find path shapes, pipes and console behavior.
- Routed (cold, Debugging): reproduce a reported hang on the release current at report time
  before hunting a mechanism.
- Hot tier unchanged: `lessons-critical.md` is at its cap, and its existing entries ("tests pass
  is not it works", "build a minimal repro") already carry the cross-cutting form of these.

## Flaky Tests

- **`session-manager.test.ts` "respects maxRestarts limit" (#1800, recurred in Phase 10; now
  skipped).** After the Phase 10 triage it failed 2 of 4 full POSIX suite runs, by hitting the
  30 s outer timeout. Three 100 ms restarts take well under a second, so the test never sees
  the `Max restarts` error: it is stuck, not slow, and the Phase 9 #1800 change (wait on the
  error, outer timeout only) did not cure it. It passes alone (3/3), and under ten CPU-burning
  processes (6/6). Skipped with a FLAKY annotation naming #1800; the cause is still open.

- **`session-manager.test.ts` "bounds a harness that exits 0 immediately" (#1800; skipped in
  CMAP iter 2).** The same shape: porch's phase_10 tests check failed on it, and a replica full
  run failed 1 of 2, stuck at the 30 s timeout without `session-gave-up`. It subscribes before
  `createSession`, so it is not a listener race. Instrumented to dump the manager's timestamped
  restart log when stuck; it did not recur in 18 further full runs (the 30-minute time box), so
  no restart log was captured. Skipped as FLAKY (architect ruling). In the same loop,
  "logs session exit without stderr tail" timed out once. That one was a real test race: it
  subscribed to `session-exit` after `createSession`, which `exit 0` can beat. It now subscribes
  first, and is fixed rather than skipped.

- **Unidentified intermittent failure under `porch done` (Phase 1, 2026-10-21).** The porch
  `tests` check failed twice (51 s, against ~38-40 s for passing runs) and passed on the next
  attempt. Six direct runs passed: `npm test` from the root, `vitest run` in the package, porch's
  `PROJECT_ID`/`PROJECT_TITLE` env set, and a script reproducing porch's detached-process-group
  spawn. Porch prints only a failed check's **stderr**, which held the harmless expected output of
  the `bugfix-1455` pr-create tests. The failing test's name was in stdout, which porch does not
  show. Next time, read `packages/codev/node_modules/.vite/vitest/<hash>/results.json` right after
  the failed check: it records per-file pass/fail. Porch hiding a failed check's stdout is worth a
  separate issue.

- **Auto-restart real-shellper tests under full-suite load (#1800; identified in Phase 9, likely
  the Phase 1 and Phase 7 intermittents too).** `session-manager.test.ts` "auto-restart logic"
  waited on a sentinel or a removed session against a fixed inner deadline (10-15 s). Under
  porch's sequence (build check, then the full suite) the deadline ran out. Which test failed
  varied from run to run: "bounds a harness that exits 0 immediately" three times, "applies
  crashLoopFallback after repeated fast failures" once. They passed with the full suite alone
  under porch's own `runCheck`, with the build followed by that file alone, and on three direct
  full-suite runs. The same sequence on a clean `origin/main` passed twice; the architect has
  seen it on main in 2 of 6 of #1789's porch runs. This branch adds ~400 tests, which turned
  intermittent into consistent. With nothing else running, the time from launch to the
  crash-loop fallback was the same on both: branch 296-315 ms, main 290-317 ms (6 runs each).
  So it is load, not a slower restart path. Fix (test-only, per #1800): the three tests wait on
  the event itself (`crashLoopFallback.onApply`, `session-gave-up`, the "Max restarts" error),
  subscribed before the session exists. The outer test timeout (30 s) is the only bound. The
  `maxRestarts` sibling had the same shape plus a late subscription, and is fixed the same way.
  No skip.

- **Windows runs after the PR opened: three one-off unit intermittents, none skipped.** Each hit a
  different test on one Node leg only, and passed on the other leg and on rerun:
  `forge-jira-preset` "fills closedAt" (run 39924678195, Node 24, `[]` with exit 0, which
  exposed the jq-masking defect fixed in this PR); a vitest worker exiting without output in
  `agy-lane-model.test.ts` (run 39927082964, Node 22); and `spec-1280-measurement-instrument` T12
  (run 39927653580 attempt 1, Node 24: `measure-prompt-surface.sh` exited non-zero with no stderr).
  Attempt 2 of 39927653580 on the final head was green on both legs. The architect's ruling on
  Phase 4(b) (a recurrence blocks the gate until the cause is named) is not engaged: none of these
  is Phase 4(b), and none recurred. They are recorded so a later Windows run that hits one again
  starts from this list. A fourth, outside the test suites: the ARM64 probe's CIM census section
  failed once on a slow runner (run 39930636358 attempt 1, the port-owner probe took 39 s) and
  passed on attempt 2.

- **POSIX CI on the PR found two latent test bugs** (this branch had no PR, so `test.yml` had not
  run on it before 2026-10-23). Both pass on macOS, which is why local runs missed them:
  - The Phase 10 drive-root regression test (`findWorkspaceRoot.test.ts`) ran its child against
    `dist/`, which the Ubuntu unit job does not build. It now runs the source under `tsx`.
  - `spec-1658-posix-residue` "isTempDirectory on Windows" assumed the host temp dir is not under
    `/tmp`. On Ubuntu, `os.tmpdir()` is `/tmp`. The POSIX-root assertions now apply only when the
    host temp dir, as given or resolved, is not under that root.
  Both green on the PR's `test.yml` (head 91ea359df) and on Windows (targeted runs 39930623116
  and 39930636358).

## Follow-up Items

Filed or ruled:
- Windows release blocker: bare user-tool spawns find a cwd program first. The architect files it
  after #1859 merges; the site inventory is under Spec Compliance, "Known gap: bare user-tool spawns".
- #1800: session-manager real-shellper restart tests are load-sensitive on POSIX; two are skipped
  as FLAKY and the cause is open.
- #1858: codex-cli status-line drift (`GPT-6.1-Sol`) makes every codex composer classify
  `no-region-end`, so all mail to codex holds on every platform. Gates the codex ConPTY captures
  and the spec's "at minimum claude and codex" criterion.

Filing candidates (owner's call):
- A PowerShell-safe form of the #1595 lifecycle hook (inert today when Claude Code falls back to
  PowerShell for lack of Git Bash; Git Bash is a hard prerequisite, so no 1658 work).
- Porch hides a failed check's stdout, where the failing test's name is.
- `afx tower start` readiness probes loopback only, so `BRIDGE_MODE=1` with a non-loopback
  `BRIDGE_TOWER_HOST` reports a timeout although Tower is up (every platform, predates 1658).
- `tower stop` reports "not running" for a Tower that is alive but neither answers HTTP nor holds
  its port; a census-verified owner-lock pid would cover it.
- POSIX Claude project-dir encoding replaces only `/` and `.`; if Claude replaces every
  non-alphanumeric, a cwd with `_`, a space or `~` resumes fresh (unverified).
- Node 20 cannot install codev on Windows (no better-sqlite3 prebuild); the cross-platform Node 20
  position was reported to the architect as a spin-off.

Carry-forwards (known, bounded, not filed):
- CRLF tolerance in `overview.ts` status.yaml parsing and `managed-block.ts` is not audited end to
  end; same for `framework-ref-audit` and the `db/consolidate.ts` marker.
- A shellper listen error with no `'error'` listener throws before `start()` rejects (every
  platform).
- Forge `PATH_INPUTS` is a manual allowlist (only `CODEV_OUTPUT_DIR`); a future path-valued concept
  input must be added to it or it reaches MSYS tools in native form.
- Windows worktree removal is serial with per-entry retries and no global deadline or progress;
  slow on a large `node_modules`. Copy-fallback links do not write through, and hard links decouple
  on write-then-rename. The symlink probe is process-wide.
- The architect terminal does not receive `CLAUDE_CODE_GIT_BASH_PATH` from a `windows.gitBashPath`
  config override (builders do); Claude Code finds a standard Git install itself.
- The `version` input of `windows.yml` (verify a published release) works from the first release
  that includes this branch; 3.3.5's codev-sdk lacks the `node/executable` export.
- The Windows `unit` job does not run the apps/* suites or artifact-canvas (no platform branches of
  their own; they run on POSIX). The repo build on ARM64 fails in the artifact-canvas bundler
  (contributor-only; installs work).
- Scenario 15b (joint check with the real `codev-ide-server-win32-x64` package) runs at verify.

## PR-gate manual pass (owner's Windows machine)

Windows 10 22H2 or 11, x64, WSL disabled. Install the branch build (`post-release-e2e` packs it;
or build from a checkout with `pnpm install` + `pnpm build`). Results go in the last column.

| # | Scenario | Steps | Expected | Result |
|---|---|---|---|---|
| 1 | Fresh install | Git for Windows, jq, Node 22 or 24; no Visual Studio Build Tools. `npm install -g` the packed tarballs; `codev --version`; `codev doctor`; `codev init` in an empty folder. | Install needs no toolchain. `--version` prints the version (not empty). Doctor's "Windows Prerequisites" is green (Git Bash path and version, jq). `init` creates the project. | |
| 3 | Tower + terminals | `afx tower start`; open the dashboard; type in the architect terminal; open a new shell; resize the window; `afx tower stop`. | Ready in seconds. The architect runs `claude` and takes input. The new shell is PowerShell. Resize reflows. Stop exits 0, `afx tower status` says not running, a second start succeeds (owner lock released). | |
| 4 | Persistence, three launchers | Run from Windows Terminal, the PowerShell console, and the VS Code terminal: spawn a builder, note its agent PID (`Get-Process claude`), `afx tower stop`, `afx tower start`. | The builder terminal reconnects with replayed output, same PID, input still works. In each launcher. | |
| 6b | Long paths | Workspace at `C:\Users\<name>\src\<repo>`, `LongPathsEnabled` off; spawn a builder; `npm install` in its worktree. | Install completes. Doctor reports workspace depth and `core.longpaths`. | |
| 8 | Forge, live | From a builder: `afx` / porch actions that list issues, view an issue, create and view a PR, and comment (all GitHub concepts). | Each succeeds; `/repos/...` style arguments are not mangled into `C:/Program Files/Git/repos/...`. | |
| 9 | Spawn to PR | `afx spawn <issue> --protocol bugfix` on a throwaway issue; let it reach PR creation. | Builder launches through Git Bash, porch transitions phases, the PR opens via the forge. | |
| 11 | Developer Mode on | Enable Developer Mode; spawn a builder in a repo with `worktree.symlinks` configured. | Real symlinks (`Get-Item <link>` shows `SymbolicLink`). With it off, directories are junctions and files hard links or copies (a copy warns). | |
| 12 | `afx send` live | `scripts/bugfix-1664-streaming-delivery-harness.mts --scenario streaming`, then `--scenario draft` (from `packages/codev`). | Streaming with an empty composer: delivered. Typed draft: held (`user-text`). Idle: delivered. | |
| 13 | Consult | From a Windows builder, a 3-way consult (porch-run, or `consult -m codex` / `-m claude` directly). | codex and claude return; an unauthenticated agy skips without blocking. | |
| 15 | VS Code extension | In VS Code on Windows: start Tower from the extension, spawn a builder, open its terminal, reveal a file. | Each works; no console windows flash. | |
| 15a | IDE server (optional dry run) | With the real `@cluesmith/codev-ide-server` installed: `afx ide start`, open `/ide/?folder=<repo>`, `afx ide stop`. | Found via `PATH`, passes the 1.128.0 floor, serves the folder, installs the sidebar extension; stop leaves no `codev-ide-server` or extension host process. | |
| G | ConPTY fixtures (gate condition) | Capture recipe in `audit.md` "ConPTY → Phase 8": `node --experimental-strip-types scripts/spec-1658-conpty-capture.mts --app claude --state all -- --model haiku` (and codex once #1858 lands). | Four `conpty-claude-*.capture.jsonl.gz` files, committed to `__tests__/fixtures/gate/conpty/`; the replay suite runs them instead of skipping: idle, midturn and resize delivered, draft held. | |

## Appendix: Implementation Notes by Phase

Rulings, measurements and findings recorded as each phase closed.

### Root cause of the 2026-09-09 `afx tower start` hang

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

### Session-tree teardown on Windows: what leaks and why it is bounded (Phase 3)

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

### Windows limitations (collected for the docs, Phase 11)

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

### Tower lifecycle on Windows (Phase 4)

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
- `POST /api/shutdown` is accepted only keyed, from this machine, and not tunnel-borne. The tunnel
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

### Git Bash, shims and MSYS paths (Phase 5)

- `lib/git-bash.ts` judges "real Git Bash" by layout (`<root>\bin` or `<root>\usr\bin` beside a
  `git.exe` whose `--version` contains `.windows.`), never by running bash: running System32
  `bash.exe` would start WSL. A bad override throws (wsl, missing, not-git) with no fallback.
- `codev-sdk/node/executable` (new subpath; `./node` untouched) holds `findExecutable` (PATHEXT,
  case-insensitive env) and `resolveSpawnable`: `.exe` to its full path, an npm `.cmd` shim to
  `node.exe <entry>`, other `.cmd`/`.bat` through `%COMSPEC% /d /s /c` with `^` escaping. The VS
  Code extension and `bootstrap-docs` share it.
- `lib/msys-path.ts` translates drive and UNC paths both ways and throws for mount-table paths
  (`/usr`, `/tmp`) instead of guessing.
- `.gitattributes` pins `*.sh` / `*.bash` to LF (all tracked scripts were already LF).

### Launcher routing and shell roles (Phase 6)

- One helper module, `lib/shell-launch.ts`, routes forge concepts, the builder launch script,
  `postSpawn`, `devCommand` and porch checks through Git Bash. Every site branches on
  `isWindows()`, and POSIX argv is asserted byte-identical per site.
- Not a login shell on Windows: Git Bash's login profile `cd`s to `$HOME` and loses the cwd.
- Git Bash has no `uuidgen` or `/proc` uuid, so relaunch id minting falls back to Node.
- `ptyCommand` resolves `.cmd`/`.exe` at both node-pty spawn points; human shells default to
  PowerShell, and a Windows Tower maps the VS Code extension's `/bin/sh -lc` onto Git Bash.
- Found on Windows: `afx dev` teardown ended the session job before its census snapshot, and the
  MSYS runtime starts native children with breakaway, so `node` under Git Bash survived. The
  snapshot now comes first.

### Runnable-worktree links and removal (Phase 7)

- `lib/worktree-links.ts`: symlink when allowed, else a junction for directories and a hard link
  for files, else a copy (warned: edits do not write through).
- `removeWorktreeDirectory` unlinks link and junction entries without traversal, retries per entry
  on EBUSY/EPERM/ENOTEMPTY/EACCES (about 6 s), and fails naming the blocking path. On Windows,
  `afx cleanup` removes with the walker, then prunes before `git branch -D`; a failed removal
  stops cleanup with the branch and state kept (CMAP iter 1).

### ConPTY render-gate validation (Phase 8)

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

### Codev IDE server on native Windows (Phase 9)

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
server that never starts listening is stopped before the start fails, because no record exists to
stop it later (CMAP iter 1, codex). The same leak existed on POSIX since #1668/#1789. It is fixed
there too as a sibling-site fix under the POSIX rule (architect ruling): SIGTERM to the group,
then SIGKILL after the stop wait.

**Test coverage trade.** #1789's unit suites drive `#!/bin/sh` stub servers and assert POSIX
modes and separators, so those tests are POSIX-only. The Windows behavior they stand for is
covered on a real Windows host by `ide-server-stub.windows.test.ts`: discovery without
`--server-path`, floor accept and refusal, sidebar install with native paths over 260 characters,
spawn, forward, stop and a never-ready server for both shim shapes. The adopt/restart-required
and serialization logic is not re-run on Windows. It is platform-neutral apart from spawning.

**Carry-forwards.** The joint
check with the real `@cluesmith/codev-ide-server-win32-x64` package (scenario 15b) runs at verify,
or earlier as an optional dry run.

**#1595 lifecycle reporter (checked here, no change).** The hook posts and is silent under Git
Bash, from a path with a space. A deleted script still exits 0 silently. When Claude Code finds no
Git Bash it falls back to PowerShell, where the bash-syntax hook fails to parse: fail-open, and
the reporter is inert. Architect ruling: no Windows work in 1658, since Git Bash is a hard
prerequisite. A PowerShell-safe hook form is a filing candidate for the owner.

### POSIX residue sweep and the native-dependency install guard (Phase 10)

**Windows finding: every `codev` subcommand was a silent exit-0 no-op on native Windows.**
`dist/cli.js` parsed argv only when an "is main module" check passed, and all three comparisons
assumed forward slashes. The npm shim (`codev.cmd`) runs node with
`argv[1] = C:\...\bin\codev.js`, and `import.meta.url` is `file:///C:/...`, so nothing matched.
The CLI loaded, registered its commands and exited 0 with no output. `afx` and `porch` were not
affected: they call their entry functions directly, and `consult`, `team` and `generate-image` call
`run()`. `isCodevEntrypoint` (behind the seam, with the POSIX expression byte-identical) fixes it.
No unit test caught it. The install-guard check did, once it required `codev --version` to print
the packed version and not merely exit 0. Lesson: a smoke check that accepts exit 0 with empty
output proves only that a process ran.

**Windows finding: the full unit suite hung for two hours.** `findWorkspaceRoot` walked up with
`while (dir !== '/')`, which never ends at a drive root (`dirname('C:\\')` is `'C:\\'`). A
synchronous loop cannot be timed out in-process, so the regression test runs the walk in a child
process with a deadline.

**Runtime defects the first complete Windows run exposed** (run 39898982593: 80 failing files, 508
tests). Each was fixed behind the seam, with POSIX unchanged. Failing tests each defect
accounts for are in parentheses; 62 in all:
- (32) Builder-worktree matchers split on `/` only. A builder on native Windows was treated as a
  non-builder by `afx send` and `whoami`, and Tower answered its lifecycle reports with 404.
- (20) The Claude project-dir encoding (`~/.claude/projects/<cwd>`) left `C:\` and backslashes in the
  name. Resume never found a stored session and always launched fresh.
- (2) `porch done` built its review-file glob from an absolute path, and glob reads `\` as an
  escape. `done` always refused on Windows. The relative pattern with `cwd` also fixes a POSIX
  workspace path containing glob metacharacters (`[...]`), which used to refuse falsely.
- (sibling site, no failing test) Frontmatter of a CRLF spec or plan (Git for Windows checks out with `core.autocrlf=true`) was
  never recognized as pre-approved.
- (1) Template user-data patterns did not match backslash relative paths.
- (5) `scripts/measure-prompt-surface.sh` (repo dev script): its embedded Python used the
  console code page (cp1252) for stdio, so it could not print its own report on Windows.
- (2) The jira forge preset broke under Git Bash with a native `jq.exe`, in two ways:
  - Raw `jq -r` lines end in CRLF. MSYS strips only the final CR of a command substitution, so
    every per-key view but the last missed, and closed items lost their dates.
  - Forge turns off MSYS argument conversion, so MSYS temp paths handed to native programs
    (`jq --slurpfile`, `acli --body-file`) were unreadable.
  Fixed with `tr -d '\r'` on the keys and a `native_path` helper (`cygpath -w`, only where
  cygpath exists). The other presets' `jq -r` uses are single-value, where the trailing CR is
  stripped.

**Totals** (final run 39909843476: 7513 passed, 0 failed, 156 skipped): 62 tests fixed in
runtime (above), plus the two suite-level defects (the silent `codev` entry and the drive-root hang);
about 445 fixed in tests; about 29 skipped on win32, each naming its POSIX assumption (mode bits 13,
Unix socket files 9, process groups and signals 6, NTFS-illegal filename 1); 1 flaky (#1800, POSIX).

**Install guard.** `preinstall` runs before any dependency's `install` script (npm's rebuild
order), so on a Windows Node with no better-sqlite3 prebuild it stops the install with the
supported versions before node-gyp can run. The Windows check proves the control case too: without
the guard, Node 20 does reach node-gyp. npm forwards neither `--node-gyp` nor
`npm_config_node_gyp` to dependency install scripts, so the check plants its stub on the script
PATH instead. Deviation (architect ruling): `engines.node` stays `>=20`, because engines is not
per-platform and POSIX installs must be unaffected.

**Test-suite sweep.** Everything else the Windows run found was tests: POSIX-branch tests that did
not force the platform seam, `.sock` paths where Windows needs named pipes, `HOME` where
`os.homedir()` reads `USERPROFILE`, `/` in expected paths, 8.3 short temp paths, and repo fixtures
checked out as CRLF. Skips are limited to assertions that are POSIX-only by nature, each naming
its assumption: mode bits, sh stubs, process groups and signals, and an NTFS-illegal filename.

**Windows timing.** Once the suite ran to completion, the remaining failures moved from run to
run. Each was a test that spawns (Git Bash, PowerShell or CIM, Python) or cold-loads a native
binding, running past vitest's 5 s test and 10 s hook defaults on a loaded runner. On Windows only,
the config raises those defaults to 30 s and 60 s. Agy lane temp dirs that a host process still
holds after the fake CLI exits (EBUSY, with a check that no fake survives) are left to the OS on
Windows. Phase 4 (b) was not given a budget: it failed once (Tower gone after the session job's
teardown), so it now records Tower's job membership, parent pid and creation time before teardown
(architect ruling: a recurrence before the PR blocks the gate until the cause is named).

**Carry-forwards.** CRLF in `overview.ts` status.yaml parsing (tolerant where checked, not
audited end to end) and `managed-block.ts` (mixed endings). The POSIX Claude project-dir encoding
replaces only `/` and `.`; if Claude replaces every non-alphanumeric character on POSIX too, a cwd
with `_`, a space or `~` resumes fresh (unverified, filing candidate). A shellper listen error with
no `'error'` listener throws before `start()` rejects (every platform, not changed).

### Windows CI leg and install docs (Phase 11)

- `windows.yml` (dispatch only, never required) gains `unit`, `cli-e2e` and `post-release-e2e`
  behind `suites=true`, on windows-latest with Node 22 and 24. Node 20 is not a leg: it cannot
  install on native Windows, and `install-guard` already tests that refusal. `post-release-e2e`
  packs codev-types, codev-core, codev-sdk and codev from the dispatched ref and installs those
  tarballs, so it tests the branch, not the last release. It installs with npm's default
  `cmd.exe` script shell, as a user's npm does (the workflow's Git Bash script shell is only for
  building the repo).
- First full dispatch, run 39916423619 @ 61c203201: all green. sdk 204/204, core 174/174, codev
  7522 passed / 156 skipped on both Node versions. The codev suite took about 6 minutes, down from
  about 50 in Phase 10 (the drive-root walk-up loop fix and the Windows-only timeouts).
- Not covered by the Windows `unit` job: the apps/* suites (web, vscode, streamdeck) and
  artifact-canvas. They hold no platform branches of their own; they run on POSIX in `test.yml`.
- The `version` input (verify a published release on Windows) works only for releases after
  3.3.5: the Windows bin lookup uses the installed `codev-sdk/node/executable` export, which no
  published release has yet. verify-install.mjs fails with that reason.
- Two intermittent Windows unit failures turned up while re-running the suites, both test bugs.
  `ws-snapshot-e2e` attached once the alt-screen switch arrived, but ConPTY can deliver the switch
  before the paint; it now waits until Tower's mirror holds the painted text. `launchers.windows`
  scenario 9/10 reported the postSpawn result "missing" after `afx spawn` exited 0 (about 1 run
  in 8). The architect ruled that a product question until shown otherwise, so the hook got an
  entry sentinel and the test a miss diagnosis. It showed the hook ran in the right worktree; the
  test cut the base64url builder id at the first `-` or `_` (`worktree-MF-L` read as
  `worktree-MF`) and looked in a directory that does not exist. Neither was skipped.
- Docs: DEPENDENCIES.md (both trees) presents native Windows and WSL 2; the release protocol
  dispatches the workflow before tagging and after publishing; the PR-time rule lives in this
  repo's CLAUDE.md/AGENTS.md because protocol prompts ship to adopters, who have no `windows.yml`.
