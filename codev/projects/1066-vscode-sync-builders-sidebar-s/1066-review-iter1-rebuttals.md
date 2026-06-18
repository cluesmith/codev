# PIR #1066 — Consultation Rebuttals (iteration 1)

Single advisory pass (`max_iterations: 1`). Dispositions below; both actionable findings were fixed in commit `6954515b`, the stale docstring in the same commit.

## Codex — REQUEST_CHANGES (HIGH): reveal gate can hijack a standalone file open

**Agreed — fixed.** The finding is correct. The reveal listener gated only on "the active editor's `fsPath` is in the diff-inject registry" (`extension.ts`), but that registry is keyed by the **right-side worktree file path** (`diff-inject-codelens.ts`), which a *normal* (non-diff) open of that same worktree file also has. So opening a tracked worktree file as a plain editor tab would match the gate and reveal/select its Builders row — a hijack the plan's "no hijack" AC did not intend. (It didn't surface at the dev-approval gate because the case verified there was a *main-repo* source file, which has a different path and isn't in the registry.)

**Change:** added `isStandaloneTextTab` (`packages/vscode/src/diff-tab-input.ts`) and gated the reveal so it returns early when the active tab is a plain `vscode.TabInputText`. The reveal now fires only for diff tabs — the per-file `vscode.diff` (`TabInputTextDiff`) and the multi-file `vscode.changes` View Diff editor.

**Design note:** I gated on "is a plain text tab" rather than the more obvious "is a diff tab" on purpose. `TabInputTextMultiDiff` (the multi-file View Diff's tab input) is **not exported by the stable `@types/vscode@1.105`**, so an `instanceof vscode.TabInputTextMultiDiff` positive gate wouldn't type-check and would risk excluding the multi-file diff. A diff tab is never a `TabInputText`, so the negative gate keeps both diff surfaces working while precisely excluding the standalone-open case.

**Regression test:** `packages/vscode/src/__tests__/diff-tab-input.test.ts` pins: `TabInputText` → skip (the hijack case), `TabInputTextDiff` → reveal, a non-text/custom input and `undefined` → reveal-not-skipped.

## Claude — COMMENT (HIGH): stale test-file docstring

**Agreed — fixed.** The `diff-nav.test.ts` header still read "the edges no-op (no wrap)" after the navigation was changed to wrap around. Updated the header to describe the visible-tree navigation order (git order in flat mode, depth-first tree order in tree mode) and the wrap-around. The tests themselves were already correct; only the docstring was stale.

## Gemini — no usable verdict

The `agy` run returned **sandbox meta-output** (a description of its `--sandbox` configuration) instead of a PR review, with no `VERDICT:` line. There is no actionable content to address. Per the consult tooling's documented behavior (Gemini via `agy` skips non-blockingly when it can't produce a review), I treated this as a non-blocking skip rather than a substantive REQUEST_CHANGES. The two models that did review (Codex, Claude) are both addressed above.

## Escalation

The Codex finding was a real defect and is fixed with a regression test, so nothing remains open. Flagging it to the architect at the `pr` gate for confirmation, since PIR's single-pass consultation does not re-review the fix.
