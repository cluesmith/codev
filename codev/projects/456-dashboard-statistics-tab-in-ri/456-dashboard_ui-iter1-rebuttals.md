# Rebuttals: dashboard_ui Phase 3 — Iteration 1

## Gemini (APPROVE)
No changes required.

## Codex (REQUEST_CHANGES)

### 1. Duplicate fetch on tab activation
**Action: FIXED.** Merged the two `useEffect` hooks in `useStatistics.ts` into a single effect that handles initial mount, range changes, and tab activation transitions. Removed the now-unused `prevActive` ref and `useRef` import. The single effect only calls `load(range)` when `isActive` is true, eliminating the double-fetch.

Also fixed minor CSS variable inconsistency noted by Claude — `.stats-error` now uses `var(--status-error)` consistent with `.work-error`.

## Claude (APPROVE)
No changes required. Two minor observations (double-fetch and CSS variable inconsistency) were addressed as part of the Codex fix above.
