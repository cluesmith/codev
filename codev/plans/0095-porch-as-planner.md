# Plan: Porch as Planner (Task Integration)

## Metadata
- **ID**: 0095
- **Status**: draft
- **Specification**: codev/specs/0095-porch-as-planner.md
- **Created**: 2026-02-08

## Executive Summary

Transform porch from an orchestrator (that spawns Claude via Agent SDK in a while loop) into a pure planner (that reads state and emits structured task JSON). The new `porch next <id>` command replaces `porch run`. The orchestrator code (`run.ts`, `claude.ts`) is deleted. State management, prompts, protocol loading, and plan extraction are preserved and reused.

## Success Metrics
- [ ] `porch next <id>` reads state and outputs structured `PorchNextResponse` JSON
- [ ] Output schema covers all response types: tasks, gate_pending, complete, error
- [ ] Pre-approved artifact detection still works (phases skipped)
- [ ] Gates still require explicit human approval via `porch approve`
- [ ] Build-verify iteration loop works across invocations (iteration persists in status.yaml)
- [ ] Per-plan-phase protocols emit one phase at a time
- [ ] Idempotent: calling `porch next` twice without filesystem changes = same output
- [ ] `porch run` command removed, `claude.ts` deleted
- [ ] All existing protocols (SPIR, MAINTAIN, TICK, BUGFIX) work without protocol.json changes
- [ ] All tests pass, >90% coverage on new code
- [ ] `porch next` completes in <2 seconds

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "phase_1", "title": "Implement porch next command"},
    {"id": "phase_2", "title": "Remove orchestrator code and update CLI"},
    {"id": "phase_3", "title": "Tests and golden files"}
  ]
}
```

## Phase Breakdown

### Phase 1: Implement `porch next` Command
**Dependencies**: None

#### Objectives
- Create the `next.ts` module that reads state and emits structured JSON task definitions
- Define the `PorchNextResponse` and `PorchTask` TypeScript interfaces
- Handle all protocol phase types: `build_verify`, `per_plan_phase`, `once`
- Support pre-approved artifact detection and skip logic
- Support build-verify iteration loop (filesystem-as-truth inference)

#### Deliverables
- [ ] `packages/codev/src/commands/porch/next.ts` — the core `next()` function
- [ ] TypeScript interfaces for `PorchNextResponse` and `PorchTask` added to `types.ts`
- [ ] Pre-approved artifact detection extracted from `run.ts` into a reusable function (or kept in `next.ts`)
- [ ] Filesystem-as-truth inference: detect review files, parse verdicts, determine if iteration passed or needs changes
- [ ] Phase prompt generation reused from `prompts.ts::buildPhasePrompt()`

#### Implementation Details

**New file: `next.ts`**

Core function signature:
```typescript
export async function next(projectRoot: string, projectId: string): Promise<PorchNextResponse>
```

**Logic flow:**
1. Read `status.yaml` via `readState()`
2. Load protocol via `loadProtocol()`
3. Get current phase config via `getPhaseConfig()`
4. If phase is `complete` → return `{ status: 'complete' }`
5. Check for pre-approved artifacts (YAML frontmatter with `approved` + `validated`) → auto-approve gate, advance phase, recurse
6. Check gate status:
   - If gate exists and is pending+requested → return `{ status: 'gate_pending', gate: gateName }`
   - If gate exists and is approved → advance phase via `done()`, recurse to compute next tasks
7. For `build_verify` / `per_plan_phase` phases:
   - If `build_complete` is false and `iteration === 1` → emit BUILD tasks (phase prompt in description)
   - If `build_complete` is false and `iteration > 1` → emit FIX tasks (history header + phase prompt)
   - If `build_complete` is true → check for review files on filesystem:
     - No review files → emit VERIFY tasks (run consultation commands)
     - Review files exist → parse verdicts:
       - All APPROVE/COMMENT → run on_complete, request gate or advance plan phase, emit next
       - Some REQUEST_CHANGES → increment iteration, emit FIX tasks
       - Max iterations reached → emit gate_pending with note
8. For `once` phases (TICK, BUGFIX) → emit single BUILD task with phase prompt
9. For `per_plan_phase` → scope tasks to `current_plan_phase` only

**State mutation:**
- `porch next` performs read-modify-write on status.yaml
- Advances `iteration`, `build_complete`, `phase`, `current_plan_phase` as needed
- Writes history records
- Idempotent when no artifacts change between calls

**New types in `types.ts`:**
```typescript
interface PorchNextResponse {
  status: 'tasks' | 'gate_pending' | 'complete' | 'error';
  phase: string;
  iteration: number;
  plan_phase?: string;
  tasks?: PorchTask[];
  gate?: string;
  error?: string;
  summary?: string;
}

