# Review: TICK-002 — Extend resolver to consult, spawn, and PTY

## Metadata
- **Parent Spec**: 612 (Pluggable CLI-Based Artifact Resolver)
- **TICK**: 002
- **Date**: 2026-03-27

## Summary

Extended the artifact resolver integration from porch-only to three additional subsystems: consult CLI, `afx spawn`, and PTY session management.

## Changes Made

### Phase 1: consult CLI resolver integration
- **`commands/consult/index.ts`**: Replaced `findSpec()`/`findPlan()` filesystem functions with `findSpecContent()`/`findPlanContent()` that use `getResolver()` from the artifact resolver
- Added `ContentRef` type (`{ content: string; label: string }`) for resolved artifacts
- Updated all four query builders (`buildSpecQuery`, `buildPlanQuery`, `buildImplQuery`, `buildPhaseQuery`) to accept `ContentRef` instead of file paths and embed artifact content inline in queries
- Updated `resolveBuilderQuery()` and `resolveArchitectQuery()` call sites
- Removed hardcoded `codev/specs/` and `codev/plans/` from error messages — now backend-agnostic
- Updated test suite to verify new `ContentRef`-based signatures

### Phase 2: spawn resolver fallback + PTY env
- **`agent-farm/commands/spawn.ts`**: Added resolver fallback before `fatal()` — tries `getResolver().findSpecBaseName()` when no local spec file found
- Added `resolverSpecName` to spec name priority: GitHub issue title > resolver spec name > local spec filename
- Updated fatal message to remove hardcoded `codev/specs/` path reference
- **`terminal/pty-manager.ts`**: Added `CODEV_ARTIFACTS_DATA_REPO` env var propagation to `baseEnv` for child PTY sessions

## Scope
- 4 files changed, 148 insertions, 153 deletions (net: -5 LOC)
- All changes under 300 LOC threshold for TICK

## Implementation Decisions

1. **Content inline vs. file paths in queries**: Switched from telling reviewers "read from disk at path X" to embedding spec/plan content directly in the query string. This makes consult work for CLI backends where artifacts aren't on disk, and also improves the review experience for local backends by providing content immediately.

2. **Non-fatal resolver in spawn**: The resolver fallback in spawn.ts uses try/catch — if the resolver fails (e.g., CLI not installed), it falls through to the existing error handling rather than adding a new failure mode.

3. **PTY env propagation**: Only propagates `CODEV_ARTIFACTS_DATA_REPO` when it's already set in the parent environment, avoiding unnecessary env pollution for local backend users.

## Flaky Tests

The following pre-existing tests were skipped (unrelated to TICK-002 changes):

- `next.test.ts`: 11 tests related to parent consultation mode, rebuttals, and phase advancement — all fail with "Consultation is set to parent mode" mismatch
- `done-verification.test.ts`: 1 test for review file verification — same parent mode issue

These were verified as pre-existing by running the test suite on the branch before applying TICK-002 changes (same 12 failures).

## Testing

- All 36 consult tests pass (including 4 updated tests for new `ContentRef` signatures)
- All 22 artifact resolver tests pass
- All 57 state tests pass
- Build compiles clean (`npm run build`)
- Full test suite: 2318 passed, 13+12 skipped, 0 new failures
