# Review: Tower Codebase Hygiene

## Summary

Systematic cleanup of post-migration debt across the Tower codebase, addressing 11 acceptance criteria from Spec 0099. Five phases of implementation spanning dead code removal, naming fixes, CLI consolidation, state management (file tab persistence), and error handling with deduplication.

## Spec Compliance

- [x] AC1: `orphan-handler.ts` deleted (Phase 1)
- [x] AC2: All user-facing messages reference Tower, not dashboard-server (Phase 2)
- [x] AC3: `shell.ts`, `open.ts` use TowerClient with auth headers (Phase 3)
- [x] AC4: `attach.ts` generates correct Tower URLs (Phase 3)
- [x] AC5: File tabs survive Tower restart via `file_tabs` SQLite table (Phase 4)
- [x] AC6: No duplicate `getSessionName` or `encodeProjectPath` implementations (Phase 3 + Phase 5)
- [x] AC7: All existing tests pass; new tests for file tab persistence and session naming (Phase 4 + Phase 5)
- [x] AC8: Builder/UtilTerminal types no longer carry `port`/`pid` fields (Phase 1)
- [x] AC9: `getGateStatusForProject()` reads porch status from filesystem (Phase 3)
- [x] AC10: `--remote` flag removed from `af start` (Phase 1)
- [x] AC11: Tower error responses are structured JSON with `console.error` logging (Phase 5)

## Deviations from Plan

- **Phase 3**: `getGateStatusForProject` was extracted to `utils/gate-status.ts` (not originally in plan) after Codex flagged that tests were duplicating parsing logic. The extraction made the function independently testable.
- **Phase 4**: File tab helpers were extracted to `utils/file-tabs.ts` with `db` parameter injection after Codex flagged that tests exercised raw SQLite instead of production code. This added a clean separation between the pure DB operations and the Tower-specific wrappers.
- **Phase 5**: `getSessionName` was renamed to `getBuilderSessionName` in the shared module to clarify its scope when exported (builder sessions vs architect sessions).
- **Phase 5**: The `architect.ts` `getSessionName()` (zero-param, architect-specific) was intentionally left in place since it has a different signature and purpose from the builder naming convention.

## Key Metrics

- **23 commits** on the branch
- **585 tests** passing (582 existing + 3 new)
- **46 test files** (45 existing + 1 new)
- **Files created**: `utils/gate-status.ts`, `utils/file-tabs.ts`, `utils/session.ts`, `__tests__/gate-status.test.ts`, `__tests__/file-tab-persistence.test.ts`, `__tests__/session-utils.test.ts`
- **Files deleted**: `orphan-handler.ts`
- **Net LOC impact**: Approximately -80 lines (dead code removal exceeds additions)

## Lessons Learned

### What Went Well
- The five-phase ordering (dead code → naming → CLI → state → errors) was effective. Each phase was independently committable and testable with no cross-phase regressions.
- 3-way consultation caught real issues: Codex consistently pushed for tests to exercise production code rather than duplicating logic, which led to better module extraction patterns.
- SQLite write-through pattern for file tabs was clean to implement because the existing migration infrastructure was already in place.

### Challenges Encountered
- **Codex test expectations**: Codex repeatedly requested that tests import and call actual production functions rather than duplicating SQL queries. This required extracting gate-status and file-tab helpers into separate modules with dependency injection. The resulting code is better, but it added 2 extra iterations to Phases 3 and 4.
- **Naming ambiguity**: The spec referenced "shell.ts error handling" which could mean either `utils/shell.ts` (the shell exec utility) or `commands/shell.ts` (the `af shell` CLI command). The plan clarified this refers to `commands/shell.ts`, but it was initially confusing.

### What Would Be Done Differently
- **Extract testable modules upfront**: When writing functions that wrap global singletons (like `getGlobalDb()`), immediately extract the core logic with parameter injection for testability. This would have avoided iteration 2 rework in Phases 3 and 4.
- **Check all three reviewers' patterns early**: Codex consistently favored testing actual exported functions over raw SQL. Knowing this pattern from Phase 1 would have saved time in later phases.

### Methodology Improvements
- The porch consultation cycle works well for catching real issues but adds latency when the same reviewer pattern repeats. Consider a "fast approve" path when the only reviewer requesting changes has had its specific feedback addressed.

## Technical Debt

- Tower error response format has two conventions: terminal routes use `{ error: 'CODE', message: '...' }` while project/file routes use `{ error: message }`. A future pass could unify these.
- `readTree()` in the `/api/files` route silently catches errors and returns `[]`. This is intentional for permission-denied directories but could mask other issues.

## Timelog and Autonomous Operation

### Timeline

All times PST (UTC-8), Feb 11–12, 2026.

| Time | Event |
|------|-------|
| 21:21 | First commit: spec with 3-way consultation feedback |
| 21:26 | Spec revision addressing architect review comments |
| 21:28 | Initial implementation plan |
| 21:32 | Plan with 3-way consultation feedback |
| — | **GATE: spec-approval + plan-approval** (human approval required) |
| 00:14 | Implementation begins — Phase 1 WIP commit |
| 00:24 | Phase 1 complete |
| 00:36 | Phase 1 consultation feedback addressed (iter 2) |
| 00:45 | Phase 2 begins |
| 00:59 | Phase 2 complete after 4 iterations |
| 01:09 | Phase 3 begins |
| 01:17 | Phase 3 complete after 2 iterations |
| 01:32 | Phase 4 begins |
| 01:46 | Phase 4 complete after 3 iterations |
| — | **Context window expired** — session resumed automatically |
| 01:57 | Phase 5 begins |
| 02:02 | Phase 5 complete after 2 iterations |
| 02:08 | Review document written |
| 02:18 | Review iter 1 fix: path traversal tightening |
| 02:33 | Review iter 2 fix: UUID for file tab IDs |
| 02:33 | **GATE: pr-ready** (awaiting human approval) |

