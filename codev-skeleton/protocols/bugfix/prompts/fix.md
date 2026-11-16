# FIX Phase Prompt

You are executing the **FIX** phase of the BUGFIX protocol.

## Goal

Fix the bug with the minimum change, and add a regression test that pins it.

## Context

- **Issue**: #{{issue.number}} — {{issue.title}}
- **Current State**: {{current_state}}

## What must be true when you finish

- **The change is minimal and targeted.** Fix the root cause from INVESTIGATE — no refactoring of surrounding code, no unrelated features. **Fix in place:** a small adjacent bug you notice is fixed in this PR and named in its body; a follow-up issue is only for work that needs something unavailable now (a device, an owner decision), touches a different subsystem, or is a large refactor. Self-documenting code, no debug or commented-out code, existing project conventions.
- **A regression test pins the fix.** Every bugfix carries a test that **fails without the fix and passes with it**, covers the issue's scenario, and is deterministic. The only exception is a genuinely untestable change (e.g. a CSS-only tweak with no observable behavior) — and then you state why, in the commit message and PR description.
- **Build and tests pass.** Confirm the real project commands (check `package.json` if unsure) and run them; fix failures before signaling.
- **The change stays within BUGFIX scope.** ~300 LOC is a guideline: a well-contained larger fix is fine. If the fix turns architectural or spreads across subsystems, tell the architect and recommend escalation rather than pressing on.

Commit with explicit staged paths and the messages `[Bugfix #{{issue.number}}] Fix: <brief description>` and `[Bugfix #{{issue.number}}] Test: <what the regression test pins>`.

## When you finish

- **Fix and tests committed and passing:** run the `porch done` command porch gives you below.
- **Blocked or outgrowing BUGFIX:** do not run `porch done`. `afx send architect` the specifics,
  then stop and wait.
