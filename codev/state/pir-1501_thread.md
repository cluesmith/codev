# pir-1501 — Scroll dial can't scroll a spec/plan under review

## Plan phase (2026-08-18)

Investigated the full canvas-command chain end to end before writing the plan. Root cause
confirmed as the issue described: `ScrollNav.onDialRotate` only ever relays the `scroll` verb →
`editorScroll`, which no-ops on the artifact-canvas (a webview, not a text editor). The review
dials work on a spec/plan because `ReviewNav` phase-switches to `sendCanvasCommand`.

Fix shape: add a `viewport-down`/`viewport-up` canvas command pair (traversal, so `count`
repeats it), phase-switch `ScrollNav.onDialRotate` to it in canvas mode. Press stays untouched
(diff-only by design, per #1498 — half-live on canvas is expected).

Key findings that shaped the plan:
- The canvas command vocab has **four** runtime allowlists guarded by compile-time drift asserts
  (types union+TraversalCommand, `canvas-relay.ts`, `canvas-view-registry.ts`,
  `ArtifactCanvas.tsx`) + a type-test classification map. All must gain the new commands or
  `check-types` fails. That's most of the mechanical work.
- The canvas count loop's position signature is `${originLine}:${scrollLeft}` — misses `scrollTop`,
  so a viewport pan would break after one step. Plan adds `scrollTop` to the signature (safe for
  existing commands: still edge-stops, never false-continues).
- The sdk `sendCanvasCommand` is generic over `CanvasCommand` — no sdk change needed.
- `command-relay.ts` (`editorScroll`) stays as the diff/text path — not touched.
- Not skeleton-mirrored: apps/* and packages/artifact-canvas|types|sdk|codev are product code.

Two decisions flagged for the reviewer:
1. Canvas-mode touchstrip label — `Scroll · editor only` is now a lie for rotation. Recommend
   `Scroll · read only` (press still inert). Wording call, confirm on hardware.
2. `VIEWPORT_SCROLL_STEP_PX` — feel parameter, tune on the physical dial at dev-approval (why this
   is a PIR).

Plan written to `codev/plans/1501-stream-deck-the-scroll-dial-ca.md`. Awaiting plan-approval gate.
