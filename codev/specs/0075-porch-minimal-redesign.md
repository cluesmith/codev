# Spec 0075: Porch Minimal Redesign (v3 - Build-Verify Cycles)

## Problem Statement

The current porch design treats 3-way consultations as an afterthought - something Claude runs, or something bolted on as "verification". This is backwards. **Build-verify cycles should be first-class citizens** in protocol execution.

## Proposed Solution

Porch orchestrates **build-verify cycles** where:
1. **BUILD**: Porch spawns Claude to create an artifact (spec, plan, code, PR)
2. **VERIFY**: Porch runs 3-way consultation (Gemini, Codex, Claude)
3. **ITERATE**: If any reviewer says REQUEST_CHANGES, feedback is fed back to Claude
4. **COMPLETE**: When all approve (or max iterations), commit + push + proceed

### Design Principles

1. **3-way reviews are automatic** - Porch runs them, not Claude
2. **Feedback loops** - Consultation feedback feeds back into next Claude iteration
3. **Capped iterations** - Max 7 attempts before proceeding to gate (configurable)
4. **Commit boundaries** - Each stage ends with commit + push
5. **Human gates** - Come after build-verify cycles, not within them

### Architecture

**The Claude → Porch → Claude Pattern:**

```
Architect Claude
    │
    └──► afx kickoff -p XXXX
              │
              └──► Builder Claude (outer)
                        │
                        └──► porch run XXXX
                                  │
                                  └──► Claude (inner) creates artifact
                                  │         │
                                  │         └──► <signal>PHASE_COMPLETE</signal>
                                  │                      or
                                  │              <signal type=AWAITING_INPUT>questions</signal>
                                  │
                                  └──► 3-way verification (Gemini, Codex, Claude)
                                  │
                                  └──► Iterate if needed, or advance
```

The outer builder Claude just runs `porch run` and handles gates. Porch spawns an inner Claude instance that does the actual work. This separates concerns:
- **Outer Claude**: Runs porch, handles gates, manages session
- **Porch**: Protocol orchestration, 3-way reviews, iteration
- **Inner Claude**: Creates artifacts, writes code, answers questions

**Build-Verify Cycle:**

```
┌─────────────────────────────────────────────────────────────────┐
│  BUILD-VERIFY CYCLE (repeated up to max_iterations)            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌───────────────┐                                              │
│  │ BUILD         │  Porch spawns Claude with:                   │
│  │ (Claude)      │  - Phase prompt                              │
│  │               │  - Previous feedback (if iteration > 1)      │
│  └───────┬───────┘                                              │
│          │ Claude signals PHASE_COMPLETE                        │
│          ▼                                                      │
│  ┌───────────────┐                                              │
│  │ VERIFY        │  Porch runs in parallel:                     │
│  │ (3-way)       │  - consult --model gemini <artifact>         │
│  │               │  - consult --model codex <artifact>          │
│  │               │  - consult --model claude <artifact>         │
│  └───────┬───────┘                                              │
│          │                                                      │
│          ▼                                                      │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ All APPROVE?                                               │  │
│  │   YES → commit + push → proceed to GATE                   │  │
│  │   NO  → synthesize feedback → next iteration              │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  Max iterations reached? → proceed to GATE anyway              │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### SPIR Protocol Flow

```
SPECIFY (build-verify cycle)
    │
    ├── BUILD: Claude writes spec
    ├── VERIFY: 3-way reviews spec
    ├── ITERATE: Until all approve or max_iterations
    ├── COMMIT: git add spec && git commit && git push
    │
    └── GATE: spec-approval (human)

PLAN (build-verify cycle)
    │
    ├── BUILD: Claude writes plan
    ├── VERIFY: 3-way reviews plan
    ├── ITERATE: Until all approve or max_iterations
    ├── COMMIT: git add plan && git commit && git push
    │
    └── GATE: plan-approval (human)

IMPLEMENT (build-verify cycle per plan phase)
    │
    ├── For each plan phase:
    │   ├── BUILD: Claude implements code + tests
    │   ├── VERIFY: 3-way reviews implementation
    │   ├── ITERATE: Until all approve or max_iterations
    │   └── COMMIT: git add files && git commit && git push
    │
    └── (no human gate per phase)

REVIEW (build-verify cycle)
    │
    ├── BUILD: Claude creates review doc + PR
    ├── VERIFY: 3-way reviews entire PR
    ├── ITERATE: Until all approve or max_iterations
    ├── COMMIT: git add review && git commit && git push
    │
    └── GATE: pr-ready (human) → merge PR
```

### Protocol Definition

The protocol.json format expresses build-verify cycles:

```json
{
  "phases": [
    {
      "id": "specify",
      "name": "Specify",
      "type": "build_verify",
      "build": {
        "prompt": "specify.md",
        "artifact": "codev/specs/${PROJECT_ID}-*.md"
      },
      "verify": {
        "type": "spec-review",
        "models": ["gemini", "codex", "claude"],
        "parallel": true
      },
      "max_iterations": 7,
      "on_complete": {
        "commit": true,
        "push": true
      },
      "gate": "spec-approval"
    }
  ]
}
```

### Feedback via Files (Simplified)

When verification runs, porch writes each consultation's output to a file:
- `.porch/0075-specify-iter1-gemini.txt`
- `.porch/0075-specify-iter1-codex.txt`
- `.porch/0075-specify-iter1-claude.txt`

On the next iteration, porch lists all previous files (build outputs + reviews) in the prompt header. **Claude reads these files itself** to understand the history and address feedback.

```markdown
# ⚠️ REVISION REQUIRED

This is iteration 2. Previous iterations received feedback from reviewers.

