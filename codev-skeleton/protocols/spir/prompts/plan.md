# PLAN Phase Prompt

You are executing the **PLAN** phase of the SPIR protocol.

## Your Goal

Transform the approved specification into an executable implementation plan with clear phases.

## Context

- **Project ID**: {{project_id}}
- **Project Title**: {{title}}
- **Current State**: {{current_state}}
- **Spec File**: `codev/specs/{{project_id}}-{{title}}.md`
- **Plan File**: `codev/plans/{{project_id}}-{{title}}.md`

## Prerequisites

Before planning, verify:
1. The specification exists and has been approved
2. You've read and understood the entire spec
3. Success criteria are clear and measurable

## Process

### 1. Analyze the Specification

Read the spec thoroughly. Identify:
- All functional requirements
- Non-functional requirements
- Dependencies and constraints
- Success criteria to validate against

### 2. Identify Implementation Phases

Break the work into logical phases. Each phase should be:
- **Self-contained** - A complete unit of functionality
- **Independently testable** - Can be verified on its own
- **Valuable** - Delivers observable progress
- **Committable** - Can be a single atomic commit

Good phase examples:
- "Database Schema" - Creates all tables/migrations
- "Core API Endpoints" - Implements main REST routes
- "Authentication Flow" - Handles login/logout/session

Bad phase examples:
- "Setup" - Too vague
- "Part 1" - Not descriptive
- "Everything" - Not broken down

### 3. Define Each Phase

For each phase, document:
- **Objective** - Single clear goal
- **Files to modify/create** - Specific paths
- **Dependencies** - Which phases must complete first
- **Success criteria** - How to know it's done
- **Test approach** - What tests will verify it

### 4. Order Phases by Dependencies

Arrange phases so dependencies are satisfied:
```
Phase 1: Database Schema (no dependencies)
Phase 2: Data Models (depends on Phase 1)
Phase 3: API Endpoints (depends on Phase 2)
Phase 4: Frontend Integration (depends on Phase 3)
```

### 5. Finalize

After completing the plan draft, signal completion. Porch will run 3-way consultation (Gemini, Codex, Claude) automatically via the verify step. If reviewers request changes, you'll be respawned with their feedback.

## Output

Create the plan file at `codev/plans/{{project_id}}-{{title}}.md`.

Use the plan template from `codev/protocols/spir/templates/plan.md` if available.

### Plan Structure

```markdown
# Implementation Plan: {{title}}

## Overview
Brief summary of what will be implemented.

## Phases

### Phase 1: [Name]
- **Objective**: [Single clear goal]
- **Files**: [List of files to create/modify]
- **Dependencies**: None
- **Success Criteria**: [How to verify completion]
- **Tests**: [What tests will be written]

### Phase 2: [Name]
- **Objective**: [Single clear goal]
- **Files**: [List of files]
- **Dependencies**: Phase 1
- **Success Criteria**: [Verification method]
- **Tests**: [Test approach]

[Continue for all phases...]

## Risk Assessment
- [Risk 1]: [Mitigation]
- [Risk 2]: [Mitigation]

```

## Signals

Emit appropriate signals based on your progress:

- After completing the plan draft:
  ```
  <signal>PLAN_DRAFTED</signal>
  ```

## Commit Cadence

Make commits at these milestones:
1. `[Spec {{project_id}}] Initial implementation plan`
2. `[Spec {{project_id}}] Plan with multi-agent review`
3. `[Spec {{project_id}}] Plan with user feedback`
4. `[Spec {{project_id}}] Final approved plan`

**CRITICAL**: Never use `git add .` or `git add -A`. Always stage specific files:
```bash
git add codev/plans/{{project_id}}-{{title}}.md
```

## Important Notes

1. **No time estimates** - Don't include hours/days/weeks
3. **Be specific about files** - Exact paths, not "the config file"
4. **Keep phases small** - 1-3 files per phase is ideal
5. **Document dependencies clearly** - Prevents blocked work

## What NOT to Do

- Don't run `consult` commands yourself (porch handles consultations)
- Don't write code (that's for Implement phase)
- Don't estimate time (meaningless in AI development)
- Don't create phases that can't be independently tested
- Don't skip dependency analysis
- Don't make phases too large (if >5 files, split it)
- Don't use `git add .` or `git add -A` (security risk)
