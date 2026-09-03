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
that re-parses the file's diff **fresh at press time**. The two "hunk" press verbs resolve
**hunk-first** (the tight changed range when one covers the cursor, degrading hunk → symbol →
file only when none does — so `forward-hunk` keeps forwarding the exact hunk and no longer
errors); the Cmd/Ctrl+K H keyboard verb keeps its intended **symbol-first** `#1073` design. The
misleading "place the cursor in a changed hunk" message is replaced with an honest one.

## Files Changed

`git diff --stat` against the merge-base (source only; the same commit also adds this review and
a lessons-learned entry):

- `apps/vscode/src/commands/press-cursor-ref.ts` — **new** shared resolver: `resolvePressCursorRef` (hunk-first, the press verbs) + `resolveCursorContextRef` (symbol-first, Cmd+K H), both on the fresh re-parse
- `apps/vscode/src/diff-inject-ref.ts` — extract the symbol/hunk search; add pure `resolveHunkFirstRef` (hunk → symbol → file) alongside `resolveCursorRef` (symbol → hunk → file)
- `apps/vscode/src/extension.ts` — the two handlers route through their respective resolvers
- `apps/vscode/src/review-queue/feedback.ts` — `hunkAnchor` async via the hunk-first resolver
- `apps/vscode/src/commands/view-diff.ts` — 3 entry-construction sites pass the new fields
- `apps/vscode/src/diff-inject-codelens.ts` — entry gains `baseRef` + `worktreePath`
- `apps/vscode/src/__tests__/press-cursor-ref.test.ts` — **new**: fresh-beats-stale, deletion-only→symbol, no-coverage→file, git-fail→frozen-fallback, **hunk-inside-symbol→hunk** (press) vs **→symbol** (keyboard)
- `apps/vscode/src/__tests__/diff-inject-ref.test.ts` — pure `resolveHunkFirstRef` precedence tests
- `apps/vscode/src/__tests__/feedback.test.ts` — staleness + whole-file-fallback cases
- `apps/vscode/src/__tests__/{builder-review-ranges,diff-codelens-mode,diff-inject-context-key,submit-review}.test.ts` — fixture updates for the two new required fields

## Commits

`git log main..HEAD --oneline` (excluding porch bookkeeping commits):

- `6c5fc1346` [PIR #1534][Phase: implement] fix: resolve forward/feedback-hunk press against a fresh, degrading hunk model
- `1b4f7afdc` [PIR #1534] Plan draft

## Test Results

- `check-types` (tsc, both tsconfigs): ✓ pass (clean, after building the workspace deps —
  see Lessons)
- `porch check 1534`: ✓ build, ✓ tests
- `pnpm test:unit` (vitest): ✓ 887 passed; **11 new** across `press-cursor-ref.test.ts` (fresh
  beats stale, deletion-only→symbol, no-coverage→file, git-fail→frozen-fallback, hunk-inside-
  symbol→hunk for the press verb, →symbol for Cmd+K H), `diff-inject-ref.test.ts` (pure
  `resolveHunkFirstRef` precedence: hunk-over-symbol, deletion→symbol, neither→file), and
  `feedback.test.ts` (fresh-parse-over-stale, whole-file fallback never emits the old error).
- Verification honesty: this was verified by **unit tests + source tracing**. The physical
  Stream Deck dial-press run was scripted and handed to the deck owner; no deck-run result has
  been relayed back as of this writing. The `dev-approval` gate was approved by the human on his
  word, with that provenance understood — **not** on a deck-verified result. If a deck run is
  performed later, its result can be appended here.

## How to Test Locally

Run the branch in the worktree: VS Code → right-click builder **pir-1534** → **Run Dev**, or
`afx dev pir-1534`; then **View Diff** (or click a changed-file row) to open a builder diff. The
pure `forward-hunk` / `feedback-hunk` verbs are deck-driven, so the physical dial-press is the
truest reproduction (that hand-off is the streamdeck architect's / Amr's at the gate); the
in-editor **Cmd/Ctrl+K H** exercises the shared fresh-parse resolver without the deck.

- **Deletion-only repro (deterministic, no timing needed):** on the builder branch, make a commit
  that *only removes* lines from a file (no additions in that hunk). Open its diff, rotate the
  dial (or "Go to Next Change") onto that deletion, press `forward-hunk`. *Before:* "place the
  cursor in a changed hunk". *After:* forwards the enclosing symbol / whole file with an honest
  note — no error.
- **Staleness repro:** open a builder diff while the builder is still committing; let it push a
  few commits that shift line numbers; rotate onto a now-green change and press. *Before:* misses
  the frozen ranges → error. *After:* the fresh re-parse forwards the correct current range.
- **Regression (must still hold):** press `forward-hunk` inside an ordinary modification that sits
  inside a function → it forwards the **exact hunk range** (`path:L<start>-L<end>`), *not* the
  whole function. The feedback-queue press enqueues the same range.
- **Keyboard contrast (intended):** put the cursor on that same in-function change and press
  **Cmd/Ctrl+K H** → it forwards the **enclosing symbol** (the whole function). This symbol-first
  behavior is by design (`#1073`) and is deliberately different from the hunk-first press verbs.
- **Automated:** `pnpm --filter codev-vscode test:unit` (vitest) — 887 pass, incl. the precedence
  pinning tests above; `pnpm --filter codev-vscode check-types` for tsc.

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

## Things to Look At During PR Review

- **Press precedence — hunk-first vs symbol-first (resolved after the CMAP pass; please
  confirm).** The first implementation routed *both* the press verbs and Cmd+K H through the
  symbol-first `resolveCursorRef`, which silently broadened `forward-hunk` from the exact hunk to
  the whole enclosing symbol on an ordinary in-function edit — the most common press path. Two of
  the three consult reviewers (Codex, Claude; HIGH confidence) flagged this as contradicting the
  plan's explicit regression promise ("press inside an ordinary modification still forwards the
  exact hunk range"). Resolved by splitting the precedence: the two "hunk" press verbs now use a
  new hunk-first `resolveHunkFirstRef` (hunk wins when one covers the cursor; degrade to
  symbol → file otherwise), while Cmd+K H keeps its intended symbol-first `#1073` behavior. This
  is a deliberate departure from the literal "symbol → hunk → file" shorthand in the architect's
  kickoff for direction (a): the shorthand's intent was "degrade instead of erroring", and
  forwarding the whole function on every ordinary hunk press was an unintended scope change.
  Pinned both directions with tests (`press-cursor-ref.test.ts`, `diff-inject-ref.test.ts`). The
  deletion-only fix is unaffected (a deletion has no hunk → still degrades). **If the intended
  behavior was symbol-first for the press verbs too, flipping back is a one-line change** — say so
  at the gate.

## Follow-ups

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
- **Rename edge (note, not a fix — surfaced by CMAP):** the press-time re-parse filters by the
  *new* pathspec (`git diff … -- <relPath>`), where `-M` cannot pair the rename against the old
  path, so a renamed+modified file may parse as a whole-file add — unlike `viewDiff`, which
  derives hunks from a rename-paired whole-diff `parseUnifiedDiff`. Low impact (hunk-first means a
  covered change still wins, and the whole-file result is a superset, never an error), so left as
  a documented edge rather than a fix.
- **Scope confirmed clean:** no `apps/streamdeck` changes (the deck sends correct canonical
  verbs; all hunk logic is host-side), no Tower, no `@cluesmith/codev-types`.
