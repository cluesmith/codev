# IMPLEMENT Phase Prompt

You are executing the **IMPLEMENT** phase of the ASPIR protocol.

## Goal

Implement the current plan phase — code and tests — so it matches the spec and passes build and tests.

## Context

- **Project ID**: {{project_id}}
- **Project Title**: {{title}}
- **Current State**: {{current_state}}
- **Plan Phase**: {{plan_phase_id}} - {{plan_phase_title}}

## Scope: this phase only

Your scope is exactly `{{plan_phase_id}}` ({{plan_phase_title}}), whose details are included below under "Current Plan Phase Details". Other phases are handled in later porch iterations — do not implement them, and do not read the full plan and build everything you see. Read `codev/specs/{{project_id}}-*.md` for requirements, but implement only what this phase requires.

When the phase is done, **commit it yourself** — porch commits only `status.yaml`, never your code — and run `porch done {{project_id}}`. Porch runs the phase checks, then `porch next` hands you the consultation commands to run in the background. REQUEST_CHANGES brings the feedback back to you for another iteration; approval moves porch to the next plan phase.

## What must be true when you finish

- **The implementation matches the spec.** The spec is the source of truth; the plan derives from it; existing code is not trusted until validated against the spec, because earlier work may have drifted. Code that "works" but diverges from the spec is wrong. When you notice yourself patching symptoms in existing code, stop and re-check what the spec actually requires before building further.
- **Tests exist and are meaningful.** Unit tests for the core logic, integration tests where the phase spans components, and coverage of error and edge cases. Tests are deterministic. Follow the project's existing test locations and naming.
- **Build and tests pass.** Confirm the actual project commands (check `package.json` rather than assuming `npm run build` / `npm test` exist) and run them; fix failures before signaling.
- **The change is clean.** Self-documenting names, explicit error handling, no commented-out or debug code, only the files this phase touches — the simplest solution that satisfies the phase, not more.

## When you finish

- **Implementation and tests complete and passing:** stage this phase's files by path and commit
  (`[Spec {{project_id}}][Phase: {{plan_phase_id}}] feat: <what it delivers>`), then run
  `porch done {{project_id}}`.
- **Blocked** — the plan is wrong, the spec is wrong, a dependency is missing, or build/tests fail
  in a way you cannot resolve — or **you need spec/plan clarification**: do not run `porch done`.
  `afx send architect` the specifics and your questions, then stop and wait.

A blocker is a message to the architect, not a silent workaround: never edit `status.yaml` or bypass a porch check to force a green.
