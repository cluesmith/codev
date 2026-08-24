# PIR Review: forward-hunk / feedback-hunk press erroring inside a visibly changed hunk

Fixes #1534

## Summary

The VS Code reviewer's "forward the change under the cursor" press verbs (`forward-hunk` /
`feedback-hunk`, deck-driven, plus the in-editor commands) intermittently failed with
**"Codev: place the cursor in a changed hunk"** while the cursor was visibly inside a green
changed region. The press validated the cursor against `entry.hunks` — a `git diff` parsed once
when the diff opened and never refreshed — which drifts from what is actually on screen (the
builder keeps committing) and cannot represent a deletion-only change (no new-side line), even
though the dial rotation that *placed* the cursor navigates VS Code's live compare-editor model.
The fix routes both press paths and the Cmd/Ctrl+K H keyboard path through one shared resolver
that re-parses the file's diff **fresh at press time** and **degrades symbol → hunk → file**
instead of erroring, and replaces the misleading message with an honest one.

## Files Changed

`git diff --stat` against the merge-base (source only; the same commit also adds this review and
a lessons-learned entry):

- `apps/vscode/src/commands/press-cursor-ref.ts` (+83 / -0) — **new** shared resolver
- `apps/vscode/src/__tests__/press-cursor-ref.test.ts` (+83 / -0) — **new** unit tests
- `apps/vscode/src/extension.ts` (+24 / -20) — both cursor handlers route through the resolver
- `apps/vscode/src/review-queue/feedback.ts` (+16 / -8) — `hunkAnchor` async via the resolver
- `apps/vscode/src/commands/view-diff.ts` (+12 / -2) — 3 entry-construction sites pass the new fields
- `apps/vscode/src/diff-inject-codelens.ts` (+5 / -0) — entry gains `baseRef` + `worktreePath`
- `apps/vscode/src/__tests__/feedback.test.ts` (+34 / -2) — staleness + whole-file-fallback cases
- `apps/vscode/src/__tests__/{builder-review-ranges,diff-codelens-mode,diff-inject-context-key,submit-review}.test.ts` — fixture updates for the two new required fields

## Commits

`git log main..HEAD --oneline` (excluding porch bookkeeping commits):

- `6c5fc1346` [PIR #1534][Phase: implement] fix: resolve forward/feedback-hunk press against a fresh, degrading hunk model
- `1b4f7afdc` [PIR #1534] Plan draft

## Test Results

- `check-types` (tsc, both tsconfigs): ✓ pass (clean, after building the workspace deps —
  see Lessons)
- `porch check 1534`: ✓ build, ✓ tests
- `pnpm test:unit` (vitest): ✓ 882 passed; **6 new** (`press-cursor-ref.test.ts` ×4:
  fresh-parse-catches-stale, deletion-only→symbol, no-coverage→file, git-fail→frozen-fallback;
  `feedback.test.ts` ×2: fresh-parse-over-stale, whole-file fallback never emits the old error).
- Verification honesty: this was verified by **unit tests + source tracing**. The physical
  Stream Deck dial-press run was scripted and handed to the deck owner; no deck-run result has
  been relayed back as of this writing. The `dev-approval` gate was approved by the human on his
  word, with that provenance understood — **not** on a deck-verified result. If a deck run is
  performed later, its result can be appended here.

## Architecture Updates

No arch changes. This is a bug fix inside the VS Code extension's existing diff-inject seam; it
adds no module boundary, no cross-package contract, and no system-shape fact. `entry.hunks`
consumption stayed local to `apps/vscode`; `DiffInjectSessionEntry` gained two fields but remains
an apps/vscode-local type (it is not in `@cluesmith/codev-types`), so no HOT `arch-critical.md`
fact and no COLD `arch.md` reference detail is warranted.

## Lessons Learned Updates

Routed one COLD entry to `codev/resources/lessons-learned.md` (Debugging and Root Cause Analysis
section) — a reusable pattern, not a per-spec changelog, so it does not belong in the hot,
capped `lessons-critical.md`:

> An error that tells the user to satisfy a condition they *visibly already satisfy* is almost
> always validating against a stale or parallel model of the world, not the user's action —
> treat the message as a lead, not a fact. Includes the two-models-drift shape (a snapshot vs a
> live model), the structural deletion-only mismatch that survives a fresh parse, the
> resolve-fresh-and-degrade fix pattern, and the API ceiling on true single-model unification
> (`textEditorDiffInformation` is a **proposed** API — clean only under an IDE-bundled build
> with a `product.json` grant).

## Things to Look At / Follow-ups

- **Residual (deliberately out of scope):** rotation (VS Code's compare-editor model) and press
  (our git parse) remain two models. After this fix the disagreement can no longer error or
  mis-scope — a deletion the rotation stops on degrades to the enclosing symbol/file — but they
  are not literally unified. True single-model navigation (issue direction "c") would let the
  press read the editor's own computed change regions and delete our parser. That is blocked
  today: those regions are exposed only via the **proposed** `textEditorDiffInformation` API
  (sole consumer: the built-in git extension), which a marketplace extension cannot enable — it
  becomes clean only in an IDE-bundled build with a `product.json` API grant. Worth a separate
  follow-up issue rather than a rider on this fix.
- **Lens position report (not this defect):** a "(lines N-M)" lens sitting above a comment
  banner is usually the *symbol* lens behaving per API (`DocumentSymbol.range` includes leading
  comments), not the frozen-hunk staleness — verified unchanged, not "corrected."
- **No timeout on the press-time git call** (`press-cursor-ref.ts:44`): a healthy worktree
  returns in single-digit ms, and any failure already falls back to the frozen hunks, but a
  pathologically hung `git` (e.g. an index lock) would leave the press pending. Adding
  `{ timeout: 3000 }` to the `execFile` options would degrade a hang straight to the fallback —
  cheap, purely defensive, deferred as it is not part of the observed failure.
- **Scope confirmed clean:** no `apps/streamdeck` changes (the deck sends correct canonical
  verbs; all hunk logic is host-side), no Tower, no `@cluesmith/codev-types`.
