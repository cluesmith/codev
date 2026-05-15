# PR Ready Review Prompt (BUGFIX)

## Context
You are performing a final self-check during the PR phase of the **BUGFIX protocol**. The builder has investigated a GitHub Issue, implemented a focused fix, and added a regression test. They are about to create — or have just created — a PR for the architect's integration review.

**BUGFIX is not SPIR.** Do **not** review against the SPIR three-document trinity. The artifacts of a BUGFIX project are:
- The originating **GitHub Issue** (serves as the spec)
- The **code fix** (minimal, focused on root cause)
- A **regression test** that fails without the fix and passes with it
- The **PR body** (Summary, Root Cause, Fix, Test Plan)

There is **no `codev/specs/`, `codev/plans/`, or `codev/reviews/` file** for a BUGFIX, and there should not be one. The commit format is `Fix #NNNN: <description>` (or `[Bugfix #NNNN] ...`), **not** `[Spec NNNN][Phase]`.

## Focus Areas

1. **Issue Resolution**
   - Does the fix actually resolve the symptom described in the issue?
   - Does the PR body include `Fixes #<N>` so the issue auto-closes on merge?
   - Does the PR description cover: Summary, Root Cause, Fix, Test Plan?

2. **Regression Test**
   - Is there a regression test that targets the exact scenario from the issue?
   - Would the test fail without the fix? (If reviewers can't tell, ask the builder to demonstrate.)
   - Is the test deterministic (not flaky)?
   - If the fix is documentation-only or otherwise truly untestable, has the builder explicitly justified the absence of a test?

3. **Scope Discipline**
   - Is the change focused on the root cause? No unrelated refactors, no drive-by fixes for other bugs.
   - Is the net diff under ~300 LOC (additions + deletions, excluding generated/lockfiles)?
   - If the scope grew beyond a bugfix, should the builder have escalated to SPIR/TICK instead?

4. **Code Cleanliness**
   - No debug code, `console.log`, or commented-out blocks left behind.
   - No stray TODOs introduced by this fix.
   - Code follows existing project conventions.

5. **Test Status**
   - All existing tests pass.
   - Build passes.
   - No new flaky tests introduced.

6. **PR Hygiene**
   - Commits use the BUGFIX format: `Fix #<N>: ...` or `[Bugfix #<N>] ...` (**not** `[Spec NNNN][Phase]`).
   - Branch is up to date with main (or close enough for clean merge).
   - PR is linked to the issue.

## Out of Scope (Do NOT request changes for)

The following are **not** part of the BUGFIX protocol and must **not** be cited as REQUEST_CHANGES reasons:

- Missing `codev/specs/<N>-*.md` — BUGFIX has no spec; the GitHub Issue is the spec.
- Missing `codev/plans/<N>-*.md` — BUGFIX has no plan.
- Missing `codev/reviews/<N>-*.md` — BUGFIX has no review document; review lives in the PR body.
- Commit format `[Spec NNNN][Phase]` — BUGFIX intentionally uses `Fix #N:` / `[Bugfix #N]`.
- `status.yaml` fields like `build_complete: false` — porch manages `status.yaml`; the builder is **forbidden** from editing it directly. Treat porch state as informational, not a fixable issue.
- Phase-scoping concerns — BUGFIX is a single-phase protocol; there are no plan phases to scope against.

## Verdict Format

After your review, provide your verdict in exactly this format:

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
  [Brief explanation of what caused the bug]

  ## Fix
  [Brief explanation of the fix]

  ## Test Plan
  - [Regression test description]
  - [Manual verification, if applicable]
```

**Verdict meanings:**
- `APPROVE`: Bug is resolved, regression test is in place, PR is ready for architect review.
- `REQUEST_CHANGES`: Real BUGFIX-relevant issues to fix (missing regression test, fix doesn't resolve the symptom, scope creep, etc.).
- `COMMENT`: Minor items, can proceed but note feedback.

## Notes

- This is the builder's final self-review before hand-off to the architect.
- The `PR_SUMMARY` block can be used directly as the PR description.
- Focus on "is this bug actually fixed and protected by a test" — not on artifacts from other protocols.
