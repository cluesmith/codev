# spir-1658 — native (non-WSL) Windows support

## Context
Issue #1658. Started as a tracking map; owner rulings on 2026-10-12 (two issue comments)
turned it into a build: SPIR, one spec, phased, **full parity** with macOS/Linux.

Owner rulings treated as fixed (Baked-Decision equivalent, though not under that heading):
- Git Bash (Git for Windows) is a hard prerequisite and the ONLY plumbing shell (forge
  concepts, builder launch script, postSpawn). No PowerShell twins, no Node port of scripts.
- PowerShell is the default interactive shell for architect/shell terminals on Windows.
- Resolve Git Bash explicitly (install paths → PATH → override); never bare `bash`
  (System32 bash.exe = WSL). Set/honor `CLAUDE_CODE_GIT_BASH_PATH`.
- Git for Windows + jq are hard prereqs checked by `codev doctor` (+ CRLF warning for
  user postSpawn scripts). WSL 2 stays documented as a supported alternative.
- Windows CI leg: recommended non-required → required; owner confirms at spec gate.

## Progress
- [done] Specify — codebase audit (~145 POSIX sites; key blockers: UDS shellper transport,
  start-time PID-reuse guard null on win32 => every reconnect fails, process-group kills,
  ps/pgrep/lsof, /bin/bash launchers). Spec drafted; CMAP iter1: claude+codex REQUEST_CHANGES,
  gemini COMMENT — all accepted (census must carry creation time; pre-kill descendant snapshot;
  kill-on-close job => relaunch-outside or refuse, not warn; worktree removal vs open handles;
  MAX_PATH; agent vs human-shell terminal split; no toolchain fallback).
- [gate] spec-approval pending. Owner decisions at gate: OQ1 CI leg + promotion N, OQ2 census
  provider (PowerShell CIM vs bundled binary), OQ3 kill-on-close behavior, OQ10 ruling-4 reading.
- [gate feedback 2026-10-21] User decisions folded into the spec ("Decisions at the spec gate"):
  - Windows CI is on-demand only (supersedes ruling 7).
  - Built-in PowerShell 5.1 is used as needed for OS integration: census, port owner, and
    relaunch outside a kill-on-close job.
  - Kill-on-close jobs: measure first, relaunch via CIM, refuse only if blocked.
  - Agent terminals launch the harness directly with no user intervention.
  - x64 is supported; arm64 only if prebuilds exist.
  - Pipe secret is Windows-only, so POSIX is unchanged and no upgrade compatibility is needed.
  - Owner-only files rely on user-folder privacy; no extra doctor checks; console windows hidden.
  - Still at the spec-approval gate, waiting for the owner.
