# Plan: Tower Shellper Reconnect on Startup

## Metadata
- **ID**: 0122
- **Status**: draft
- **Specification**: codev/specs/0122-tower-shellper-reconnect.md
- **Created**: 2026-02-16

## Executive Summary

The reconnection implementation already exists on main, built incrementally across Spec 0105 (terminal management), Bugfix #274 (architect persistence), and TICK-001 (reconciliation ordering). This plan validates the existing implementation against the spec's success criteria and addresses gaps identified by 3-way consultation.

Key existing components:
- `reconcileTerminalSessions()` in `tower-terminals.ts` — 2-phase startup reconciliation
- `reconnectSession()` in `session-manager.ts` — PID validation, socket probing, client setup
- Startup integration in `tower-server.ts` line 298 — called after `initTerminals()`, before `initInstances()`
- `_reconciling` flag — prevents race with on-the-fly reconnection (Bugfix #274)

## Success Metrics
- [ ] All 6 specification success criteria verified by existing tests
- [ ] Consultation feedback gaps addressed (bounded concurrency, testing coverage)
- [ ] Existing unit tests pass
- [ ] E2E validation of stop/start cycle

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "phase_1", "title": "Verify existing implementation and add missing E2E test"},
    {"id": "phase_2", "title": "Address consultation feedback gaps"}
  ]
}
```

## Phase Breakdown

### Phase 1: Verify existing implementation and add missing E2E test
**Dependencies**: None

#### Objectives
- Verify existing implementation matches all 6 spec success criteria
- Run existing unit tests for `reconnectSession` and `reconcileTerminalSessions`
- Add an E2E-style integration test for the full stop/start cycle if not already covered

#### Deliverables
- [ ] Existing tests pass
- [ ] Gap analysis document (which success criteria are tested vs untested)
- [ ] E2E test for Tower stop/start reconnection if missing

#### Implementation Details
- Run existing test suites:
  - `packages/codev/src/terminal/__tests__/session-manager.test.ts` — reconnectSession tests
  - `packages/codev/src/agent-farm/__tests__/tower-terminals.test.ts` — reconcileTerminalSessions tests
  - `packages/codev/src/agent-farm/__tests__/bugfix-274-architect-persistence.test.ts` — race condition test
  - `packages/codev/src/terminal/__tests__/tower-shellper-integration.test.ts` — integration tests
- Map each spec success criterion to existing test(s)
- Add E2E test for stop/start cycle if not covered

#### Acceptance Criteria
- [ ] All existing tests pass
- [ ] Each success criterion mapped to at least one test
- [ ] E2E test demonstrates reconnection after simulated Tower restart

#### Test Plan
- **Unit Tests**: Validate reconnectSession edge cases (dead PID, PID reuse, stale socket, live reconnect)
- **Integration Tests**: stop/reconnect/replay flow in session-manager.test.ts
- **E2E Tests**: Full Tower stop/start with shellper process survival

---

### Phase 2: Address consultation feedback gaps
**Dependencies**: Phase 1

#### Objectives
- Address actionable feedback from Gemini, Codex, and Claude consultations
- Add bounded concurrency for parallel socket probing (Gemini/Codex concern)
- Ensure socket path validation is robust (Codex concern)

#### Deliverables
- [ ] Bounded parallel reconnection with `Promise.allSettled` and concurrency limit
- [ ] Tests for parallel reconnection
- [ ] Any other actionable gaps from consultation

#### Implementation Details

**Bounded concurrency for reconnection probes:**
The current implementation uses sequential `for...of` loop (tower-terminals.ts line 378). With many dead sessions (e.g., 10 with 2s timeout each), startup could take 20+ seconds. Add bounded parallel probing using `Promise.allSettled` with a concurrency limit of 5.

Files to modify:
- `packages/codev/src/agent-farm/servers/tower-terminals.ts` — parallelize Phase 1 loop

**Socket path validation (already addressed):**
The existing `reconnectSession()` already validates socket paths via `fs.lstatSync()` checking `isSocket()` (session-manager.ts lines 297-307). No additional work needed.

**Auto-restart restoration (already addressed):**
Already implemented for architect sessions (tower-terminals.ts lines 410-434). No additional work needed.

**Replay data handling (already addressed):**
Already handled via `client.getReplayData()` and `attachShellper()` (tower-terminals.ts lines 449, 456). No additional work needed.

#### Acceptance Criteria
- [ ] Parallel reconnection probes with bounded concurrency
- [ ] Startup with 5+ dead sockets completes within ~5 seconds
- [ ] All existing tests still pass
- [ ] New test for concurrent probe behavior

#### Test Plan
- **Unit Tests**: Mock multiple sessions, verify parallel probing and concurrency limit
- **Manual Testing**: Start Tower with multiple stale SQLite rows, measure startup time

---

## Risk Analysis

### Technical Risks
| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Parallel probing introduces race conditions | Low | Medium | Use `Promise.allSettled`, process results sequentially |
| Existing tests rely on sequential behavior | Low | Low | Run tests after changes, fix any ordering assumptions |

## Validation Checkpoints
1. **After Phase 1**: All existing tests pass, gap analysis complete
2. **After Phase 2**: Parallel probing works, startup performance improved

## Expert Review

**Date**: 2026-02-16
**Models**: Gemini 3 Pro, GPT-5.2 Codex, Claude

**Key Feedback**:
- Gemini: Circular dependency concern (already addressed — reconciliation lives in tower-terminals.ts, not SessionManager), parallel probes needed, auto-restart restoration needed (already implemented), replay data handling (already implemented)
- Codex: Socket-path validation (already implemented via lstat), bounded concurrency needed, stale deletion strategy (2-phase approach already handles), testing strategy needed
- Claude: Implementation already exists with extensive test coverage, minor spec documentation gaps

**Plan Adjustments**:
- Added Phase 2 for bounded concurrency based on Gemini/Codex feedback
- Confirmed existing code already addresses most concerns

## Notes
- The implementation was built incrementally across Spec 0105, Bugfix #274, and TICK-001
- Most consultation concerns are already addressed by existing code
- The primary new work is adding bounded parallel probing for startup performance
