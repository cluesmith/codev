# Plan: Tip of the Day

## Metadata
- **ID**: plan-0350-tip-of-the-day
- **Status**: draft
- **Specification**: codev/specs/0350-tip-of-the-day.md
- **Created**: 2026-02-16

## Executive Summary

Implement a "Tip of the Day" banner in the dashboard Work view. This is a frontend-only change: a new `TipBanner` component with a tips data file, CSS styling in the existing `index.css`, and integration into `WorkView.tsx`. Two phases: first build the component and data, then integrate and test.

## Success Metrics
- [ ] All specification acceptance criteria met
- [ ] Unit tests cover rotation, navigation, dismiss, and code span rendering
- [ ] No visual regression in Work view
- [ ] Banner is visually subtle and non-intrusive

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "tip-component", "title": "TipBanner component, tips data, and styles"},
    {"id": "integration-and-tests", "title": "WorkView integration and tests"}
  ]
}
```

## Phase Breakdown

### Phase 1: TipBanner component, tips data, and styles
**Dependencies**: None

#### Objectives
- Create the `TipBanner` component with all interactive behavior
- Author 48+ tips covering all required categories
- Add CSS styling to `index.css`

#### Deliverables
- [ ] `packages/codev/dashboard/src/lib/tips.ts` — static array of 48+ tip strings
- [ ] `packages/codev/dashboard/src/components/TipBanner.tsx` — component with rotation, navigation, dismiss, and code span rendering
- [ ] CSS classes added to `packages/codev/dashboard/src/index.css`

#### Implementation Details

**`tips.ts`** — Data file exporting a `tips: string[]` array. Each tip is a plain string with backtick-delimited code spans (e.g., `` Use `afx status` to check all builder statuses ``). At least 48 tips covering: `afx` commands, `porch` commands, `consult` usage, workflow best practices, and dashboard features.

**`TipBanner.tsx`** — Functional component:
- Props: none (self-contained, reads localStorage directly)
- State: `tipIndex` (number), `dismissed` (boolean)
- `getDayOfYear()` helper: compute as `Math.floor((date - new Date(date.getFullYear(), 0, 0)) / 86400000)` using local time
- On mount: compute daily index via `getDayOfYear(new Date()) % tips.length`
- Arrow buttons: increment/decrement `tipIndex` with modular wraparound
- Dismiss: set `dismissed = true`, write `tip-dismissed-YYYY-MM-DD` to localStorage (wrapped in try/catch for private browsing safety)
- On mount: check localStorage for today's dismiss key; if found, render nothing
- Code span rendering: split tip string on backtick pairs, wrap odd segments in `<code>`
- Export named: `export function TipBanner()`

**CSS in `index.css`** — New classes following existing BEM-like pattern:
- `.tip-banner` — flex row, `var(--bg-tertiary)` background, subtle padding, `margin-bottom: 16px`
- `.tip-banner-label` — "Tip:" prefix, `var(--text-muted)`, semi-bold
- `.tip-banner-text` — flex: 1, `var(--text-secondary)`, `font-size: 12px`
- `.tip-banner-text code` — monospace, `var(--bg-primary)` background, small padding
- `.tip-banner-nav` — arrow buttons, minimal styling, `var(--text-muted)`
- `.tip-banner-dismiss` — X button, `var(--text-muted)`, no border

#### Acceptance Criteria
- [ ] Component renders a tip with "Tip:" label
- [ ] Code spans render as `<code>` elements
- [ ] Arrow buttons cycle through tips with wraparound
- [ ] Dismiss hides banner and persists to localStorage
- [ ] Banner auto-hides when today's dismiss key exists
- [ ] Daily tip is deterministic based on day of year

#### Rollback Strategy
Delete the three new/modified files; no other files are touched in this phase.

---

### Phase 2: WorkView integration and tests
**Dependencies**: Phase 1

#### Objectives
- Integrate `TipBanner` into `WorkView.tsx` at the correct insertion point
- Write comprehensive unit tests

#### Deliverables
- [ ] `packages/codev/dashboard/src/components/WorkView.tsx` — import and render `TipBanner`
- [ ] `packages/codev/dashboard/__tests__/TipBanner.test.tsx` — unit tests

#### Implementation Details

**WorkView integration** — Import `TipBanner` and render it after the `overviewError` div and before the first `<section>`. This ensures errors remain above the tip banner per spec requirement.

```tsx
{overviewError && <div className="work-error">...</div>}
<TipBanner />
<section className="work-section">
```

**Tests** (`TipBanner.test.tsx`) using Vitest + React Testing Library:
1. **Daily rotation** — Mock `Date` to verify correct tip index for a given day
2. **Code span rendering** — Verify backtick-delimited text renders as `<code>` elements
3. **Arrow navigation** — Click left/right, verify tip text changes; verify wraparound at boundaries
4. **Dismiss behavior** — Click dismiss, verify banner disappears; verify localStorage key written
5. **Dismiss persistence** — Pre-set localStorage key for today, render component, verify banner is not shown
6. **Next-day reappearance** — Pre-set localStorage key for yesterday, render, verify banner is shown
7. **Ephemeral reset on reload** — Navigate to a different tip, re-render component, verify it resets to daily tip

#### Acceptance Criteria
- [ ] TipBanner appears in Work view between error area and builders section
- [ ] All tests pass
- [ ] Existing tests still pass
- [ ] Banner renders correctly with the full 48+ tip set

#### Test Plan
- **Unit Tests**: Rotation logic, code span parsing, navigation, dismiss + localStorage
- **Manual Testing**: Visual check in dashboard — banner appearance, arrow cycling, dismiss + reload, next-day behavior

#### Rollback Strategy
Revert the WorkView.tsx change (single import + single JSX line). Delete test file.

## Dependency Map
```
Phase 1 (component + data + CSS) ──→ Phase 2 (integration + tests)
```

## Risk Analysis
### Technical Risks
| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Tips content too long for single line | Low | Low | Spec allows wrapping on narrow viewports |
| localStorage unavailable | Very Low | Low | Component renders tip without dismiss; no crash |

## Validation Checkpoints
1. **After Phase 1**: TipBanner renders in isolation (can verify with a temporary import)
2. **After Phase 2**: Full integration visible in dashboard, all tests green

## Notes
- No backend changes needed
- No new dependencies needed
- All styling uses existing CSS variables
- Import paths use `.js` extension per project ESM convention
