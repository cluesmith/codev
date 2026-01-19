# Spike: Ralph-Inspired SPIDER Reimagination

**Goal**: Reimagine SPIDER using Ralph principles where the Builder owns the entire lifecycle in a worktree, with human gates as backpressure points.

**Time-box**: 4-6 hours
**Status**: IN_PROGRESS
**Started**: 2026-01-19

## Background

### Current Model (v1.x)

```
ARCHITECT (main repo)                    BUILDER (worktree)
═══════════════════════                  ════════════════════
  Specify ──────┐
                │ Human approves spec
  Plan ─────────┤
                │ Human approves plan
                │
                └──── af spawn ────────►  Implement
                                          Defend
                                          Evaluate
                                          ◄──── PR ────────
  Review ◄──────────────────────────────  (merge)
```

**Problems:**
1. Context fragmentation (Architect context ≠ Builder context)
2. Architect does S+P but doesn't run the code
3. Builder can't see spec evolution, just gets handed a final spec
4. No retry loop - if Builder fails, human has to intervene

### Ralph Model (v2.0 Vision)

```
ARCHITECT (main repo)                    BUILDER (worktree)
═══════════════════════                  ════════════════════

  Creates worktree ─────────────────────► RALPH LOOP:
  Assigns project                         │
                                          ├─► Specify ───┐
                                          │              │ ◄── Human approval gate
                                          │   ◄──────────┘
                                          │
                                          ├─► Plan ──────┐
                                          │              │ ◄── Human approval gate
                                          │   ◄──────────┘
                                          │
                                          ├─► Implement
                                          ├─► Defend (tests = backpressure)
                                          ├─► Evaluate
                                          │
                                          └─► PR + Review ────────► Merge
```

**Key Differences:**
1. **Builder owns entire lifecycle** (S→P→I→D→E→R)
2. **Human gates are backpressure** - loop pauses until approved
3. **Fresh context per iteration** - Ralph tenet #1
4. **Backpressure over prescription** - Ralph tenet #2
5. **Let Ralph Ralph** - minimal Architect intervention

## Hypothesis

A Ralph-style loop can execute the full SPIDER protocol with:
1. Human approval gates for Specify and Plan phases
2. Test-based backpressure for Defend phase
3. Fresh context per iteration (re-read spec, plan, status on each cycle)
4. State machine in status file (from checklister spike)
5. Remote approvals via HQ (from CODEV_HQ spike)

## Key Questions

### Q1: How does the loop work?

**Proposed Loop Structure:**

```bash
# ralph-spider.sh (conceptual)
while true; do
  # Read current state
  STATE=$(parse_status_file)

  case $STATE in
    "specify:draft")
      claude "Write spec for project $PROJECT"
      update_status "specify:review"
      ;;
    "specify:review")
      # BLOCKED - waiting for human approval
      if human_approved "specify"; then
        update_status "plan:draft"
      else
        sleep 30  # Poll or wait for signal
      fi
      ;;
    "plan:draft")
      claude "Write plan based on approved spec"
      update_status "plan:review"
      ;;
    "plan:review")
      # BLOCKED - waiting for human approval
      if human_approved "plan"; then
        update_status "implement"
      else
        sleep 30
      fi
      ;;
    "implement")
      claude "Implement phase N of plan"
      if build_passes; then
        update_status "defend"
      fi
      ;;
    "defend")
      claude "Write tests for implementation"
      if tests_pass; then
        update_status "evaluate"
      fi
      ;;
    "evaluate")
      if acceptance_criteria_met; then
        if more_phases; then
          update_status "implement"  # Next phase
        else
          update_status "review"
        fi
      fi
      ;;
    "review")
      claude "Create PR, write review document"
      update_status "complete"
      ;;
    "complete")
      exit 0
      ;;
  esac
done
```

### Q2: Where does Architect fit?

**Minimal Architect responsibilities:**
1. Create project entry in projectlist.md
2. Create worktree: `af spawn --project 0071 --ralph`
3. Approve spec (via HQ dashboard or local edit)
4. Approve plan (via HQ dashboard or local edit)
5. Review final PR
6. Merge and cleanup

**Architect does NOT:**
- Write specs (Builder does)
- Write plans (Builder does)
- Hand-hold through implementation

### Q3: How do human gates work?

**Option A: Polling (Simple)**
- Builder checks status file every 30s
- Human edits YAML: `specify.human_approval: { status: passed }`
- Builder sees change, continues

**Option B: Signal (CODEV_HQ)**
- Builder connects to HQ WebSocket
- Human clicks "Approve" in dashboard
- HQ sends `approval` message to Builder
- Builder updates status file, continues