interface PorchTask {
  subject: string;
  activeForm: string;
  description: string;
  sequential?: boolean;
}
```

**Pre-approved artifact detection:**
Extract `isArtifactPreApproved()` from `run.ts` into `next.ts` (or a shared module). It reads the artifact file's YAML frontmatter looking for `approved:` and `validated:` fields.

**Review file detection (filesystem-as-truth):**
To determine if consultation completed, check for review files matching the pattern `<id>-<phase>-iter<N>-<model>.txt` in the project directory. Parse their verdicts using `parseVerdict()` (extracted from `run.ts` into a shared location).

#### Key Files to Create/Modify
- **Create**: `packages/codev/src/commands/porch/next.ts`
- **Modify**: `packages/codev/src/commands/porch/types.ts` (add PorchNextResponse, PorchTask)
- **Modify**: `packages/codev/src/commands/porch/index.ts` (wire up `porch next` CLI subcommand)

#### Acceptance Criteria
- [ ] `porch next <id>` outputs valid JSON conforming to PorchNextResponse schema
- [ ] For a fresh SPIR project → outputs specify BUILD tasks
- [ ] For pre-approved spec → skips specify, outputs plan BUILD tasks
- [ ] For approved gate → advances and outputs next phase tasks
- [ ] For pending gate → outputs `gate_pending` status
- [ ] For `per_plan_phase` → outputs tasks for current plan phase only
- [ ] Calling twice without filesystem changes produces identical output (idempotency)

#### Test Plan
- **Unit Tests**: Test `next()` with mock status.yaml + protocol.json fixtures covering each branch
- **Manual Testing**: Run `porch init spir <id> test && porch next <id>` and verify JSON output

#### Rollback Strategy
Revert the commit. `run.ts` still exists in this phase, so no functionality is lost.

#### Risks
- **Risk**: Phase prompt generation may need adjustments for task description context
  - **Mitigation**: Reuse existing `buildPhasePrompt()` as-is initially; adjust if task descriptions need different framing

---

### Phase 2: Remove Orchestrator Code and Update CLI
**Dependencies**: Phase 1

#### Objectives
- Delete `run.ts` (orchestrator loop) and `claude.ts` (Agent SDK spawning)
- Remove `porch run` CLI subcommand from `index.ts`
- Remove `@anthropic-ai/claude-agent-sdk` dependency from `package.json`
- Extract `parseVerdict()` and `isArtifactPreApproved()` from `run.ts` into shared modules before deleting
- Update CLI help text

#### Deliverables
- [ ] `run.ts` deleted
- [ ] `claude.ts` deleted
- [ ] `porch run` CLI case removed from `index.ts`
- [ ] `parseVerdict()` moved to a shared location (e.g., `verdict.ts`) and imported by `next.ts`
- [ ] `isArtifactPreApproved()` available in `next.ts` (extracted before `run.ts` deletion)
- [ ] `@anthropic-ai/claude-agent-sdk` removed from `package.json`
- [ ] CLI help updated to show `next` instead of `run`
- [ ] Build succeeds (`npm run build`)

#### Implementation Details

**Extract before delete:**
1. Move `parseVerdict()` from `run.ts` to `verdict.ts` (new file). It's used by `next.ts` to infer consultation results from review files.
2. Move `isArtifactPreApproved()` into `next.ts` (it's only needed there now).
3. Move `allApprove()` helper into `verdict.ts` alongside `parseVerdict()`.

**Delete:**
- `packages/codev/src/commands/porch/run.ts`
- `packages/codev/src/commands/porch/claude.ts`

**Modify `index.ts`:**
- Remove `case 'run':` and its `import('./run.js')` dynamic import
- Add `case 'next':` that imports and calls `next()` from `next.ts`, then `console.log(JSON.stringify(result))`
- Update help text

**Modify `package.json`:**
- Remove `@anthropic-ai/claude-agent-sdk` from dependencies (verify no other code imports it first)

#### Key Files to Create/Modify
- **Create**: `packages/codev/src/commands/porch/verdict.ts`
- **Delete**: `packages/codev/src/commands/porch/run.ts`
- **Delete**: `packages/codev/src/commands/porch/claude.ts`
- **Modify**: `packages/codev/src/commands/porch/index.ts`
- **Modify**: `packages/codev/package.json`

#### Acceptance Criteria
- [ ] `npm run build` succeeds with no references to deleted files
- [ ] `porch run` prints an error or is not listed (no silent failure)
- [ ] `porch next <id>` still works after refactoring
- [ ] No imports of `@anthropic-ai/claude-agent-sdk` remain in the codebase
- [ ] `parseVerdict()` is importable from `verdict.ts`

#### Test Plan
- **Unit Tests**: Existing `parse-verdict.test.ts` updated to import from `verdict.ts` instead of `run.ts`
- **Manual Testing**: `npm run build`, `porch --help`, `porch next <id>`

#### Rollback Strategy
Revert the commit. Restores `run.ts` and `claude.ts`.

#### Risks
- **Risk**: Other code may import from `run.ts` or `claude.ts`
  - **Mitigation**: Search codebase for all imports before deleting; update any references

---

### Phase 3: Tests and Golden Files
**Dependencies**: Phase 2

#### Objectives
- Comprehensive unit tests for `porch next` covering all branches
- Golden JSON files for SPIR protocol at each phase transition
- Update/remove obsolete tests (claude.test.ts, run-retry.test.ts, timeout.test.ts, timeout-retry.test.ts)
- Verify existing e2e tests still pass or update them

#### Deliverables
- [ ] `packages/codev/src/commands/porch/__tests__/next.test.ts` — unit tests
- [ ] `packages/codev/src/commands/porch/__tests__/verdict.test.ts` — verdict parsing tests (migrated from parse-verdict.test.ts)
- [ ] Golden test fixtures in `packages/codev/src/commands/porch/__tests__/golden/` for SPIR protocol transitions
- [ ] Obsolete tests deleted: `claude.test.ts`, `run-retry.test.ts`, `timeout.test.ts`, `timeout-retry.test.ts`
- [ ] `parse-verdict.test.ts` updated or replaced by `verdict.test.ts`
- [ ] All tests pass: `npm test`

#### Implementation Details

**Unit tests for `next.ts`** (`next.test.ts`):
1. **Fresh project**: `phase=specify`, `iteration=1`, `build_complete=false` → emits BUILD tasks with spec prompt
2. **Pre-approved artifact**: Spec file with YAML frontmatter → skips specify, emits plan tasks
3. **Build complete, no reviews**: `build_complete=true`, no review files → emits VERIFY tasks
4. **Build complete, all approve**: Review files exist with APPROVE verdicts → advances phase
5. **Build complete, request changes**: Review files with REQUEST_CHANGES → increments iteration, emits FIX tasks
6. **Gate pending**: Gate requested but not approved → returns `gate_pending`
7. **Gate approved**: Gate approved → advances to next phase
8. **Per-plan-phase**: SPIR implement phase with 3 plan phases → emits one at a time
9. **Plan phase advance**: All reviews approve for a plan phase → advances to next plan phase
10. **All plan phases complete**: Moves to review phase
11. **Protocol complete**: All phases done → returns `complete`
12. **Idempotency**: Call twice without changes → same output
13. **Max iterations**: Reaches max without unanimity → emits appropriate response
14. **TICK/BUGFIX `once` phases**: Emits single task with phase prompt

**Golden files** (`golden/`):
- `spir-fresh-specify.json` — Fresh project, first call
- `spir-specify-gate-pending.json` — After spec consultation
- `spir-plan-tasks.json` — After spec approved
- `spir-implement-phase1.json` — After plan approved, first plan phase
- `spir-implement-phase2.json` — After phase 1 complete
- `spir-review-tasks.json` — After all implementation phases
- `spir-complete.json` — After review phase

**Obsolete test cleanup:**
- `claude.test.ts` → delete (tests Agent SDK wrapper that no longer exists)
- `run-retry.test.ts` → delete (tests run loop retry logic that no longer exists)
- `timeout.test.ts` → delete (tests build timeout that no longer exists)
- `timeout-retry.test.ts` → delete (tests timeout retry that no longer exists)

#### Key Files to Create/Modify
- **Create**: `packages/codev/src/commands/porch/__tests__/next.test.ts`
- **Create**: `packages/codev/src/commands/porch/__tests__/verdict.test.ts`
- **Create**: `packages/codev/src/commands/porch/__tests__/golden/*.json` (7 golden files)
- **Delete**: `packages/codev/src/commands/porch/__tests__/claude.test.ts`
- **Delete**: `packages/codev/src/commands/porch/__tests__/run-retry.test.ts`
- **Delete**: `packages/codev/src/commands/porch/__tests__/timeout.test.ts`
- **Delete**: `packages/codev/src/commands/porch/__tests__/timeout-retry.test.ts`
- **Modify**: `packages/codev/src/commands/porch/__tests__/parse-verdict.test.ts` → rename/update imports

#### Acceptance Criteria
- [ ] `npm test` passes with zero failures
- [ ] Unit tests cover all `next()` branches: fresh project, pre-approved, gate states, per-plan-phase, iteration loop, idempotency, `once` phases
- [ ] Golden file tests compare actual output against expected JSON for each SPIR transition
- [ ] No references to deleted test files in the codebase
- [ ] Build counter test still passes (build-counter.test.ts unchanged)

#### Test Plan
- **Unit Tests**: Run `npm test` — all porch tests must pass
- **Integration**: Run `npm run test:e2e` — existing e2e scenarios should pass or be updated
- **Manual Testing**: `porch init spir 9999 test-golden && porch next 9999` → compare against golden

#### Rollback Strategy
Revert the commit. Tests are additive; deleting obsolete tests doesn't break functionality.

#### Risks
- **Risk**: E2e tests may depend on `porch run` behavior
  - **Mitigation**: Check e2e test files for `porch run` usage; update to use `porch next` if needed

---

## Dependency Map
```
Phase 1 ──→ Phase 2 ──→ Phase 3
```

## Resource Requirements
### Development Resources
- **Environment**: Node.js with npm, TypeScript compiler

### Infrastructure
- No database changes
- No new services
- No configuration updates beyond package.json

## Risk Analysis
### Technical Risks
| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Review file detection pattern doesn't match existing files | Medium | High | Check actual file naming in porch project dirs |
| `once` phase types (TICK, BUGFIX) don't have build/verify config | Medium | Medium | Handle gracefully — emit single task with prompt or steps |
| Removing Agent SDK breaks other importers | Low | High | Search entire codebase for imports before removing |

## Validation Checkpoints
1. **After Phase 1**: `porch next` outputs valid JSON for fresh SPIR project
2. **After Phase 2**: `npm run build` succeeds, `porch run` gone, `porch next` works
3. **After Phase 3**: `npm test` passes, golden files validated

## Documentation Updates Required
- [ ] Update `codev/resources/commands/overview.md` with `porch next` command
- [ ] Update `codev/roles/builder.md` to reference `porch next` instead of `porch run`
- [ ] Update `codev/resources/protocol-format.md` if needed

## Notes

The TICK and BUGFIX protocols use `type: "once"` phases (not `build_verify`). These don't have `build` or `verify` config. `porch next` should handle them by emitting a single task with the phase steps listed in the description, since there's no prompt file to load. However, the current `run.ts` orchestrator doesn't actually handle `once` phases differently — it treats everything as build_verify. So `porch next` should similarly focus on `build_verify` and `per_plan_phase` phases first, with `once` phases as a simple passthrough.

The `isArtifactPreApproved()` function uses `globSync` to find artifact files. This import needs to work correctly in the new location.

---

## Amendment History

<!-- When adding a TICK amendment, add a new entry below this line in chronological order -->
