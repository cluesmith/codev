# PR Review Prompt (PIR)

## Context

You are performing the 3-way review of a PIR PR. The builder implemented an approved plan, the human approved the `dev-approval` gate (having run and tested the code locally), and the PR is open. This is a single advisory pass (`max_iterations: 1`) — your verdict is surfaced to the human at the `pr` gate, who is the sole remaining reviewer; it is not auto-re-reviewed.

## Focus Areas

- **Completeness** — the PR body is the review-file content plus `Fixes #<N>`; commits are formatted `[PIR #<N>] ...`; the diff matches what the review file describes.
- **Test Status** — all tests pass on the branch, coverage is adequate, and skipped/flaky tests are documented.
- **Code Quality** — no debug code, no stray `TODO` or unaddressed `// REVIEW:` markers.
- **Branch Hygiene** — the branch is up to date with the default branch (whatever `git symbolic-ref --short refs/remotes/origin/HEAD` reports — typically `main`, sometimes `dev`/`ci`); commits are atomic; the diff size is reasonable for the issue.
- **Issue Linkage** — the PR body carries `Fixes #<N>` (or `Refs #<N>` for a partial fix), without which GitHub won't auto-close the issue on merge.

## Verdict Format

Provide your verdict in exactly this format — `consult` parses it:

```
---
VERDICT: [APPROVE | REQUEST_CHANGES | COMMENT]
SUMMARY: [One-line summary of your assessment]
CONFIDENCE: [HIGH | MEDIUM | LOW]
---
KEY_ISSUES:
- [Issue 1 or "None"]
- [Issue 2]
...
```

- `APPROVE`: ready to merge.
- `REQUEST_CHANGES`: issues to fix before merging.
- `COMMENT`: minor items; can merge but note the feedback.

## Scope

Flag a missing `Fixes #<N>` and obvious problems the gate reviewer might have missed. Do **not** redesign the approach (settled at `plan-approval`, validated at `dev-approval`), demand changes the human already accepted at `dev-approval` (they ran the code; you didn't), or flag the syntax of `git diff` examples in review-file prose — quoted diff syntax is documentation, not a command; apply two-dot/three-dot scrutiny only to diffs you compute yourself. You are the secondary reviewer for hygiene and edge cases: "what would an integration reviewer catch that the gate reviewer missed".
