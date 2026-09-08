# BUGFIX Protocol

Investigate → Fix → PR, driven by a GitHub issue. No spec, no plan, no artifact files: the issue
is the specification and the PR body carries the reasoning.

Use it for a defect whose fix is isolated. For a small *feature* use AIR; for anything needing a
design decision use SPIR.

## The state machine

```json
{{> protocols/bugfix/protocol.json}}
```

## Phases

**Investigate** — reproduce the bug and identify the root cause. **No code in this phase.**
Confirm the fix fits BUGFIX scope; if it does not, signal `BLOCKED` and recommend escalation
rather than growing the project quietly.

**Fix** — the minimal change that resolves the root cause, plus a regression test that **fails
without the fix and passes with it**. A test that passes either way documents nothing. Do not
refactor surrounding code, fix unrelated bugs (file separate issues), or add features.

```
[Bugfix #42] Fix: URL-encode username before API call
[Bugfix #42] Test: regression for unencoded username
```

**PR** — open with the `pr-create` forge concept command the PR-phase prompt hands you (`gh
pr create` on GitHub), body carrying Summary, Root Cause, Fix and Test Plan plus
`Fixes #<N>` so the issue closes on merge. Run one CMAP pass (Gemini, Codex, Claude), record
each verdict, and address or rebut every `REQUEST_CHANGES`. Notify the architect with the
verdicts, then `porch done <id>` and wait.

Merge with `gh pr merge --merge`. **Do not pass `--delete-branch`** — the builder is checked out
on that branch in a worktree, and deleting it out from under them breaks the worktree.

## The gate exists to make merge authorization structural

BUGFIX has one human gate, `pr`. Its purpose is that the merge trigger is **porch state** —
approved or not — rather than free text typed into the builder's pane. That closes the
self-merge bug class: a builder cannot infer authorization from ambiguous prose.

## Consultation

One CMAP pass at the PR. No per-phase consultation: the issue is the spec and the fix is small,
so review effort concentrates where it can still change the outcome.

## Scope

The <300 LOC threshold is a **guideline**, measured as net diff (additions + deletions) against
the merge-base with the default branch. A well-contained 350-line fix is fine; a 200-line fix
smeared across ten files probably warrants escalation.

## Escalation

If the change outgrows BUGFIX mid-flight — architectural impact, multiple components, unclear
root cause after investigation — notify the architect with specifics and recommend SPIR. **Do
not silently expand scope.**

## Edge cases

| Scenario | Action |
|---|---|
| Cannot reproduce | Document the attempts on the issue, ask the reporter for detail, notify the architect |
| Fix outgrows scope | Notify the architect and recommend escalation; do not proceed |
| Unrelated test failures | Out of scope — note them for the architect, do not fix here |
| Multiple bugs in one issue | Fix the primary one; file separate issues for the rest |

## Branch naming

`builder/bugfix-<issue>-<slug>`
