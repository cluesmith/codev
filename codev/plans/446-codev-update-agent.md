# Plan: codev update --agent

## Metadata
- **ID**: plan-446
- **Status**: draft
- **Specification**: codev/specs/446-codev-update-agent.md
- **Created**: 2026-02-19

## Executive Summary

Refactor the `update()` function in `packages/codev/src/commands/update.ts` to accept an `agent` boolean option. When `agent` is true, suppress all `console.log` (stdout) output, skip the interactive Claude spawn, collect all results (including scaffold utility outputs), and return the `UpdateResult` object. The CLI wrapper in `cli.ts` serializes it to JSON on stdout. Human-readable progress goes to stderr via `console.error` in agent mode.

This is Approach 1 from the spec: minimal refactor of the existing function, no code duplication.

## Success Metrics
- [ ] All specification criteria met (11 test scenarios)
- [ ] Test coverage >90% for new/changed code
- [ ] Zero breaking changes to existing `codev update` behavior
- [ ] JSON output is valid and parseable

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "refactor_update", "title": "Refactor update() to return structured data"},
    {"id": "cli_integration", "title": "CLI integration and JSON output"},
    {"id": "tests", "title": "Tests and validation"}
  ]
}
```

## Phase Breakdown

### Phase 1: Refactor update() to return structured data
**Dependencies**: None

#### Objectives
- Make `update()` return `UpdateResult` instead of `void`
- Add `agent` option to `UpdateOptions`
- Capture scaffold utility results in `UpdateResult`
- Redirect console output to stderr in agent mode
- Skip interactive Claude spawn in agent mode

#### Deliverables
- [ ] Updated `UpdateOptions` interface with `agent?: boolean`
- [ ] Updated `UpdateResult` interface to include scaffold file tracking
- [ ] `update()` returns `Promise<UpdateResult>`
- [ ] Logging uses stderr (`console.error`) when `agent` is true
- [ ] Interactive Claude spawn skipped when `agent` is true
- [ ] Error handling wraps the function in try/catch to produce error result

#### Implementation Details

**File: `packages/codev/src/commands/update.ts`**

1. Add `agent?: boolean` to `UpdateOptions` interface (line 21).

2. Expand `UpdateResult` to include scaffold-originated files:
```typescript
interface UpdateResult {
  updated: string[];
  skipped: string[];
  conflicts: Array<{ file: string; codevNew: string; reason: string }>;
  newFiles: string[];
  rootConflicts: Array<{ file: string; codevNew: string; reason: string }>;
  error?: string;
}
```
Note: `conflicts` changes from `string[]` to object arrays to match the JSON schema.

3. Create a `log()` helper at the top of `update()` that routes to `console.error` when `agent` is true, `console.log` when false:
```typescript
const log = agent ? console.error.bind(console) : console.log.bind(console);
```
Replace all `console.log` calls in the function with `log()`.

4. After calling `copyConsultTypes()`, `copySkills()`, `copyRoles()`, append their `copied` results to `result.newFiles` with full relative paths:
   - `copyConsultTypes().copied` → prefix each with `codev/consult-types/`
   - `copySkills().copied` → prefix each with `.claude/skills/` and append `/`
   - `copyRoles().copied` → prefix each with `codev/roles/`

5. In the hash-based loop, when a conflict is found, push an object `{ file, codevNew, reason }` instead of a plain string. Same for root conflicts.

6. At the end, instead of spawning Claude when `agent` is true, skip the spawn.

7. Wrap the entire function body in a try/catch. On error:
   - If `agent`, set `result.error = error.message` and return the result
   - If not `agent`, re-throw (preserving existing behavior)

8. Change return type from `Promise<void>` to `Promise<UpdateResult>`.

#### Acceptance Criteria
- [ ] `update({ agent: true })` returns `UpdateResult` with all file categories populated
- [ ] `update({ agent: false })` behaves identically to current behavior (logs to stdout, spawns Claude)
- [ ] Scaffold utility files appear in `result.newFiles` with full relative paths
- [ ] No `console.log` calls reach stdout in agent mode

#### Test Plan
- **Unit Tests**: Call `update()` with `agent: true` in a temp directory, assert on returned result
- **Manual Testing**: Run `codev update --agent` in a real project, pipe stdout to `jq`

#### Rollback Strategy
Revert the single file change. No migrations or external state.

#### Risks
- **Risk**: Changing `console.log` → `log()` might miss a call
  - **Mitigation**: Grep for remaining `console.log` after refactor; test stdout purity

---

### Phase 2: CLI integration and JSON output
**Dependencies**: Phase 1

#### Objectives
- Wire the `--agent` flag in Commander.js
- Serialize `UpdateResult` to JSON on stdout
- Add `codevVersion` and schema version to output
- Handle error case with JSON error output

#### Deliverables
- [ ] `--agent` / `-a` CLI flag added to update command
- [ ] JSON output written to stdout with correct schema
- [ ] Version string interpolated from `version.ts`
- [ ] Error JSON emitted on failure (exit 1)

#### Implementation Details

**File: `packages/codev/src/cli.ts`**

1. Add `.option('-a, --agent', 'Non-interactive agent mode with JSON output')` to the update command (after line 74).

2. Pass `agent: options.agent` to the `update()` call.

3. After `update()` returns, if `agent` is true:
   - Import `version` from `./version.js`
   - Construct the JSON output object:
     ```typescript
     const output = {
       version: '1.0',
       codevVersion: version,
       success: !result.error,
       dryRun: !!options.dryRun,
       summary: {
         new: result.newFiles.length,
         updated: result.updated.length,
         conflicts: result.conflicts.length + result.rootConflicts.length,
         skipped: result.skipped.length,
       },
       files: {
         new: result.newFiles,
         updated: result.updated,
         skipped: result.skipped,
         conflicts: [...result.conflicts, ...result.rootConflicts],
       },
       instructions: result.error ? null : {
         conflicts: result.conflicts.length + result.rootConflicts.length > 0
           ? 'For each conflict, merge the .codev-new file into the original. Preserve user customizations and incorporate new sections from .codev-new. Delete the .codev-new file after merging.'
           : null,
         commit: `Stage and commit all changed files with message: '[Maintenance] Update codev to v${version}'`,
       },
       ...(result.error ? { error: result.error } : {}),
     };
     console.log(JSON.stringify(output));
     ```
   - If `result.error`, call `process.exit(1)` after outputting JSON.

4. In the `catch` block for agent mode, emit error JSON to stdout before exiting:
   ```typescript
   if (options.agent) {
     console.log(JSON.stringify({
       version: '1.0',
       codevVersion: version,
       success: false,
       dryRun: !!options.dryRun,
       error: error instanceof Error ? error.message : String(error),
       summary: { new: 0, updated: 0, conflicts: 0, skipped: 0 },
       files: { new: [], updated: [], skipped: [], conflicts: [] },
       instructions: null,
     }));
     process.exit(1);
   }
   ```

#### Acceptance Criteria
- [ ] `codev update --agent` outputs valid JSON on stdout
- [ ] `codev update --agent --dry-run` outputs JSON with `dryRun: true`
- [ ] `codev update --agent --force` outputs JSON with no conflicts
- [ ] Error case emits JSON with `success: false` and `error` field
- [ ] `codevVersion` matches installed package version

#### Test Plan
- **Integration Tests**: Spawn `codev update --agent` as a child process, capture stdout, parse JSON
- **Manual Testing**: Run against real project with known conflicts

#### Rollback Strategy
Revert cli.ts changes. The update.ts changes from Phase 1 are backward-compatible.

#### Risks
- **Risk**: Import cycle with version.ts
  - **Mitigation**: version.ts has no dependencies — safe to import from cli.ts

---

### Phase 3: Tests and validation
**Dependencies**: Phase 1, Phase 2

#### Objectives
- Add comprehensive unit tests for agent mode
- Validate stdout purity and JSON schema
- Ensure existing behavior is unchanged

#### Deliverables
- [ ] Unit tests for all 11 spec test scenarios
- [ ] Test for stdout purity (no non-JSON output)
- [ ] Test for error JSON output
- [ ] Regression test for standard (non-agent) mode
- [ ] Build passes (`npm run build`)
- [ ] All tests pass (`npm test`)

#### Implementation Details

**File: `packages/codev/src/__tests__/update.test.ts`**

Add new test suite `describe('agent mode')` with:

1. **Happy path**: Create temp project with codev/, run `update({ agent: true })`, assert:
   - Returns `UpdateResult` (not void)
   - `newFiles`, `updated`, `skipped`, `conflicts` arrays present
   - No `error` field

2. **Conflicts**: Create temp project with user-modified file (hash mismatch), run `update({ agent: true })`:
   - `conflicts` array has objects with `file`, `codevNew`, `reason`
   - `.codev-new` file exists on disk

3. **Dry run**: Run `update({ agent: true, dryRun: true })`:
   - No files modified on disk
   - Result still populated with expected changes

4. **Force mode**: Run `update({ agent: true, force: true })`:
   - No conflicts in result
   - User-modified files overwritten

5. **Up to date**: Run update twice, second time:
   - All arrays empty except `skipped`

6. **No codev directory**: Run `update({ agent: true })` in empty dir:
   - Error thrown (or `result.error` set)

7. **Standard mode regression**: Run `update()` without agent:
   - Verify `console.log` is called (not `console.error`)
   - Interactive spawn would be triggered on conflicts

8. **Scaffold files in newFiles**: Mock or create skeleton with consult-types/skills/roles:
   - Verify `newFiles` includes full relative paths

9. **Error produces result**: Force a write failure, run `update({ agent: true })`:
   - `result.error` is set
   - Other fields are populated as far as they got

10. **JSON schema validation** (in CLI test or integration test):
    - Capture stdout from agent mode
    - `JSON.parse()` succeeds
    - Required fields present

#### Acceptance Criteria
- [ ] All tests pass
- [ ] `npm run build` succeeds
- [ ] Coverage >90% for update.ts changes

#### Test Plan
- **Unit Tests**: vitest with temp directories (existing pattern)
- **Build Verification**: `npm run build && npm test`

#### Rollback Strategy
Tests are additive — no risk of breaking existing tests.

---

## Dependency Map
```
Phase 1 (refactor update) ──→ Phase 2 (CLI integration) ──→ Phase 3 (tests)
```

## Validation Checkpoints
1. **After Phase 1**: `update({ agent: true })` returns data; `update()` still works normally
2. **After Phase 2**: `codev update --agent` outputs valid JSON
3. **After Phase 3**: All tests pass, build succeeds

## Documentation Updates Required
- [ ] codev skill file (`.claude/skills/codev/`) — add `--agent` flag to update command docs

## Approval
- [ ] Technical Lead Review
- [ ] Engineering Manager Approval
- [ ] Resource Allocation Confirmed
- [ ] Expert AI Consultation Complete

## Notes

The key architectural insight is that `UpdateResult` already exists with the right shape — we're enriching it (adding scaffold file tracking and conflict objects) and making the function return it instead of discarding it. The CLI layer handles JSON serialization, keeping the core logic presentation-agnostic.

---

## Amendment History

This section tracks all TICK amendments to this plan.
