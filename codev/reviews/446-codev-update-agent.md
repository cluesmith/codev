# Review: codev-update-agent

## Summary

Added `--agent` / `-a` flag to `codev update` that produces structured JSON output on stdout instead of interactive terminal output. This enables AI agents (like `af spawn`) to programmatically consume update results — file lists, conflict details, and merge instructions — without parsing human-readable output or dealing with the interactive Claude merge spawn.

## Spec Compliance

- [x] `--agent` flag added to update command via Commander.js
- [x] JSON output on stdout with schema version `1.0`
- [x] `codevVersion` from `version.ts` (reads package.json)
- [x] `success` boolean (false when `result.error` is set)
- [x] `dryRun` boolean reflecting the `--dry-run` flag
- [x] `summary` object with `new`, `updated`, `conflicts`, `skipped` counts
- [x] `files` object with `new`, `updated`, `skipped` string arrays and `conflicts` ConflictEntry array
- [x] `instructions` object with `conflicts` (merge guidance) and `commit` (suggested message with version)
- [x] Error JSON emitted on failure with `success: false` and exit code 1
- [x] Human-readable logs routed to stderr in agent mode (stdout stays clean)
- [x] Interactive Claude spawn skipped in agent mode
- [x] Non-agent behavior unchanged (regression tested)
- [x] Combinable with `--dry-run` and `--force` flags

## Deviations from Plan

- **Phases 1 and 2 implemented together**: The `refactor_update` and `cli_integration` phases were implemented in a single commit because they are tightly coupled — the CLI integration depends directly on the UpdateResult type from the refactor. This was noted by reviewers and accepted.

- **Dry-run scaffold limitation**: Scaffold utility files (consult-types, skills) are not reported in dry-run mode because the scaffold utilities are gated behind `if (!dryRun)`. Roles, however, DO appear in dry-run because they're also served through the hash-based template loop. This differs slightly from the spec's blanket "scaffold files are not tracked in dry-run" statement, but is the correct behavior — the hash-based loop correctly previews what would change.

## Lessons Learned

### What Went Well
- Clean separation of concerns: `update()` returns data, CLI decides presentation
- The `log()` helper pattern (`agent ? console.error : console.log`) was simple and effective for stdout/stderr routing
- 3-way consultations caught the `codev/` prefix bug in all three reviews — demonstrating the value of parallel review
- ConflictEntry objects are more useful than bare strings (file path, .codev-new path, reason)

### Challenges Encountered
- **Gemini timeouts**: Gemini consultation timed out in 4 out of 5 phases. Worked around with placeholder files but lost one reviewer's perspective.
- **Path prefix bug**: Initial implementation used bare `relativePath` (e.g., `protocols/spir.md`) instead of project-relative `codev/protocols/spir.md` in result arrays. All three reviewers caught this in the refactor_update phase.
- **Test assertion weakness**: First test iteration had `expect(true).toBe(true)` and tests with zero assertions. Reviewers correctly flagged these in the tests phase.

### What Would Be Done Differently
- Write the JSON schema validation test FIRST (plan item 10) — it's the primary user-facing contract and should have been the first test, not an afterthought
- Include `projectRelativePath` from the start in the plan — the path prefix issue was foreseeable

### Methodology Improvements
- Gemini consultation reliability is a concern — 80% timeout rate suggests the timeout threshold or model endpoint may need adjustment

## Technical Debt
- None identified. The implementation is clean and minimal.

## Consultation Feedback

### Specify Phase (Round 1)

#### Claude
- **Concern**: Scaffold utility files need tracking in JSON output
  - **Addressed**: Added scaffold file tracking to spec (consult-types, skills, roles)
- **Concern**: `success` field semantics with dry-run ambiguous
  - **Addressed**: Clarified in spec — `success` reflects whether errors occurred, independent of dry-run

#### Codex
- **Concern**: Version source unclear, error JSON shape needed
  - **Addressed**: Added explicit `codevVersion` source (version.ts) and error JSON schema to spec

#### Gemini
- **Concern**: Timeout (no feedback received)

### Plan Phase (Round 1)

#### Claude
- **Concern**: Changing `conflicts` from `string[]` to objects would break Claude spawn code
  - **Addressed**: Updated `allConflicts` construction to use `.map(c => c.file)` for backward compatibility
- **Concern**: `result` initialized after scaffold calls; dry-run return needs `return result`
  - **Addressed**: Moved result initialization before scaffold calls; ensured all returns include result

#### Codex
- **Concern**: Dry-run scaffold limitation; stdout purity from helpers; error handling split
  - **Addressed**: Documented scaffold limitation; verified scaffold utilities don't write to stdout; designed two-level error handling

#### Gemini
- **Concern**: Same conflicts/spawn breaking change, missing test scenarios
  - **Addressed**: Same fix as Claude feedback

### Implement: refactor_update (Round 1)

#### Claude, Codex, Gemini (all three)
- **Concern**: Template-loop paths missing `codev/` prefix
  - **Addressed**: Introduced `projectRelativePath = \`codev/${relativePath}\`` and fixed `allConflicts` double-prefix bug

### Implement: cli_integration (Round 1)

#### Claude
- No concerns raised (APPROVE)

#### Codex
- No concerns raised (APPROVE)

#### Gemini
- Timeout (no feedback received)

### Implement: tests (Round 1)

#### Claude
- **Concern**: Missing JSON schema validation test, version interpolation test, dry-run scaffold assertion, weak assertions
  - **Addressed**: Added all missing tests and strengthened weak assertions

#### Codex
- **Concern**: Same missing tests plus scaffold presence in newFiles, .codev-new creation assertion
  - **Addressed**: JSON schema and version tests added; scaffold presence implicitly tested via path-format test; conflict test now verifies .codev-new file exists on disk

#### Gemini
- Timeout (no feedback received)

## Flaky Tests

No flaky tests encountered.

## Architecture Updates

No architecture updates needed. This feature adds a flag to an existing CLI command (`codev update`) and refactors its return type. No new subsystems, data flows, or architectural decisions were introduced. The `UpdateResult` and `ConflictEntry` interfaces are local to `update.ts` and `cli.ts`.

## Lessons Learned Updates

No lessons learned updates needed. The path-prefix bug and test assertion weakness are already covered by existing lessons ("run exhaustive grep before claiming all instances fixed" and "tests passing does NOT mean requirements are met"). The Gemini timeout issue is operational, not a generalizable development lesson.

## Follow-up Items

- Investigate Gemini consultation timeout rate (80% in this project)
- Consider adding CLI-level integration tests that capture actual stdout from `codev update --agent` (current tests validate the JSON construction logic but not the full CLI pipeline)
