# Builder thread — spir-1401 (artifact-canvas remote command channel)

## 2026-08-11 — Specify phase started

Porch has me in `specify`. No pre-existing spec, so I'm authoring one from issue #1401.

Architect guidance received at spawn+specify:
- Command set mirrors keyboard vocabulary from #1237 (PR #1344) and #1380 (PR #1398) exactly; composer open/submit/cancel in scope, text entry out.
- Target rule for no-canvas-open / multiple-canvases-open must be decided IN the spec (explicit rule or explicit error; no silent no-op).
- Before requesting spec-approval, message main architect — they route the sdk-surface section to the streamdeck architect (same stakeholder arrangement as #1189).
- sdk constraints hard: environment-agnostic, zero runtime deps, imports only codev-types, CI boundary tests.
- Ride existing plumbing: canvas adapters (File/Marker/Theme) + the live-update channel the open page already holds; `afx open` serves the canvas via Tower.

Research in flight: two Explore agents mapping (a) the canvas keyboard action inventory + live-update channel, (b) Tower route conventions + sdk/controller structure.

## 2026-08-11 — Spec drafted

Ground-truth findings that shaped the spec:
- Canvas keyboard handling is inline (no action enum/names anywhere); block next/prev is native Tab over `tabindex=0`; reading-mode toggle has no key. The spec therefore DEFINES the canonical 14-command names.
- The canvas's only live host is the VS Code webview (postMessage); Tower's `afx open` page is the legacy open.html annotator, NOT the canvas — the migration is #1386 (open). The architect's "afx open serves the canvas via Tower" note resolves to that planned migration; the bridge is designed host-agnostic so the #1386 page becomes a second registrant with no protocol change.
- Existing `POST /api/command` relay is fire-and-forget broadcast — structurally cannot satisfy Requirement 4 (explicit no-canvas answer), so the spec recommends a canvas view registry in Tower + a targeted route, delivery as a viewId-addressed event on the existing SSE channel, `CommandAdapter` as the package seam (D-series pattern), and `sendCanvasCommand` on the sdk controller subpath.
- Target rule decided at spec time: zero matches → explicit `no-canvas` error; multiple → deliver to exactly one, most-recently-active (never broadcast — composer-submit would double-post).

Next: commit draft, message main architect (they route the sdk-surface section to the streamdeck architect BEFORE the spec-approval gate), then `porch done 1401` for the 3-way consultation.
