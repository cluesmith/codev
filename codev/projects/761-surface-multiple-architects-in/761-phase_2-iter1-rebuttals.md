# Phase 2 Implementation — Iteration 1 Review Rebuttals

## Verdicts

| Model | Verdict |
|-------|---------|
| Gemini | REQUEST_CHANGES (one critical issue, addressed) |
| Codex | (unavailable — environment limitation) |
| Claude | REQUEST_CHANGES (one critical bug + one minor, both addressed) |

## Gemini REQUEST_CHANGES — addressed

### Missing sync effect: deep links and auto-switch don't update the left pane

Gemini correctly identified that the original implementation deviated from the plan in a sound way — using an independent `activeArchitectName` state in `App.tsx` (separate from `useTabs`'s `activeTabId`) to keep the right pane content intact when switching architects on the left. But the consequence was that `activeTabId` updates (from `?tab=architect:<name>` deep links and the auto-switch for newly-added architects) didn't propagate to the left pane.

**Fix**: Added a one-way sync effect in `App.tsx`:

```tsx
useEffect(() => {
  if (activeTab?.type === 'architect' && activeTab.architectName) {
    setActiveArchitectName(activeTab.architectName);
  }
}, [activeTab?.id, activeTab?.type, activeTab?.architectName]);
```

This mirrors `useTabs`'s activeTab (when it lands on an architect) into the left pane's `activeArchitectName`. Strip clicks still update only `activeArchitectName` directly — they do not change `activeTabId`, preserving the right pane's content.

Added a new test (`N=2: deep-link ?tab=architect:<name> syncs the left pane selection`) that asserts deep-linking to a non-main architect makes that architect's terminal visible on the left after render.

## Claude REQUEST_CHANGES — both issues addressed

### Critical bug: right pane blanks on reload after architect selection

Claude traced the bug:
1. User clicks `sibling` in the architect strip → `writeActiveArchitect('sibling')`.
2. User reloads.
3. `App.tsx` `activeArchitectName` initializes to `'sibling'` from localStorage — left pane correctly shows sibling.
4. `useTabs` *also* reads localStorage and sets `activeTabId = 'architect:sibling'`. **This is the bug.**
5. Right pane content checks `activeTab?.type === 'work'/'analytics'/'team'`, all false → entire right pane blanks until user clicks something.

**Fix**: Removed `readActiveArchitect()` restoration and the architect-specific localStorage write from `useTabs.ts`. Persistence is now entirely owned by `App.tsx`'s strip-click handler (which already calls `writeActiveArchitect`). On reload, `useTabs` leaves `activeTabId` at the default `'work'`; the left pane independently restores via `App.tsx`'s `activeArchitectName` state.

**Tradeoff acknowledged**: on mobile, where there is no left-pane strip, the architect tab is in the main TabBar. Mobile users lose architect-tab-restore-on-reload — `activeTabId` defaults to `'work'`. They can re-tap their architect tab. This is the smaller of two UX regressions; the desktop blank-right-pane issue affects the customer this hotfix is targeting.

Added a new regression test (`N=2: reload with persisted architect keeps work view active on the right pane`) that asserts WorkView remains visible on the right pane while the left pane restores the persisted architect.

### Minor: deploy-window fallback produced `undefined` names

Claude flagged that `buildArchitectTabs`'s deploy-window fallback (scalar `state.architect` from older server) would produce `label: undefined` and `architectName: undefined` when the scalar lacked the new `name` field.

**Fix**: `buildArchitectTabs` now defaults `a.name ?? 'main'` so a tab always has a non-undefined label/architectName. Single line change.

## Tests updated

Two test changes to reflect the corrected behaviour:
- `useTabs.architects.test.ts`: "restores persisted active architect from localStorage" renamed to "does NOT restore active architect from localStorage into activeTabId" with rationale documenting the right-pane blanking bug it prevents.
- `useTabs.architects.test.ts`: "writes localStorage when selectTab is called on an architect tab" renamed to "selectTab does NOT write localStorage from useTabs" — App.tsx now owns persistence.

Added two new App-level tests:
- `N=2: reload with persisted architect keeps work view active on the right pane (Claude iter-1 bug fix)`.
- `N=2: deep-link ?tab=architect:<name> syncs the left pane selection` (Gemini iter-1 sync fix).

Total dashboard tests: 22 passing (up from 20 in initial Phase 2 submission).

## Codex unavailable

Same environment issue as all previous phases.

Ready for re-verification.
