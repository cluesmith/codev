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
- [in progress] Specify — auditing codebase (transport/lifecycle, launchers/residue) to ground the spec.
