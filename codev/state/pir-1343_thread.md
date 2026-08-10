# pir-1343 — full-row '+' affordance (GitHub-diff pattern)

## 2026-08-10 — plan phase

- Read #1343, #1236/#863/#1107/#1237 context in-code, and #1380 + its 2026-08-10 requirements
  addendum (comment on fragment-local anchoring) per architect instruction. The #1380 constraint
  (block-scoped affordance, block-local leading space) shaped the whole design.
- Investigated `packages/artifact-canvas`: the current model is a canvas-anchored
  `.codev-canvas-overlay` positioned from `offsetTop`, a body-level 1.9rem gutter, and the #1236
  grace+pin machinery (`OVERLAY_GRACE_MS`, `graceTimerRef`, `overlayPinnedRef`).
- Plan drafted at `codev/plans/1343-artifact-canvas-full-row-affor.md`. Key decisions:
  - Block-local leading space: `--codev-canvas-gutter` padding on top-level `[data-line]` rows
    (chose this over hover-extension pseudo-elements because abs-positioned pseudos don't travel
    through #1380's column fragmentation).
  - "+" portalled into the hovered row's own DOM; vertical position = pointer's line (quantized
    by line-height, clamped to the row), host-relative only. Focus path centers on first line.
  - Grace/pin machinery deleted entirely (architect: this PR, not a follow-up).
  - Dead strips: leading strips become structurally alive (row padding); inter-row margins stay
    inert-but-sticky (argued in plan); host page padding out of scope.
  - Flagged for reviewer: chrome blocks (pre/blockquote/table) go full-bleed into the old gutter
    zone (text x preserved); "+" drift inside horizontally-scrolled wide tables accepted as v1
    limitation; `pre` fixed via inner `pre > code` scroll.
- Gate: plan-approval pending.
