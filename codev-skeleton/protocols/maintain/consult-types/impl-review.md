# Implementation Review Prompt (MAINTAIN)

## Context

You are reviewing the **maintain** phase of a MAINTAIN run: a scheduled, whole-repository hygiene pass that audits, removes dead code and unused dependencies, and syncs the governance docs, scoped to the commits since the last run. Verify the cleanup is correct and safe.

**MAINTAIN is not SPIR.** There is **no spec, no plan, and no review document**. The run's record is its maintenance run file in `codev/maintain/` (audit findings, what was removed and why, deferred items). Do **not** request changes for missing `codev/specs/`, `codev/plans/`, or `codev/reviews/` artifacts.

## Verify before flagging

Before requesting changes, confirm the claim against the project rather than your training data:

- Check `package.json` for the actual dependency versions before calling a dependency unused or misused.
- If "Previous Iteration Context" is provided, read it before re-raising concerns already disputed.

## Focus Areas

- **Removals are really dead** — every removed export, file, or dependency has no remaining caller. Grep for it yourself; a detector cannot tell "vestigial" from "used by a path nobody searched".
- **Each removal is justified** — the maintenance run file records why, and removals are one per commit.
- **Docs match the code** — `arch.md` / `arch-critical.md` and `lessons-learned.md` / `lessons-critical.md` describe what exists now; hot-tier files stay within their caps; `CLAUDE.md` and `AGENTS.md` are byte-identical.
- **Build and tests pass** after the cleanup.
- **Scope** — dead-code removal, dependency cleanup, doc sync, and small bugs found on the way (named in the run file). Refactoring live code is out of scope.

## Out of Scope (Do NOT request changes for)

- Missing spec, plan, or review documents — MAINTAIN produces none.
- "Plan Alignment" or "Spec Adherence" — there is no plan or spec to align with.
- `status.yaml` fields — porch manages them; the builder must not edit that file.

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

- `APPROVE`: the cleanup is correct and safe; the builder can move to the review phase.
- `REQUEST_CHANGES`: a removal breaks something, a doc is wrong, or build/tests fail.
- `COMMENT`: minor suggestions; can proceed but note the feedback.
