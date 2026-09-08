# PIR Review: `composer-open-or-submit` — context-aware canvas command

Refs #1420

## Summary

Adds a single context-aware canvas command, `composer-open-or-submit`, to the artifact-canvas
remote-command vocabulary (spec 1401). The canvas — the only party that knows whether a composer is
open — resolves it against its own `composingLine` state: open the composer at the focused block when
none is open, submit the draft when one is. This lets a stateless controller (the Stream Deck) drive
open-then-submit from one gesture without guessing composer state, which if wrong would re-anchor the
composer and discard an in-progress dictated comment. This is the **bridge-extension half** of the
agreed cross-lane split; the deck dial remapping and touchstrip legibility (issue requirements 3–4)
are streamdeck's follow-on lane, sequenced after this command merges.

## Files Changed

Scoped to this branch (`git diff --stat` at the merge-base), code + tests:

- `packages/types/src/canvas-command.ts` (+9 / -0) — new union member + type doc-comment
- `packages/types/type-tests/canvas-command.type-test.ts` (+1 / -0) — CLASSIFICATION map entry
- `packages/codev/src/agent-farm/servers/canvas-relay.ts` (+1 / -0) — Tower relay allowlist
- `packages/codev/src/agent-farm/__tests__/canvas-relay.test.ts` (+16 / -1) — relay round-trip + count-rejection
- `apps/vscode/src/markdown-preview/canvas-view-registry.ts` (+1 / -0) — host allowlist
- `packages/artifact-canvas/src/components/ArtifactCanvas.tsx` (+16 / -0) — `canvasActions` entry
- `packages/artifact-canvas/src/adapters/CommandAdapter.ts` (+6 / -1) — doc-comment refresh
- `packages/artifact-canvas/src/__tests__/remote-commands.test.tsx` (+71 / -0) — open/submit/empty-no-op coverage

Non-code (protocol artifacts): `codev/plans/1420-*.md`, `codev/state/pir-1420_thread.md`, `status.yaml`.

## Commits

`git log main..HEAD --oneline` (implementation commits only):

- `3c719dac6` [PIR #1420] feat: add composer-open-or-submit canvas command
- `22cafa2fa` [PIR #1420] test: assert no-re-anchor; refresh CommandAdapter prose

## Test Results

- `pnpm build` (types + artifact-canvas + codev): ✓ pass
- `pnpm --filter @cluesmith/codev-artifact-canvas test`: ✓ 176 passed (3 new)
- `pnpm --filter @cluesmith/codev test`: ✓ 4850 passed, 48 skipped (2 new, incl. relay round-trip)
- `codev-types` `check-types` + `check-types:tests`: ✓ clean
- `codev-vscode` `check-types` (src + webview): ✓ clean
- Manual verification: exercised at the `dev-approval` gate — open-then-submit via `sendCanvasCommand`
  against a running canvas view, `Esc`-between-presses re-opens rather than submitting a discarded
  draft.

## Architecture Updates

No arch-doc changes. This adds one member to the already-documented, closed `CanvasCommand` vocabulary
(spec 1401); it changes no module boundary, transport, or invariant. The one structural fact worth a
future contributor knowing — that a new `CanvasCommand` member must be added to **four**
`satisfies`-guarded enumerations (the union, the type-test CLASSIFICATION map, Tower's relay allowlist
in `canvas-relay.ts`, and the host allowlist in `canvas-view-registry.ts`) plus the `canvasActions`
map — is already enforced by those compile-time guards themselves: omitting any one fails the build,
so it needs no prose in the hot-capped `arch-critical.md`.

## Lessons Learned Updates

No new hot-tier lesson. The design principle here — a context-dependent decision belongs to the party
that owns the state (the canvas), never to a stateless client that would have to guess — is an
application of the existing `lessons-critical.md` entry "Single source of truth beats distributed
state." One spec-narrow observation, recorded here rather than promoted: the issue's requirement list
enumerated three allowlists to update but there were four (Tower's own relay validation was the
omitted one); the `satisfies readonly CanvasCommand[]` + `Assert` guards on every list are what turned
that undercount from a latent production 400 into a compile error caught before the first test run.

## Things to Look At During PR Review

- **`Refs #1420`, not `Fixes` — deliberate (raised by Codex at the PR consultation, REQUEST_CHANGES).**
  Issue #1420 enumerates requirements 1–5; this PR is the bridge-extension lane and lands 1, 2, and 5,
  but requirements 3 (deck dial remap) and 4 (touchstrip legibility) remain for streamdeck's follow-on
  lane. Auto-closing #1420 on merge would drop that remaining work on the floor, so the PR body
  references the issue rather than closing it. **Human decision at the `pr` gate:** if the follow-on
  work is (or will be) tracked under its own issue / #1410 and #1420 should close with this merge,
  switch back to `Fixes #1420` or close the issue manually. This finding gets no automated
  re-review (PIR consultation is single-pass), so it is surfaced here and to the architect.
- **The open-vs-submit branch reads `composingLine` live.** `canvasActions` is rebuilt every render
  and `runCanvasCommandRef.current` is refreshed every render (`ArtifactCanvas.tsx:996-1001`), so the
  action body sees the current `composingLine`. `composer-cancel` already relies on this exact
  pattern. If that render-freshness assumption were wrong, the command would resolve against a stale
  state — the "submits on second press" test is what pins it.
- **Draft-safety rests on `CommentComposer.submit()`'s empty guard** (`overlays/CommentComposer.tsx`),
  which trims and returns early on an empty body. The open+empty press routes to `submit()`, so it is
  a no-op that leaves the composer mounted — it never writes an empty comment and never re-anchors.
  The empty-draft test asserts the composer's line-scoped `aria-label` is unchanged after moving the
  cursor and pressing again, so a wrong branch resolution (which would re-open at the new line) fails
  it directly.
- **Edit composer shares `composingLine`.** A press while editing an existing comment (the pencil
  path) routes to submit-the-edit, not a re-anchor that would discard it — correct, and worth
  exercising.

## How to Test Locally

For reviewers pulling the branch:

- **View diff**: VSCode sidebar → right-click builder `pir-1420` → **Review Diff**
- **Run dev**: VSCode sidebar → **Run Dev**, or `afx dev pir-1420`
- **What to verify** (maps to the plan's Test Plan):
  - With a canvas view open and Tower running, POST `composer-open-or-submit` to
    `/api/canvas/command` (or via the sdk): first call opens the composer at the focused block.
  - Type a comment, POST again: it submits (a marker is written).
  - Press `Esc` to cancel between the two POSTs, then POST again: it re-opens rather than submitting a
    discarded draft.
  - Send `count` with the command: Tower answers `invalid-request` (400) — it is non-traversal.

## Follow-on (not this lane)

`apps/streamdeck/src/actions.ts` still sends `composer-open` on the review-dial press. The deck remap
(fine dial → `composer-open-or-submit`, coarse dial → `composer-cancel`) and touchstrip legibility are
streamdeck's follow-on lane, coordinated with #1410's layout work.