- [gate feedback 2026-10-21] Merged origin/main (389 commits; clean). Spec synced: 64 forge scripts (Jira/acli added), reuse bootstrap-docs PATHEXT lookup.
- [gate feedback 2026-10-21] Owner direction via main: Codev IDE server (#1789) IN SCOPE on native Windows. Added SC block, Dependencies (1789 merges first; @cluesmith/codev-ide + win32-x64 pkg 1.0.0; floor 1.128.0 on --version line 1), scenarios 15a/15b (joint check on owner's Windows box), decision 12. Spec head 1c6b39602. Still holding at spec-approval.

## 2026-10-21 plan drafted
- Plan written: 10 phases (audit+seam, pipe transport, lifecycle, resolvers+doctor, launcher routing, worktree links, ConPTY captures, IDE server, residue sweep, CI leg+docs). Ruling-1 order kept; buckets split.
- Audit at plan time: #1789 (PR #1806) still OPEN; IDE server spawn/forward from #1668 already on main. #1595/#1672 not seen on main yet; re-audit at Phases 5/8/9.
- Key ask for the plan gate: land the dispatch-only windows.yml skeleton on main early (GitHub dispatches only workflows present on the default branch), so each phase can run Windows checks on the branch.
- IDE joint check: formal at verify (SPIR has no dev-approval gate); optional dry run before the pr gate.

## 2026-10-21 plan CMAP iter1 → plan-approval gate
- CMAP: gemini APPROVE, codex + claude REQUEST_CHANGES. All points verified against code and accepted; rebuttal in codev/projects/1658-*/1658-plan-iter1-rebuttals.md.
- Plan now 11 phases (old Phase 3 split into census/teardown and Tower lifecycle). Reconnect identity moved into Phase 2; CIM census gets TTL+single-flight (it sits on /health, which sizes the owner-lock probe budget); executable resolver lives in codev-sdk/node (shared with apps/vscode); native-dep install guard added.
- Two items for the architect at the gate: (1) early landing of dispatch-only windows.yml on main; (2) Git Bash order as literally ruled makes the override a last resort.

## 2026-10-21 plan approved → Phase 1 committed, early PR #1849
- Owner approved the plan with main's recommendations: early dispatch-only windows.yml PR = yes; Git Bash override wins when valid (System32 / non-Git override fails loudly). Spec ruling 5 + plan amended (96b64a811); gate approved by me on main's relay.
- Phase 1 committed (4736ccec4): lib/platform.ts seam, scripts/windows-probe.mjs, .github/workflows/windows.yml, audit.md (site inventory; measured facts PENDING).
- Early PR #1849 (branch spir-1658-windows-workflow, built from origin/main via plumbing, no checkout): windows.yml + probe script only.
- Audit surprises: forge scripts live in packages/codev/scripts/forge (not skeleton); doctor's ps-eww Tower-env check has no CIM equivalent; builder session-id minting needs uuidgen or /proc uuid inside Git Bash (probe checks); repo build on Windows needs npm_config_script_shell=Git Bash.
- Env note: worktree needed `pnpm install` after the main merge (artifact-canvas link missing → apps/web tsc failure). Not a code defect.
- Holding porch done for Phase 1 until #1849 merges + probe facts + owner survival matrix are in.

## 2026-10-21 Phase 1 CI facts (dispatches 39555516317, 39555898877, 39556358109)
- PR #1849 merged by main; windows.yml dispatchable. Applied main's should-fixes (quote $FILTER; isolate --tower: temp CODEV_AGENT_FARM_DIR + SHELLPER_SOCKET_DIR + free port; the socket-dir part matters because the boot orphan sweep is scoped by socket dir).
- Node 20 unsupported on Windows: better-sqlite3 12.10.0 has no ABI-115 prebuild → node-gyp → fails; published codev can't install. Node 22/24 fine. ARM64 prebuilds exist for both deps. Cross-platform Node 20 gap reported to main as a spin-off.
- Hang not reproduced (checkout + published 3.3.5 on Node 22/24 reach ready <1s). Found: `afx tower stop` silently fails on Windows (lsof under cmd) and leaves Tower alive; plausible hang cause.
- CIM census ~0.5s warm / ~4s cold; Git Bash lacks uuidgen and /proc uuid (builder session id would be empty → mint in Node, Phase 6).
- Probe lessons: npm ignores npm_config_node_gyp for deps' own `node-gyp rebuild`; --foreground-scripts echoes the script text, so detect node-gyp by its log lines; the workflow's npm_config_script_shell must not leak into user-path install probes.
- Waiting on owner's launcher survival matrix + their probe runs before porch done / Phase 2.

## 2026-10-21 Phase 1 approved (iter 3: codex + claude APPROVE; gemini skipped, agy not signed in)
- Owner ruling 07:41Z: hang criterion discharged as not reproducible (3.3.3 = the 2026-09-09 release, and 3.3.5, both start fine x64/ARM64 Node 22/24; stale-Tower mechanism ruled out by direct test). Spec amended; review doc started early.
- ARM64 measured supported (windows-11-arm). Repo build on ARM fails in artifact-canvas bundler (contributor-only).
- Intermittent porch tests-check failure x2, unidentified (porch shows only stderr); recorded under Flaky Tests with the vitest results.json recipe.
- Carry-forward (non-blocking, claude iter3): survival check uses PID liveness only (add creation-time identity when Phase 4 relies on it); elevated same-user processes have null CommandLine → husks from an elevated session are unreapable, record in Phase 3; --survival arg handling nits; isSystem32 WindowsApps/Sysnative coverage carries into Phase 5 resolver; plan's "check-types" = pnpm build (tsc) in packages/codev. (Claude's "targeted job never ran" is wrong: run 39555516317 ran it green.)

## 2026-10-21 Phase 2 implemented (eaeee654e)
- New terminal/shellper-endpoint.ts: POSIX endpoint/log path unchanged; Windows pipe `\\.\pipe\codev-shellper-<user>-<fresh uuid>` (fresh UUID, not the session id, so the name is unguessable before creation); log in socketDir by shellper session id.
- Secret: minted per session in SessionManager on Windows, passed in the shellper env (CODEV_SHELLPER_SECRET), deleted from the shellper's process.env, stripped from every PTY env (launch and SPAWN). A pipe shellper without it refuses to start. Pre-auth: nothing written, frames ignored, mismatch drops, 10s unauthenticated timeout drops.
- Identity: Windows reconnect skips start time; WELCOME must carry the row's sessionId + shellperPid. Identity-refused (distinct from null) also covers a Windows ENOENT pipe (a pipe exists exactly as long as its server). Reconcile + on-the-fly paths delete such rows WITHOUT signaling the live pid (it is not ours); #1686 keep-row guard unchanged for null.
- Deviation: the plan named only a secret column; v19 also adds shellper_session_id, because the shellper session id differs from the terminal id and was only recoverable from the .sock basename. Persisting beats deriving; pre-v19 rows keep the basename fallback.
- POSIX non-regression pinned by goldens: HELLO bytes, WELCOME key set, argv JSON key list, start-time check still runs.
- Windows-only test file shellper-named-pipe.windows.test.ts (real pipe cross-manager reconnect; no-secret zero bytes; scenario 14 second local user, CI-gated since it creates a user).
- Windows CI (run 39568235990): all 4 real-pipe tests green. Found + fixed: Tower waited for shellper stdout EOF, which never comes on Windows (closeSync(1) leaves the pipe open) → read info on complete JSON. Scenario 14: second non-admin user gets EPERM opening the pipe (default DACL), so the secret is defense in depth. Orphaned cmd.exe after killSession confirms Phase 3 tree teardown is needed.

