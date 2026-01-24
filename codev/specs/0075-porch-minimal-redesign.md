# Spec 0075: Porch Minimal Redesign

## Problem Statement

The current porch implementation is ~4,800 lines and tries to do too much:
- REPL interface for interactive use
- Claude subprocess management and signal parsing
- Complex state machine with nested substates
- Consultation coordination
- Desktop notifications

This complexity creates fragility. Signal detection is unreliable, the REPL conflicts with automated use, and debugging is difficult.

## Proposed Solution

**Flip the relationship**: Instead of porch orchestrating Claude, Claude calls porch as a tool.

Claude is already good at:
- Calling tools in a loop
- Following instructions from tool output
- Making decisions based on feedback

Porch becomes an **advisor tool** that Claude consults, not an orchestrator that spawns Claude.

### Key Features to Keep

1. **Declarative protocols** - protocol.json defines phases, gates, checks
2. **Plan unrolling** - Extract phases from plan markdown, track progress
3. **Gates** - Human approval checkpoints that block progress
4. **Checks** - Run npm test, npm build, etc. to verify criteria

### Features to Remove

1. **REPL** - No interactive prompt
2. **Claude subprocess management** - No spawning Claude
3. **Signal parsing** - No parsing `<signal>` tags from output
4. **Consultation coordination** - Claude handles this directly
5. **Desktop notifications** - Not needed
6. **Complex substate tracking** - No nested states like `specify:consultation_2`

### Generic Protocol Support

Porch must support any protocol defined in protocol.json, not just SPIDER. This includes:
- **SPIDER** - Full specify → plan → implement → defend → evaluate → review flow
- **TICK** - Amendment workflow for existing specs
- **MAINTAIN** - Codebase maintenance
- **Custom protocols** - User-defined workflows

The protocol.json format defines phases, gates, and checks declaratively. Porch interprets this at runtime.

## Commands

### `porch status <id>`

Shows current state and prescriptive next steps.

```
$ porch status 0074

══════════════════════════════════════════════════
  PROJECT: 0074 - remove-today-summary
  PROTOCOL: spider
  PHASE: implement (2 of 4)
══════════════════════════════════════════════════

CURRENT PLAN PHASE: phase_2 - Add E2E tests
STATUS: in_progress

CRITERIA:
  ✗ npm test (not yet run)
  ✗ npm run build (not yet run)

INSTRUCTIONS:
  You are implementing phase_2: "Add E2E tests".

  From the plan:
  - Add tests to tests/e2e/dashboard.bats
  - Verify removal of activity.js and activity.css
  - Test that no activity-related endpoints exist

  When complete, run: porch check 0074

NEXT ACTION: Implement the E2E tests as specified in the plan.
```

### `porch check <id>`

Runs the phase checks and reports results.

```
$ porch check 0074

RUNNING CHECKS...

  ✓ npm run build (passed)
  ✗ npm test (3 failing tests)

RESULT: CHECKS FAILED

  Fix the failing tests before advancing.
  Run: porch check 0074 (to re-check)
```

### `porch done <id>`

Advances to next phase if checks pass. Refuses if checks fail.

```
$ porch done 0074

RUNNING CHECKS...
  ✓ npm run build (passed)
  ✓ npm test (passed)

CHECKS PASSED. Advancing...

PHASE COMPLETE: phase_2 - Add E2E tests
NEXT PHASE: phase_3 - Documentation cleanup

Run: porch status 0074 (to see next steps)
```

### `porch gate <id>`

Requests human approval for current gate.

```
$ porch gate 0074

GATE: spec_approval

  The specification is complete and ready for review.

  Artifact: codev/specs/0074-remove-today-summary.md

  Human approval required. STOP and wait.
  Do not proceed until gate is approved.

STATUS: WAITING FOR HUMAN APPROVAL
```

### `porch approve <id> <gate>`

Human approves a gate (run from separate terminal).

```
$ porch approve 0074 spec_approval

Gate spec_approval approved.
```

### `porch init <protocol> <id> <name>`

Initialize a new project (same as current).

## State File

Simplified `status.yaml`:

```yaml
id: "0074"
title: "remove-today-summary"
protocol: "spider"
phase: "implement"
plan_phases:
  - id: "phase_1"
    title: "Backend cleanup"
    status: "complete"
  - id: "phase_2"
    title: "Add E2E tests"
    status: "in_progress"
  - id: "phase_3"
    title: "Documentation cleanup"
    status: "pending"
current_plan_phase: "phase_2"
gates:
  spec_approval: { status: "approved", approved_at: "2026-01-20T..." }
  plan_approval: { status: "approved", approved_at: "2026-01-20T..." }
  impl_approval: { status: "pending" }
  review_approval: { status: "pending" }
started_at: "2026-01-20T..."
updated_at: "2026-01-21T..."
```

