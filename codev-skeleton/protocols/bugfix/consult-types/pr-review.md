# PR Ready Review Prompt (BUGFIX)

## Context

You are performing the final self-check during the PR phase of the **BUGFIX protocol**. The builder has investigated a GitHub Issue, implemented a focused fix, and added a regression test, and is about to create — or has just created — the PR for the architect's integration review.

**BUGFIX is not SPIR.** Do **not** review against the SPIR three-document trinity. A BUGFIX project's artifacts are the originating **GitHub Issue** (the spec), the **code fix** (minimal, root-cause-focused), a **regression test** that fails without the fix and passes with it, and the **PR body** (Summary, Root Cause, Fix, Test Plan). There is **no `codev/specs/`, `codev/plans/`, or `codev/reviews/` file**, and there should not be. The commit format is `Fix #NNNN: <description>` (or `[Bugfix #NNNN] ...`), **not** `[Spec NNNN][Phase]`.

## Focus Areas

- **Issue resolution** — the fix resolves the symptom; the PR body includes `Fixes #<N>` (so the issue auto-closes on merge) and covers Summary, Root Cause, Fix, Test Plan.
- **Regression test** — a deterministic test targets the exact scenario and would fail without the fix; a truly untestable (e.g. docs-only) fix has the absence explicitly justified.
- **Scope discipline** — focused on the root cause, no unrelated refactors or drive-by fixes, net diff under ~300 LOC; if it grew beyond a bugfix, it should have escalated to SPIR/TICK.
- **Code cleanliness** — no debug code, `console.log`, commented-out blocks, or stray TODOs; follows project conventions.
- **Test status** — existing tests and the build pass; no new flaky tests.
- **PR hygiene** — commits use `Fix #<N>: ...` / `[Bugfix #<N>] ...` (**not** `[Spec NNNN][Phase]`), the branch is current with its base, and the PR is linked to the issue.

## Out of Scope (Do NOT request changes for)

These are **not** part of the BUGFIX protocol and must **not** be cited as `REQUEST_CHANGES` reasons:

- Missing `codev/specs/<N>-*.md` — BUGFIX has no spec; the GitHub Issue is the spec.
- Missing `codev/plans/<N>-*.md` — BUGFIX has no plan.
- Missing `codev/reviews/<N>-*.md` — BUGFIX has no review document; the review lives in the PR body.
- Commit format `[Spec NNNN][Phase]` — BUGFIX intentionally uses `Fix #N:` / `[Bugfix #N]`.
- `status.yaml` fields like `build_complete: false` — porch manages `status.yaml`; the builder is **forbidden** from editing it directly. Treat porch state as informational, not a fixable issue.
- Phase-scoping concerns — BUGFIX is a single-phase protocol; there are no plan phases to scope against.
- The syntax of `git diff` examples in review-file prose (e.g. `git diff ci..HEAD` in a "Files Changed" caption) — quoted diff syntax is documentation, not a command. Apply two-dot/three-dot scrutiny only to diffs you compute yourself.

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
  Fixes #<N>. [1-2 sentences on what was fixed.]

  ## Root Cause
  [What caused the bug]

  ## Fix
  [What changed]

  ## Test Plan
  - [Regression test description]
  - [Manual verification, if applicable]
```

- `APPROVE`: bug resolved, regression test in place, PR ready for architect review.
- `REQUEST_CHANGES`: real BUGFIX-relevant issues (missing regression test, fix doesn't resolve the symptom, scope creep).
- `COMMENT`: minor items; can proceed but note the feedback.

The `PR_SUMMARY` block can be used directly as the PR description.