## 2026-10-21 Phase 3 implemented (census + session-tree teardown)
- process-census.ts: Windows provider = inline `powershell.exe -NoProfile -NonInteractive -Command` CIM Win32_Process → JSON (pid, ppid, cmdline, creation time, working set); UTF-8 output forced; single quotes only so argv quoting cannot mangle it. TTL 2s + single-flight; failure rejects and is never cached. POSIX unchanged ([] on failure).
- lib/process-tree.ts: killSessionTree (POSIX = today's group signals, synchronous, with opt-in pid fallback and SIGKILL escalation per site) and waitForTreeExit. Windows: census snapshot → taskkill /T /F → explicit kill of recorded survivors whose creation time still matches; tree walk rejects a "child" created before its parent (Windows keeps a dead parent's pid as ppid). Census failure still runs taskkill on the root, then rejects.
- Sites migrated: pty-session, session-manager (orphan sweep, max-restart give-up, and killSession on Windows, which fixes the orphaned cmd.exe from Phase 2), architect-session-holder reap, cleanup, porch checks (detached only off Windows, windowsHide, relay waits for the async teardown before re-raising on Windows). shellper-main's PTY kill tree-kills on Windows.
- New terminal/shellper-cmdline.ts: Windows command lines are argv-unquoted (CommandLineToArgvW rules) and config fields JSON-decoded, so `C:\\Users\\...` matches `C:\Users\...`; Windows scope = decoded socketDir field compared as a path. Husk sweep takes one census per sweep and reads creation times from it.
- architect-session-holder: snapshot is now async (listProcessEntries returns a Promise); findOwnArchitectShellpers is async (one test gained an await). classifyArchitectSessionHolder takes a required list.
- Not migrated, deliberately: tower-utils sessionHasLiveHolder (sync, on the sync resolveArchitectLaunch path). On Windows `ps` is absent, so it reports "no holder", its documented fallback; the async reconcileArchitectSessionHolder (now census-backed) still guards add-architect/launch.
- probeTowerHealth budget on Windows = census timeout (10s) + 2s. Doctor: Windows "Process Census" check (warns on failure); Tower Environment check reports "not available on Windows".
- Removed shell.ts killProcess/killProcessTree and the tree-kill dependency.
- Windows CI iterations (runs 39572306380 → 39574693242): teardown first read the census through its 2s TTL cache and missed fresh children / saw dead ones; teardown now always reads fresh (`listProcessCensus({ fresh: true })`). ConPTY's `conhost.exe --headless` stays a child of the shellper after the PTY exits, so the husk predicate now ignores the console host (`isConsoleHostEntry`).
- Measured: libuv puts a Node process's non-detached children in a kill-on-close job (they die with their Node parent); a Git Bash `&` does not orphan (MSYS keeps the job's Windows parent alive); `detached: true` escapes on both platforms (parity).
- Real gap: a descendant orphaned by `cmd /c start /b` (non-detached, ppid = dead cmd) survives teardown. Spec's B2 trigger. 5/6 Windows tests green. Escalated to architect with options (A: PowerShell-created per-session Job Object with BREAKAWAY_OK; B: accept and document; C: ship Phase 3, B2 as its own phase). Waiting.

## 2026-10-21 Phase 3b (per-session Job Object), inside porch's phase_4 slot
- Ruling: Option C. 3b runs first in the phase_4 slot, gets its own 3-way consult, then Phase 4 starts. Commits from a891d303c are tagged `[Phase: phase_3b]`.
- Architect addition, done: a live root with no creation time now rejects (reported by every caller); a reused pid resolves with `refused: 'reused-pid'`; fallbackToPid stays closed.
- lib/windows-job.ts: one PowerShell helper per Tower, Win32 calls bound with Reflection.Emit (in memory, no Add-Type, no DLL), line-JSON assign/terminate, 5s request timeout, bind/start failure disables jobs (logged once), at most 3 restarts in 5 min.
- Cost gate passed (audit 1.8): cold start+bind 3.6-4.3s, warm assign 1-3ms, nested assign works.
- Surprises: (1) a job's NAME dies with its last handle (member processes don't keep it), so the helper duplicates a non-inheritable job handle into the shellper; (2) Node `detached: true` does NOT break away (libuv never passes CREATE_BREAKAWAY_FROM_JOB), so no setsid parity; a CIM Win32_Process.Create launch does escape. Architect ruled: document (a), Phase 4 starts Tower via CIM when the launcher is inside a session (b, with conditions), keep BREAKAWAY_OK (c).
- Shellper: with `deferPty` (Windows), the first PTY spawn waits for Tower's authenticated HELLO; 30s PTY-less deadline then exit. Session-manager assigns `Local\codev-session-<id>` between reading shellper info and connecting. Teardown, the orphan sweep, max-restart give-up and `afx cleanup` terminate the job first. Doctor reports job availability.
- The pinned `it.fails` re-parented test is now a real-session test, and passes (setup verified before teardown).
- 3b own consult (codex + claude REQUEST_CHANGES, gemini skipped): all findings fixed; see 1658-phase_3b-iter1-rebuttals.md. Biggest: a teardown could terminate a job the session never joined, so terminate now requires the root to be a job member (IsProcessInJob). Also: a helper exit is logged once; one assign budget per create sits inside the shellper deadline; every reap path passes job names; duplicate after assign, query-only.
- Gotcha: reading the Win32 last error through a PowerShell function returns garbage (203); read Marshal::GetLastWin32Error() on the statement right after the call.
- Verified: POSIX 7001/0; Windows run 39655482085 19/19.

