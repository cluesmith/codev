---
approved: 2026-02-16
validated: [claude]
---

# Specification: Test Suite Consolidation

## Metadata
- **ID**: 0124
- **Status**: approved
- **Created**: 2026-02-16

## Problem Statement

The test suite has grown to 1,747 tests across 110 files. An evaluation found ~285 tests (16%) that are obsolete, redundant, trivially duplicative, or over-mocked to the point of testing nothing real. This bloat slows CI, increases maintenance burden, and makes it harder to identify meaningful test failures.

## Current State

- **1,747 test cases** across **110 files** and **563 describe blocks**
- Obsolete bugfix regression tests for bugs fixed long ago, already covered by unit tests
- Terminal/session management tested 4+ ways across 6 overlapping files
- Tunnel subsystem has 5 test files (~150 tests) with heavy overlap
- Trivial tests verifying string operations, type checks, and basic error handling
- Over-mocked tests that only verify mock call sequences, not real behavior
- E2E tests that repeat what unit tests already cover

## Desired State

- **~1,400-1,500 tests** across **~95-100 files** — leaner, faster, more meaningful
- No obsolete bugfix test files (bugs covered by unit tests don't need dedicated regression files)
- Terminal/session tests consolidated into clear layers (unit, integration, E2E)
- Tunnel tests consolidated from 5 files to 3
- Trivial and over-mocked tests removed
- Zero loss of meaningful coverage

## Success Criteria

- [ ] Remove obsolete bugfix test files (bugfix-195, 195-attach, 199, 202, 213, 274)
- [ ] Consolidate terminal/session tests: merge `pty-session.test.ts` into `session-manager.test.ts`, reduce `pty-manager.test.ts` to PTY-specific tests only
- [ ] Consolidate tunnel tests: merge `tunnel-client.integration.test.ts` into `tunnel-client.test.ts`, reduce `tunnel-edge-cases.test.ts` by ~50%
- [ ] Remove trivial tests (string operations, type checks, basic Map lookups) across all files
- [ ] All remaining tests pass after consolidation
- [ ] Net reduction of at least 200 tests
- [ ] No reduction in code coverage for critical modules (terminal, tunnel, porch, tower routes)

## Constraints

### Technical Constraints
- Must not reduce coverage of critical paths (session reconnection, tunnel heartbeat, porch state machine)
- Must maintain E2E coverage for Tower stop/start, spawn, and cleanup flows
- Tests must still pass in CI (GitHub Actions)

### Scope Constraints
- **DO NOT** add new tests — this is purely a removal/consolidation effort
- **DO NOT** refactor production code — only test files
- **DO NOT** touch porch tests — they're complex and justified

## What to Remove

### 1. Obsolete Bugfix Tests (7 files, ~50 tests)

| File | Reason for Removal |
|------|-------------------|
| `bugfix-195.test.ts` | Migration v4 fixed this; schema tests cover it |
| `bugfix-195-attach.test.ts` | Duplicate of above |
| `bugfix-199-zombie-tab.e2e.test.ts` | Covered by terminal lifecycle tests |
| `bugfix-202-stale-temp-projects.e2e.test.ts` | Covered by project lifecycle tests |
| `bugfix-213-architect-restart.test.ts` | Covered by session-manager state tests |
| `bugfix-274-architect-persistence.test.ts` | Covered by session-manager reconnection tests |

Keep `bugfix-286-annotator-popup.test.ts` (unique UI regression).

### 2. Terminal/Session Test Consolidation (~40-70 tests)

- Merge `pty-session.test.ts` into `session-manager.test.ts` (keep only tests that aren't already covered)
- Reduce `pty-manager.test.ts` from 16 to ~6 tests (PTY interface only, not CRUD that session-manager covers)
- Keep `session-manager.test.ts`, `shellper-protocol.test.ts`, `tower-shellper-integration.test.ts` as-is

### 3. Tunnel Test Consolidation (~35-50 tests)

- Merge `tunnel-client.integration.test.ts` into `tunnel-client.test.ts`
- Reduce `tunnel-edge-cases.test.ts` by ~50% (keep critical edge cases, remove trivial backoff/cap tests)
- Consider merging `tunnel-integration.test.ts` endpoint tests into `tower-tunnel.test.ts`

### 4. Trivial Test Removal (~60-80 tests, scattered)

Remove tests that verify:
- Basic string operations (lowercase, trim, pad)
- Type identity checks (returns Map, returns array)
- Singleton pattern (returns same instance)
- Simple Map/Set lookups (returns undefined for unknown key)
- Generic error handling (handles X error gracefully)

### 5. Tower Route Consolidation (~20 tests)

- Merge overlapping `tower-instances.test.ts` endpoint tests into `tower-routes.test.ts`

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Accidentally remove test covering uncovered edge case | Medium | Medium | Run coverage report before and after; diff |
| Merge conflict with active PRs | Low | Low | Do this as a single focused PR |
| Broken CI after removal | Low | High | Run full test suite before PR |

## Notes

- This spec was informed by a comprehensive evaluation of all 110 test files
- The builder should verify each removal by checking that the behavior is covered elsewhere before deleting
- When in doubt, keep the test — lean doesn't mean reckless
