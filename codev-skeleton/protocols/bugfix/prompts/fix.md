# FIX Phase Prompt

You are executing the **FIX** phase of the BUGFIX protocol.

## Your Goal

Implement the bug fix and add a regression test. Keep it minimal and focused.

## Context

- **Issue**: #{{issue.number}} — {{issue.title}}
- **Current State**: {{current_state}}

## Process

### 1. Implement the Fix

Apply the minimum change needed to resolve the bug:
- Fix the root cause identified in the INVESTIGATE phase
- Do NOT refactor surrounding code
- Do NOT add features beyond what's needed
- Do NOT fix other bugs you happen to notice (file separate issues)

**Code Quality**:
- Self-documenting code (clear names, obvious structure)
- No commented-out code or debug prints
- Follow existing project conventions

### 2. Add a Regression Test

**A regression test is MANDATORY.** Every bugfix MUST include a test unless you provide explicit justification for why a test is impossible (e.g., pure CSS-only change with no testable behavior). If you skip the test, you MUST explain why in your commit message and PR description.

Write a test that:
- Fails without the fix (demonstrates the bug)
- Passes with the fix (demonstrates the fix works)
- Covers the specific scenario from the issue
- Is deterministic (not flaky)

Place tests following project conventions (`__tests__/`, `*.test.ts`, etc.).

### 3. Verify the Fix

Run build and tests:

```bash
npm run build      # Must pass
npm test           # Must pass
```

Fix any failures before proceeding. If build/test commands don't exist, check `package.json`.

### 4. Commit

Stage and commit your changes:
- Never `git add -A` / `--all` / `.` — stage each file explicitly by path.
- Commit message: `Fix #{{issue.number}}: <brief description>`

## Signals

When fix and tests are complete and passing:

```
<signal>PHASE_COMPLETE</signal>
```

If you encounter a blocker:

```
<signal>BLOCKED:reason goes here</signal>
```

## Important Notes

1. **Minimal changes only** — Fix the bug, nothing else
2. **Regression test is MANDATORY** — No fix without a test. If truly untestable, justify in writing.
3. **Build AND tests must pass** — Don't signal complete until both pass
4. **Stay under 300 LOC** — If the fix grows beyond this, signal `TOO_COMPLEX`
