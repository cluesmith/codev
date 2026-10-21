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
