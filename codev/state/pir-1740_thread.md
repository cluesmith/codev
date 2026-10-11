# pir-1740 thread: Jira forge preset

## 2026-10-12: plan phase
- Architect ruling on #1740 fixes: Cloud only, wrap `acli`, hybrid like Linear, Done-category closed semantics, no smart commits, KEY-123 ids end to end.
- acli not installed here; official reference is self-inconsistent (`comment create` vs `comment`). Implement phase installs via brew tap and verifies with --help. JSON shape can only be confirmed against a live Cloud site (asked architect for a sandbox).
- Surprise: non-numeric ids are NOT end-to-end for Linear either. Spec 719 widened spawn parse + types only; overview worktree-name recovery, porch cwd detection, resume, PR<->issue linking, VS Code open-by-id all assume digits. Plan step 4 fixes them via a shared issue-id helper + uppercase canonicalization at spawn.
- Doctor reports auth only for github today; plan adds provider auth + gh auth for hybrids.
