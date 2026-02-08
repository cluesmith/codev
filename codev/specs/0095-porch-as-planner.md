# Specification: Porch as Planner (Task Integration)

## Metadata
- **ID**: 0095
- **Status**: draft
- **Created**: 2026-02-08

## Clarifying Questions Asked

1. **Q: Could we modify porch to generate a task list and reuse Claude Code's features?**
   A: Yes. The idea is porch becomes a planner, not an orchestrator. It reads the current state and emits Claude Code tasks for the next batch of work.

2. **Q: Shouldn't status.yaml go away if we're using tasks?**
   A: No. Tasks are session-scoped (they die when the conversation ends). status.yaml is still needed for cross-session persistence — if a builder session dies mid-implementation, porch needs to know where it left off on the next invocation.

3. **Q: Who is the executor?**
   A: Claude Code is the executor. Porch no longer spawns Claude via Agent SDK. Instead, Claude Code (the builder) calls porch to get its next tasks, executes them, then calls porch again.

4. **Q: How does the iteration loop work?**
   A: Porch generates tasks for ONE build-verify iteration at a time. After consultation results come back, Claude calls porch again. Porch reads the results, decides whether to iterate or advance, and emits the next batch of tasks.

## Problem Statement

Porch currently has a dual role: it is both the **planner** (deciding what phase comes next, what the build-verify loop should do) and the **orchestrator** (spawning Claude via Agent SDK, running consultations as subprocesses, managing the event loop). This coupling creates several problems:

1. **Invisible execution**: When porch runs, the user sees nothing until the phase completes. There's no progress tracking, no task list, no incremental status.
2. **Redundant runtime**: Porch spawns Claude via Agent SDK, but the builder is already running inside a Claude Code session. This creates a Claude-inside-Claude nesting that wastes tokens and context.
3. **Fragile process management**: Porch manages subprocess lifecycles (Claude SDK, consult CLI), timeouts, retries, and circuit breakers — all infrastructure that Claude Code already handles.
4. **No user interaction during execution**: Once `porch run` starts, the user can't intervene until a gate or failure. With tasks, the user can see progress and interact.

## Current State

### Execution Model

`porch run <id>` enters a while loop:
1. Reads `status.yaml` to determine current phase and iteration
2. If build needed: spawns Claude via `@anthropic-ai/claude-agent-sdk` with a phase prompt, captures output to a file, retries up to 3 times with exponential backoff
3. If verify needed: spawns 3 parallel `consult` CLI subprocesses, parses verdicts
4. If all approve: runs `on_complete` (commit/push), requests gate
5. If changes requested: increments iteration, injects review feedback into next prompt, loops
6. Gate blocks execution until `porch approve` is called

### Key State (`status.yaml`)

- `phase`: Current protocol phase (specify, plan, implement, review)
- `iteration`: Current build-verify iteration (1-based, persisted)
- `build_complete`: Whether build finished in current iteration
- `history[]`: All previous iterations with build output paths + review file paths
- `gates{}`: Gate status (pending/approved with timestamps)
- `plan_phases[]`: Extracted plan phases with per-phase status
- `current_plan_phase`: Which plan phase is active
- `awaiting_input`: Whether worker signaled BLOCKED

### Existing Precedent: `--single-phase` mode

`porch run --single-phase` already does something close to the proposed model. It runs ONE build-verify cycle, then exits with structured JSON (`__PORCH_RESULT__`):
```json
{"phase": "specify", "status": "gate_needed", "gate": "spec-approval", "reviews": [...]}
```
The builder's Claude then interprets this result and decides what to do next. This proves the "porch as advisor" pattern works.

### What Works Well Today

- Deterministic phase transitions driven by protocol.json
- Comprehensive iteration history with feedback injection
- Pre-approved artifact detection (YAML frontmatter)
- Atomic state writes (temp file + rename)
- Gate mechanics preventing automation from bypassing human approval

## Desired State

Porch becomes a **pure planner**: given the current state (status.yaml + filesystem), it emits a batch of Claude Code tasks for the next step. Claude Code executes the tasks. When the batch completes (or hits a gate), Claude calls porch again.

### Invocation Flow

```
Builder session starts
  |
  v
Claude calls: porch next <id>
  |
  v
Porch reads: status.yaml + protocol.json + filesystem
  |
  v
Porch emits: TaskCreate calls (or structured JSON that Claude interprets)
  |
  v
Claude Code creates tasks, executes them
  |
  v
Tasks complete (or hit gate boundary)
  |
  v
Claude calls: porch next <id>  (loop)
```

