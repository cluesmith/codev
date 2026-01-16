# Spike: Checklister Agent

**Goal**: Build an agent that enforces SPIDER protocol compliance by maintaining a checklist state and blocking progression until all required items are complete.

**Time-box**: 2-4 hours
**Status**: COMPLETE
**Started**: 2026-01-16
**Completed**: 2026-01-16

## Hypothesis

A checklister agent can enforce deterministic SPIDER compliance by:
1. Maintaining state about which checklist items are complete
2. Blocking phase transitions until prerequisites are met
3. Providing clear feedback about what's missing

## Key Questions

1. **State Management**: How should checklist state be stored?
   - Option A: In-memory (session-scoped)
   - Option B: File-based (`.spider-state.json`)
   - Option C: SQLite (like agent-farm state)

2. **Integration**: How does the checklister interact with the architect/builder?
   - Option A: Separate agent that reviews commits/PRs
   - Option B: Inline hooks in the architect/builder prompts
   - Option C: Pre-commit/post-commit git hooks
   - Option D: Claude Code skill that can be invoked

3. **Granularity**: What level of detail?
   - High-level phase gates only (S → P → I → D → E → R)
   - Per-phase detailed checklists (all items in protocol.md)
   - Hybrid: phase gates + critical items only

## SPIDER Checklist Model

Based on `codev/protocols/spider/protocol.md`:

```yaml
spider_checklist:
  # SPECIFY PHASE
  specify:
    - id: spec_draft
      label: "Initial specification draft committed"
      blocking: true
    - id: spec_consult_1
      label: "First multi-agent consultation (GPT-5 + Gemini)"
      blocking: true
    - id: spec_feedback_commit
      label: "Specification with multi-agent review committed"
      blocking: true
    - id: spec_human_review
      label: "Human review complete"
      blocking: true
    - id: spec_consult_2
      label: "Second multi-agent consultation"
      blocking: true
    - id: spec_final
      label: "Final approved specification committed"
      blocking: true

  # PLAN PHASE
  plan:
    - id: plan_draft
      label: "Initial plan draft committed"
      blocking: true
    - id: plan_consult_1
      label: "First multi-agent consultation"
      blocking: true
    - id: plan_feedback_commit
      label: "Plan with multi-agent review committed"
      blocking: true
    - id: plan_human_review
      label: "Human review complete"
      blocking: true
    - id: plan_consult_2
      label: "Second multi-agent consultation"
      blocking: true
    - id: plan_final
      label: "Final approved plan committed"
      blocking: true

  # IDE LOOP (repeated per phase)
  phase_template:
    implement:
      - id: prev_phase_committed
        label: "Previous phase committed (git log verification)"
        blocking: true
      - id: code_complete
        label: "All code for phase complete"
        blocking: true
      - id: impl_consult
        label: "Expert consultation (GPT-5 + Gemini)"
        blocking: true
      - id: impl_feedback_addressed
        label: "Expert feedback addressed"
        blocking: true

    defend:
      - id: unit_tests
        label: "Unit tests for all new functions"
        blocking: true
      - id: integration_tests
        label: "Integration tests for critical paths"
        blocking: true
      - id: tests_passing
        label: "All tests passing"
        blocking: true
      - id: defend_consult
        label: "Expert consultation on tests"
        blocking: true
      - id: overmocking_check
        label: "Overmocking check completed"
        blocking: true

    evaluate:
      - id: acceptance_criteria
        label: "All acceptance criteria met"
        blocking: true
      - id: expert_approval
        label: "Expert final approval received"
        blocking: true
      - id: user_evaluation
        label: "User evaluation discussion completed"
        blocking: true
      - id: user_approval
        label: "User explicit approval to proceed"
        blocking: true
      - id: phase_commit
        label: "Phase commit created"
        blocking: true
      - id: plan_updated
        label: "Plan document updated with phase status"
        blocking: true

  # REVIEW PHASE
  review:
    - id: all_phases_committed
      label: "All implementation phases committed"
      blocking: true
    - id: review_doc
      label: "Review document created"
      blocking: true
    - id: arch_updated
      label: "arch.md updated if needed"
      blocking: false
    - id: lessons_learned
      label: "Lessons learned documented"
      blocking: true
    - id: docs_updated
      label: "README/AGENTS.md/CLAUDE.md updated if needed"
      blocking: false
```

## Proposed Interface

### As a Claude Code Skill

