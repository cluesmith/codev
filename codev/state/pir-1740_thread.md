# pir-1740 thread: Jira forge preset

## 2026-10-12: plan phase
- Architect ruling on #1740 fixes: Cloud only, wrap `acli`, hybrid like Linear, Done-category closed semantics, no smart commits, KEY-123 ids end to end.
- acli not installed here; official reference is self-inconsistent (`comment create` vs `comment`). Implement phase installs via brew tap and verifies with --help. JSON shape can only be confirmed against a live Cloud site (asked architect for a sandbox).
- Surprise: non-numeric ids are NOT end-to-end for Linear either. Spec 719 widened spawn parse + types only; overview worktree-name recovery, porch cwd detection, resume, PR<->issue linking, VS Code open-by-id all assume digits. Plan step 4 fixes them via a shared issue-id helper + uppercase canonicalization at spawn.
- Doctor reports auth only for github today; plan adds provider auth + gh auth for hybrids.

## 2026-10-12: live acli probe (owner installed + logged in), plan revised
- Read-only probe of acli 1.3.39. Key facts: auth status is a real round trip (text, no --json); `workitem search --fields` is allow-listed and returns NO dates; `view` returns everything (one key per call, ~1.2s); REST `self` is an infra host, so browse URL needs jira-site or the auth-status Site line; unbounded JQL is rejected; `--fields key` alone returns nulls.
- Design changes: issue-list omits createdAt; recently-closed does search + per-hit view (24h window, capped); identity keyed on email.
- Owner instruction: keep tenant-specific details out of committed artifacts; fixtures are structural with synthetic values.
