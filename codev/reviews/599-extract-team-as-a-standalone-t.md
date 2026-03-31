# Review: Extract `team` as a Standalone Top-Level CLI

## Summary

Extracted the `afx team` subcommands (`list`, `message`, `update`) into a standalone `team` CLI binary, added a new `team add` command for scaffolding team member files, added deprecation warnings to `afx team`, and created comprehensive documentation (skill doc, command reference, architecture updates).

## Spec Compliance

- [x] R1: New `team` CLI binary — `bin/team.js` registered in `package.json`, routes through `dist/cli.js run(['team', ...args])`
- [x] R2: `team add <github-handle>` — creates member files with YAML frontmatter, validates handles, normalizes to lowercase, prevents duplicates
- [x] R3: `afx team` deprecation — per-subcommand warnings on stderr, then delegates to same underlying functions
- [x] R4: Skill documentation — `.claude/skills/team/SKILL.md` covering all 4 commands, file format, setup, deprecation
- [x] R5: Command reference — `codev/resources/commands/team.md` following existing doc patterns
- [x] R6: Reference updates — cron config, CLAUDE.md/AGENTS.md, arch.md all updated

All success criteria met as specified. No deviations from requirements.

## Deviations from Plan

- **Phase 1 (cli-extraction)**: Added `requireWorkspace()` helper in `src/cli.ts` rather than modifying `findWorkspaceRoot()`. This was necessary because `findWorkspaceRoot()` returns cwd as a fallback instead of throwing, so an explicit `codev/` directory check was needed. Clean separation — workspace validation lives in the CLI layer, not the library.
- **Phase 2 (deprecation)**: Original test approach was a tautology (manually calling `console.warn`). Replaced with actual `runAgentFarm()` invocations after Gemini caught this during consultation.
- **Phase 3 (docs-and-refs)**: Also fixed pre-existing gap where `porch.js` was missing from arch.md bin/ listings, since we were updating those same locations for `team.js`.

## Lessons Learned

### What Went Well

- **Following the `consult.js` pattern** made CLI extraction trivial — `bin/team.js` is 3 lines
- **Library code was already cleanly separated** (`src/lib/team.ts`, `src/lib/team-github.ts`), so no refactoring of business logic was needed
- **3-way consultation** caught real issues at every phase: spec gaps (Codex on error handling), plan gaps (Gemini on workspace validation tests), implementation issues (Gemini on tautology tests), and doc gaps (Gemini/Claude on arch.md)

### Challenges Encountered

- **ESM module system**: Used `require('fs')` in an ESM module (`src/cli.ts`) — failed at runtime. Fixed by using proper ESM imports (`import { existsSync } from 'node:fs'`). Also had dynamic `import('node:fs/promises')` in `team.ts` that was cleaned up to a top-level import.
- **`findWorkspaceRoot()` doesn't throw**: It returns cwd as fallback, so can't rely on it for workspace validation. Required the `requireWorkspace()` wrapper that explicitly checks for `codev/` directory.
- **Error prefix consistency**: CLI catch blocks printed `error.message` without `Error: ` prefix, but spec required it. Fixed by wrapping all catch blocks with `` `Error: ${...}` `` template.

### What Would Be Done Differently

- **Check `findWorkspaceRoot()` behavior upfront** before planning — the "returns cwd fallback" behavior was a surprise that required a workaround.
- **Write integration-style tests from the start** — the tautology test (manually calling `console.warn` instead of exercising real CLI code) was an avoidable mistake.

### Methodology Improvements

- The ASPIR protocol worked smoothly for this scope — autonomous spec/plan approval was appropriate since requirements were clear from the issue.
- 3-way consultation was valuable in every phase. Even APPROVE verdicts with minor observations (like Claude noting the handle casing edge case) led to improvements.

## Technical Debt

- `findWorkspaceRoot()` returning cwd as fallback (rather than throwing) forces callers to do their own `codev/` directory check. Multiple CLI entry points now need this pattern. A future improvement could add a `requireWorkspaceRoot()` variant that throws.
- `afx team` deprecation warnings will need to be removed eventually (tracked implicitly — no new issue needed since the deprecation itself is the communication mechanism).

## Consultation Feedback

### Specify Phase (Round 1)

#### Gemini (APPROVE)
- No blocking concerns. Minor suggestion to move handlers to `src/commands/team/` for cleaner separation.
  - **Rebutted**: Library code already cleanly separated in `src/lib/team.ts`.

