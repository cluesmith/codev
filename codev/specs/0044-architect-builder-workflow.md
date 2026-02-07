# Specification: Architect-Builder Workflow Clarity

## Metadata
- **ID**: 0044-architect-builder-workflow
- **Status**: specified
- **Created**: 2025-12-09
- **Updated**: 2025-12-09

## Problem Statement

The architect-builder workflow in SPIR is not clearly documented. The stages, responsibilities, and handoffs are scattered across multiple documents. Additionally, SPIR-SOLO exists as a redundant variant (it's just SPIR with one-way review instead of 3-way).

This causes:
1. Confusion about who does what and when
2. Inconsistent review checkpoints
3. Unclear state transitions in projectlist.md
4. Redundant protocol variants

## Scope

This spec covers:
1. **Delete SPIR-SOLO** - It's redundant (just SPIR with consultation disabled)
2. **Define the 7-stage workflow** with clear responsibilities
3. **Update SPIR protocol** to reference this workflow (other protocols have different lifecycles)
4. **Update projectlist.md states** to match the workflow

**Out of scope:**
- TICK protocol (amendment workflow, different lifecycle)
- EXPERIMENT protocol (research workflow)
- MAINTAIN protocol (housekeeping workflow)

## Current State

### Scattered Documentation
- `codev/roles/architect.md` - Partial workflow
- `codev/roles/builder.md` - Partial workflow
- `codev/protocols/spir/protocol.md` - Phase definitions
- `CLAUDE.md` / `AGENTS.md` - Protocol selection guide

### Projectlist States (Current)
```
conceived → specified → planned → implementing → implemented → committed → integrated
```

These don't map cleanly to the actual workflow stages.

### SPIR-SOLO
A redundant protocol that's just SPIR without 3-way consultation. Should be deleted - users can just say "without consultation" when invoking SPIR.

## Desired State

### The 7-Stage Architect-Builder Workflow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        ARCHITECT DOMAIN                                  │
├─────────────────────────────────────────────────────────────────────────┤
│         User describes project concept                                  │
│         Architect adds entry to projectlist.md                          │
│         Architect writes spec, AI does 3-way review                     │
│         Human reviews spec, iterates until approved                     │
│  → 1. CONCEIVED → [HUMAN APPROVAL] → 2. SPECIFIED                       │
│                                                                         │
│         Architect writes plan, AI does 3-way review                     │
│         Human reviews plan, approves                                    │
│         Architect commits spec + plan to main                           │
│  → 3. PLANNED                                                           │
│                                                                         │
│         Human instructs: "spawn builder"                                │
│         Architect spawns builder: `af spawn -p XXXX`                    │
│  → 4. IMPLEMENTING                                                      │
├─────────────────────────────────────────────────────────────────────────┤
│                        BUILDER DOMAIN                                    │
├─────────────────────────────────────────────────────────────────────────┤
│         Builder walks through plan phases:                              │
│           - Implement (write code)                                      │
│           - Defend (write tests)                                        │
│           - Evaluate (3-way review per phase)                           │
│         Commits after each phase                                        │
│         Builder writes review doc                                       │
│         Builder creates PR, notifies architect                          │
│  → 5. IMPLEMENTED (PR created, awaiting review)                         │
├─────────────────────────────────────────────────────────────────────────┤
│                        HANDOFF / INTEGRATION                             │
├─────────────────────────────────────────────────────────────────────────┤
│         Architect does 3-way "integration" review                       │
│         Architect iterates with builder via PR comments                 │
│         Architect tells builder to merge                                │
│         Builder merges PR (NO --delete-branch flag)                     │
│         Architect cleans up builder                                     │
│  → 6. COMMITTED                                                         │
│                                                                         │
│         Human validates in production                                   │
│         Human marks as integrated                                       │
│  → 7. INTEGRATED                                                        │
└─────────────────────────────────────────────────────────────────────────┘
```

### Stage Details

#### Stage 1: CONCEIVED
- **Actor**: User + Architect AI
- **Entry**: User describes project concept
- **Actions**:
  1. Architect adds project to `projectlist.md` with `status: conceived`
  2. Architect writes spec in `codev/specs/XXXX-name.md`
  3. Architect does 3-way review on spec
  4. Architect presents spec to human via `af open`
- **Exit**: Human approves spec
- **Artifacts**: Entry in projectlist.md, spec file (awaiting approval)
- **Note**: AI must stop at `conceived` after writing spec. Only human can transition to `specified`.

#### Stage 2: SPECIFIED
- **Actor**: Human + Architect AI
- **Entry**: Human approves spec
- **Actions**:
  1. Human reviews spec via `af open codev/specs/XXXX-name.md`
  2. Human and architect iterate until satisfied
  3. Human changes status to `specified`
  4. Architect writes plan in `codev/plans/XXXX-name.md`
  5. Architect does 3-way review on plan
  6. Human reviews and approves plan
- **Exit**: Plan approved
- **Artifacts**: Approved spec, projectlist status = `specified`

#### Stage 3: PLANNED
- **Actor**: Architect AI + Human
- **Entry**: Human approves plan
- **Actions**:
  1. Architect commits spec + plan to main
- **Exit**: Plan committed
- **Artifacts**: Plan file committed to main, projectlist status = `planned`

#### Stage 4: IMPLEMENTING
- **Actor**: Architect AI (spawn) + Builder AI (work)
- **Entry**: Human instructs architect to spawn builder
- **Actions**:
  1. Architect spawns builder: `af spawn -p XXXX`
  2. Builder reads spec and plan
  3. For each phase in plan:
     - **Implement**: Write code per phase requirements
     - **Defend**: Write tests for the implementation
     - **Evaluate**: 3-way review (does implementation match spec?)
     - Commit after phase completion
- **Exit**: All phases complete, PR created
- **Artifacts**: Implementation code, tests, commits per phase, projectlist status = `implementing`

#### Stage 5: IMPLEMENTED
- **Actor**: Builder AI
- **Entry**: All implementation phases complete
- **Actions**:
  1. Builder writes review doc in `codev/reviews/XXXX-name.md`
  2. Builder does "PR ready" 3-way review (final self-check)
  3. Builder creates PR with summary
  4. Builder notifies architect: "PR #N ready for integration review"
- **Exit**: PR created, awaiting review
- **Artifacts**: Review doc, PR created, projectlist status = `implemented`

#### Stage 6: COMMITTED
- **Actor**: Architect AI + Builder AI
- **Entry**: PR created
- **Actions**:
  1. Architect does 3-way "integration" review (focus: does this fit the system?)
  2. Architect posts findings as PR comments
  3. Architect notifies builder: `af send XXXX "Check PR comments"`
  4. Builder addresses feedback, pushes updates
  5. Repeat until architect satisfied
  6. Architect tells builder: "Ready to merge"
  7. Builder merges PR (uses `gh pr merge N --merge`, NOT `--delete-branch`)
  8. Builder notifies architect: "Merged"
  9. Architect pulls main: `git pull`
  10. Architect cleans up builder: `af cleanup -p XXXX`
- **Exit**: PR merged, builder cleaned up
- **Artifacts**: PR merged, projectlist status = `committed`

**Important**: Builder must NOT use `--delete-branch` because that would leave the worktree pointing at a deleted branch.

#### Stage 7: INTEGRATED
- **Actor**: Human
- **Entry**: Architect confirms cleanup complete
- **Actions**:
  1. Human validates in production
  2. Human updates projectlist.md: status = `integrated`
- **Exit**: Human confirms integration
- **Artifacts**: projectlist status = `integrated`

**Human-Gated Transitions**: The following transitions require explicit human approval:
- `conceived` → `specified` (human approves spec)
- `specified` → `planned` (human approves plan)
- `planned` → `implementing` (human instructs spawn)
- `committed` → `integrated` (human validates production)

### Review Types

| Review Type | When | Focus | Actor | Consult Command |
|-------------|------|-------|-------|-----------------|
| Spec Review | Stage 1 | Is spec complete? Correct? | Architect | `consult --model X --type spec-review spec N` |
| Plan Review | Stage 2 | Is plan feasible? Complete? | Architect | `consult --model X --type plan-review plan N` |
| Phase Review | Stage 4 (per phase) | Does code match spec? Tests pass? | Builder | `consult --model X --type phase-review ...` |
| PR Ready Review | Stage 5 | Final self-check before PR | Builder | `consult --model X --type pr-ready pr N` |
| Integration Review | Stage 6 | Does this fit the broader system? | Architect | `consult --model X --type integration pr N` |

**Note**: The `--type` parameter selects the appropriate review prompt for each stage. Each review type has a tailored prompt focusing on that stage's concerns.

### Communication Protocol

**Architect → Builder**:
- Use `af send XXXX "short message"` for notifications
- Use PR comments for detailed feedback (large messages corrupt in tmux)

**Builder → Architect**:
- Use `af send architect "short message"` for notifications
- Create PR with summary when ready

### 3-Way Review Definition

A "3-way review" means consulting three external AI models in parallel using the `consult` tool with the appropriate review type:

```bash
# Example: Spec review (all three in parallel)
./codev/bin/consult --model gemini --type spec-review spec 44
./codev/bin/consult --model codex --type spec-review spec 44
./codev/bin/consult --model claude --type spec-review spec 44

# Example: Integration review
./codev/bin/consult --model gemini --type integration pr 83
./codev/bin/consult --model codex --type integration pr 83
./codev/bin/consult --model claude --type integration pr 83
```

The `--type` parameter loads the appropriate review prompt (see Review Types table above).

**Parallel Execution Rules**:
- **Architect**: Run 3-way reviews in background (`run_in_background: true`) so human can continue working
- **Builder**: Run 3-way reviews in parallel but NOT background (builder waits for results before proceeding)

Each consultant returns a verdict: `APPROVE`, `REQUEST_CHANGES`, or `COMMENT`.

**When to proceed**:
- If all 3 APPROVE → proceed
- If any REQUEST_CHANGES → address feedback, iterate
- Use judgment on COMMENT verdicts

**Skip consultation**: If consultation CLIs are unavailable or offline, document this in the review and proceed with human approval only.

### Error Recovery and Abort Paths

#### Builder Crash Recovery
If a builder crashes mid-implementation:
1. Check `af status` to see builder state
2. If worktree intact: `af spawn -p XXXX` respawns in existing worktree
3. If worktree corrupted: `af cleanup -p XXXX --force` then respawn fresh

#### Aborting a Project
To abandon a project from any stage:
1. If builder spawned: `af cleanup -p XXXX`
2. Update projectlist.md: `status: abandoned`
3. Add note explaining why

#### Rolling Back a Merge
If a merged PR needs to be reverted:
1. `git revert <merge-commit>` on main
2. Update projectlist.md: `status: abandoned` with note
3. Create new project if reattempting

#### Consultation Failures
If consultation fails (timeout, API error):
1. Retry once
2. If still fails, document in review and proceed with available consultants
3. Minimum: 1 consultation + human review

### Projectlist States (Updated)

```yaml
status:
  - conceived      # Concept added, spec may exist but awaiting human approval
  - specified      # Spec approved by human, plan being created
  - planned        # Plan approved and committed, awaiting builder spawn
  - implementing   # Builder spawned and working through phases
  - implemented    # Code complete, tests passing, PR created and awaiting review
  - committed      # PR merged, builder cleaned up
  - integrated     # Validated in production by human
  - abandoned      # Work stopped, documented why
```

## Solution

### Part 1: Delete SPIR-SOLO

Remove directories:
- `codev/protocols/spider-solo/`
- `codev-skeleton/protocols/spider-solo/`
- `packages/codev/templates/protocols/spider-solo/`

Update references in:
- `CLAUDE.md` - Protocol selection guide
- `AGENTS.md` - Protocol selection guide
- `README.md` - Available protocols
- `INSTALL.md` - Setup instructions
- `codev/resources/arch.md` - Architecture doc
- `codev-skeleton/agents/codev-updater.md` - Updater agent
- `packages/codev/templates/agents/codev-updater.md` - Template
- `tests/11_fresh_spider_solo.bats` - Delete this test file
- `tests/helpers/common.bash` - Remove SPIR-SOLO helper functions
- `tests/README.md` - Update test descriptions

**Migration for existing projects**: Any project currently using SPIR-SOLO should simply use SPIR. The workflow is identical; SPIR-SOLO was just SPIR without 3-way consultation. To skip consultation, users can say "without consultation" when requesting work.

**No active projects affected**: Search `codev/projectlist.md` for projects referencing SPIR-SOLO protocol. If any exist, update their notes to indicate they now use SPIR.

### Migration: Existing Projectlist States

The 7-stage workflow uses the same states as before, with simplified definitions:

| State | Definition |
|-------|-----------|
| `conceived` | Idea captured. Spec may exist but awaiting human approval. |
| `specified` | Spec approved by human. |
| `planned` | Plan approved and committed. |
| `implementing` | Builder spawned and working. |
| `implemented` | Code complete, tests passing, PR created and awaiting review. |
| `committed` | PR merged. |
| `integrated` | Validated in production by human. |

**Migration action**: Update any projects with `spec-draft` status to `conceived`. The state now covers both "no spec yet" and "spec exists but not approved".

### Part 2: Update Protocol Documentation

1. **Create workflow reference doc**:
   - `codev/resources/architect-builder-workflow.md` (our instance)
   - `codev-skeleton/resources/architect-builder-workflow.md` (template for other projects)
2. **Update SPIR protocol**: Reference the workflow doc, replace any "use spider-solo" references with "request without consultation"
3. **Update role files**: `codev/roles/architect.md`, `codev/roles/builder.md`
4. **Update CLAUDE.md/AGENTS.md**:
   - Remove SPIR-SOLO references
   - Update protocol selection guide
   - Emphasize use of `consult` command for reviews
5. **Add review type prompts**: Create `codev/roles/review-types/` directory with:
   - `spec-review.md` - Prompt for spec reviews
   - `plan-review.md` - Prompt for plan reviews
   - `phase-review.md` - Prompt for builder phase reviews
   - `pr-ready.md` - Prompt for PR ready self-check
   - `integration.md` - Prompt for architect integration reviews
6. **Update consult tool**: Add `--type` parameter to `codev/bin/consult` that loads prompts from `codev/roles/review-types/`

### Part 3: Update Projectlist States

1. Update state definitions in projectlist.md template
2. Document state transitions
3. Remove `spec-draft` state (merged into `conceived`)
4. Update `implemented` definition to include "PR created and awaiting review"

## Success Criteria

- [ ] SPIR-SOLO deleted from all locations
- [ ] Workflow document created with all 7 stages
- [ ] SPIR protocol references workflow doc
- [ ] Role files updated with clear responsibilities
- [ ] CLAUDE.md/AGENTS.md updated
- [ ] Projectlist states documented (7 states: conceived, specified, planned, implementing, implemented, committed, integrated)
- [ ] All tests pass (update tests that reference SPIR-SOLO)

## Constraints

- Must maintain backward compatibility with existing projectlist entries
- Must not break existing builder workflows mid-flight
- Documentation must be clear enough for AI agents to follow

## Test Plan

### Automated Tests

1. **Delete SPIR-SOLO test**: Remove `tests/11_fresh_spider_solo.bats`
2. **Update helpers**: Remove SPIR-SOLO functions from `tests/helpers/common.bash`
3. **Grep verification**: Run `grep -r "spider-solo" --include="*.md" --include="*.ts" --include="*.bats"` and ensure no hits

### Manual Verification

1. **Full workflow walkthrough**: Create a test project (0999), walk through all 9 stages
2. **Error recovery**: Test builder crash recovery with `af spawn` on existing worktree
3. **Abort path**: Test abandoning a project mid-implementation

### Documentation Verification

1. **Cross-references**: All links in workflow doc resolve
2. **State consistency**: All projectlist.md examples use valid states
3. **CLI help**: `af --help` doesn't reference SPIR-SOLO

### Acceptance Criteria

- [ ] `grep -r "spider-solo"` returns no hits in codebase
- [ ] `grep -ri "zen.*mcp\|mcp.*zen"` returns no hits (verifies old ZEN MCP server consultation references are removed - we now use the `consult` CLI tool instead)
- [ ] All existing tests pass: `./tests/run_tests.sh`
- [ ] Manual workflow walkthrough succeeds
- [ ] `af status` shows correct builder states
- [ ] Projectlist states match documented states
- [ ] `consult --type <type>` works with all 5 review types
- [ ] Review type prompts exist in `codev/roles/review-types/`

## References

- Current SPIR protocol: `codev/protocols/spir/protocol.md`
- Architect role: `codev/roles/architect.md`
- Builder role: `codev/roles/builder.md`
- Agent Farm CLI: `codev/resources/agent-farm.md`
