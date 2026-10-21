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