**Read the files below to understand the history and address the feedback.**

## Previous Iterations

### Iteration 1

**Build Output:** `.porch/0075-specify-iter-1.txt`

**Reviews:**
- gemini (✓ APPROVE): `.porch/0075-specify-iter1-gemini.txt`
- codex (✗ REQUEST_CHANGES): `.porch/0075-specify-iter1-codex.txt`
- claude (💬 COMMENT): `.porch/0075-specify-iter1-claude.txt`

## Instructions

1. Read the review files above to understand the feedback
2. Address any REQUEST_CHANGES issues
3. Consider suggestions from COMMENT and APPROVE reviews
```

This approach is simpler than synthesizing feedback - Claude has full access to the raw consultation output.

### Claude Signals

Inner Claude communicates with porch via XML signals in its output:

| Signal | Meaning | Porch Action |
|--------|---------|--------------|
| `<signal>PHASE_COMPLETE</signal>` | Artifact created, ready for verification | Run 3-way review |
| `<signal>GATE_NEEDED</signal>` | Human approval required | Stop and wait |
| `<signal>BLOCKED:reason</signal>` | Claude is stuck | Log blocker, may retry |
| `<signal type=AWAITING_INPUT>questions</signal>` | Claude needs clarification | Prompt user for answers, store in `context.user_answers`, respawn Claude |

**AWAITING_INPUT Flow:**

When Claude needs to ask clarifying questions (e.g., during spec writing), it emits:

```xml
<signal type=AWAITING_INPUT>
Please answer these questions:
1. What's the primary use case?
2. What's in scope vs out of scope?
</signal>
```

Porch:
1. Displays the questions to the user
2. Collects answers
3. Stores answers in `status.yaml` under `context.user_answers`
4. Respawns Claude with answers prepended to the prompt

### Consultation Output

Porch captures consultation verdicts:

| Verdict | Meaning |
|---------|---------|
| `APPROVE` | No changes needed, ready to proceed |
| `REQUEST_CHANGES` | Issues found, needs revision |
| `COMMENT` | Suggestions only, no blocking issues (explicit only) |

**Verdict Parsing (Safe Defaults):**
1. If output contains `REQUEST_CHANGES` → `REQUEST_CHANGES`
2. If output contains `APPROVE` → `APPROVE`
3. If output is empty, very short (<50 chars), or malformed → `REQUEST_CHANGES` (safe default)
4. If no explicit verdict found → `REQUEST_CHANGES` (safe default)

**Key safety principle:** Silent failures (crashes, timeouts, empty output) default to `REQUEST_CHANGES` to prevent proceeding with unverified code.

### Error Handling

| Failure Mode | Behavior |
|--------------|----------|
| `consult` CLI crashes | Verdict = `REQUEST_CHANGES`, error written to review file |
| `consult` CLI times out | Not currently handled (TODO: add timeout) |
| Empty/malformed output | Verdict = `REQUEST_CHANGES` |
| Claude fails to produce artifact | Claude retries (porch doesn't intervene) |
| Git commit fails | Warning logged, continues (may be nothing to commit) |
| Git push fails | Warning logged, continues |

Porch prioritizes **not proceeding with unverified code** over graceful degradation.

### State Tracking

```yaml
id: "0075"
title: "porch-minimal-redesign"
protocol: "spir"
phase: "specify"
iteration: 2
build_complete: false
history:
  - iteration: 1
    build_output: ".porch/0075-specify-iter-1.txt"
    reviews:
      - model: gemini
        verdict: APPROVE
        file: ".porch/0075-specify-iter1-gemini.txt"
      - model: codex
        verdict: REQUEST_CHANGES
        file: ".porch/0075-specify-iter1-codex.txt"
      - model: claude
        verdict: COMMENT
        file: ".porch/0075-specify-iter1-claude.txt"
gates:
  spec-approval: { status: "pending" }
```

### REPL Commands

Same as before, but simplified since consultations are automatic:

| Command | Description |
|---------|-------------|
| `t` / `tail` | Tail the current output |
| `s` / `status` | Show current status |
| `a` / `approve` | Approve current gate |
| `q` / `quit` | Kill current process and exit |
| `Enter` | Refresh status |

### Display During Verify Phase

```
[0075] SPECIFY - Iteration 2/3
  BUILD: complete
  VERIFY: running...
    gemini: running (45s)
    codex:  APPROVE
    claude: running (30s)

> _
```

## Success Criteria

1. Build-verify cycles are first-class in protocol.json
2. Porch runs 3-way consultations automatically (not Claude)
3. Feedback from failed verifications feeds back to next iteration
4. Each stage ends with commit + push
5. Human gates come after build-verify cycles complete
6. Max iteration cap prevents infinite loops
7. Clean status display showing build/verify progress

## Testing Strategy

| Test Type | Coverage |
|-----------|----------|
| Unit tests | `parseVerdict()`, `allApprove()`, `formatVerdicts()`, `buildHistoryHeader()` |
| Integration | Build-verify loop with mocked consult (TODO) |
| E2E | Manual testing with real consultations |

**Existing tests:**
- `plan.test.ts` - Plan phase parsing, `advancePlanPhase()`, `isPlanPhaseComplete()`
- `state.test.ts` - State initialization, serialization with `history` field
- `protocol.test.ts` - Protocol parsing including `build_verify` type

**Test gaps (TODO):**
- Mock `consult` CLI for integration testing
- Timeout handling tests
- Git failure recovery tests

## Out of Scope

- Multiple concurrent Claude sessions
- Desktop notifications
- Custom consultation models per phase
- Consultation timeout handling (future enhancement)

## Consultation

(To be filled after 3-way review)
