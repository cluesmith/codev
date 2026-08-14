# air-1444 — Stream Deck: re-glyph the catch-all Codev Action

## Issue
`Codev Action` (catch-all verb runner) draws a **terminal** glyph (`icons/action.*`).
#1440 gave the new `open-terminal` action its own terminal-glyph icon. The two now look
near-identical in the Stream Deck action picker. Re-glyph the catch-all, not open-terminal.

## Verification (issue point 3) — done before coding
`CodevAction` (src/actions.ts:63-66) extends `VerbKey` and does NOT override `onWillAppear`.
Only `DevServerAction`/`BuilderAction`/gate keys composite a runtime face via `setImage`.
So the Codev Action key face shows the manifest `States[0].Image` (`icons/action`) directly.
=> The change is NOT picker-only: it fixes both the picker list icon AND the physical key face.

## Approach
- Source: the existing Codev brand mark `icons/plugin.svg` (architect's first candidate).
  Prototyped the render at 72 / 20px — the handshake mark is legible and unambiguously
  not-a-terminal even at 20x20. It survives; no new artwork needed.
- Extend `scripts/render-action-icons.mjs` (from #1440) rather than hand-rolling: add a
  brand-mark source path alongside the glyph source, reuse the same fit fractions
  (KEY_FILL 0.56, LIST_FILL 0.94) and render targets (72/144/20/40).
- No manifest change: `Codev Action` already references `icons/list/action` + `icons/action`;
  only the pixels behind those filenames change.

## Status
- [x] Verify runtime render path
- [x] Prototype brand-mark legibility at 20px
- [x] Extend render script + regenerate action PNGs (brand-mark source in render-action-icons.mjs)
- [x] Tests (172 pass; check-types + build green after building @cluesmith/codev-sdk first)
- [x] PR #1453 with review in body

## Notes
- send-queue/open-terminal PNGs re-encode with different IM metadata but are pixel-identical
  (AE=0) to #1440's committed versions; reverted them so the diff is action-only.
- check-types/build initially failed on missing @cluesmith/codev-sdk/controller — pre-existing,
  fixed by `pnpm --filter @cluesmith/codev-sdk build` (dist wasn't built in the worktree).
- No CMAP: AIR economy, purely declarative asset regen, visually + test-guarded.
