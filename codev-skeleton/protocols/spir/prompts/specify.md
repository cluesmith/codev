# SPECIFY Phase Prompt

You are executing the **SPECIFY** phase of the SPIR protocol.

## Goal

Produce a specification at `codev/specs/{{artifact_name}}.md` that explores the problem space and the proposed solution well enough that the plan and implementation can follow without re-deciding anything.

## Context

- **Project ID**: {{project_id}}
- **Project Title**: {{title}}
- **Current State**: {{current_state}}
- **Spec File**: `codev/specs/{{artifact_name}}.md`

## What must be true when you finish

- **An existing spec is honored, not rewritten.** If `codev/specs/{{project_id}}-*.md` already exists, it carries the architect's decisions — read it fully and refine it in place. Clarifying questions are for the case where no spec exists yet; when one does, the spec is the answer.
- **Baked Decisions are fixed.** If the issue body has a "Baked Decisions" section (any heading level, case-insensitive), copy it verbatim into the spec's Constraints and treat each item as settled — do not relitigate it in Solution Exploration. Raise a genuine problem with a baked decision via `afx send architect`; if two baked decisions contradict, stop and flag it via `afx send` rather than choosing.
- **The problem is characterized before solutions are.** Current state vs desired state, stakeholders, assumptions, and constraints are explicit.
- **Solutions are explored, not assumed.** More than one approach is considered, each with its trade-offs and risks, before one is recommended.
- **Open questions are surfaced and ranked** by whether they block progress, shape the design, or are merely nice to know.
- **Success is measurable.** Acceptance criteria are concrete enough to test against.

## Output

Write the spec to `codev/specs/{{artifact_name}}.md` using the template below as its interface — these headings, in this order. A section that genuinely does not apply keeps its heading with a one-line `N/A — [reason]` rather than being deleted. Do not pattern-match an older spec in `codev/specs/` that predates this template.

{{> protocols/spir/templates/spec.md}}

Keep the three artifact filenames in sync: spec `codev/specs/{{artifact_name}}.md`, plan `codev/plans/{{artifact_name}}.md`, review `codev/reviews/{{artifact_name}}.md`.

## Signals

- Waiting on clarifying-question answers — **put the questions inside the signal**, which is displayed prominently to the user:
  ```
  <signal type=AWAITING_INPUT>
  Please answer:
  1. ...
  2. ...
  </signal>
  ```
- Initial draft done:
  ```
  <signal>SPEC_DRAFTED</signal>
  ```

## Commit cadence

Commit at each milestone, staging the spec file explicitly:
```bash
git add codev/specs/{{artifact_name}}.md
```
1. `[Spec {{project_id}}] Initial specification draft`
2. `[Spec {{project_id}}] Specification with multi-agent review`
3. `[Spec {{project_id}}] Specification with user feedback`
4. `[Spec {{project_id}}] Final approved specification`

Porch runs the 3-way consultation itself after you signal — do not run `consult`. This is the Specify phase: no implementation detail (that is the plan), no code, no time estimates.