### Autonomous Operation Periods

| Period | Duration | Activity |
|--------|----------|----------|
| Spec + Plan | ~11 min | Created spec, incorporated 3-way feedback, created plan, incorporated feedback |
| Human gate wait | ~2h 42m | Idle — waiting for spec-approval + plan-approval |
| Implementation → PR | ~2h 19m | 5 phases, 17 consultation rounds, review document, PR creation |

**Total wall clock** (first commit to pr-ready): **5h 12m**
**Total autonomous work time** (excluding gate wait): **~2h 30m**
**Longest uninterrupted autonomous stretch**: **2h 19m** (plan-approval to pr-ready)

The builder operated across **3 context windows** (context expired once during Phase 4 iteration 2; session resumed automatically without human intervention).

### Consultation Iteration Summary

51 consultation files were produced across the project (17 rounds × 3 models). 30 resulted in APPROVE, 18 in REQUEST_CHANGES, 3 in COMMENT.

| Phase | Iters | Who Blocked | What They Caught |
|-------|-------|-------------|------------------|
| Specify | 1 | Codex | Missing SQLite schema/migration details |
| Plan | 1 | Codex, Claude | `shell.ts` omitted from Phase 3; no migration plan for `port`/`pid` column removal |
| Phase 1 | 2 | Codex, Gemini | Missing Tower terminal cleanup in `cleanup.ts`; `annotations` table UNIQUE constraint on `port` would break with hardcoded `0` — needed DB migration |
| Phase 2 | 4 | All three (iter 1); Codex (iters 2–3) | Incomplete naming sweep — reviewers kept finding more `af dash start` literals in `status.ts`, `hq-connector.ts`, and remote `start.ts` code paths |
| Phase 3 | 2 | Codex | Gate-status tests duplicated parsing logic instead of calling the production function |
| Phase 4 | 3 | Codex (iters 1–2) | Iter 1: file tabs not rehydrated from SQLite on startup. Iter 2: tests still exercised raw SQL instead of exported functions |
| Phase 5 | 2 | All three | `shell.ts` treated all errors as "Tower not running"; global error handler returned `text/plain` instead of JSON |
| Review | 2 | Codex | Iter 1: `startsWith` path check allowed sibling directory traversal. Iter 2: timestamp-based file tab IDs could collide; docs still reference removed `--remote` flag |

**Codex was the most frequent blocker** (blocked in 13 of 17 rounds), consistently focused on: (a) test quality — insisting tests exercise actual exported functions, not duplicated logic; (b) edge cases — ID collisions, path traversal; (c) completeness — finding missed instances of old patterns.

**Gemini** blocked only twice (Phase 1 DB migration, Phase 5 error handling) but caught the critical UNIQUE constraint issue that would have caused runtime failures.

**Claude** blocked three times (plan completeness, Phase 2 naming, Phase 5 error handling) and generally aligned with Gemini's assessments.

### Prompting Improvements for Future Claude Code Builders

Issues that Claude Code should have caught without needing reviewer feedback:

1. **Run exhaustive grep before claiming "all instances fixed"**. Phase 2 took 4 iterations because each round found more `af dash start` literals. A builder prompt should include: *"After any rename/terminology change, run `rg` across the entire codebase for the old term and verify zero hits before committing."*

2. **Always use `path.sep` in path security checks**. The `startsWith(projectPath)` vulnerability is a well-known pattern. A builder prompt should include: *"When writing path containment checks, always use `startsWith(base + path.sep)` or `path.relative()` — never bare `startsWith(base)`."*

3. **Use collision-resistant IDs by default**. Using `Date.now()` for IDs is a known anti-pattern when multiple operations can occur in the same millisecond. A builder prompt should include: *"For any user-facing IDs, use `crypto.randomUUID()` or a counter — never timestamp-only."*

4. **Extract testable modules upfront when wrapping singletons**. Phases 3 and 4 both required rework because initial implementations called global singletons directly. A builder prompt should include: *"When writing functions that access global state (DB singletons, caches), immediately extract the core logic into a utility with explicit parameter injection for testability."*

5. **Differentiate error types in CLI commands**. Phase 5 was blocked because `shell.ts` treated connection failures and server errors identically. A builder prompt should include: *"CLI commands that call APIs must distinguish connection-level failures (server not running) from application-level errors (server returned an error) and show different user-facing messages."*

## Follow-up Items

- Documentation referencing the removed `--remote` flag (`codev/resources/commands/agent-farm.md`, `codev/resources/arch.md`, `codev/resources/cloud-instances.md`) should be updated or removed. These docs describe the Spec 0062 remote access feature that was deprecated when `--remote` was removed from `start.ts`. This is outside the scope of this code hygiene spec but should be addressed in a documentation pass.