### Example: SPIR Protocol for Spec 0094

**Invocation 1** (spec exists, not yet reviewed):
```
Tasks emitted:
  1. Run 3-way consultation on spec (consult spec 0094 --model gemini/codex/claude)
  2. Read consultation results, incorporate feedback, update spec if needed
  3. [GATE] Request human approval of spec (porch gate 0094)
```

**Invocation 2** (spec approved, no plan exists):
```
Tasks emitted:
  1. Read the approved spec, create implementation plan
  2. Run 3-way consultation on plan
  3. Incorporate feedback, update plan
  4. [GATE] Request human approval of plan (porch gate 0094)
```

**Invocation 3** (plan approved with 2 phases):
```
Tasks emitted:
  1. Implement Phase 1: Update CSS mobile block
  2. Implement Phase 2: Add .new-shell-row class in JS
  3. Run build check (npm run build)
  4. Run test check (npm test)
  5. Run 3-way review on implementation
  6. If reviewers flag issues: fix and re-consult (up to N iterations)
  7. [GATE] Request human approval
```

### What Porch Still Does

- Reads protocol.json to determine phase ordering, checks, gates
- Reads status.yaml to know current phase, iteration, history
- Reads filesystem to detect pre-approved artifacts
- Computes the next batch of tasks based on all the above
- Updates status.yaml when phases advance (via `porch done`, `porch approve`)
- Tracks iteration history (build outputs, review files)

### What Porch No Longer Does

- Spawns Claude via Agent SDK (claude.ts)
- Manages subprocess lifecycles
- Runs the while loop / event loop
- Manages timeouts, retries, circuit breakers (Claude Code handles its own)
- Streams output to files (Claude Code does this natively)

### What Claude Code Gains

- Native task progress UI (spinners, completion status)
- User can see what's happening at every step
- User can intervene between tasks
- Tasks are visible in the conversation, not hidden in a subprocess

## Stakeholders
- **Primary Users**: Builders (AI agents running inside Claude Code sessions)
- **Secondary Users**: Architects (humans monitoring builder progress)
- **Technical Team**: Codev maintainers
- **Business Owners**: Project owner (Waleed)

## Success Criteria
- [ ] `porch next <id>` reads state and outputs structured task definitions
- [ ] Claude Code builder can consume task definitions and create tasks
- [ ] status.yaml is updated correctly across session boundaries
- [ ] Pre-approved artifact detection still works (phases skipped)
- [ ] Gates still require explicit human approval via `porch approve`
- [ ] Build-verify iteration loop works across invocations (iteration count persists)
- [ ] History tracking preserved (build outputs + review files referenced)
- [ ] Existing protocols (SPIR, MAINTAIN, TICK) work without modification to protocol.json
- [ ] A builder can be killed and restarted, and `porch next` picks up where it left off

## Constraints

### Technical Constraints
- Claude Code tasks are session-scoped — they do not persist across sessions
- status.yaml must remain the persistent state store
- Protocol definitions (protocol.json) should not change
- Must support all existing phase types: build_verify, per_plan_phase
- Consultation still runs via `consult` CLI (no change to that tool)

### Business Constraints
- Backward compatible: `porch run` should still work for users not using Claude Code
- The `porch approve` gate workflow must remain human-only

## Assumptions
- Claude Code's TaskCreate/TaskUpdate API is available to porch (either directly or via structured output that Claude interprets)
- The builder's Claude Code session has access to `consult`, `git`, and build tools
- One builder session works on one project at a time

## Solution Approaches

### Chosen Approach: Structured JSON Output

Porch outputs task definitions as structured JSON to stdout. The builder's Claude reads the output and creates tasks via TaskCreate, then executes them. No skill wrapper needed — Claude can interpret JSON directly.

### `porch next` Output Schema

```typescript
interface PorchNextResponse {
  status: 'tasks' | 'gate_pending' | 'complete' | 'error';
  phase: string;              // Current protocol phase name
  iteration: number;          // Current build-verify iteration (1-based)
  plan_phase?: string;        // Current plan phase (for per_plan_phase protocols)

  // Present when status === 'tasks'
  tasks?: PorchTask[];

  // Present when status === 'gate_pending'
  gate?: string;              // Gate name (e.g., "spec-approval")

  // Present when status === 'error'
  error?: string;             // Error message

  // Present when status === 'complete'
  summary?: string;           // Protocol completion summary
}

interface PorchTask {
  subject: string;            // Imperative title (e.g., "Run 3-way consultation on spec")
  activeForm: string;         // Present continuous (e.g., "Running spec consultation")
  description: string;        // Full instructions for Claude to execute
  sequential?: boolean;       // If true, must complete before next task starts (default: false)
}
```