#### Codex (REQUEST_CHANGES)
- **Concern**: Missing behavior for non-codev workspace, undefined handle normalization, undefined error messages/exit codes.
  - **Addressed**: Added Design Constraint for workspace errors, specified lowercase normalization, defined exact error messages and exit codes in R2.

#### Claude (APPROVE)
- Minor observation on handle casing.
  - **Addressed**: Covered by Codex rebuttal (lowercase normalization).

### Plan Phase (Round 1)

#### Gemini (REQUEST_CHANGES)
- **Concern**: Missing workspace-not-found error handling implementation; missing error handling tests.
  - **Addressed**: Added workspace validation to Phase 1 Implementation Details and error handling tests to Phase 1 Test Plan.

#### Codex (REQUEST_CHANGES)
- **Concern**: Missing workspace-not-found handling; deprecation warning format doesn't match spec per-subcommand format; tests don't assert exact error strings.
  - **Addressed**: Added workspace validation, per-subcommand deprecation format, and exact-string assertion tests.

#### Claude (APPROVE)
- Minor observations on workspace-not-found not being an explicit acceptance criterion.
  - **N/A**: Non-blocking observation, workspace validation already covered by other rebuttals.

### CLI-Extraction Phase (Round 1)

#### Gemini (REQUEST_CHANGES)
- **Concern**: Missing integration tests for full CLI invocation; error prefix mismatch in catch blocks.
  - **Addressed**: Fixed error prefix to include `Error: ` in all catch blocks. Integration tests deferred to E2E layer (unit tests cover the same code paths).

#### Codex (REQUEST_CHANGES)
- **Concern**: Error messages missing `Error: ` prefix; missing workspace and non-writable directory tests.
  - **Addressed**: Error prefix fixed; workspace validation and error handling tests added.

#### Claude (APPROVE)
- No concerns raised.

### Deprecation Phase (Round 1)

#### Gemini (REQUEST_CHANGES)
- **Concern**: Deprecation test is a tautology — manually calls `console.warn` instead of exercising actual CLI code.
  - **Addressed**: Replaced with `runAgentFarm(['team', 'list'])` and `runAgentFarm(['team', 'message', ...])` invocations.

#### Codex (REQUEST_CHANGES)
- **Concern**: Tests only cover `list`, not `message`/`update`; no verification of actual CLI path.
  - **Addressed**: Now tests both `list` and `message` through actual `runAgentFarm()` invocations.

#### Claude (APPROVE)
- Minor observation that test only covers `list` subcommand.
  - **Addressed**: Added `message` subcommand test in the same fix.

### Docs-and-Refs Phase (Round 1)

#### Gemini (REQUEST_CHANGES)
- **Concern**: arch.md bin/ listings and Global CLI Commands section don't mention `team.js`; deprecation text in Team View section could be removed.
  - **Addressed**: Updated all three bin/ listing locations and Global CLI Commands. **Rebutted** deprecation text removal — it provides useful context for developers reading old code.

#### Codex (APPROVE)
- No concerns raised.

#### Claude (COMMENT)
- **Concern**: Same arch.md bin/ listing gaps as Gemini.
  - **Addressed**: Fixed alongside Gemini's feedback. Also noted and fixed pre-existing `porch.js` gap.

## Architecture Updates

Architecture updates were completed during Phase 3 (docs-and-refs) as part of the implementation:
- Updated Team View CLI reference section (line 653) to document standalone `team` commands
- Added `team.js` and `porch.js` to bin/ directory listings (lines 901, 907, 965-968)
- Updated Global CLI Commands section to list all five globally installed commands
- No further arch.md updates needed at review time.

## Lessons Learned Updates

No lessons learned updates needed. The insights from this project (follow existing patterns, check utility behavior upfront, avoid tautology tests) are specific instances of existing entries:
- "Check for existing work before implementing from scratch" (general principle of understanding before coding)
- "Tests passing does NOT mean requirements are met" (the tautology test issue)
- "Trust the protocol" (3-way consultation caught every significant issue)

## Flaky Tests

No flaky tests encountered. All 2049+ tests passed consistently across all phases.

## Follow-up Items

- Consider adding `requireWorkspaceRoot()` to `src/lib/skeleton.ts` as a throwing variant of `findWorkspaceRoot()` to eliminate the repeated `codev/` directory check pattern.
- Eventually remove `afx team` deprecation warnings (no timeline — let them serve as migration reminders).
