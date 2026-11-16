# IMPLEMENT Phase Prompt

You are executing the **IMPLEMENT** phase of the AIR protocol.

## Goal

Implement the feature described in the issue, with tests, as a focused change under ~300 LOC. AIR produces no `codev/specs/` or `codev/plans/` artifacts.

## Baked Decisions

Check the issue body for a section named "Baked Decisions" (any heading level, case-insensitive). If present, treat each listed decision as fixed during implementation. Do not autonomously substitute alternate languages, frameworks, or dependencies. If you discover a serious problem with a baked decision, raise it via `afx send architect` rather than working around it.

If two baked decisions contradict each other, do not pick one — pause, flag the contradiction via `afx send`, and wait for resolution before implementing.

## Context

- **Issue**: #{{issue.number}} — {{issue.title}}
- **Current State**: {{current_state}}

## What must be true when you finish

- **The feature matches the issue.** You have read it fully — desired behavior, acceptance criteria, any examples — and implemented exactly what it describes: no refactoring of surrounding code, no features beyond the issue. **Fix in place:** a small adjacent bug you notice is fixed in this PR and named in its body; a follow-up issue is only for work that needs something unavailable now (a device, an owner decision), touches a different subsystem, or is a large refactor. Self-documenting code, no debug or commented-out code, existing project conventions.
- **Tests exist.** They cover the happy path and the key edge cases, and are deterministic. (Purely declarative changes — config only — may not need them; say so.)
- **Build and tests pass.** Confirm the real project commands (check `package.json` if unsure) and run them; fix failures before signaling.
- **The change stays within AIR scope.** ~300 LOC is a guideline. If the change turns architectural or needs a decision the issue does not make, tell the architect and recommend escalating to SPIR or ASPIR rather than pressing on.

Commit with an explicit staged path and the message `[Air #{{issue.number}}] feat: <brief description>`.

## When you finish

- **Implementation and tests committed and passing:** run the `porch done` command porch gives you below.
- **Too large for AIR, or blocked** (missing context, unclear requirements): do not run `porch done`.
  Send the specifics, then stop and wait:
  ```bash
  afx send architect "Issue #<N>: <what you found>. Recommend escalating to SPIR or ASPIR."   # or: Blocked on <X>
  ```