Tasks are ordered — Claude executes them in array order. Tasks with `sequential: true` must complete before the next task begins. Tasks without it can be parallelized at Claude's discretion. This replaces the invalid `blockedBy` indices from the draft (Claude Code's TaskUpdate uses `addBlockedBy` with task IDs, not creation-time indices).

### Example Responses

**Tasks to execute:**
```json
{
  "status": "tasks",
  "phase": "specify",
  "iteration": 1,
  "tasks": [
    {
      "subject": "Run 3-way consultation on spec",
      "activeForm": "Running spec consultation",
      "description": "Run these three commands in parallel in the background:\n\nconsult spec 0094 --model gemini\nconsult spec 0094 --model codex\nconsult spec 0094 --model claude\n\nWait for all three to complete, then call `porch next 0094` again."
    }
  ]
}
```

**Gate pending (waiting for human approval):**
```json
{
  "status": "gate_pending",
  "phase": "specify",
  "iteration": 1,
  "gate": "spec-approval"
}
```

**Protocol complete:**
```json
{
  "status": "complete",
  "phase": "review",
  "iteration": 1,
  "summary": "All phases complete. PR merged."
}
```

### State Mutation Rules

`porch next` is a **read-modify-write** operation:
1. **Reads** status.yaml, protocol.json, and filesystem artifacts
2. **Infers** what has happened since the last call (filesystem-as-truth):
   - Review files exist → consultation completed
   - Review verdicts are all APPROVE → verification passed
   - Gate status changed → approval granted
   - Build artifacts updated → build completed
3. **Updates** status.yaml if state transitions are warranted (e.g., advance phase, increment iteration)
4. **Emits** tasks for the next step based on the new state

This makes `porch next` idempotent when called without intervening work — if no artifacts changed, it emits the same tasks.

### Task Description Content

Phase prompts (100+ lines with variable substitution and history injection) are embedded directly in the task `description` field. The existing `buildPhasePrompt()` function in `prompts.ts` generates these — `porch next` reuses it. The description includes:
- The full phase prompt with all variables resolved
- Previous iteration feedback (if iterating after REQUEST_CHANGES)
- Plan phase context (for per_plan_phase protocols)
- File paths to relevant artifacts (spec, plan, review files)

### `porch run` Coexistence

`porch run` (orchestrator mode) and `porch next` (planner mode) share:
- State machine logic (phase transitions, gate checks, artifact detection)
- State persistence (status.yaml read/write via state.ts)
- Prompt generation (prompts.ts)
- Protocol loading (protocol.ts)

They differ only in execution:
- `porch run`: spawns Claude via Agent SDK, manages the while loop
- `porch next`: emits JSON, returns immediately

No flags or migration needed. Users choose by calling the appropriate command.

## Resolved Questions

### Critical
- [x] **Does status.yaml stay?** Yes — tasks are session-scoped, need persistent state.
- [x] **How does Claude signal task completion back to porch?** Filesystem-as-truth. Porch infers completion from artifacts on disk when `porch next` is called. No explicit "done" signal needed. If the review files exist, the consultation step is done. If the spec file has been updated since the last iteration, the build step is done. This makes the system robust to crashes — `porch next` is idempotent.
- [x] **Should `porch run` be kept?** Yes, kept as-is. `porch run` remains the orchestrator mode for non-Claude-Code environments. `porch next` is the new planner mode. They share the same state machine logic but differ in execution model. No migration needed — they coexist.

### Important
- [x] **How are iteration failures communicated?** Porch reads review files directly on next `porch next` call. If reviews contain REQUEST_CHANGES verdicts, porch emits "fix and re-consult" tasks with the feedback content injected into the task description. No explicit failure signal from Claude is needed.
- [x] **Per-plan-phase granularity?** One phase at a time. Porch emits tasks for the current `plan_phase` only. After that phase's build-verify loop completes, the next `porch next` call advances `current_plan_phase` and emits tasks for the next one. This gives porch control over sequencing and keeps task batches focused.
- [x] **AWAITING_INPUT signal?** Removed in task mode. Tasks make it redundant — the user can see task status directly in the Claude Code UI. `porch run` retains AWAITING_INPUT for backward compatibility.

### Nice-to-Know
- [x] **Could porch output TaskCreate JSON directly?** No — Claude Code's task API is tool-call based, not stdin-parseable. Porch outputs its own schema; the builder's Claude interprets it and calls TaskCreate.

