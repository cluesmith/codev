# Review: 0350 — Tip of the Day

## Summary

Implemented a "Tip of the Day" banner in the dashboard Work view. The banner displays a rotating tip that changes daily, supports arrow navigation, dismissal via localStorage, and renders inline code spans from backtick-delimited text. Ships with 51 tips covering afx, porch, consult, workflow, dashboard, and protocol categories.

## Spec Compliance

- [x] Tip banner appears in the Work view below the header
- [x] Tip changes daily (day-of-year modulo, local time)
- [x] At least 48 tips (shipped 51)
- [x] Tips include inline code formatting (backtick-delimited → `<code>`)
- [x] Left/right arrows navigate between tips with wraparound
- [x] Dismiss button hides banner until the next day (`tip-dismissed-YYYY-MM-DD`)
- [x] Visually subtle — muted colors, small font, doesn't compete for attention
- [x] No backend changes
- [x] Unit tests cover rotation, navigation, dismiss, code spans, and ephemerality

## Deviations from Plan

- **Tip count**: Plan specified "48+ tips" — shipped 51. Three extra tips in the protocol category for better coverage.
- **localStorage mock**: Tests required a custom localStorage mock for jsdom compatibility. This wasn't anticipated in the plan.
- **Symlink for porch naming**: Created a `350-0350-tip-of-the-day.md` symlink in `codev/plans/` because porch expects `{id}-*.md` while consult expects `0{id}-*.md`. This is a porch naming convention issue, not a feature issue.

## Lessons Learned

### What Went Well

- Two-phase plan was the right granularity — clean separation of component creation from integration + testing
- 3-way consultations caught real issues: Codex's test assertion feedback was valid and improved quality
- Component is self-contained with no props, making integration a single-line change
- All existing tests continued to pass throughout — no regressions

### Challenges Encountered

- **jsdom localStorage**: The dashboard's jsdom test environment doesn't provide a full localStorage implementation. Required a manual mock. Future dashboard tests using localStorage should reference this pattern.
- **Porch/consult naming conflict**: Porch expects plan files at `{id}-*.md` while consult's `findPlan()` pads to 4 digits and looks for `0{id}-*.md`. Worked around with a symlink.
- **Dashboard test runner isolation**: Dashboard tests use a separate vitest config (`dashboard/vitest.config.ts`) and are excluded from the main test runner. Had to discover this during development.

### What Would Be Done Differently

- Would include the localStorage mock pattern in the plan phase upfront
- Would verify the test runner config before writing tests

### Methodology Improvements

- Porch project naming should be consistent with the existing `codev/specs/` and `codev/plans/` naming convention (zero-padded IDs). The `{numeric-id}-{zero-padded-id}-{name}` pattern creates confusion.

## Technical Debt

- None introduced. The feature is self-contained and doesn't affect existing code paths.

## Follow-up Items

- Consider adding ARIA `role="complementary"` to the banner in a future iteration
- Old `tip-dismissed-*` localStorage keys accumulate over time (negligible — a few bytes per day)
