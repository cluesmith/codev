# Review: af cron — Scheduled Workspace Tasks

## Summary

Implemented a lightweight cron scheduler for Tower that loads task definitions from `.af-cron/*.yaml` per workspace, executes them asynchronously via `child_process.exec`, evaluates conditions against command output, and delivers notifications through the existing `af send` pipeline. Added full CLI support via `af cron` subcommands and a skeleton example for new projects.

## Deliverables

### Phase 1: Database Schema and Cron Parser
- `cron_tasks` table added to global.db (migration v10)
- Minimal cron parser supporting `*`, `*/N`, fixed values, comma lists, and shortcuts (`@hourly`, `@daily`, `@startup`)
- 28 parser unit tests + 3 migration tests

### Phase 2: Core Scheduler Module
- `tower-cron.ts` (~400 lines): YAML loading, async execution, condition evaluation, message delivery, SQLite state tracking
- Dependency injection via `CronDeps` interface for testability
- 26 unit tests covering all scheduler functions

### Phase 3: Tower Integration and API Routes
- `initCron()`/`shutdownCron()` wired into Tower lifecycle
- 6 API routes: list, status, run, enable, disable (with workspace filtering and ambiguity detection)
- 9 route handler tests

### Phase 4: CLI Commands and Skeleton Updates
- `af cron` subcommand group with list, status, run, enable, disable
- `TowerClient`-based handlers following existing CLI patterns
- Skeleton example `.af-cron/ci-health.yaml.example`
- 13 CLI unit tests

**Total: 79 new tests across 4 test files.**

## Spec Compliance

- [x] `.af-cron/*.yaml` task definitions loaded per workspace
- [x] Standard 5-field cron expressions with `@hourly`, `@daily`, `@startup` shortcuts
- [x] Async `child_process.exec` execution (non-blocking)
- [x] Condition evaluation via `new Function('output', ...)`
- [x] `${output}` template substitution in messages
- [x] Message delivery via shared send pipeline (format + write + broadcast)
- [x] SQLite state tracking (last_run, last_result, last_output)
- [x] Enable/disable per task (both YAML and DB-level)
- [x] Command timeout support
- [x] `@startup` tasks run once at Tower init
- [x] REST API for task management
- [x] CLI subcommands for all operations
- [x] Skeleton example files

## Deviations from Plan

- **Test file locations**: Plan suggested `packages/codev/tests/unit/` but tests were placed in `packages/codev/src/agent-farm/__tests__/` to match the existing project convention (all other Tower/agent-farm tests live there).
- **Shared `deliverMessage()` helper**: Plan suggested extracting a shared helper for both cron and `handleSend`. Deferred — the cron module has its own `deliverMessage()` function that follows the same pipeline. Extracting a shared utility would require modifying the existing `handleSend` route handler, which is out of scope for this spec.
- **`CronDeps.getTerminalManager` return type**: Changed from `null` to `undefined` to match the actual `TerminalManager.getSession()` API which returns `PtySession | undefined`.

## Lessons Learned

### What Went Well
- **Dependency injection pattern**: Using `CronDeps` interface made the scheduler fully testable without complex mocking of the Tower server internals.
- **Incremental phases**: Each phase built cleanly on the previous one. Phase 1 (parser + schema) was independently testable, Phase 2 (scheduler) used Phase 1 exports, etc.
- **Existing patterns**: The Tower codebase has strong patterns for route handlers, CLI commands, and module initialization. Following these made implementation straightforward.

### Challenges Encountered
- **esbuild JSDoc parsing**: `*/N` in JSDoc comments was parsed as closing the comment block, causing build failures. Fixed by converting JSDoc to line comments in the parser module.
- **Consult tooling file list mismatch**: All 12 consultations (3 per phase x 4 phases) showed wrong "Changed Files" due to the worktree containing project directories from other builders. Required rebuttals for every Codex review. Gemini and Claude consistently identified the correct files.
- **Test mock subtleties**: `child_process.exec` mock needed to pass non-empty stdout/stderr to avoid overwriting the error object's properties. `initCron` running `@startup` tasks asynchronously required clearing mock call counts before testing `tick()`.

### What Would Be Done Differently
- Would have checked the esbuild JSDoc limitation before writing documentation-heavy code.
- The consult tooling issue should be reported as a separate bug — it adds overhead to every phase review.

### Methodology Improvements
- The `--project-id` flag for `consult` should work in builder worktrees to avoid the multi-project detection issue. Currently only `--issue` works as a workaround.

## Technical Debt

- **`new Function` for condition evaluation**: Works correctly but is a code injection vector. Acceptable since conditions are in local YAML files controlled by the workspace owner (same trust level as shell commands). Could add a sandboxed evaluator in a follow-up.
- **No concurrency limit**: All due tasks fire concurrently. At expected scale (2-5 tasks, 1-3 workspaces) this is fine. May need a concurrency limit if usage grows.

## Follow-up Items

- Fix consult tooling multi-project detection in builder worktrees
- Consider adding `af cron history` to show execution history from SQLite
- Consider dashboard UI panel for cron tasks (React component)
- Add `@weekly` and `@monthly` shortcuts if requested
