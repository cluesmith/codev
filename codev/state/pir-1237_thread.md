# Builder thread — pir-1237

## 2026-08-05 — Plan phase

- Spawned as PIR builder for #1237 (keyboard-first review navigation in artifact-canvas).
- **Scope expanded by architect mid-plan**: this PIR is the full artifact-canvas batch — #1236 ('+' affordance disappears + undersized; first implementation phase), #1232 (uniform arrow cursor over content), #1237 (jump keys, focus audit, minimap focus, discoverability). One plan, one PR, `Fixes #1232, Fixes #1236, Fixes #1237`.
- Re-verified all three issues' file:line diagnoses against current source — all hold. Key extra finding while tracing #1237's focus audit: submit/delete lose focus because the marker write shifts the `data-line` map → `html` changes → the innerHTML effect rebuilds the body and destroys the focused element. Esc-cancel is already correct (no rebuild on cancel).
- Plan written to `codev/plans/1237-artifact-canvas-keyboard-first.md`: Phase A #1236 (200ms grace + overlay pin + font-size token + 24px hit target), Phase B #1232 (one `cursor: default` rule on the body), Phase C #1237 (n/p, ]/[, Home/End jump keys; `pendingFocusLineRef` restoration across rebuilds; minimap dots focus target block; `?` keys legend).
- Sitting at `plan-approval` gate.
