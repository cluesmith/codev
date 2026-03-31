# Review: Porch Gate Notifications

## Summary

Implemented four integration points for gate notification visibility: (1) backend data plumbing adding `gateStatus` to `/api/state`, (2) a `GateBanner` React component in the dashboard, (3) a `GateWatcher` module in the Tower that sends `afx send` notifications to the architect on gate transitions, and (4) enhanced `afx status` CLI output with wait time and approval commands.

## Spec Compliance

- [x] `/api/state` response includes `gateStatus` field with gate info for the active project
- [x] Dashboard shows a banner above terminals when any builder has a pending gate
- [x] Banner includes builder ID, gate name, wait time (or omitted if unavailable), and approval command
- [x] Banner disappears within one poll cycle after gate approval
- [x] Architect terminal receives a message when a gate transitions to pending
- [x] Message is sent exactly once per gate transition (not on every poll)
- [x] Existing `afx send` protocol is used (no new message transport)
- [x] Works for all gate types: spec-approval, plan-approval, pr-ready, merge-approval
- [x] `afx status` output includes wait time and approval command for blocked builders
- [x] No notification when Tower runs without any active builders
- [x] `afx send` failures are logged at warn level and do not break the poll loop
- [x] Existing tests pass; new tests cover notification behavior

## Deviations from Plan

No significant deviations. All four phases were implemented as planned.

**Minor adjustments:**
- **Phase 3**: The `LogFn` type in `gate-watcher.ts` was initially defined with `level: string`, which caused a TypeScript error when the tower's `log` function uses literal union `'INFO' | 'ERROR' | 'WARN'`. Changed to match the literal union type.
- **Phase 2**: Codex requested Playwright E2E tests in iteration 1 — these were specified in the plan but initially overlooked. Added in iteration 2 and all models approved.

## Lessons Learned

### What Went Well
- The four-phase breakdown was effective — each phase was self-contained with clear deliverables
- The dual-map dedup design (notified + projectKeys) in GateWatcher cleanly handles gate transitions without edge cases
- 3-way consultation caught the missing Playwright E2E tests in Phase 2 before they could become a gap
- Type alignment across three codebases (backend, dashboard, CLI) worked smoothly because Phase 1 established the shared `GateStatus` shape first

### Challenges Encountered
- **TypeScript parameter contravariance**: The `LogFn` type needed to exactly match the tower's log function signature. Resolved by using the same literal union type.
- **Vitest mock constructors**: The `TowerClient` class mock in Phase 4 tests needed to be a real class (not an arrow function returning an object) because `status.ts` uses `new TowerClient()`. Resolved by using `class MockTowerClient` in the mock factory.

### What Would Be Done Differently
- Would add Playwright E2E tests in the initial Phase 2 implementation rather than waiting for consultation feedback
- Would verify mock patterns (class vs function) before writing tests to avoid the constructor error

## Technical Debt

- `new Date(gate.requestedAt).getTime()` in `status.ts` could return `NaN` for malformed ISO timestamps, producing `"waiting NaNm"`. Since porch controls the data format this is low risk, but a defensive `isNaN` check could be added in a future hardening pass.

## Follow-up Items

- Consider adding a clickable "Approve" button in the dashboard banner (noted in spec as future enhancement)
- Gate watcher poll interval (10s) could be made configurable via Tower settings
