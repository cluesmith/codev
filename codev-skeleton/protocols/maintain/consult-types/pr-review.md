# PR Ready Review Prompt

## Context

You are performing the final self-check during the Review phase — the builder has completed all implementation phases and is about to open the PR. This is the last check before the work goes to the architect for integration review.

## Focus Areas

- **Completeness** — all spec requirements implemented, all plan phases complete, the review document written (`codev/reviews/XXXX-name.md`), and commits in the `[Spec XXXX][Phase]` format.
- **Test Status** — all tests pass, coverage is adequate for the changes, and any skipped/flaky tests are accounted for.
- **Code Cleanliness** — no debug code, no stray `TODO` / `// REVIEW:` left unaddressed, code properly formatted.
- **Documentation** — inline comments clear where needed, the review document comprehensive, new APIs documented.
- **PR Readiness** — the branch is up to date with its base (the integration branch the PR targets), commits are atomic and well-described, and the diff size is reasonable.

## Scope

Do not flag the syntax of `git diff` examples that appear in review-file prose (e.g. `git diff ci..HEAD` inside a "Files Changed" caption or "How to Test Locally" section) — quoted diff syntax is documentation, not a command. Apply two-dot/three-dot scrutiny only to diffs you compute yourself.

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

PR_SUMMARY: |
  ## Summary
  [2-3 sentences describing what this PR does]

  ## Key Changes
  - [Change 1]
  - [Change 2]

  ## Test Plan
  - [How to test]
```

- `APPROVE`: ready to create the PR.
- `REQUEST_CHANGES`: issues to fix before PR creation.
- `COMMENT`: minor items; can create the PR but note the feedback.

The `PR_SUMMARY` block can be used directly as the PR description.
