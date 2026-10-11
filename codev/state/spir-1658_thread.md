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
