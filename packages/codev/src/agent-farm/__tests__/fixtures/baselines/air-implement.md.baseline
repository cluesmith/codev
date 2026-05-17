# IMPLEMENT Phase Prompt

You are executing the **IMPLEMENT** phase of the AIR protocol.

## Your Goal

Read the GitHub issue, implement the feature, and add tests. Keep it focused and under 300 LOC.

## Context

- **Issue**: #{{issue.number}} — {{issue.title}}
- **Current State**: {{current_state}}

## Process

### 1. Read the Issue

Read the full issue description. Identify:
- What is the desired behavior?
- What are the acceptance criteria?
- Are there examples or mockups?
- What files/modules are likely affected?

### 2. Implement the Feature

Apply a focused implementation:
- Implement what the issue describes — no more, no less
- Do NOT refactor surrounding code
- Do NOT add features beyond what's described in the issue
- Do NOT fix unrelated bugs you happen to notice (file separate issues)

**Code Quality**:
- Self-documenting code (clear names, obvious structure)
- No commented-out code or debug prints
- Follow existing project conventions

### 3. Add Tests

Write tests that:
- Cover the main happy path
- Cover key edge cases
- Are deterministic (not flaky)

Place tests following project conventions (`__tests__/`, `*.test.ts`, etc.).

### 4. Verify the Build

Run build and tests:

```bash
npm run build      # Must pass
npm test           # Must pass
```

Fix any failures before proceeding. If build/test commands don't exist, check `package.json`.

### 5. Commit

Stage and commit your changes:
- Use explicit file paths (never `git add -A` or `git add .`)
- Commit message: `[Air #{{issue.number}}] feat: <brief description>`

## Signals

When implementation and tests are complete and passing:

```
<signal>PHASE_COMPLETE</signal>
```

If the feature is too complex for AIR (> 300 LOC or architectural):

```
<signal>TOO_COMPLEX</signal>
```

If you're blocked (missing context, unclear requirements, etc.):

```
<signal>BLOCKED:reason goes here</signal>
```

## Important Notes

1. **Stay focused** — Implement what the issue describes, nothing else
2. **Tests are expected** — Add tests unless the change is purely declarative (e.g., config only)
3. **Build AND tests must pass** — Don't signal complete until both pass
4. **Stay under 300 LOC** — If the feature grows beyond this, signal `TOO_COMPLEX`
5. **No spec/plan artifacts** — AIR does not create files in `codev/specs/` or `codev/plans/`
