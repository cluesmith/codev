# IMPLEMENT Phase Prompt

You are executing the **IMPLEMENT** phase of the SPIR protocol.

## Goal

Implement the current plan phase — code and tests — so it matches the spec and passes build and tests.

## Context

- **Project ID**: {{project_id}}
- **Project Title**: {{title}}
- **Current State**: {{current_state}}
- **Plan Phase**: {{plan_phase_id}} - {{plan_phase_title}}

## Scope: this phase only

Your scope is exactly `{{plan_phase_id}}` ({{plan_phase_title}}), whose details are included below under "Current Plan Phase Details". Other phases are handled in later porch iterations — do not implement them, and do not read the full plan and build everything you see. Read `codev/specs/{{project_id}}-*.md` for requirements, but implement only what this phase requires.

When you signal `PHASE_COMPLETE`, porch runs the 3-way consultation, checks that tests exist and pass, and either respawns you with feedback or commits and moves to the next phase.

## What must be true when you finish

- **The implementation matches the spec.** The spec is the source of truth; the plan derives from it; existing code is not trusted until validated against the spec, because earlier work may have drifted. Code that "works" but diverges from the spec is wrong. When you notice yourself patching symptoms in existing code, stop and re-check what the spec actually requires before building further.
- **Tests exist and are meaningful.** Unit tests for the core logic, integration tests where the phase spans components, and coverage of error and edge cases. Tests are deterministic. Follow the project's existing test locations and naming.
- **Build and tests pass.** Confirm the actual project commands (check `package.json` rather than assuming `npm run build` / `npm test` exist) and run them; fix failures before signaling.
- **The change is clean.** Self-documenting names, explicit error handling, no commented-out or debug code, only the files this phase touches — the simplest solution that satisfies the phase, not more.

## Signals

- Implementation and tests complete and passing:
  ```
  <signal>PHASE_COMPLETE</signal>
  ```
- Blocked — the plan is wrong, the spec is wrong, a dependency is missing, or build/tests fail in a way you cannot resolve:
  ```
  <signal>BLOCKED:reason goes here</signal>
  ```
- Need spec/plan clarification:
  ```
  <signal type=AWAITING_INPUT>
  Your specific questions here
  </signal>
  ```

A blocker is a signal, not a silent workaround: never edit `status.yaml` or bypass a porch check to force a green.
