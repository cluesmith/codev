# Plan: Add Icons to Tabs in Workspace Overview

## Metadata
- **ID**: plan-2026-02-21-add-icons-to-tabs
- **Status**: draft
- **Specification**: codev/specs/464-add-icons-to-tabs-in-workspace.md
- **Created**: 2026-02-21

## Executive Summary

Add Unicode-based icons to each tab type in the dashboard tab bar using the Unicode Symbol Map approach (Approach 1 from spec). A static `TAB_ICONS` record maps tab types to Unicode characters. The icon renders as a `<span>` with `aria-hidden="true"` before the label text, with `flex-shrink: 0` to prevent squeezing.

## Success Metrics
- [ ] All 7 tab types have icons in the `TAB_ICONS` map (work, architect, builder, shell, file, activity, files)
- [ ] Icons render before labels in the tab bar
- [ ] `aria-hidden="true"` on all icon spans
- [ ] Tab height unchanged at 34px
- [ ] Truncated labels still show icon
- [ ] No new dependencies
- [ ] Build passes

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "icon_rendering", "title": "Icon Map and TabBar Rendering"},
    {"id": "tests", "title": "Unit Tests"}
  ]
}
```

## Phase Breakdown

### Phase 1: Icon Map and TabBar Rendering
**Dependencies**: None

#### Objectives
- Add a complete `TAB_ICONS` map and render icons in every tab

#### Deliverables
- [ ] `TAB_ICONS` record in `TabBar.tsx`
- [ ] Icon `<span>` rendered before label in tab buttons
- [ ] CSS for `.tab-icon`

#### Implementation Details

**File: `packages/codev/dashboard/src/components/TabBar.tsx`**

Add a `TAB_ICONS` constant — a `Record<Tab['type'], string>` mapping each tab type to its Unicode character:

```typescript
const TAB_ICONS: Record<Tab['type'], string> = {
  work: '\u25C8',           // ◈
  architect: '\u25B6\uFE0E', // ▶︎ (text presentation)
  builder: '\u2692\uFE0E',   // ⚒︎ (text presentation)
  shell: '$',                // $
  file: '\u2261',            // ≡
  activity: '\u26A1\uFE0E',  // ⚡︎ (text presentation)
  files: '\u2630',           // ☰
};
```

In the JSX, add a `<span>` before the label:

```tsx
<span className="tab-icon" aria-hidden="true">{TAB_ICONS[tab.type]}</span>
<span className="tab-label">{tab.label}</span>
```

**File: `packages/codev/dashboard/src/index.css`**

Add a `.tab-icon` rule:

```css
.tab-icon {
  flex-shrink: 0;
}
```

No other CSS changes needed — `.tab` already uses `display: flex; gap: 6px;` for spacing.

#### Acceptance Criteria
- [ ] Each tab button has an icon span before the label span
- [ ] Icon uses correct Unicode character for tab type
- [ ] Icon span has `aria-hidden="true"`
- [ ] `.tab-icon` has `flex-shrink: 0`
- [ ] `npm run build` passes in `packages/codev`

#### Test Plan
- **Manual Testing**: Open dashboard, verify icons visible on all tab types
- **Build Verification**: `npm run build` succeeds

---

### Phase 2: Unit Tests
**Dependencies**: Phase 1

#### Objectives
- Add unit tests verifying icon rendering for each tab type

#### Deliverables
- [ ] Icon rendering tests added to existing `TabBar.test.tsx`

#### Implementation Details

**File: `packages/codev/dashboard/__tests__/TabBar.test.tsx`** (existing file — vitest + @testing-library/react already set up)

Add new tests to the existing describe block. Tests should verify:
1. Each tab type renders with the expected icon character
2. Icon span has `aria-hidden="true"` attribute
3. Icon appears before the label in DOM order
4. Close button and tab selection still work with icons present

**Note**: The existing `mockTabs` use `type: 'dashboard'` which is no longer in the `Tab['type']` union. Since `TAB_ICONS` is a `Record<Tab['type'], string>`, the new tests must use valid types (`'work'`, `'builder'`, `'shell'`, etc.). Fix the legacy mock data to use `type: 'work'` instead of `type: 'dashboard'`.

**Export requirement**: `TAB_ICONS` must be exported from `TabBar.tsx` so tests can reference expected icon values without hardcoding.

#### Acceptance Criteria
- [ ] Tests pass for all tab types
- [ ] Existing tests still pass after mock data fix
- [ ] `npm test` passes in `packages/codev`

#### Test Plan
- **Unit Tests**: Verify icon rendering, aria-hidden, DOM order, and existing behavior preservation

---

## Dependency Map
```
Phase 1 (Icon Rendering) ──→ Phase 2 (Tests)
```

## Validation Checkpoints
1. **After Phase 1**: `npm run build` passes, icons visible in dashboard
2. **After Phase 2**: `npm test` passes

## Notes
- This is a small, self-contained UI change touching 2-3 files
- No runtime behavior changes — purely visual enhancement
- The `activity` and `files` icons won't be visible until those tab types are used in `buildTabs()`
