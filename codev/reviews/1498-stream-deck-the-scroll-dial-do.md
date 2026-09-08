# PIR Review: Scroll dial narrates itself (mode, builder, empty state, canvas honesty)

Fixes #1498

## Summary

The Stream Deck Scroll dial was the only touchstrip dial that did not narrate itself — a
static `setTitle('Scroll')`, no store subscription, no `setFeedback` — even though its
press is the one mode-dependent gesture on the board (forward-now vs stage-into-queue per
`codev.diffCodelensMode`). It now renders the house pattern: line 1 pairs the axis with a
qualifier (`Scroll · send` / `Scroll · queue` in diff/editor mode; `Scroll · editor only`
in canvas mode), line 2 names the selected builder (`No builder` when none), and there is
no progress bar (the dial's rotation and any builder-progress bar are unrelated axes). The
root fix has two halves — a manifest layout declaration and the render code — because the
dial was *declared* title-only, not merely un-rendered.

## Deviation From the Approved Plan

The approved plan specified only the `send` / `queue` line-1 qualifiers. The third
qualifier, **`Scroll · editor only` for canvas mode, was added after plan approval** — the
owner (Amr) ruled during the dev-approval hardware session that the dial silently doing
nothing on a spec/plan violated this lane's own "inert must be visibly inert" principle, so
the canvas-mode honesty was absorbed here rather than deferred. It landed *before*
dev-approval was granted, was flagged to the architect in the thread, and is unit-tested —
human-visible, not silent scope creep. Naming it explicitly here so the `pr` gate is clean.
(The separate *capability* gap — actually scrolling a canvas — stayed out of scope as
follow-up #1501.)

## Files Changed

Against `git merge-base main HEAD` (`9129ab81c`):

- `apps/streamdeck/src/actions.ts` (+79 / -) — `ScrollNav` rewritten to a store-subscribed
  dial; shared `selectedBuilderLine` helper (also adopted by `ReviewNav`); canvas-mode
  qualifier.
- `apps/streamdeck/src/__tests__/actions.test.ts` (+54 / -) — ScrollNav render coverage.
- `apps/streamdeck/com.cluesmith.codev.sdPlugin/layouts/title-value.json` (+24 / -0) — new
  title+value layout (no bar).
- `apps/streamdeck/com.cluesmith.codev.sdPlugin/layouts/label.json` (−15) — deleted (orphaned).
- `apps/streamdeck/com.cluesmith.codev.sdPlugin/manifest.json` (+4 / −) — scroll-nav layout
  repoint + Push description.
- `codev/reviews/1495-stream-deck-architect-action-k.md` (+21 / -0) — folded #1462 protocol
  note from the merged pir-1495 lane (separate commit, per architect).
- Plan, thread, porch status.

## Commits

`git log main..HEAD --oneline` (implementation, excluding porch chores):

- `8773d096e` [PIR #1498] Scroll dial: title+value touchscreen layout (no bar), retire label.json
- `46f881652` [PIR #1498] Scroll dial narrates itself: mode-aware line 1, selected builder line 2, inert empty state
- `69a149a2b` [PIR #1498] docs: land stranded #1462 protocol note into 1495 review (folded from pir-1495 lane)
- `3667cbc85` [PIR #1498] Scroll dial: 'Scroll · editor only' in canvas mode (both gestures inert), cross-ref #1501
- (plus plan/thread commits)

## Test Results

- `pnpm --filter @cluesmith/codev-streamdeck build`: ✓ pass
- `pnpm --filter @cluesmith/codev-streamdeck test`: ✓ pass (238 tests, 5 new/updated ScrollNav cases)
- `check-types` (tsc --noEmit): ✓ pass
- `validate` (manifest ↔ layouts): ✓ pass
- **Manual (dev-approval, hardware, VS Code extension 3.3.0 — all five checks attested):**
  1. Diff-phase builder → `Scroll · send` + `#id title`, no bar; rotation scrolls the editor.
  2. Forward mode: press forwards the selection to the builder immediately.
  3. Queue mode: line 1 flips to `Scroll · queue`; press stages into the review queue and the
     Send Fb badge increments (builder not interrupted).
  4. No builder selected: `No builder`; press inert.
  5. Canvas mode (spec/plan-phase builder): `Scroll · editor only`; both rotation and press inert.

  (All five ran under VS Code, whose 3.3.0 extension knows the `feedback-*` verbs, so the
  press-path checks 2–3 were genuinely exercised, not silently dropped.)

## Architecture Updates

No HOT (`arch-critical.md`) change: this is a single-dial legibility fix inside the already
established touchstrip pattern (subscription + `setFeedback` + `reviewMode`), not a new
system-shape invariant. No new module boundary, wire field, or state.

The durable architectural finding — the deck's two Scroll-dial gestures have **different
reach into VSCode** (rotation = any text editor via `editorScroll`; press = builder-diff
only via `feedback-selection`, whose `activeEntry()` requires a tracked diff entry) — is a
reference detail about the deck↔VSCode command surface, recorded below under Lessons
Learned (COLD) and in the finding section rather than promoted to an invariant.

## Lessons Learned Updates

Routed one COLD entry to `codev/resources/lessons-learned.md` (## Testing): the
default-fixture semantic trap (below). The two other findings reinforce an existing HOT
lesson ("Verify reviewer/plan claims against the actual file before acting") rather than
adding a new one — the press-also-dead result came precisely from reading the code against
a premise asserted as fact, so the existing rule already covers it.

### The four durable findings (the record for this lane)

**1. The two gestures have different scopes — this outlives the wording.** Rotation is
any-text-editor (`editorScroll`); the press is builder-**diff**-only (`feedback-selection`
→ `feedbackSelection` → `selectionAnchor()` → `activeEntry()`, which returns undefined
unless the focused document is a tracked builder-diff entry — `feedback.ts:48-90`). No
single mode label can describe both gestures in every state, which is *why* canvas mode
shows `editor only` rather than a delivery-mode qualifier: on a spec/plan (an
artifact-canvas webview) there is neither an active text editor nor a diff entry, so both
gestures are inert.

**2. The root cause was a declaration mismatch, not missing render code.** Five dials
declared `layouts/dial.json`; this one declared `layouts/label.json`, so it was built
title-only *by manifest* and the code merely agreed with it. That is why the fix has a
manifest half (new `title-value.json`, retire `label.json`) as well as a code half.

**3. A green test that was semantically wrong (the fixture trap).** The original
`Scroll · send`/`queue` assertions ran against `pir-1`, the fixture default — which is
blocked at plan-approval and therefore **canvas** mode. They passed while asserting a
delivery-mode label for a builder that should never show one. The bug was invisible until
canvas mode was given meaning, which flipped that builder's expected label to
`editor only`. The next person adding a mode-dependent assertion will reach for the same
default fixture; pick the builder whose phase matches the mode under test (`pir-2` is diff).

**4. #1501 scope correction.** A canvas viewport-scroll capability (#1501) would revive
**rotation** only; the press stays diff-bound by design. So `Scroll · editor only` will
*narrow* (rotation starts working) rather than *disappear* when #1501 lands — it does not
simply collapse back to `send`/`queue`.

## Things to Look At During PR Review

- `ScrollNav.renderTo` (`actions.ts`): the three-way qualifier (`editor only` / `queue` /
  `send`) and its render-site comment. The press is deliberately **not** gated on
  `reviewMode` — it no-ops server-side in canvas mode already, and gating it deck-side would
  add state for no behavioural gain.
- The shared `selectedBuilderLine` helper: `ReviewNav` now calls it too. Its output is
  byte-identical to the inlined logic it replaced, which is what keeps `ReviewNav`'s existing
  string assertions green — worth confirming that equivalence held.
- The fixture trap (finding 3): the diff/queue tests were moved onto `pir-2`.

## How to Test Locally

For reviewers pulling the branch:

- **View diff**: VSCode sidebar → right-click builder `pir-1498` → **Review Diff**.
- **Run on hardware**: build the sdk then the plugin, `streamdeck link` the *worktree's*
  `com.cluesmith.codev.sdPlugin`, `streamdeck restart com.cluesmith.codev`, confirm with
  `streamdeck list`. A manifest/layout change may need a full quit+reopen of the Elgato app.
- **What to verify**: the five hardware checks above — both delivery modes, the no-builder
  state, and a spec/plan-phase builder for `Scroll · editor only`.

## Flaky Tests

None.