## Protocol Definition

Keep declarative protocol.json. Porch reads this at runtime to determine phases, gates, and checks.

```json
{
  "name": "spider",
  "description": "Multi-phase development with consultation",
  "phases": [
    {
      "id": "specify",
      "name": "Specification",
      "gate": "spec_approval",
      "checks": ["build"],
      "next": "plan"
    },
    {
      "id": "plan",
      "name": "Planning",
      "gate": "plan_approval",
      "checks": ["build"],
      "next": "implement"
    },
    {
      "id": "implement",
      "name": "Implementation",
      "type": "phased",
      "checks": ["build", "test"],
      "next": "defend"
    },
    {
      "id": "defend",
      "name": "Testing",
      "checks": ["build", "test"],
      "next": "evaluate"
    },
    {
      "id": "evaluate",
      "name": "Evaluation",
      "gate": "impl_approval",
      "checks": ["build", "test"],
      "next": "review"
    },
    {
      "id": "review",
      "name": "Review",
      "gate": "review_approval",
      "next": null
    }
  ],
  "checks": {
    "build": "npm run build",
    "test": "npm test"
  }
}
```

**Protocol-agnostic**: Porch doesn't hardcode SPIDER. It reads the protocol definition and follows it. TICK, MAINTAIN, or custom protocols work the same way - define phases, gates, checks in protocol.json.

## Role Prompt Enforcement

The builder role prompt must heavily emphasize porch:

```markdown
# CRITICAL: Porch Protocol Enforcement

You are operating under the SPIDER protocol. Porch is the gatekeeper.

## MANDATORY BEHAVIORS

1. **FIRST ACTION**: Run `porch status {PROJECT_ID}` to see your current state
2. **BEFORE ANY WORK**: Read porch's instructions carefully
3. **AFTER COMPLETING WORK**: Run `porch check {PROJECT_ID}` to verify
4. **TO ADVANCE**: Run `porch done {PROJECT_ID}` - porch will verify and advance
5. **AT GATES**: Run `porch gate {PROJECT_ID}` and STOP. Wait for human.

## PORCH IS AUTHORITATIVE

- Porch tells you what phase you're in
- Porch tells you what to do next
- Porch runs the checks that determine if you're done
- Porch controls advancement between phases
- You CANNOT skip phases or ignore porch

## WHEN PORCH SAYS STOP, YOU STOP

If porch output contains "STOP" or "WAIT", you must stop working
and wait for human intervention. Do not try to proceed.
```

## Error Handling

**Fail loudly.** When something is wrong, porch exits with non-zero status and clear error message.

| Condition | Behavior |
|-----------|----------|
| `status.yaml` missing | Error: "Project not found. Run porch init first." |
| `status.yaml` corrupted | Error: "Invalid state file: {parse error}" |
| `protocol.json` missing | Error: "Protocol '{name}' not found" |
| `protocol.json` invalid | Error: "Invalid protocol: {parse error}" |
| Plan file missing (for phased phase) | Error: "Plan file required for phased protocol" |
| Unknown gate in `porch approve` | Error: "Unknown gate: {name}" |
| Already approved gate | Warning: "Gate already approved" (not an error) |
| Check command fails | Report failure, do not advance |
| Check command hangs | Timeout after 5 minutes, report as failure |

No graceful degradation. No guessing. If state is unclear, fail and tell the user.

## Success Criteria

1. Porch reduced from ~4,800 lines to <600 lines
2. All commands produce clear, prescriptive output
3. Plan phases are extracted and tracked correctly
4. Gates block progress until human approves
5. Checks verify criteria before phase advancement
6. No subprocess management or signal parsing
7. Claude can drive the workflow by calling porch commands
8. **Supports any protocol defined in protocol.json** (SPIDER, TICK, MAINTAIN, custom)
9. **Fails loudly with clear errors** on invalid state or missing files
10. **Unit tests** for state, protocol, plan, and check modules

## Out of Scope

- Desktop notifications
- Consultation coordination (Claude handles directly)
- REPL interface
- Signal parsing
- Complex substate tracking (specify:consultation_2, etc.)