**Option C: Hybrid**
- Polling as fallback
- HQ signal for instant response
- Same as CODEV_HQ spike implementation

### Q4: What about context windows?

**Ralph Principle: Fresh Context Is Reliability**

Each iteration:
1. Re-read the spec file
2. Re-read the plan file
3. Re-read the status file
4. Focus on current task only

This matches Ralph Orchestrator's design - don't accumulate stale context.

**Implementation:**
- Use `--resume` sparingly (or not at all)
- Each phase gets a fresh Claude invocation
- State lives in files, not AI memory

### Q5: How does this connect to existing spikes?

| Spike | Contribution |
|-------|--------------|
| **Checklister** | State file format (`codev/checklists/*.json` or status files) |
| **Checklister** | Phase-based enforcement via hooks |
| **CODEV_HQ** | WebSocket protocol for approvals |
| **CODEV_HQ** | Dashboard for human review |
| **Ralph research** | Loop structure, backpressure principles |

## Proposed Implementation

### Phase 1: Loop Orchestrator (2h)

Create `ralph-spider.sh` (or TypeScript) that:
1. Reads status file to determine current state
2. Invokes Claude with phase-specific prompt
3. Updates status file on completion
4. Handles human approval gates (polling initially)

### Phase 2: Builder Prompts (1.5h)

Create phase-specific prompts:
- `specify.md` - Write a spec for project X
- `plan.md` - Write a plan based on approved spec
- `implement.md` - Implement phase N of plan
- `defend.md` - Write tests for implementation
- `evaluate.md` - Verify acceptance criteria
- `review.md` - Create PR and review document

### Phase 3: Integration Test (1.5h)

Run the full loop on a simple project:
1. Create project entry
2. Spawn ralph-spider builder
3. Approve spec via status file edit
4. Approve plan via status file edit
5. Let implementation run
6. Verify PR created

### Phase 4: HQ Integration (optional, 1h)

Connect to CODEV_HQ for:
- Real-time approval notifications
- Dashboard visibility
- Mobile approval flow

## State Machine

```yaml
# codev/status/0071-test-project.md
---
id: "0071"
protocol: ralph-spider
current_state: specify:draft

states:
  specify:
    draft: { status: completed, completed_at: ... }
    review: { status: in_progress }
  plan:
    draft: { status: pending }
    review: { status: pending }
  implement:
    phase_1: { status: pending }
  defend:
    phase_1: { status: pending }
  evaluate:
    phase_1: { status: pending }
  review: { status: pending }

gates:
  specify_approval:
    human: { status: pending }
  plan_approval:
    human: { status: pending }
  defend_gate:
    tests_pass: { status: pending }
    build_pass: { status: pending }
---

## Log

- 2026-01-19 10:00: Started specify:draft
- 2026-01-19 10:15: Spec draft complete, waiting for approval
```

## Mapping to Ralph Orchestrator Concepts

| Ralph Concept | Our Implementation |
|---------------|-------------------|
| **Hat-Based Mode** | Phase-specific prompts (specify.md, plan.md, etc.) |
| **Spec-Driven Preset** | SPIDER phases with approval gates |
| **Backpressure** | Test failures, human approval gates |
| **Fresh Context** | Re-read files each iteration |
| **Disk Is State** | Status file (YAML + Markdown) |
| **Git Is Memory** | Git commits for each state transition |

## Success Criteria

1. **PASS**: Loop correctly transitions through all SPIDER phases
2. **PASS**: Human approval gates block until approved
3. **PASS**: Test failures in Defend phase trigger retry
4. **PASS**: State persists across Claude restarts
5. **PASS**: Final PR is created with proper artifacts

## Risks

| Risk | Mitigation |
|------|------------|
| Claude writes bad specs | Human approval gate catches this |
| Infinite loops | Max iteration limit per phase |
| Context too large | Keep prompts focused, re-read only needed files |
| Human approval delays | Polling + HQ notifications |

## Open Questions

1. Should each phase be a separate Claude invocation or use `--resume`?
2. How to handle multi-phase implementation plans (phase_1, phase_2, etc.)?
3. Should we use checklister hooks for enforcement or rely on the loop?
4. How does consultation (Gemini/Codex) fit into the loop?

## References

- [Checklister Spike](../checklister/README.md) - State file format, enforcement
- [CODEV_HQ Spike](../codev-hq/README.md) - WebSocket approvals
- [Ralph Orchestrator](https://github.com/mikeyobrien/ralph-orchestrator) - Loop patterns
- [codev2/synthesis.md](../../../codev2/synthesis.md) - 3-way Ralph analysis
