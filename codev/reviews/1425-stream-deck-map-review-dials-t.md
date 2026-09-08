# PIR Review: Map canvas review dial presses to composer-open-or-submit / composer-cancel

Fixes #1425

## Summary

The bridge command `composer-open-or-submit` shipped on main in PR #1424 (the #1420 bridge
lane) but nothing on the Stream Deck sent it, so the hands-free review flow did not exist on
hardware. This PR is the deck half: in canvas/review mode the **fine** review dial press now
sends `composer-open-or-submit` (open the composer, or submit the open draft) and the
**coarse** dial press sends `composer-cancel`, superseding #1400's shared `composer-open`.
The touchstrip line 1 now pairs each dial's rotate axis with its press meaning
(`Blocks · Open/Submit`, `Headings · Cancel`) so a reviewer can tell submit from cancel at a
glance. Changes are confined to `apps/streamdeck`.

## Files Changed

- `apps/streamdeck/src/actions.ts` (+21 / -5)
- `apps/streamdeck/src/__tests__/actions.test.ts` (+13 / -10)

(Plan, thread, and porch status files also travel on the branch but are not part of the
runtime change.)

## Commits

- `fe813cbe3` [PIR #1425] Remap canvas review dial presses: fine open/submit, coarse cancel
- `561123043` [PIR #1425] thread: implement phase done, at dev-approval

## Test Results

- `pnpm --filter @cluesmith/codev-streamdeck check-types`: ✓ pass
- `pnpm --filter @cluesmith/codev-streamdeck test`: ✓ pass (84 tests; press/title assertions
  updated, no net new test files — the new behavior folded into the existing canvas-press and
  canvas-legibility tests)
- `pnpm --filter @cluesmith/codev-streamdeck build`: ✓ pass (esbuild → `bin/plugin.js`)
- porch `build` + `tests` checks: ✓ pass
- Manual verification (dev-approval, physical Stream Deck+): the deck was sideloaded from
  this lane's worktree build and the issue flow was exercised — navigate to a block, fine
  press opens the composer, dictate, fine press submits; coarse press cancels an open
  composer; a fine press on an open-but-empty composer is a no-op (draft preserved). Approved
  at the dev-approval gate. Restore target after the session is a fresh main-checkout build
  (per the plan), which frees the pir-1400 worktree for the #1176 orphan sweep.

## Architecture Updates

No arch changes. This is a client-side dial remap inside an existing pattern: `CanvasSpec`
already parameterised the canvas-mode rotate/tap verbs per dial; this PR adds a `press` verb +
`pressLabel` to the same spec. No module boundary, process boundary, or system-shape fact
changed — nothing rises to `arch-critical.md` or `arch.md`.

## Lessons Learned Updates

No governance-doc edit. The two gotchas here are streamdeck-sideload-local and already
documented, so they stay in this review rather than in `lessons-learned.md`:

- **Sideload builds must run from the worktree root, not the main checkout.** `pnpm --filter
  @cluesmith/codev-streamdeck build` resolves against the nearest pnpm workspace, so running
  it from the main checkout builds *main's* `apps/streamdeck` and you sideload the wrong
  `bin/plugin.js`. The plan's swap commands `cd` into the worktree first. (Consistent with the
  existing "run tests/build from the worktree" rule.)
- **Build the sdk dist before type-checking the plugin.** `apps/streamdeck` imports
  `@cluesmith/codev-sdk/*`; a fresh worktree has no sdk `dist/`, so `check-types` fails to
  resolve the module until `pnpm --filter @cluesmith/codev-sdk build` runs once. (Already in
  `apps/streamdeck/README.md`.)

## Things to Look At During PR Review

- **Consultation dispositions** (review-phase 3-way, iter 1): gemini APPROVE, claude APPROVE,
  codex COMMENT. Codex flagged one stale source comment — the `ReviewNav` class doc still said
  canvas presses "open the composer at the focused block," which no longer holds after the
  per-dial remap. Fixed the comment to describe fine=open-or-submit / coarse=cancel (no
  behavior change). No REQUEST_CHANGES from any reviewer.
- **`renderTo` title composition** (`actions.ts`): canvas mode now emits
  `` `${label} · ${pressLabel}` ``; diff mode still emits the bare `diff.label`. Confirm the
  diff-mode path is untouched (the mode-transition test covers `Headings · Cancel` → `Files`).
- **Contextual label wording**: the fine dial press is `composer-open-or-submit` (open, then
  submit), labelled `Open/Submit` rather than `Submit` to stay honest about the first press.
- **Touchstrip width**: `Blocks · Open/Submit` (~20 chars) is the widest line-1 string. It was
  checked on hardware at dev-approval; the pre-approved fallback if it ever clips on a
  different layout is `Blocks · Submit`.
- **Verb validity**: both `composer-open-or-submit` and `composer-cancel` are existing
  `CanvasCommand` members, in the canvas-relay allowlist, and implemented in the
  `ArtifactCanvas` action map — this PR only routes the deck to them, no bridge/canvas/types
  change.

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder pir-1425 → **Review Diff**
- **Unit**: from the worktree root, `pnpm --filter @cluesmith/codev-sdk build` then
  `pnpm --filter @cluesmith/codev-streamdeck test`
- **Hardware** (optional re-verify): build from the worktree root, `streamdeck unlink
  com.cluesmith.codev`, `streamdeck link <abs path>/.builders/pir-1425/apps/streamdeck/com.cluesmith.codev.sdPlugin`,
  `streamdeck restart com.cluesmith.codev`; then in canvas mode: fine press opens → dictate →
  fine press submits; coarse press cancels; fine press on an empty open composer is a no-op.
