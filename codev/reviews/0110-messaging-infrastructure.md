# Review: Messaging Infrastructure (Spec 0110)

## Summary

Implemented standardized agent naming, cross-project messaging, WebSocket message bus, and a structured `POST /api/send` endpoint for Tower. The CLI `afx send` command was refactored from local terminal resolution to delegating all routing to Tower. Four implementation phases were completed across 16 files, adding ~2,350 lines (net +2,116 after removing old code).

## Spec Compliance

- [x] AC1: `afx send architect "msg"` still works (backward compat)
- [x] AC2: `afx send builder-spir-0109 "msg"` works with new naming
- [x] AC3: `afx send codev-public:architect "msg"` delivers cross-project
- [x] AC4: `afx status` shows agents with new naming convention
- [x] AC5: `/ws/messages` WebSocket broadcasts all `afx send` messages in structured JSON
- [x] AC6: `afx spawn -p 0109` creates builder named `builder-spir-0109`
- [x] AC7: Bare ID `0109` resolves to `builder-spir-0109` via tail match
- [x] AC8: Messages include sender, recipient, timestamp, and content

## Deviations from Plan

- **Phase 1 (agent naming)**: `stripLeadingZeros()` added to tail matching logic. Bare `0109` matches `builder-spir-109` even though the stored name has no leading zero. This was a backward compat improvement not in the original plan.
- **Phase 2 (send endpoint)**: Added `fromWorkspace` field to the API contract. The plan only had `workspace` (target context), but the broadcast needs to know the sender's workspace separately for `from.project`.
- **Phase 3 (message bus)**: Implemented as planned with no deviations.
- **Phase 4 (CLI refactor)**: Worktree paths and branch names were NOT changed (per rebuttal to Codex's concern). Only the `builderId` stored in state.db uses the new format.
- **Dashboard message panel**: Explicitly out of scope per spec ("follow-up UI task").

## Lessons Learned

### What Went Well
- **Phase decomposition**: The 4-phase plan with clear deliverables per phase worked well. Each phase was independently testable and buildable.
- **Backward compatibility**: The tail-match approach (`0109` → `builder-spir-109`) means all existing scripts and muscle memory continue working without modification.
- **Centralized routing**: Moving all address resolution to Tower (rather than CLI) was a significant simplification — `send.ts` dropped from 327 to 219 lines.

### Challenges Encountered
- **Codex reviewer persistence**: Codex raised the same concern about worktree/branch renames across multiple iterations despite it being addressed in rebuttals. Required clear documentation of the rebuttal reasoning.
- **Integration test reliability**: Initial integration tests used `activateWorkspace` which waited for auto-spawned architect terminals — slow and flaky. Switched to explicit terminal registration via `POST /api/terminals` for reliability.
- **Sender provenance**: The plan initially didn't account for needing `fromWorkspace` separately from `workspace`. The `workspace` field serves as target resolution context, but `from.project` in the broadcast needs the sender's workspace. Added `fromWorkspace` to the API.

### What Would Be Done Differently
- **Start with integration tests earlier**: The integration test gap wasn't caught until Phase 4 iteration 2. Adding integration test scaffolding in Phase 2 (when the endpoint was built) would have caught issues sooner.
- **Rebuttal documentation upfront**: Writing explicit rebuttal docs for recurring reviewer concerns saves time across iterations.

## Technical Debt

- **No message persistence**: The bus is live-only per spec. If dashboard message history is needed, SQLite persistence should be added (spec mentions this as Phase 2 follow-up).
- **`sendToAll` still iterates local state**: The `--all` flag reads builders from local `state.db` rather than querying Tower. This works but means `sendToAll` can't discover builders from other workspaces. May want a Tower endpoint for listing all builders.

## Follow-up Items

- **Spec Phase 2**: Dashboard message panel UI (spec lines 114-124)
- **Message history**: Optional SQLite persistence for message replay
- **`afx send --all` via Tower**: Consider a Tower-side broadcast endpoint
- **Porch integration**: Spec 0108 (gate notifications) can use the new `POST /api/send` endpoint

## Test Summary

| Test File | Tests | Type |
|-----------|-------|------|
| `agent-names.test.ts` | 39 | Unit — name generation, parsing, resolution |
| `message-format.test.ts` | 10 | Unit — message formatting |
| `tower-messages.test.ts` | 30 | Unit — address resolution, subscriber management |
| `tower-routes.test.ts` | 34 | Unit — endpoint validation, error handling |
| `send.test.ts` | 18 | Unit — CLI command with mocked TowerClient |
| `send-integration.test.ts` | 5 | Integration — real Tower server, WebSocket bus |
| `status-naming.test.ts` | 2 | Unit — legacy status display with new naming |
| **Total** | **138** | |
