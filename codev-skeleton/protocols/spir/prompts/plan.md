# PLAN Phase Prompt

You are executing the **PLAN** phase of the SPIR protocol.

## Goal

Turn the approved spec into an executable plan at `codev/plans/{{artifact_name}}.md`: a phase breakdown a builder can implement one phase at a time.

## Context

- **Project ID**: {{project_id}}
- **Project Title**: {{title}}
- **Current State**: {{current_state}}
- **Spec File**: `codev/specs/{{artifact_name}}.md`
- **Plan File**: `codev/plans/{{artifact_name}}.md`

## What must be true when you finish

- **The plan derives from the spec.** You have read the whole spec — its functional and non-functional requirements, constraints, and success criteria — and the plan validates against them.
- **The work is decomposed into phases, each of which is:**
  - **self-contained** — a complete unit of functionality;
  - **independently testable** — verifiable on its own;
  - **valuable** — delivers observable progress;
  - **committable** — a single atomic commit.

  A phase name states what it delivers ("Database schema", "Authentication flow"), not a position ("Setup", "Part 1").
- **Each phase carries its own contract:** objective, the specific files it creates or modifies, which earlier phases it depends on, its success criteria, and how it will be tested.
- **Phases are ordered so dependencies are satisfied before the phase that needs them.**

## Output

Write the plan to `codev/plans/{{artifact_name}}.md` using the template below as its interface:

{{> protocols/spir/templates/plan.md}}

## Signals

- Draft done:
  ```
  <signal>PLAN_DRAFTED</signal>
  ```

## Commit cadence

Commit at each milestone, staging the plan file explicitly:
```bash
git add codev/plans/{{artifact_name}}.md
```
1. `[Spec {{project_id}}] Initial implementation plan`
2. `[Spec {{project_id}}] Plan with multi-agent review`
3. `[Spec {{project_id}}] Plan with user feedback`
4. `[Spec {{project_id}}] Final approved plan`

Porch runs the 3-way consultation itself after you signal — do not run `consult`. This is the Plan phase: decompose and sequence the work, do not write code, and do not estimate time.
