# PIR Review: VSCode area-header roll-up icons (Backlog & Builders views)

Fixes #926

## Summary

Adds a roll-up status icon to the `area/*` group headers in the VSCode sidebar's
Backlog and Builders trees, so an engineer can triage at a glance without
expanding each group. Both rollups are computed client-side from the overview
cache (no server / payload change). The Backlog header is **binary** — filled
vs. outline grey for "area has a builder" vs. "open to spawn"; the Builders
header is a **worst-of-three** — `bell` (any blocked) → `comment-discussion`
(any idle) → `circle-filled` (all active), reusing the builder-row icon
vocabulary. Counts live in the tooltip.

## Files Changed

Code (anchored at merge-base `b6059d5b`):

- `packages/vscode/src/views/backlog-filter.ts` (+24 / -0) — `activeBuilderCountByArea` (pure)
- `packages/vscode/src/views/backlog-tree-item.ts` (+28 / -... ) — `BacklogGroupTreeItem` icon/tooltip
- `packages/vscode/src/views/backlog.ts` (+5 / -...) — wire into `rootChildren()`
- `packages/vscode/src/views/builder-row.ts` (+70 / -0) — `rollupGroupState`, `BUILDER_STATE_GLYPH`, `worstBuilderState`, `GroupRollup`/`BuilderState`
- `packages/vscode/src/views/builder-tree-item.ts` (+21 / -...) — `BuilderGroupTreeItem` icon/tooltip
- `packages/vscode/src/views/builders.ts` (+49 / -...) — wire rollup into `rootChildren()`; row icon/contextValue now sourced from the shared glyph
- `packages/vscode/src/__tests__/backlog-filter.test.ts` (+38 / -0) — `activeBuilderCountByArea` tests
- `packages/vscode/src/__tests__/builder-row.test.ts` (+53 / -0) — `rollupGroupState` + `worstBuilderState` tests

8 files, +265 / -23.

## Commits

`git log main..HEAD --oneline` (implementation commits; porch chore commits omitted):

- `3d07ae01` [PIR #926] Add area-header roll-up icons to Backlog & Builders views
- `f846f6aa` [PIR #926] Unit-test activeBuilderCountByArea + rollupGroupState
- `b6092ab8` [PIR #926] Backlog header: filled/outline grey instead of green (reserve green for live builders)
- `845c0a45` [PIR #926] Centralize builder-state glyphs + worstBuilderState helper (drop nested ternaries)

## Test Results

- `pnpm check-types`: ✓ pass
- `pnpm lint`: ✓ pass
- `pnpm test:unit`: ✓ pass (211 tests, 14 new across the two helper suites)
- `node esbuild.js`: ✓ pass (extension bundles)
- porch `build` + `tests` checks: ✓ pass (at dev-approval)
- Manual verification: reviewer approved the running worktree at the
  `dev-approval` gate (VSCode Extension Host) — confirmed the Backlog
  filled/outline-grey headers and the Builders worst-of-three headers render and
  their tooltips carry the counts.

## Architecture Updates

No `arch.md` changes needed. This adds two pure helpers and sets `iconPath` on
two existing `AreaGroupTreeItem` subclasses — no new module boundary, service,
or data-flow. It stays within the established VSCode-view pattern (pure,
vscode-free helpers in `backlog-filter.ts` / `builder-row.ts` tested under the
vitest `__tests__/` harness; `ThemeIcon` construction at the tree-item call
site). The one mild structural improvement — `BUILDER_STATE_GLYPH` as the single
source of truth for the three builder-state glyphs shared by the row and the
header — is a local DRY consolidation, not an architectural change.

## Lessons Learned Updates

No `lessons-learned.md` change — the insights here are PR-specific rather than
durable cross-cutting wisdom, and are captured in this review:

- **Issue specs referencing `file:line` icon vocabulary can go stale across a
  rebase.** #926 specced the Builders blocked rollup as a static `bell` "reusing
  the row icons." Between issue authoring and implementation, the row's blocked
  icon became gate-specific (`gateIconFor` → `book`/`checklist`/`code`/…), so
  `bell` is now only an unmapped-gate fallback. The rebase-time accuracy pass
  caught this; the header keeps a *generic* `bell` as a deliberate group-level
  "attention" glyph (a group can hold builders at different gates), documented at
  `builder-tree-item.ts`.
- **Reserve color semantics across sibling views.** Green = "live/active agent"
  on builder rows; using a green dot in the Backlog overloaded it. The Backlog
  rollup ships as filled/outline *grey* so green stays exclusive to live
  builders and the Backlog reads as a calm "where can I spawn" surface.

## Things to Look At During PR Review

- **Backlog "active builder" semantics.** `activeBuilderCountByArea` counts
  *any* builder in the area (including one blocked at a gate) as "active" — the
  Backlog question is "is anyone working this area?". A consequence worth a
  conscious nod: the same area can show a filled-grey Backlog header (has a
  builder) while its Builders header is `bell`/yellow (that builder is blocked).
  That's intended — the two views answer different questions.
- **Known limitation (accepted).** An area whose only open issue is being built
  has that issue filtered out of the backlog (`spawnableBacklog`), so it renders
  no Backlog header at all and can't show "working" there. Fine for the "where
  do I spawn?" goal; a follow-up (#948) tracks optionally keeping in-progress
  issues in the Backlog with the builder's state icon.
- **Builders worst-of-three is a severity summary, not a full picture.** One
  glyph can't convey a mixed group; the full `{blocked, idle, active}` breakdown
  is in the tooltip. This was discussed at the gate and kept deliberately.
- **Shared-glyph refactor touched existing row code** (`builders.ts`
  `makeBuilderRow`): the row now classifies once into a `BuilderState` driving
  both `contextValue` family (`CONTEXT_FAMILY`) and icon (`BUILDER_STATE_GLYPH`),
  with the blocked row still overriding the *glyph* via `gateIconFor` while
  reusing the shared *color*. Behavior is identical; worth a glance to confirm
  the contextValue strings (`blocked-builder`/`awaiting-builder`/`builder`) are
  unchanged so menu `when`-clauses still match.

## How to Test Locally

For reviewers pulling the branch:

- **View diff**: VSCode sidebar → right-click builder `pir-926` → **View Diff**
- **Run dev server**: VSCode sidebar → **Run Dev Server**, or `afx dev pir-926`
- **What to verify** (mapped to the plan's Test Plan):
  - Backlog: an area with a spawnable issue **and** a live builder → filled grey
    dot; an area with only spawnable issues → outline grey dot. Hover → builder
    count.
  - Builders: a group with a builder blocked at a gate → yellow `bell`;
    worst-idle group → blue `comment-discussion`; all-active → green
    `circle-filled`. Hover → "b blocked · i waiting · a active".
  - Both: collapse/expand still works; a single-`Uncategorized` repo renders flat
    rows with no header (unchanged).
  - Unit: `cd packages/vscode && pnpm test:unit`.