## 2026-10-22 Phase 4 (Tower lifecycle on Windows)
- tower stop: POST /api/shutdown (keyed + loopback-only) then wait on the answering pid; fallback kills the listening pid ALONE (a tree kill would end every session: shellpers are Tower's ppid-children). Force path: census, every shellper session tree with its job, then Tower's tree.
- Port owner on Windows via Get-NetTCPConnection -State Listen (fixes doctor and ide-server too).
- tower start from inside a session (CODEV_SHELLPER_SESSION, set by the Windows shellper for its PTY): daemon created through CIM Win32_Process.Create (env sanitized, marker stripped, same cwd); CIM failure refuses with the supported launch paths. Tower boot warns once if the marker is in its own env; /health reports insideCodevSession on Windows; doctor shows it.
- windowsHide on the daemon and shellper spawns.
- Gotcha: vitest's NODE_ENV=test leaks into a spawned Tower and points it at test.db.
- Windows run 39658293851: scenarios 3, 4, 5 and the CIM survival test green; CIM Tower lands in the same logon session as the launcher.
- Phase 4 consult iter1 addressed (codex agent-pid; claude minors); Windows 39660493868 23/23. Architect logSafe nit done d4fd2e7b6.
- phase_4 iter2 consult addressed (codex bridge-mode stop; claude test tightening); Windows 39662352535 24/24.

## 2026-10-22 Phase 5 (Git Bash, shim, MSYS resolvers + doctor)
- lib/git-bash.ts: override (`windows.gitBashPath` in .codev/config.json, then CLAUDE_CODE_GIT_BASH_PATH) → %ProgramFiles%\Git → %LocalAppData%\Programs\Git → PATH. "Real Git Bash" is judged by layout (`<root>\bin` or `<root>\usr\bin` beside a git.exe whose --version contains `.windows.`), never by running bash: running System32 bash.exe would start WSL. System32/Sysnative/SysWOW64 and the WindowsApps alias are always rejected; a bad override throws (wsl / missing / not-git), no fallback.
- codev-sdk/node/executable (new subpath export, `./node` untouched): findExecutable/findAllExecutables (PATHEXT, case-insensitive env on Windows) + resolveSpawnable: .exe → full path; npm .cmd shim → node.exe <entry> (node.exe beside the shim first, as cmd-shim does); other .cmd/.bat → %COMSPEC% /d /s /c with cross-spawn-style ^ escaping and windowsVerbatimArguments. bootstrap-docs uses it.
- lib/msys-path.ts: drive and UNC both ways; fromMsysPath throws for mount-table paths (/usr, /tmp) instead of guessing; MSYS_PATHCONV_OPT_OUT env.
- doctor: "Windows Prerequisites" section (isWindows only): Git Bash and jq are required (fail); CRLF postSpawn/devCommand script files warn. POSIX output has no new section (test).
- .gitattributes: `*.sh` / `*.bash` text eol=lf (all 78 tracked .sh already LF; no churn).
- Phase 5 consult: iter1 codex REQUEST_CHANGES (jq probe failure counted ok; CRLF scan missed quoted paths), both fixed in 5fe79f6fe, plus Git install discovery via ProgramW6432 and git.exe-on-PATH. iter2 codex + claude APPROVE (gemini skipped, agy exit 3). Windows runs 39665855828 and 39667662523: 6/6.
- Carry-forwards for Phase 6 (claude iter2): memoize resolveGitBash at the call sites; resolved paths carry PATHEXT casing (`.CMD`); the `cmd /c` form cannot stop `%VAR%` expansion; a builder env exporting CLAUDE_CODE_GIT_BASH_PATH makes it a loud override inside builders (fine while it is the resolved path); fromMsysPath throws for mount-table paths, so callers must catch.

## 2026-10-22 Phase 6 (launcher routing and shell roles)
- One helper module, lib/shell-launch.ts: `gitBashFor(workspaceRoot)` memoizes resolveGitBash per override value (closes the Phase 5 memoize carry-forward); `gitBashCommand` (`-c`), `gitBashScript` (script path in MSYS form), `gitBashEnv` (MSYS opt-out), `spawnOnHost`/`spawnableOnHost`/`findOnHostPath` for bare commands, `windowsInteractiveShell`, `windowsShellRequest`. Every site branches on isWindows(), so POSIX argv is byte-identical (asserted per site).
- Git Bash routed: forge concepts (execFile, script vs `-c` string, CODEV_OUTPUT_DIR translated to MSYS form because `tar -C C:\...` reads the colon as a remote host), builder launch script + `afx spawn --shell`, postSpawn (runStreaming), devCommand, porch checks.
- Launch script on Windows: `cd` in MSYS form, CODEV_BUILDER_WORKTREE stays native (Node reads it), exports CLAUDE_CODE_GIT_BASH_PATH. Role file path stays native (codex receives it as an argument). Relaunch id minting falls back to `<node> -e randomUUID` (audit 1.5: Git Bash has no uuidgen or /proc uuid).
- Not a login shell on Windows (devCommand, `bash` shell role): Git Bash's login profile cds to $HOME, losing the terminal cwd.
- PTY: `ptyCommand` (lib/pty-command.ts) at both node-pty spawn points (shellper-main factory, PtySession.spawn), so the architect's `claude` .cmd/.exe resolves wherever it is launched from; a verbatim cmd.exe line goes to node-pty as its string args form. pty-manager on Windows: PowerShell default and a Windows base env (PATH/PATHEXT/SystemRoot/COMSPEC/USERPROFILE..., HOME = profile).
- Shell roles (Area F): `defaultInteractiveShell()` in the platform seam (powershell.exe on Windows); loader defaults and init/adopt scaffolds use it; dashboard "new shell" (afx shell) on Windows uses `shell.shell` through windowsInteractiveShell; `bash` → Git Bash `-i`, never System32.
- VS Code: `cli-process.ts` spawnCodevCli for afx (tower start/stop, spawn) and the `codev --version` preflight. The extension's dev runner still sends `/bin/sh -lc`; a Windows Tower maps client POSIX shells onto Git Bash in handleTerminalCreate, so the extension needs no resolver.
- `afx tower log --follow`: Node follower (lib/file-follow.ts) on Windows.
- Gotcha: agent-farm config.test mocks lib/config.js wholesale, so a helper re-exported from config vanished there; the host default lives in platform.ts.
- Gotcha: a developer's ~/.codev/config.json (shell.shell: bash) leaks into loadConfig in tests; the route test points HOME at its temp dir.
- Deferred: the architect does not get CLAUDE_CODE_GIT_BASH_PATH from a `windows.gitBashPath` config override (only builders do); it inherits Tower's env, and Claude Code finds a standard Git install itself.
- POSIX full suite 7148/0 (+import/bench 44/44), tsc clean, vscode 1245/1245 + check-types + esbuild bundle. Windows run 39673039595 dispatched with `.windows.` (new launchers.windows.test.ts: live forge incl. `gh api /repos/...`, .cmd architect stub, afx shell PowerShell, spawn --worktree via Git Bash + postSpawn, CRLF hook, porch checks + phase transition, afx dev teardown).
- Windows 39673039595: all Phase 6 scenarios green except `afx dev` teardown; the Phase 3 porch-timeout test broke because its check string carried an unquoted Windows path (check strings are bash now; test single-quotes them).
- Root cause of the dev teardown miss: killWindowsTree ended the session job BEFORE its census snapshot. The job allows breakaway (3b ruling c) and the MSYS runtime starts native children with breakaway, so `node` under Git Bash survived the job while its bash parents died, and the post-job snapshot could not link it to the root. Fix: snapshot first, then terminate the job, then kill surviving snapshot members (creation-time re-verified). Unit test for the breakaway case.
- Windows 39674582715 (`.windows.`): 37/37.
- Phase 6 consult iter1: codex REQUEST_CHANGES (doctor spawned codex/opencode/agy bare) fixed via spawnSyncOnHost/spawnOnHost; claude APPROVE, notes 1/2/3/5 addressed (role-text assertion, no shell.shell committed from Windows scaffolds, explicit return, PATH_INPUTS criterion), 4 declined (overrides are user bash). gemini skipped (agy exit 3). Rebuttals: 1658-phase_6-iter1-rebuttals.md.
- Gotcha: Git Bash `$(...)` strips a trailing CR as well as LF (role file is a CRLF checkout on the runner).
- POSIX 7152/0; Windows 39676695295 36/37 (only the CRLF expectation), then 39677250753 launchers 7/7.
- Phase 6 consult iter2: codex APPROVE, claude APPROVE (gemini skipped). Carry-forward for the review doc: forge `PATH_INPUTS` is a manual allowlist (only CODEV_OUTPUT_DIR); a future path-valued concept input must be added or it reaches MSYS tools in native form.

## Phase 7: runnable-worktree links and removal

- New `agent-farm/lib/worktree-links.ts`: `createWorktreeLink` (POSIX: the same `symlinkSync` calls; Windows: symlink when the first attempt succeeds, else junction for directories, hard link for files, copy on EXDEV/EPERM/ENOTSUP/EMLINK; probe result remembered per process) and `removeWorktreeDirectory` (lstat every entry, unlink link/junction entries without traversal, rmdir fallback for directory links, chmod+unlink for read-only files, per-entry retry with backoff ~6s on EBUSY/EPERM/ENOTEMPTY/EACCES, final `WorktreeRemovalError` naming the path).
- spawn-worktree's four link sites call the helper; a copy is a logger.warn ("edits will not write through").
- cleanup on Windows: shellper tree already killed earlier in cleanupBuilder; removal via the walker instead of `git worktree remove`, then `git worktree prune` BEFORE `git branch -D` (git refuses to delete a branch a registered worktree has checked out). POSIX unchanged.
- The runner account can create symlinks, so the Windows test forces the probe to `false` (`setSymlinkProbeForTests`) to exercise junction + hard link for real; a second test leaves the probe to the host and logs LINK-METHOD.
- Windows runs: 39679431647 (`worktree-links`): real scenarios 11 + 6a green (LINK-METHOD directory=symlink with the probe left to the host; removal waited ~3.1s for a child cwd + an open handle, junction/hard-link targets intact); unit file failed only because it assumed `/` separators and ran the POSIX test on win32, fixed. 39679989913 (`worktree-`): all Phase 7 files green except the POSIX cleanup-routing test (now skipIf win32; 39680520858 green). Also caught by the broad filter: `worktree-write-guard.test.ts` "bakes an absolute CODEV_WORKTREE_ROOT" fails on Windows, untouched by this branch: Phase 10 POSIX residue (audit lists worktree-write-guard.ts).
- POSIX full suite 7173/0, build green.
- Phase 7 consult iter1: codex REQUEST_CHANGES (cleanup carried on after a failed Windows removal, deleting branch + state); fixed: removal failure is fatal before prune/branch/state. claude APPROVE (notes 3, 4 fixed; 1, 2 carried). gemini skipped. Carry-forwards for the review doc: serial removal speed on big node_modules; copies don't write through; hard links decouple on write-then-rename of the root file; a failed Windows removal stops cleanup with branch and state kept.
- Intermittent: porch's first `tests` check for Phase 7 failed once, then passed on direct rerun and on porch retry (7173/0); the failing test was not captured.
- Windows 39682261313 (`worktree-links`): 2/2 files green. Phase 7 consult iter2: codex APPROVE, claude APPROVE (gemini skipped). Carry-forwards for the review doc: no global deadline/progress on serial removal retries; the symlink probe is process-wide and unkeyed (one unsupported filesystem pins it false; degrades safely to junction/hard link).

## Phase 8: ConPTY gate validation (blocked on owner captures)

- Built the capture side so the owner's run is one command per agent: `scripts/spec-1658-conpty-capture.mts` records idle / draft / midturn / resize as timed JSONL (output, keystrokes, resizes, probe points), scrubbed same-length, refused if a private value survives. Recipe in audit.md "ConPTY → Phase 8".
- Replay: `__tests__/helpers/conpty-replay.ts` runs each probe through the real `deliverAgentMail` with the live bindings (`classifyAgentScreen`, `composerFingerprintForSession`) on the capture's clock. `spec-1658-conpty-gate-replay.test.ts`: synthetic self-tests (including a negative control that must hold `composer-redraw`) plus a loop over `fixtures/gate/conpty/` (a visible todo until captures land).
- Proven on macOS with real claude 2.1.306: idle delivered at once, draft held `user-text` every pass, mid-turn delivered after one 250 ms composer sample, resize delivered. Not committed (platform must be win32).
- Expectation: mid-turn with an empty composer → DELIVERED (#1664), not held as the plan/spec scenario 12 wording says; raised with the architect.
- Found (not Windows, not fixed here): codex-cli 0.162.1's status line starts `GPT-6.1-Sol`, the region-end pattern wants lowercase `gpt`, so every codex composer classifies `no-region-end` and all mail to codex holds. Reported to the architect as a separate fix; codex captures wait on it.
- Recorder dialog handling: only the folder-trust dialog is accepted, only a yes/trust option confirmed, never one naming update/install; codex's update offer is dismissed with its own Esc.
- Also: `detectHarnessFromCommand` reads Windows backslash and quoted paths by basename; the #1664 harness launches through `ptyCommand` so it runs on Windows.
- Architect ruling (main, 2026-10-22): #1664 reading confirmed (spec scenario 12 + plan criteria amended); codex drift filed as #1858, not folded in; option (b): Phase 8 closes on the harness, Windows fixtures are a PR-gate deliverable (claude required, codex may wait on #1858). The real-capture suite now SKIPS with a reason naming the empty fixture directory (unit-tested), no todo. Review doc has a Phase 8 section with the deviation.

## Phase 9: Codev IDE server on native Windows (blocked on #1806)

- Re-entered after the phase_9 context refresh. PR #1806 (Spec 1789) is still OPEN; main has no ide-version.ts / ide-extensions.ts / 1.128.0 floor (only the PIR #1668 IDE code). Plan dependency unmet: raised to the architect with options (wait / start on existing parts / reorder) and waiting for a ruling.
- Architect ruling (main, 2026-10-22): option (b). Build now on what main has; do NOT merge builder/spir-1789; finish discovery / version floor (parseIdeServerVersion) / extension handover on Windows after #1806 merges (architect will say). Phase 9 stays open in porch until both halves are in.
- First half: `ide-server.ts` spawns via `spawnIdeServerProcess` (POSIX: plain spawn; Windows: `spawnOnHost`, shim resolver + windowsHide), readiness on Windows is a loopback connect (`isPortAccepting`; the PowerShell port query is seconds per poll), stop on Windows kills trees (`stopWindowsIdeServer`): the recorded pid is a root only when a live listener descends from it (reused pid never killed), other listeners are their own roots; census failure falls back to listeners. POSIX untouched. Fixtures: `__tests__/fixtures/ide/` stub server (`--version` prints `1.128.0\r\n<commit>`, one child, echoes url+argv) behind two shims. `.gitattributes`: `*.cmd text eol=crlf`.
- Gotcha: a `.cmd` whose body is `node "%~dp0x.mjs" %*` matches the npm-shim pattern, so the resolver runs node directly (no cmd.exe). The plain-shim fixture hides the entry in a variable to force the cmd.exe path.
- Native `?folder=C:\...` (encoded, raw backslashes, >260 chars) passes the forward byte for byte; no forward code change was needed.
- POSIX 7199/0. Windows 39688446088 (`ide-`): 7/7 files, stub stop killed 3 processes.
- #1806 merged (architect, 2026-10-23). Merged origin/main as 3af370fd2; conflicts: tunnel-client blocklist (kept both api/shutdown and api/agent-lifecycle), spawn-worktree launch script (main's lifecycle-reporter launchCmd + this branch's scriptLocalPath/mintFallback), ide-server (main's preflight/lock + Windows spawn/stop).
- Second half on #1789's code: `ideServerSpawnable` (Windows: JS launcher under Tower's Node, else shim resolver) used by every server subprocess (spawn, --version, --install-extension); `buildIdeServerEnv` keeps Windows' `Path` key (a separate PATH key would shadow it and the server would lose the user's PATH); timeout kill is a tree kill on Windows; server CLI commands not detached on Windows (a detached cmd.exe has no console, so a plain .cmd shim's output reached no pipe); discovery via findOnHostPath (PATHEXT); npm via the shim resolver.
- Found while testing: `scripts/build-ide-extension.mjs` spawned bare `pnpm` (ENOENT on Windows, breaking every Windows build after #1789); runs pnpm's npm_execpath under Node on Windows now.
- Found while testing: with the server down, an /ide/ request's respawn check ran the synchronous PowerShell port query and stalled Tower's event loop for seconds; async liveness checks now use the loopback probe on Windows (`isPortListening`).
- #1789's sh-stub tests (ide-command/extensions/version/server-preflight) are skipIf(win32), Windows covered by the .cmd stub test: discovery via PATHEXT, floor accept/refuse, sidebar install with native paths >260 chars, spawn/forward/stop for both shim shapes.
- #1595 lifecycle reporter on Windows (run 39874334734): Git Bash hook posts and is silent; missing script exits 0 silently; settings carry forward-slash paths. Claude Code's documented fallback without Git Bash is PowerShell, where the bash-syntax command fails to parse (exit 1, no post): fail-open, reporter inert. No Windows work needed while Git Bash is a prerequisite.
- Phase 9 CMAP. iter1: codex REQUEST_CHANGES (never-ready server untracked; stop with survivors deleted the record) -> fixed, plus Claude's notes (async port query on all IDE paths). Architect ruling (a): fix the never-ready leak on POSIX too (sibling site, origin #1668/#1789), recorded as a spec/plan deviation.
- porch tests check failed 2/2 under porch only: #1800 (session-manager auto-restart real-shellper tests, fixed inner deadlines, load-sensitive; ~400 more tests on this branch made it consistent). Idle launch-to-fallback time equal on branch and main (~300 ms). Test-only fix: wait on onApply / session-gave-up / the Max restarts error, outer timeout only; commit 28631aae6 "Refs #1800".
- iter2: codex REQUEST_CHANGES (stop with no listener deleted the record): Windows now tells a failed port query (null) from no listener; a port-closed server is identified by Tower's connection-token path on its command line, then killed; survivors re-checked by creation time. iter3: codex REQUEST_CHANGES (never-ready "stopped" unverified on Windows): now waits on the kill snapshot (waitForTreeExit). Porch force-advanced at its 3-iteration ceiling; iter3 rebuttal is the audit trail. Final Windows run 39881464958 green on d5b8e1822.

## Phase 10: POSIX residue sweep and native-dependency install guard

- Runtime residue: host-path helpers (`lib/host-paths.ts`: `~` expansion, last segment, under-dir), temp-dir checks per host, the write guard allowlists `os.tmpdir()` and USERPROFILE\.claude on Windows. Doctor reports workspace depth against MAX_PATH, `core.longpaths`, and a relocated state dir.
- Install guard: `preinstall` refuses a Windows Node with no better-sqlite3 prebuild (Node 20) before any `install` script runs, and the message names the supported versions. `postinstall` verifies both bindings load on Windows, and a runtime twin explains a later load failure. Architect ruling: engines stays `>=20` (engines is not per-platform), recorded as a plan deviation.
- Install-guard check gotcha: npm forwards neither `--node-gyp` nor `npm_config_node_gyp` to dependency install scripts (arborist omits nodeGyp, so run-script falls back to its bundled copy). What works is the script PATH: an ancestor `node_modules/.bin/node-gyp` comes before npm's shim. Control, unsupported and supported all pass on Windows.
- Found by the tightened check: `codev` on native Windows was a silent exit-0 no-op for every subcommand. The cli.ts entry check compared POSIX-shaped paths only. Fixed with `isCodevEntrypoint` behind the seam.
- The full Windows unit suite timed out at 120 min. Cause: `findWorkspaceRoot` looped forever at a drive root (`while (dir !== '/')`). Fixed; a regression test runs the walk in a child with a deadline (architect ask).
- /tmp residue: every test file that uses `/tmp` is annotated (opaque / posix-only / sun_path), and the rest moved to `os.tmpdir()` or `helpers/socket-temp-root.ts`. The checker `scripts/spec-1658-tmp-residue-check.mjs` passes.
- First complete Windows run (39898982593): 80 failing files, 508 tests. Seven parallel triage passes under the architect's ruling (fix runtime candidates; skip only POSIX-only assertions, naming the assumption). Runtime bugs found and fixed: builder-worktree matchers split on `/` only (Windows builders treated as non-builders, lifecycle reports 404), the Claude project-dir encoding left `C:\` in the name (resume never found a session), the `porch done` review glob broke on backslashes (done always refused), CRLF pre-approval frontmatter, and template user-data patterns. Everything else was tests: unforced POSIX-branch seams, `.sock` paths where Windows needs pipes, HOME vs USERPROFILE, '/' expectations, and fixtures checked out as CRLF.
- Windows runs now carry a `purpose` input shown as the run name (owner ask via the architect).
- Rounds 2-5 after the triage: jira forge native-jq fixes; doctor needed a module-level platform pin (vi.resetModules); session-manager's 29 exposed tests got the seam pin plus pipe endpoints, with socket-file assertions skipped. Load timeouts moved from run to run, so vitest.config sets Windows-only defaults (30s test / 60s hook). Agy temp dirs a host process still holds are left behind on Windows; the survivor check stays.
- Phase 4(b) failed once (Tower gone after the session-job teardown). Not skipped (architect: a recurrence before the PR blocks the pr gate until the cause is named). It now records IsProcessInJob, ppid and creation time before teardown (TOWER-JOB-FACTS); confirmed inJob=False on two later runs.
- #1800 "respects maxRestarts limit" recurred on POSIX (stuck, not slow): skipped as FLAKY; #1800 stays open (architect).
- Final Windows run 39909843476 @ 14c8cdc93: 7513 passed, 0 failed, 156 skipped; install guard 3/3; probes green. Counts sent to the architect.
- Learned: a local `Object.defineProperty(process, 'platform', { value: 'win32' })` in vi.hoisted reproduces seam-driven Windows failures on macOS (it reproduced doctor's 29 failures exactly), but not Windows path shapes or named pipes.

## Phase 11: Windows CI leg and install docs

- windows.yml gains `unit`, `cli-e2e` and `post-release-e2e` (input `suites=true`), Node 22/24 on windows-latest. Plan deviation: not Node 20 (cannot install on Windows; `install-guard` already covers the refusal). `post-release-e2e` packs codev-types/core/sdk/codev from the dispatched ref and runs verify-install.mjs on the tarballs; `version=X.Y.Z` swaps in the published package and runs that job alone.
- verify-install.mjs on Windows: bins are `<prefix>\<bin>.cmd`, resolved through the installed SDK's `resolveSpawnable` (loaded from the install itself, so the script still needs no checkout build) and run with execFileSync. POSIX path unchanged; verified locally on macOS against freshly packed tarballs.
- Docs: DEPENDENCIES.md (both trees, identical) presents native Windows and WSL 2, with Node 22/24, Git for Windows + jq, shells, Git Bash resolution, long paths, Developer Mode optional, privacy, LF scripts, PowerShell/CIM, limitations; Node minimum corrected 18 -> 20; Linux/WSL `build-essential` + `python3`. README prerequisites point at it. Release protocol dispatches the Windows workflow before tagging and after publish. arch.md: Platform Layer entry + Supported Platforms. lessons-learned: four [From #1658] entries (prebuild matrix, detached is not setsid, seam tests vs real host, reproduce-on-the-reported-release). runnable-worktrees skill (all four copies): Windows link fallback and LF scripts.
- PR-time dispatch rule went into this repo's CLAUDE.md/AGENTS.md, not the protocol prompts: those ship to adopters, who have no windows.yml.
- Unverified claims were cut while writing the docs (WSL /mnt/c performance, "don't mix Windows and WSL afx", a winget Node id that can move past 24); `afx spawn` warns only on the copy fallback, so the docs say that rather than "reports the method".
