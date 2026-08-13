# Builder thread — bugfix-1431

## Issue #1431 — phaseArtifactVerb missing verify-approval gate mapping

Stream Deck's `phaseArtifactVerb` (apps/streamdeck/src/actions.ts:327) maps the
`spec-approval`, `plan-approval`, `dev-approval`, and `pr` gates but not
`verify-approval`. A builder blocked at `verify-approval` therefore returns
`undefined`, and the Builder Action Automatic press falls back to `open-terminal`
instead of opening the review diff. Meanwhile the #1428 faces already render this
gate (yellow + `verified` glyph + `Verify` label) — so the key looks gate-blocked
but the press opens a terminal: a face/behaviour contradiction.

## Root cause (investigate phase — no code)

Single missing branch in the gate section of `phaseArtifactVerb`. The VS Code
sidebar's `gateIconFor` (apps/vscode/src/views/builder-row.ts) already knows
`verify-approval` → `verified`; the Stream Deck resolver never caught up.

## Fix (architect-scoped: strictly one line + one test + one comment cleanup)

1. actions.ts `phaseArtifactVerb` gate branch: add `verify-approval` returning
   `'view-diff'` (same as dev-approval/pr — human reviewing finished work). The
   Automatic press then resolves view-diff → open-diff-first via
   BuilderAction.resolveVerb (#1414), which is correct and intended.
2. actions.test.ts: assertion beside the existing dev-approval/pr gate cases.
3. face.ts ~line 52: delete the doc-comment clause saying the resolver "doesn't
   handle it yet (that gap is BUGFIX #1431)" — this lane closes that gap.

Do NOT touch anything else in face.ts/actions.ts (#1410 just landed a large change;
keep this diff trivially reviewable).

## Fix phase — done

Made the three scoped edits. Regression test confirmed to fail without the fix
(returns `undefined`) and pass with it (`view-diff`). Full suite 125/125,
check-types clean, esbuild build clean (after building the `@cluesmith/codev-sdk`
workspace dep first — the type/build errors before that were the unbuilt dep, not
my change). Committed as `Fix #1431: ...`.

## PR phase

PR #1442 opened (Fixes #1431). CMAP consult needs `--project-id bugfix-1431` —
auto-detect fails because the worktree's `codev/projects/` holds every project.
Running all three (gemini/codex/claude) in the background.

## CMAP verdicts

- gemini = APPROVE (HIGH) — "clean, minimal fix … with unit test coverage."
- claude = APPROVE (HIGH) — "correct one-line gate mapping … backed by a genuine
  regression test; scope and hygiene are clean."
- codex  = UNAVAILABLE — the codex lane errored on OpenAI billing ("no credits
  remaining"), not a review verdict. Environment issue, unrelated to this change.

Two independent APPROVEs, no requested changes. Notifying architect and firing the
pr gate; codex reported honestly as unavailable rather than a fabricated verdict.
