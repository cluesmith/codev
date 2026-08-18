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

## Implement phase (2026-08-18)

Plan APPROVED by Amr (gate minted by architect). Decision 1 ruled: `Scroll · read only` (reasoning:
names what works; `no send` rejected — `send`/`queue` are delivery modes, so `no send` wrongly
implies queuing). Decision 2: `VIEWPORT_SCROLL_STEP_PX = 60`, tune on hardware at dev-approval.

Production code implemented (NOT committed yet):
- types: `viewport-down`/`viewport-up` added to `CanvasCommand` + `TraversalCommand` + type-test map.
- 3 runtime allowlists updated (canvas-relay, canvas-view-registry, ArtifactCanvas TRAVERSAL_COMMANDS).
- ArtifactCanvas: `scrollViewport` helper + `VIEWPORT_SCROLL_STEP_PX=60`; count-loop position
  signature extended `${originLine}:${scrollLeft}:${scrollTop}` (the sharp one-liner — without it a
  multi-tick rotate scrolls once).
- ScrollNav.onDialRotate: mode split keyed on `'canvas'` SPECIFICALLY (never "not diff", so `none`
  keeps editorScroll); canvas branch sends viewport-down/up via sendCanvasCommand, count=|ticks|,
  workspace-only target; transient `status` line for canvas errors (parity with ReviewNav).
- ScrollNav.renderTo: canvas qualifier `editor only` → `read only`, doc comment carries the reasoning.

STOP-AND-TELL (architect's literal non-regression): streamdeck suite = 238 passed, 2 failed.
- :669 label test → `read only` (ruled change, authorized).
- :638 "scrolls the editor on rotate" FAILS. But the diff path did NOT move: the #1505 guard at :704
  asserts editorScroll-rotate byte-for-byte and is GREEN. :638 fails only because its fixture is the
  default selection pir-1 = canvas mode, and it predates the mode split (rotate used to be
  mode-independent). Architect said to stop before editing :638 — sent evidence + proposed fix
  (repoint :638 rotate to pir-2 diff mode; add a canvas-mode rotate test; update :669). HOLDING for ruling.

## Implement phase — ruling applied + consult (2026-08-18)

Architect ruled: (a) repoint :638 in place with mode stated, (b) add canvas-mode rotate test,
(c) :669 → read only. Plus audit rest of ScrollNav block for latent mis-fixtures. Done all;
audit found NOTHING else exposed (negative result reported). 6 commits pushed.

Correctness find during implement (beyond plan): the canvas body is NOT the vertical scroller —
in vertical mode the HOST PAGE scrolls (viewportStartLine measures window top;
preview-template.ts leaves body overflow default). Plan said pan root.scrollTop (would no-op in
VS Code). Fixed: pan document.scrollingElement; count-loop signature tracks that scroller's
scrollTop. Proven by 4 new Playwright tests in real Chromium.

CMAP (impl review, borrowed aspir template + --project-id 1501 after tooling friction):
- Gemini APPROVE (no issues); Codex COMMENT (stale doc comment); Claude REQUEST_CHANGES.
- Addressed: (1) stale ScrollNav CLASS-level doc comment still said "editor only / both inert"
  (I'd updated renderTo's doc but missed the class header — real miss) → fixed; (2) README.md:282
  Scroll bullet lacked the mode split unlike siblings → fixed; (3) host-contract note made
  explicit in scrollViewport (no speculative fallback — it'd also no-op; matches viewportStartLine's
  single assumption); nit removed dead cancelWheelGlide call (glide is horizontal-only, pan is
  vertical-only) + fixed misleading comment; nit ternary→if/else (user pref).
- Declined (noted for dev-approval / review): focus-ring re-arm on pure pan via runCanvasCommand
  (eyeball on hardware); ReviewNav.runCanvas duplication (would widen diff into ReviewNav; low pri).
- Re-verified after fixes: streamdeck 242, artifact-canvas 177 unit + 10 Playwright, all check-types.
