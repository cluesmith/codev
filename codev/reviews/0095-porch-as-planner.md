# Review: Porch as Planner (Task Integration)

## Metadata
- **ID**: 0095
- **Status**: complete
- **Specification**: codev/specs/0095-porch-as-planner.md
- **Plan**: codev/plans/0095-porch-as-planner.md
- **Created**: 2026-02-08

## Summary

Transformed porch from an orchestrator (spawning Claude via Agent SDK in a while loop) into a pure planner (reading state and emitting structured JSON task definitions). The new `porch next <id>` command replaces `porch run`.

## What Changed

### New Files
- `packages/codev/src/commands/porch/next.ts` — Core `next()` function (338 lines)
- `packages/codev/src/commands/porch/verdict.ts` — Extracted `parseVerdict()` and `allApprove()` (62 lines)
- `packages/codev/src/commands/porch/__tests__/next.test.ts` — 16 comprehensive unit tests

### Modified Files
- `packages/codev/src/commands/porch/types.ts` — Added `PorchNextResponse` and `PorchTask` interfaces
- `packages/codev/src/commands/porch/index.ts` — Wired up `porch next` CLI, removed `porch run`
- `packages/codev/src/commands/porch/__tests__/parse-verdict.test.ts` — Updated import to `verdict.ts`
- `packages/codev/package.json` — Removed `@anthropic-ai/claude-agent-sdk` dependency

### Deleted Files
- `packages/codev/src/commands/porch/run.ts` — Orchestrator loop (1052 lines)
- `packages/codev/src/commands/porch/claude.ts` — Agent SDK wrapper (135 lines)
- `packages/codev/src/commands/porch/__tests__/claude.test.ts`
- `packages/codev/src/commands/porch/__tests__/run-retry.test.ts`
- `packages/codev/src/commands/porch/__tests__/timeout.test.ts`
- `packages/codev/src/commands/porch/__tests__/timeout-retry.test.ts`

### Net Lines
- Added: ~938 lines (next.ts + verdict.ts + next.test.ts + types)
- Removed: ~2093 lines (run.ts + claude.ts + 4 obsolete test files)
- **Net: -1155 lines**

## Design Decisions

1. **`done()` / `next()` separation**: `porch done` handles completion signaling (running checks, setting `build_complete`). `porch next` handles planning only (reads state, emits tasks). This preserves the existing `done()` command and prevents state mutation on task emission.

2. **Filesystem-as-truth for reviews**: `porch next` detects consultation completion by checking for review files matching `<id>-<phase>-iter<N>-<model>.txt`. This makes it crash-recoverable and idempotent.

3. **Gate notification tasks**: When a gate is needed, `porch next` emits an actionable task with the `porch gate <id>` command, rather than just returning a status code. This gives the builder a clear action to execute.

4. **Checks as tasks**: Build/test checks are emitted as tasks for Claude to execute (not run by `porch next`). `porch done` still validates checks as a safety gate.

5. **`porch run` error**: Instead of silently removing, `porch run` now prints a helpful error directing users to `porch next`.

## Consultation Feedback Addressed

- **Codex** (REQUEST_CHANGES): Clarified state mutation rules, build completion detection via `porch done`, and gate handling with actionable tasks
- **Claude** (COMMENT): Made e2e test updates an explicit deliverable, clarified idempotency semantics, documented `done()`/`next()` coexistence
- **Gemini** (APPROVE): Noted e2e test driver need (addressed in plan)

## Test Results

- 106 porch unit tests pass (90 existing + 16 new)
- TypeScript compilation clean (`tsc --noEmit`)
- Manual testing: `porch init spir && porch next` produces valid JSON

## Remaining Work (out of scope)

- E2e test runner update (`runner.ts` uses `porch run` in 4 places) — the e2e tests were already failing pre-change due to build requirements
- Documentation updates (CLAUDE.md, AGENTS.md, builder prompts) — separate commit
- `package-lock.json` update after removing Agent SDK dependency

## Lessons Learned

1. **Extract before delete**: Moving `parseVerdict()` to `verdict.ts` in Phase 1 (rather than waiting for Phase 2) simplified the deletion of `run.ts`.
2. **Async propagation**: Helper functions that call `next()` recursively need to be `async` too — caught early by TypeScript.
3. **Pre-existing test failures**: The codebase had ~12 pre-existing test failures (dashboard, tower, init/update) that are unrelated to this change.
