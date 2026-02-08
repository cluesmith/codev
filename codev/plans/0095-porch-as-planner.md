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
7. For `build_verify` / `per_plan_phase` phases — determine current step in the build-verify cycle:
   - **Need BUILD**: `build_complete === false` → emit BUILD tasks
     - If `iteration === 1` → phase prompt in description
     - If `iteration > 1` → history header + feedback injection + phase prompt
     - Include check commands as inline tasks (e.g., "Run `npm run build`", "Run `npm test`")
     - Final task: "Call `porch next <id>` to get next step"
   - **Need VERIFY**: `build_complete === true` AND no review files for current iteration → emit VERIFY tasks
     - Tasks: run 3-way consultation commands in parallel
     - Final task: "Call `porch next <id>` to get next step"
   - **VERIFY COMPLETE**: `build_complete === true` AND review files exist → parse verdicts, then:
     - All APPROVE/COMMENT → advance: request gate (emit gate notification task) or advance plan phase; update state; recurse for next tasks
     - Some REQUEST_CHANGES → increment iteration, reset `build_complete`, emit FIX tasks with feedback
     - Max iterations reached → request gate anyway (emit gate notification task with max-iterations note)
8. For `once` phases (TICK, BUGFIX) → emit single task with phase steps from protocol.json listed in description (or phase prompt if a prompt file exists)
9. For `per_plan_phase` → scope tasks to `current_plan_phase` only

**State mutation rules (addressing consultation feedback):**
- `porch next` ONLY mutates state when it **detects completed work** via filesystem-as-truth:
  - Review files exist for current iteration → parse and decide (advance or iterate)
  - Gate status changed (approved) → advance phase
  - Pre-approved artifact detected → skip phase
- `porch next` does NOT mutate state when merely emitting tasks. If Claude crashes before executing tasks and calls `porch next` again, the same tasks are emitted (idempotency).
- Exception: when advancing from VERIFY COMPLETE (all approve), porch updates state (resets iteration, advances phase) and then emits the NEXT batch of tasks. This is a single atomic transition — the state reflects "ready for next step."

**Build completion detection (filesystem-as-truth):**
- `build_complete` is NOT set by `porch next`. The builder sets it by calling `porch done <id>` after completing build work and checks.
- `porch done` validates checks (build, test), and if passed, sets `build_complete = true` in status.yaml.
- `porch next` reads `build_complete` to decide whether to emit BUILD or VERIFY tasks.
- This preserves the existing `done()` → `next()` separation. `done()` handles completion signaling + checks. `next()` handles planning.

**`done()` and `next()` coexistence:**
- `done()` remains as the command Claude calls to signal work completion. It runs checks, sets `build_complete`, and can advance plan phases.
- `next()` is the planning command that reads state and emits tasks. It does NOT replace `done()`.
- The builder loop is: `porch next` → execute tasks → `porch done` → `porch next` → ...
- For gate advancement: `porch approve` (human) → `porch next` (detects approved gate, advances)

**Checks become tasks:**
- `porch next` does NOT call `runPhaseChecks()` directly. Instead, it emits check commands as tasks for Claude to execute.
- Example tasks: "Run `npm run build`", "Run `npm test -- --exclude='**/e2e/**'`"
- `porch done` still runs checks as validation before setting `build_complete`. This provides a safety gate.
- `checks.ts` is preserved and used by `done()`, not by `next()`.

**Gate notification tasks:**
- When a build-verify cycle completes (all approve) and a gate is needed, `porch next` emits a gate notification task alongside the `gate_pending` status:
  ```json
  {
    "status": "gate_pending",
    "gate": "spec-approval",
    "tasks": [{
      "subject": "Request human approval for spec",
      "activeForm": "Requesting spec approval",
      "description": "Run: porch gate 0094\nThis will open the artifact for human review.\nSTOP and wait for human approval."
    }]
  }
  ```
- This gives the builder an actionable task to execute when a gate is needed.

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
- Update e2e tests to use `porch next` instead of `porch run` (explicit deliverable — 4 scenarios affected)

