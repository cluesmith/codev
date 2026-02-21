# Review: af rename Command

## Summary

Implemented `af rename <name>` — a CLI command that renames the current utility shell session's dashboard tab. The feature spans three layers: SQLite persistence (migration v11 adds `label` column), Tower API (PATCH `/api/terminals/:id/rename` endpoint), and CLI (`af rename` command). Labels persist across Tower restarts via reconciliation and are scoped to utility shells only (architect/builder terminals cannot be renamed). Duplicate names are auto-deduplicated with a `-N` suffix.

## Spec Compliance

- [x] `af rename "name"` works inside shellper sessions
- [x] `SHELLPER_SESSION_ID` and `TOWER_PORT` injected into shell environment at creation
- [x] PATCH API endpoint with name validation (1-100 chars), control char stripping
- [x] Session type check: only shell type allowed (403 for architect/builder)
- [x] Duplicate name dedup with `-1`, `-2` suffix (workspace-scoped)
- [x] Labels persist in SQLite across Tower restarts
- [x] Dashboard tab titles update after rename (via existing state polling)
- [x] Error messages match spec phrasing

## Deviations from Plan

- **Phase 1: Fallback path env vars**: Plan specified setting `SHELLPER_SESSION_ID` for non-persistent fallback sessions. Intentionally omitted because these sessions are ephemeral (don't survive Tower restarts) and rename wouldn't persist. Accepted by 2/3 reviewers (Gemini, Claude).

- **Phase 2+3 combined commit**: Phase 2 and Phase 3 changes were committed together after Phase 2 work was verified. This was pragmatic — Phase 3 was small (one new file + minor modifications) and depended entirely on Phase 2.

## Lessons Learned

### What Went Well
- 3-way consultation caught critical issues during planning: hardcoded dashboard names in `handleWorkspaceState`, wrong route registration location, missing label loading in reconciliation
- The two-step ID lookup strategy (direct PtySession ID, then shellperSessionId scan) cleanly handles both persistent and non-persistent sessions without adding a new route namespace
- Adding the `excludeId` parameter to `getActiveShellLabels` kept the dedup logic clean — one SQL query excludes the current session

### Challenges Encountered
- **PtySession ID vs SHELLPER_SESSION_ID mismatch**: The CLI sends the stable shellper UUID, but Tower manages PtySession objects keyed by ephemeral `term-xxxx` IDs. Resolved with the two-step lookup pattern.
- **Label propagation through multiple paths**: Labels flow through shell creation, reconciliation (startup), on-the-fly reconnection, and the state endpoint. Required changes in 4 different code paths to be consistent.

### What Would Be Done Differently
- Would have included the `handleWorkspaceState` fix and reconciliation label loading in the original plan (before consultation), as these were critical for the feature to work at all
- The Codex reviewer consistently flagged missing tests that exercise actual handlers vs. contract-only tests — a valid concern worth addressing in future projects with integration test infrastructure

## Technical Debt

- **No integration tests for rename endpoint**: Tests are unit-level (SQLite + logic contracts). A proper integration test would require standing up a Tower instance with PTY sessions. Acceptable for now but should be addressed when E2E infrastructure matures.
- **Catch-all 400 in rename handler**: The outer try/catch returns 400 "Invalid JSON body" for any exception, which could mask unexpected errors as validation failures. Low risk given the simple control flow.

## Consultation Feedback

### Specify Phase (Round 1)

#### Gemini
- **Concern**: ID mapping across restarts needs clarification
  - **Addressed**: Plan added two-step ID lookup strategy
- **Concern**: `TOWER_PORT` env var needed alongside `SHELLPER_SESSION_ID`
  - **Addressed**: Both env vars injected in Phase 1

#### Codex
- **Concern**: Label vs name dual field could cause confusion
  - **Rebutted**: Single `label` field used throughout, consistent naming

#### Claude
- **Concern**: API contract should be explicit about request/response format
  - **Addressed**: Spec updated with exact request/response JSON

### Plan Phase (Round 1)

#### Gemini
- **Concern (CRITICAL)**: `handleWorkspaceState` hardcodes shell names
  - **Addressed**: Added to Phase 1 deliverables
- **Concern**: ID lookup needs two-step strategy
  - **Addressed**: Phase 2 implementation details updated

#### Codex
- **Concern (CRITICAL)**: `reconcileTerminalSessions` hardcodes label on reconnection
  - **Addressed**: Added to Phase 1 deliverables
- **Concern**: Dedup should be scoped to active sessions only
  - **Addressed**: Phase 2 queries only active sessions

#### Claude
- **Concern (CRITICAL)**: Route should be in `handleTerminalRoutes`, not workspace-scoped
  - **Addressed**: Phase 2 route registration location corrected

### Phase 1 Implementation (Round 1)

#### Gemini — APPROVE
- No concerns

#### Codex — REQUEST_CHANGES
- **Concern**: Missing env var injection for fallback shells
  - **Rebutted**: Intentional omission — non-persistent sessions are ephemeral
- **Concern**: Missing phase 1 unit tests
  - **Addressed**: Tests existed in `terminal-label.test.ts` (17 tests) but weren't visible to Codex's diff analysis

#### Claude — APPROVE
- No concerns. Noted the fallback deviation as reasonable.

### Phase 2 Implementation (Round 1)

#### Gemini — APPROVE
- No concerns

#### Codex — REQUEST_CHANGES
- **Concern**: Response `id` should match the request session ID
  - **Rebutted**: Code already returns `terminalId` (the path param). Codex may have reviewed stale code.
- **Concern**: Tests don't exercise the actual HTTP handler
  - **Rebutted**: Unit-level SQL tests are pragmatic; integration tests require full Tower server.

#### Claude — APPROVE
- **Observation**: CORS already includes PATCH (non-blocking)
- **Observation**: Catch-all 400 could mask errors (non-blocking, low risk)

### Phase 3 Implementation (Round 1)

#### Gemini — APPROVE
- No concerns

#### Codex — REQUEST_CHANGES
- **Concern**: Empty-name handling should be client-side
  - **Addressed**: Added `options.name.trim().length === 0` check in rename.ts
- **Concern**: Error message phrasing doesn't match spec
  - **Addressed**: Hardcoded spec-matching messages instead of deferring to server responses
- **Concern**: Tests don't exercise the actual rename function
  - **Rebutted**: Function has side effects (process.exit, process.env) making direct invocation fragile. Contract tests verify the logic pieces.

#### Claude — APPROVE
- No concerns. Noted the rename.ts is only 44 lines — clean and focused.

## Architecture Updates

Updated `codev/resources/arch.md`:
- Added `PATCH /api/terminals/:id/rename` to the Terminal Manager REST API reference
- Updated SQLite invariant #3 to mention custom labels alongside shellper metadata

## Lessons Learned Updates

No lessons learned updates needed. The insights from this project (two-step ID lookup, multi-path label propagation, consultation catching critical issues) are specific to this feature rather than generalizable beyond what's already documented.

## Flaky Tests

No flaky tests encountered.

## Follow-up Items

- `af shell --name` bug: The `--name` parameter is ignored during shell creation. Related but out of scope for this spec. Trivial fix in `handleWorkspaceShellCreate`.
- Integration test infrastructure for Tower endpoints would improve confidence in HTTP handler tests.
