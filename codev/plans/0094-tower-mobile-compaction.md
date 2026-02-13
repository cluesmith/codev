# Plan 0094: Tower Mobile Compaction

## Overview

Single-file CSS changes to `packages/codev/templates/tower.html` to reduce vertical space waste on mobile viewports (<=600px). One minor JS change to add a semantic class.

## Phase 1: Mobile CSS Compaction (Single Phase) — COMPLETED

**Objective**: Apply all 7 mobile compaction changes from the spec in a single phase since they're all CSS-only changes to one file.

**Changes**:

1. **Hide Share button** - Add `#share-btn { display: none !important; }` inside existing `@media (max-width: 600px)` block
2. **Compact instance header** - Replace `flex-direction: column` with `flex-wrap: wrap` and keep row direction; fix `.instance-actions` width
3. **Hide project path row** - Add `.instance-path-row { display: none; }` on mobile
4. **Compact port items** - Override `flex-direction: column` to `row` for `.port-item`; fix `.port-actions` width and button sizing
5. **Compact New Shell row** - Add `.new-shell-row` class in JS `renderInstance()`, style it with reduced margin/padding on mobile
6. **Compact recent items** - Override column direction to row, hide `.recent-path`, reduce `.recent-time` font size
7. **Reduce section spacing** - Tighten `.main`, `.section-header`, `.instances`, `.recents-section`, `.instance-meta` on mobile

**Files Modified**:
- `packages/codev/templates/tower.html` (inline CSS + JS)

**Success Criteria**:
- On 600px viewport: each project card is ~40-50% shorter than current
- Project name + status + actions on one line
- No project path visible on mobile
- Overview/Architect rows are compact single-line
- Recent projects: name + time + Start button inline, no path
- Share button hidden on mobile
- Desktop (>800px): no visual changes
- All buttons tappable (min 36px touch targets)

**Commit**: `[Spec 0094] feat: Compact tower overview for mobile viewports`