#### Deliverables
- [ ] `packages/codev/src/commands/porch/__tests__/next.test.ts` — unit tests
- [ ] `packages/codev/src/commands/porch/__tests__/verdict.test.ts` — verdict parsing tests (migrated from parse-verdict.test.ts)
- [ ] Golden test fixtures in `packages/codev/src/commands/porch/__tests__/golden/` for SPIR protocol transitions
- [ ] Obsolete tests deleted: `claude.test.ts`, `run-retry.test.ts`, `timeout.test.ts`, `timeout-retry.test.ts`
- [ ] `parse-verdict.test.ts` updated or replaced by `verdict.test.ts`
- [ ] E2e test runner (`runner.ts`) updated to drive `porch next` loop (affects: happy-path, feedback-loop, single-phase, benchmark scenarios)
- [ ] All tests pass: `npm test`
- [ ] E2e tests pass or are updated: `npm run test:e2e`

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
- **Modify**: E2e test runner and scenarios that reference `porch run`

#### Acceptance Criteria
- [ ] `npm test` passes with zero failures
- [ ] Unit tests cover all `next()` branches: fresh project, pre-approved, gate states, per-plan-phase, iteration loop, idempotency, `once` phases
- [ ] Golden file tests compare actual output against expected JSON for each SPIR transition
- [ ] No references to deleted test files in the codebase
- [ ] Build counter test still passes (build-counter.test.ts unchanged)
- [ ] E2e test runner uses `porch next` loop (not `porch run`)

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
| E2e test rework larger than expected (4 scenarios use `porch run`) | Medium | Medium | Explicit Phase 3 deliverable; may temporarily disable if blocking |
| `done()` and `next()` state transitions conflict | Low | High | Clear separation: `done()` = completion signal, `next()` = planning only |

## Validation Checkpoints
1. **After Phase 1**: `porch next` outputs valid JSON for fresh SPIR project
2. **After Phase 2**: `npm run build` succeeds, `porch run` gone, `porch next` works
3. **After Phase 3**: `npm test` passes, golden files validated

## Documentation Updates Required
- [ ] Update `codev/resources/commands/overview.md` with `porch next` command
- [ ] Update `codev/roles/builder.md` to reference `porch next` instead of `porch run`
- [ ] Update `codev/resources/protocol-format.md` if needed
- [ ] Update `CLAUDE.md` / `AGENTS.md` porch section to reference `porch next`
- [ ] Update builder prompt templates that reference `porch run`

## Notes

**`once` phase handling (TICK, BUGFIX):** These protocols use `type: "once"` phases without `build`/`verify` config. `porch next` handles them by: (1) checking if a prompt file exists in the protocol's `prompts/` directory for that phase — if so, use `buildPhasePrompt()` to generate the task description; (2) if no prompt file, list the phase `steps` from protocol.json in the task description. The current `run.ts` doesn't distinguish `once` phases either — they're a passthrough. Same approach here.

**`isArtifactPreApproved()` and `globSync`:** This function uses Node.js `globSync` to find artifact files. When extracted to `next.ts`, ensure the import works correctly (`import { globSync } from 'node:fs'`).

**Builder loop pattern:** The expected calling pattern for builders:
```
porch next <id>  → emits BUILD tasks
  Claude executes tasks (writes code, runs checks)
porch done <id>  → validates checks, sets build_complete
porch next <id>  → emits VERIFY tasks (consultation)
  Claude executes tasks (runs consult commands)
porch next <id>  → reads review files, decides:
  - all approve → advances, emits next BUILD tasks (or gate)
  - request changes → emits FIX tasks
```

**Consultation feedback addressed (2026-02-08):**
- Gemini: APPROVE — noted e2e test driver need (addressed in Phase 3) and `once` phase content (addressed above)
- Codex: REQUEST_CHANGES — (1) state mutation path clarified: `done()` handles completion, `next()` handles planning; (2) build completion detection: `porch done` sets `build_complete`; (3) gate handling: now emits actionable gate task
- Claude: COMMENT — (1) e2e test rework now explicit Phase 3 deliverable; (2) idempotency semantics clarified; (3) `checks.ts` integration clarified: used by `done()`, not `next()`; (4) `done()` coexistence documented; (5) documentation scope expanded

---

## Amendment History

<!-- When adding a TICK amendment, add a new entry below this line in chronological order -->