```bash
# Check current state
/checklister status

# Mark item complete (with evidence)
/checklister complete spec_draft --evidence "commit abc123"

# Attempt phase transition
/checklister gate plan  # Fails if specify phase incomplete

# Reset (for testing)
/checklister reset
```

### State File Format

```json
{
  "project_id": "0069",
  "protocol": "spider",
  "current_phase": "specify",
  "completed": {
    "spec_draft": {
      "timestamp": "2026-01-16T10:00:00Z",
      "evidence": "commit abc123"
    }
  },
  "phases": {
    "phase_1_core_toggle": {
      "current_stage": "implement",
      "completed": {}
    }
  }
}
```

## Implementation Plan

### Phase 1: Minimal Viable Checklister

1. Create skill definition in `.claude/skills/checklister.md`
2. Define state file format (`.spider-state.json`)
3. Implement status command (read-only)
4. Implement complete command (mark items done)
5. Implement gate command (check phase transitions)

### Phase 2: Integration Test

1. Create test spec 0069 (tower light/dark mode)
2. Run SPIDER with checklister enforcement
3. Verify gates block correctly
4. Document friction points

### Phase 3: Refinement

1. Address friction points from test
2. Add automatic evidence detection (git commit parsing)
3. Consider CI/hook integration

## Test Case: Spec 0069 - Tower Light/Dark Mode

A minimal SPIDER task to test the checklister:

**Goal**: Add a light mode toggle to `codev tower start` dashboard

**Scope**:
- Add theme toggle button to dashboard header
- Implement light mode CSS variables
- Persist preference in localStorage
- < 200 lines of code

This is intentionally small to test the protocol overhead, not implementation complexity.

## Success Criteria

1. **PASS**: Checklister blocks phase transition when items incomplete
2. **PASS**: Checklister allows transition when all blocking items complete
3. **PASS**: State persists across sessions
4. **PASS**: Clear feedback about what's missing
5. **PASS**: Overhead feels reasonable (not annoying)

## Notes

- Start simple: file-based state, manual marking
- Don't over-engineer: this is a spike, not production
- Focus on learning what friction points exist

---

## Spike Findings

### Key Decisions Made

1. **State Management**: File-based (Option B: `.spider-state.json`)
   - Simple JSON format
   - Persists across sessions
   - Human-readable and editable
   - Can be version controlled

2. **Integration**: Claude Code skill (Option D)
   - Created `.claude/commands/checklister.md`
   - Invoked via `/checklister <command>`
   - Claude interprets the skill and acts on state

3. **Granularity**: Per-phase detailed checklists
   - All items from protocol.md
   - Blocking vs non-blocking distinction preserved
   - Dynamic implementation phases (added as plan defines them)

### Files Created

1. **`.claude/commands/checklister.md`** - Skill definition with:
   - Commands: init, status, complete, gate, add-phase, reset, list
   - State file format
   - Complete checklist item definitions for all SPIDER phases (S, P, IDE, R)
   - Separate I/D/E stage tracking within IDE loop
   - Gate logic rules for phase AND stage transitions

2. **`codev/checklists/`** - Directory for per-project state files:
   - One JSON file per project (e.g., `0069.json`)
   - Project metadata (id, spec_name, protocol, started_at)
   - Current phase AND stage tracking
   - Completed items with timestamps and evidence
   - Dynamic implementation_phases section

### Success Criteria Results

| Test | Result | Evidence |
|------|--------|----------|
| Blocks phase transition when incomplete | **PASS** | Gate returns BLOCKED with missing items |
| Allows transition when complete | **PASS** | Gate returns ALLOWED, updates phase |
| State persists across sessions | **PASS** | JSON file in codev/checklists/ |
| Clear feedback about missing items | **PASS** | Lists specific item IDs and labels |
| Overhead feels reasonable | **TBD** | Need more real-world usage |

### Protocol Integration

The SPIDER protocol (`codev/protocols/spider/protocol.md`) has been updated with:
- Checklister configuration section
- `/checklister` commands at each workflow checkpoint
- Gate commands at all phase/stage transitions

### Test Execution Log

```
/checklister init 0069
→ Created codev/checklists/0069.json

/checklister status 0069
→ Shows Specify phase (0/6 complete)

/checklister complete spec_draft --evidence "commit 9c0a551"
→ Marked complete, Progress: 1/6

/checklister gate plan (with 1/6 complete)
→ BLOCKED - Missing 5 items

/checklister gate plan (with 6/6 complete)
→ ALLOWED - Transitioned to Plan phase
```

