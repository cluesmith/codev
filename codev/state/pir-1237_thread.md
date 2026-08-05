# Builder thread — pir-1237

## 2026-08-05 — Plan phase

- Spawned as PIR builder for #1237 (keyboard-first review navigation in artifact-canvas).
- **Scope expanded by architect mid-plan**: this PIR is the full artifact-canvas batch — #1236 ('+' affordance disappears + undersized; first implementation phase), #1232 (uniform arrow cursor over content), #1237 (jump keys, focus audit, minimap focus, discoverability). One plan, one PR, `Fixes #1232, Fixes #1236, Fixes #1237`.
- Re-verified all three issues' file:line diagnoses against current source — all hold. Key extra finding while tracing #1237's focus audit: submit/delete lose focus because the marker write shifts the `data-line` map → `html` changes → the innerHTML effect rebuilds the body and destroys the focused element. Esc-cancel is already correct (no rebuild on cancel).
- Plan written to `codev/plans/1237-artifact-canvas-keyboard-first.md`: Phase A #1236 (200ms grace + overlay pin + font-size token + 24px hit target), Phase B #1232 (one `cursor: default` rule on the body), Phase C #1237 (n/p, ]/[, Home/End jump keys; `pendingFocusLineRef` restoration across rebuilds; minimap dots focus target block; `?` keys legend).
- Sitting at `plan-approval` gate.

## 2026-08-05 — Implement phase

- Plan approved as written. Implemented all three phases:
  - **A (#1236)**: split `activateFromTarget` into mouse/focus paths; single `graceTimerRef` (200ms, `OVERLAY_GRACE_MS`) covers both mouseleave-dismiss and block-crossing re-anchor; `overlayPinnedRef` pins while the pointer is on the overlay (stale pins ignored when no overlay is up, reset in `openComposer`). CSS: overlay inherits `--codev-canvas-font-size`, button min 24×24px.
  - **B (#1232)**: `cursor: default` on `.codev-artifact-canvas-body`.
  - **C (#1237)**: `onBodyKeyDown` handles n/p (commented blocks), ]/[ (headings), Home/End, `?` legend toggle — all guarded on the event originating from a `[data-line]` block; `pendingFocusLineRef` records the working block on submit/edit/delete and the decoration effect restores focus after the post-write rebuild (nearest-preceding fallback); minimap dots focus the target block before scrolling; new `KeyboardHelp.tsx` legend.
- New tests: hover-affordance (fake-timer grace machine), keyboard-nav (jumps, guards, focus restoration, legend), minimap focus handoff, theme rule assertions.
