# PR Review Prompt (MAINTAIN)

## Context

You are reviewing the pull request of a MAINTAIN run — a scheduled, whole-repository hygiene pass (audit, dead-code and dependency cleanup, governance-doc sync) scoped to the commits since the last run. The builder has opened the PR; after this review, the run stops at the human `maintain-complete` gate.

**MAINTAIN is not SPIR.** There is **no spec, no plan, and no review document**. The run's record is its maintenance run file in `codev/maintain/`. Do **not** request changes for missing `codev/specs/`, `codev/plans/`, or `codev/reviews/` artifacts.

## Focus Areas

- **Removals are really dead** — spot-check removed code for remaining callers.
- **The run file is complete** — base commit, audit findings, each removal with its reason, documentation changes, deferred items, and the PR number.
- **Docs match the code** — governance docs describe what exists now, hot-tier caps hold, and `CLAUDE.md` / `AGENTS.md` are byte-identical.
- **Test status** — build and tests pass.
- **PR hygiene** — `Closes #<N>` only when a GitHub issue requested this run; commits are one removal each with `[Maintain] ...` messages.

## Out of Scope (Do NOT request changes for)

- Missing spec, plan, or review documents — MAINTAIN produces none.
- `status.yaml` fields — porch manages them.
- The syntax of `git diff` examples quoted in prose — quoted diff syntax is documentation, not a command.

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

- `APPROVE`: ready for the human `maintain-complete` gate.
- `REQUEST_CHANGES`: issues to fix before the gate.
- `COMMENT`: minor items; can proceed but note the feedback.
