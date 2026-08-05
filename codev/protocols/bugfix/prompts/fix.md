# FIX Phase Prompt

You are executing the **FIX** phase of the BUGFIX protocol.

## Goal

Fix the bug with the minimum change, and add a regression test that pins it.

## Context

- **Issue**: #{{issue.number}} — {{issue.title}}
- **Current State**: {{current_state}}

## What must be true when you finish

- **The change is minimal and targeted.** Fix the root cause from INVESTIGATE and nothing else — no refactoring of surrounding code, no unrelated features, no other bugs you happen to notice (file separate issues for those). Self-documenting code, no debug or commented-out code, existing project conventions.
- **A regression test pins the fix.** Every bugfix carries a test that **fails without the fix and passes with it**, covers the issue's scenario, and is deterministic. The only exception is a genuinely untestable change (e.g. a CSS-only tweak with no observable behavior) — and then you state why, in the commit message and PR description.
- **Build and tests pass.** Confirm the real project commands (check `package.json` if unsure) and run them; fix failures before signaling.
- **The change stays within BUGFIX scope.** If the fix grows past ~300 LOC, signal `TOO_COMPLEX` rather than pressing on.

Commit with an explicit staged path and the message `Fix #{{issue.number}}: <brief description>`.

## Signals

- Fix and tests complete and passing:
  ```
  <signal>PHASE_COMPLETE</signal>
  ```
- Blocked:
  ```
  <signal>BLOCKED:reason goes here</signal>
  ```
