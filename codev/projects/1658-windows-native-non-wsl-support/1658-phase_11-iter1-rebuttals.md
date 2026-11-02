# Phase 11, iteration 1: responses

## Codex (REQUEST_CHANGES)

1. **DEPENDENCIES.md said architect terminals open PowerShell.** Correct, fixed in both copies.
   Architect and builder terminals run their configured agent CLI (`claude` by default); only
   plain shell terminals default to Windows PowerShell 5.1 (spec decision 4 at the spec gate).
2. **arch.md still listed `tree-kill`.** Correct, fixed: the Technology Stack entry now names
   `lib/process-tree.ts` (`killSessionTree`) and points at the Platform Layer entry.

## Claude (APPROVE), minor points

1. Workflow comment overstated the `version` path (probes always run). Fixed the comment:
   `version` without `suites` runs post-release-e2e and the probes. Gating the probes is not in
   scope; they are cheap and every dispatch has run them since Phase 1.
2. Orphaned lesson after the footer. Fixed: moved inside Debugging and Root Cause Analysis.
3. Green evidence predates two commits. Re-dispatched `suites=true` on the fixed head (run id in
   the thread).
4. Hardcoded Git Bash path in the workflow env. Not changed: it is the runner image's standard
   Git for Windows path, every job has used it since Phase 1, and a move would fail at the first
   pnpm script with the path in the error.
5. Multi-package `winget install`. Fixed: three separate lines.
6. Missing-SDK-export failure surfaced as an unhandled rejection. Fixed: it prints a `FAIL:` line
   and exits 1 like the other checks.
7. cli-e2e uploads no report. Not changed: the job log carries vitest's default reporter output.

## Gemini

Skipped (agy exit 3), as in every earlier iteration.

## "Working tree changed" banners

The three paths were my own consult log files at the worktree root (`.consult-*.log`), not a
reviewer write. They are deleted and were never staged.
