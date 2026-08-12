# PIR Review: SD+ Automatic diff press opens the builder's first file diff (dial-ready)

Fixes #1414

## Summary

The Stream Deck Builder Action **Automatic** press previously fired `view-diff` for a
diff-phase builder, opening VSCode's multi-file **aggregate** diff editor — the wrong
landing spot for the SD+ per-file review dials. This adds a builder-id-scoped relay verb
`open-diff-first` (→ new `codev.openBuilderDiffFirstFile`) that opens the builder's **first
changed file in per-file diff mode** and seeds the dial navigation anchor there, and points
only the Automatic diff branch at it. The explicit **View Diff** PI option is unchanged
(still aggregate), and the shared `phaseArtifactVerb` / `zoomInVerb` / `reviewMode` resolvers
are untouched.

## Files Changed

(vs merge-base `5bfbc6595`)

- `apps/vscode/src/commands/diff-nav.ts` (+45 / -7) — `resolveDiffContext` gains an optional explicit `seed`; new `navigateBuilderDiffToFirst(builderId, deps)`
- `apps/vscode/src/extension.ts` (+6 / -1) — register `codev.openBuilderDiffFirstFile`
- `apps/vscode/src/command-relay.ts` (+1 / -0) — `'open-diff-first' → codev.openBuilderDiffFirstFile` in the provider-side allowlist
- `apps/streamdeck/src/actions.ts` (+5 / -1) — `BuilderAction.resolveVerb` remaps the Automatic `view-diff` result to `open-diff-first`
- `apps/vscode/src/__tests__/diff-nav.test.ts` (+83 / -4) — 4 tests: happy path (opens file 0, seeds anchor), empty-list flash, no-worktree flash, falsy-id flash
- `apps/vscode/src/__tests__/command-relay.test.ts` (+10 / -0) — verb maps to the command with the builder-id arg
- `apps/streamdeck/src/__tests__/actions.test.ts` (+13 / -0) — Automatic → `open-diff-first`; explicit `view-diff` still verbatim

## Commits

- `679ab20e1` [PIR #1414] vscode: add builder-id-scoped open-diff-first verb (first file diff, dial-ready)
- `71db33dfb` [PIR #1414] streamdeck: point Builder Action Automatic diff branch at open-diff-first
- `581fb7517` [PIR #1414] thread: implement-phase log

## Test Results

- `npm run build` (porch `build` check): ✓ pass (8.8s)
- `npm test` (porch `tests` check): ✓ pass (29.7s)
- Unit: vscode 812 tests / 68 files ✓; streamdeck 86 tests / 5 files ✓; both `check-types` clean. (Fresh worktree required `pnpm --filter @cluesmith/codev-types build` and `… codev-sdk build` before vitest — see lesson [From 936].)
- Manual (hardware SD+, dev-approval gate): the human approved the gate. **A clean in-session hardware confirmation of the new first-file-diff open was NOT captured**: the physical deck was found still linked to a sibling worktree's bundle (`pir-1425`, via `streamdeck list`), so it kept firing the old `view-diff` and the aggregate opened. That was a link/load issue, not the code — this branch's built bundle contains `open-diff-first` and the verb-level behavior is covered by unit tests on both halves. See **Things to Look At** for the residual hardware check and the zoom-in follow-up.

## Architecture Updates

No HOT arch change. This adds one relay verb inside the existing provider-side allowlist
pattern (`VERB_COMMANDS` in `command-relay.ts` is the security boundary; the server relay
stays a pure passthrough) and one editor-context command — no module-boundary shift, no new
subsystem, nothing that belongs in `arch-critical.md` or `arch.md`.

## Lessons Learned Updates

Routed one COLD lesson to `codev/resources/lessons-learned.md` (Testing) — the dual-artifact
hardware-testing trap surfaced live at the dev-approval gate: a Stream Deck feature spans two
independently-loaded artifacts (the deck plugin bundle and the VSCode extension provider), and
a sibling worktree's live `streamdeck link` silently served the stale `actions.ts`, so the deck
fired the pre-change verb even though this branch's bundle was built. The lesson records the
`streamdeck list` diagnosis and the aggregate-vs-nothing symptom that localizes the stale half.

(No HOT lessons change — this is a spec-narrow testing recipe, not an always-inject rule.)

## Things to Look At During PR Review

- **Scope of the remap.** The `view-diff → open-diff-first` swap lives ONLY in
  `BuilderAction.resolveVerb`, deliberately not in the shared `phaseArtifactVerb`. Confirm the
  reasoning holds: `reviewMode` classifies on `verb === 'view-diff'` (`actions.ts:264`) and
  `zoomInVerb` reuses the shared resolver, so remapping at the source would have broken both.
- **Defined empty/error outcomes.** Per main's dev-review addendum, the seeded path must end in
  a user-visible status-bar flash (never a silent no-op / throw) for zero-changed-files,
  no-worktree, and missing-id. The seed replaces only resolve step 1; steps 2–3 (and their
  flashes) still run. Each is pinned by a test in `diff-nav.test.ts`.
- **Residual hardware verification (open).** A clean SD+ confirmation of the first-file open +
  dial seeding was not captured in-session (deck pointed at pir-1425). Worth a quick hardware
  re-check with the deck relinked to a branch build of both artifacts.
- **The "verify-first" question is still open, and the zoom-in follow-up.** #1414 asked whether
  the old aggregate press left the dials navigable. Because the in-session deck ran the old
  bundle, this wasn't answered cleanly. Separately, the **Zoom Navigator touch-strip zoom-in**
  (`zoomInVerb`, `actions.ts:337`) still opens the aggregate by design — out of scope here. If
  the hardware re-check shows the dials need seeding there too, that's a follow-up issue for the
  architect (flagged, not self-expanded).

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder `pir-1414` → **View Diff** (auto-detects the default branch).
- **Run dev**: VSCode sidebar → **Run Dev**, or `afx dev pir-1414`.
- **Hardware SD+** (both halves must be on this branch):
  - Deck: `streamdeck unlink com.cluesmith.codev && streamdeck link .builders/pir-1414/apps/streamdeck/com.cluesmith.codev.sdPlugin && streamdeck restart com.cluesmith.codev` (from the main repo root; `streamdeck list` to confirm). Relink pir-1425 when done.
  - Extension: install this branch's vsix (`pnpm --filter codev-vscode run vsix` → `cursor --install-extension`) and keep that window focused.
  - Verify: a **Builder Action** on **Automatic**, aimed at an implement/review builder with changes, opens **file 1 in per-file mode**; the Files/Changes dial steps from there. An explicit **View Diff** key still opens the aggregate.