### Friction Points Identified

1. **Manual marking is verbose**
   - Every item needs explicit `/checklister complete <id>`
   - Could be annoying if many items per phase
   - **Mitigation**: Auto-detect from git commits (future)

2. **Evidence is optional but valuable**
   - Without evidence, hard to verify later
   - **Mitigation**: Make evidence required for certain items

3. **Implementation phases are dynamic**
   - Need to add phases to state as plan defines them
   - Could add `/checklister add-phase <name>` command

4. **No undo mechanism**
   - Once marked complete, can't easily undo
   - **Mitigation**: Reset command exists for full reset

### Command Summary

| Command | Description |
|---------|-------------|
| `/checklister init <id>` | Initialize checklist for project |
| `/checklister status [id]` | Show checklist state |
| `/checklister complete <item> [--evidence "..."]` | Mark item done |
| `/checklister gate <target>` | Check phase/stage transition |
| `/checklister add-phase <name>` | Add implementation phase |
| `/checklister reset [--project <id>]` | Clear state |
| `/checklister list` | List all active checklists |

Gate targets: `plan`, `implement`, `defend`, `evaluate`, `next-phase`, `review`

---

## Phase 2: True Enforcement via Claude Code Hooks

### The Problem with Honor System

Initial design relied on Claude voluntarily:
1. Maintaining the state file
2. Checking gates before transitions
3. Not skipping steps

**This is not enforcement - it's honor system.** Claude can rationalize skipping steps.

### Solution: Claude Code PreToolUse Hooks

Claude Code has hooks that intercept tool calls BEFORE they execute. If the hook returns exit code 2, the tool call is **blocked**.

### Architecture

```
┌─────────────────────────────────────────────────────┐
│                    BUILDER                          │
│  (maintains full context, executes entire SPIDER)   │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
              ┌────────────────┐
              │  PreToolUse    │
              │  Hook          │
              │  (Edit/Write)  │
              └────────┬───────┘
                       │
              ┌────────▼────────┐
              │  checklister-   │
              │  guard.sh       │
              │  (validates     │
              │   phase rules)  │
              └─────────────────┘
                       │
            ┌──────────┴──────────┐
            │                     │
       [ALLOWED]             [BLOCKED]
       exit 0                exit 2 + stderr
```

### Files Created

1. **`.claude/hooks/checklister-guard.sh`** - Guard script that:
   - Reads current phase from `codev/checklists/*.json`
   - Validates file path against phase rules
   - Returns exit 2 with instructional error if blocked

2. **`.claude/settings.json`** - Hook configuration:
   ```json
   {
     "hooks": {
       "PreToolUse": [{
         "matcher": "Edit|Write",
         "hooks": [{"type": "command", "command": "...guard.sh"}]
       }]
     }
   }
   ```

### Phase Rules

| Phase | Allowed Files |
|-------|--------------|
| Specify | `codev/specs/*.md`, `codev/checklists/*`, `.claude/*` |
| Plan | Above + `codev/plans/*.md` |
| Implement/Defend/Evaluate | All files |
| Review | All files |

### Test Results

Guard script correctly blocks:
```
⚠️ BLOCKED by Checklister

Current phase: SPECIFY
Attempted to edit: src/test-file.ts

In Specify phase, you can only edit:
  - codev/specs/*.md
  - codev/checklists/*

To proceed to Plan phase, complete all spec_* items and run:
  /checklister gate plan
```

**Note:** Hooks load at session start. Must restart Claude Code after adding settings.json.

### Portability Limitation

| CLI | Hooks Support | True Enforcement |
|-----|--------------|------------------|
| Claude Code | ✓ PreToolUse | ✓ Yes |
| Codex | ✗ No hooks | ✗ No |
| Gemini CLI | ✗ No hooks | ✗ No |

**Claude Code hooks are not portable.** Other CLIs would need different enforcement (git hooks as backstop).

### Consultation Insights

Three-way consultation (Claude, Codex, Gemini) unanimously recommended:
- **Keep Builder as primary** (maintains context)
- **Checklister as validator, not orchestrator**
- **Enforcement at boundaries** (hooks, git)
- **Don't fragment context** with agent layering

### Recommendations for Production

1. **Test in new session** - Hooks only load at session start
2. **Add git hooks as backstop** - For non-Claude-Code environments
3. **Consider opt-in** - Make enforcement configurable in `codev/config.json`
4. **Instructional errors** - Error messages should tell agent what to do next