## Performance Requirements
- `porch next` should complete in <2 seconds (it's a read + compute, no network)
- No change to consultation or build performance (those are unchanged)

## Security Considerations
- Gate approval must still require `--a-human-explicitly-approved-this` flag
- No change to authentication model

## Test Strategy

### Unit Tests (automated, run via `npm test`)
1. **Schema validation**: `porch next` output conforms to `PorchNextResponse` schema for every protocol phase
2. **Happy path**: Fresh project → specify tasks; after spec approval → plan tasks; after plan approval → implement tasks
3. **Pre-approved artifact**: Spec with `approved:` frontmatter → skips specify, emits plan tasks
4. **Iteration loop**: Create review files with REQUEST_CHANGES verdicts → next call emits fix tasks with feedback injected
5. **Gate pending**: After verify-approve → `status: "gate_pending"`. After `porch approve` → next tasks
6. **Idempotency**: Call `porch next` twice without changing filesystem → same output both times
7. **Per-plan-phase**: Protocol with 3 plan phases → emits one phase at a time, advances on each call
8. **Protocol complete**: All phases done → `status: "complete"`

### Golden Tests
For each protocol (SPIR, MAINTAIN, TICK), maintain golden JSON files of expected `porch next` output at each phase transition. Compare actual output against golden files.

### Integration Tests (run via `npm run test:e2e`)
1. **Full loop**: Set up a test project, call `porch next` repeatedly, simulate artifact creation between calls, verify state advances correctly through all phases
2. **Regression**: `porch run` and `porch next` produce equivalent state transitions for the same protocol

### Non-Functional Tests
1. `porch next` completes in <2s on a project with 10+ iterations of history
2. Large status.yaml files (50+ history entries) don't cause issues

## Dependencies
- **Claude Code task API**: TaskCreate, TaskUpdate, TaskList
- **Existing porch modules**: state.ts, protocol.ts, plan.ts, prompts.ts (reused)
- **Removed dependency**: claude.ts (Agent SDK spawning) — no longer needed for task mode

## References
- `codev/resources/protocol-format.md` — Protocol to Task Conversion algorithm (already documented)
- `packages/codev/src/commands/porch/run.ts` — Current execution loop
- `packages/codev/src/commands/porch/state.ts` — State management
- `packages/codev/src/commands/porch/types.ts` — State schema

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|-------------------|
| Task descriptions not detailed enough for Claude to execute | Medium | High | Include full prompt content in task descriptions, test with real protocols |
| Session dies mid-iteration, tasks lost | Medium | Low | status.yaml tracks iteration + history; `porch next` regenerates tasks |
| Backward compatibility break for `porch run` users | Low | Medium | Keep `porch run` as legacy mode initially |
| Gate approval timing — user approves in one session, builder in another | Low | Medium | status.yaml gates persist; `porch next` checks gate status on each call |

## Notes

The `--single-phase` mode in the current `porch run` already demonstrates this pattern: it runs one cycle, outputs `__PORCH_RESULT__` JSON, and lets the outer Claude decide what's next. This spec generalizes that pattern into the primary execution model.

The Protocol to Task Conversion algorithm documented in `protocol-format.md` provides the conceptual foundation. This spec makes it concrete and addresses the state management, iteration, and gate concerns that the simple conversion algorithm glossed over.

---

## Amendments

### Amendment 1 (2026-02-08): Address 3-way consultation feedback

**Consultation**: Gemini, Codex, Claude — all REQUEST_CHANGES (HIGH confidence)

**Changes made:**
1. **Defined formal output schema** (`PorchNextResponse`, `PorchTask`) with all response types (tasks, gate_pending, complete, error)
2. **Resolved completion signaling**: Filesystem-as-truth — porch infers completion from artifacts on disk, no explicit "done" signal needed
3. **Fixed `blockedBy`**: Replaced invalid index-based dependency with `sequential` boolean flag. Claude Code's TaskUpdate uses `addBlockedBy` with task IDs, not creation-time indices
4. **Clarified `porch run` coexistence**: Both modes share state machine logic, differ only in execution model. No migration needed
5. **Specified task description content**: Full phase prompts with variable substitution embedded in description field, reusing existing `buildPhasePrompt()`
6. **Defined state mutation rules**: `porch next` is read-modify-write, idempotent when no artifacts change
7. **Added automated test strategy**: Unit tests, golden tests, integration tests, regression test against `porch run`
8. **Resolved all open questions**: Per-plan-phase (one at a time), AWAITING_INPUT (removed in task mode), iteration failures (read review files directly)
