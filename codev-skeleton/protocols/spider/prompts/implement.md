# IMPLEMENT Phase Prompt

You are executing the **IMPLEMENT** phase of the SPIDER protocol.

## Your Goal

Write clean, well-structured code AND tests that implement the current plan phase.

## Context

- **Project ID**: {{project_id}}
- **Project Title**: {{title}}
- **Current State**: {{current_state}}
- **Plan Phase**: {{plan_phase_id}} - {{plan_phase_title}}

## ⚠️ SCOPE RESTRICTION — READ THIS FIRST

**You are implementing ONLY the current plan phase: {{plan_phase_id}} ({{plan_phase_title}}).**

- **DO NOT** implement other phases. Other phases will be handled in subsequent porch iterations.
- **DO NOT** read the full plan file and implement everything you see.
- The plan phase details are included below under "Current Plan Phase Details". That is your ONLY scope.
- If you need to reference the spec for requirements, read `codev/specs/{{project_id}}-*.md` but ONLY implement what the current phase requires.

## What Happens After You Finish

When you signal `PHASE_COMPLETE`, porch will:
1. Run 3-way consultation (Gemini, Codex, Claude) on your implementation
2. Check that tests exist and pass
3. If reviewers request changes, you'll be respawned with their feedback
4. Once approved, porch commits and moves to the next plan phase

## Spec Compliance (CRITICAL)

**The spec is the source of truth. Code that doesn't match the spec is wrong, even if it "works".**

### Trust Hierarchy

```
SPEC (source of truth)
  ↓
PLAN (implementation guide derived from spec)
  ↓
EXISTING CODE (NOT TRUSTED - must be validated against spec)
```

**Never trust existing code over the spec.** Previous implementations may have drifted.

### Pre-Implementation Sanity Check (PISC)

**Before writing ANY code:**

1. ✅ "Have I read the spec in the last 30 minutes?"
2. ✅ "If the spec has a 'Traps to Avoid' section, have I read it?"
3. ✅ "Does my approach match the spec's Technical Implementation section?"
4. ✅ "If the spec has code examples, am I following them?"
5. ✅ "Does the existing code I'm building on actually match the spec?"

**If ANY answer is "no" or "unsure" → STOP and re-read the spec.**

### Avoiding "Fixing Mode"

A dangerous pattern: You start looking at symptoms in code, making incremental fixes, copying existing patterns - without going back to the spec. This leads to:
- Cargo-culting patterns that may be wrong
- Building on broken foundations
- Implementing something different from the spec

**When you catch yourself "fixing" code:**
1. STOP
2. Ask: "What does the spec say about this?"
3. Re-read the spec's Traps to Avoid section
4. Verify existing code matches the spec before building on it

## Prerequisites

Before implementing, verify:
1. Previous phase (if any) is committed to git
2. You've read the plan phase you're implementing
3. You understand the success criteria for this phase
4. Dependencies from earlier phases are available

## Process

### 1. Review the Plan Phase

Read the current phase in the plan:
- What is the objective?
- What files need to be created/modified?
- What are the success criteria?
- What dependencies exist?

### 2. Set Up

- Verify you're on the correct branch
- Check that previous phase is committed: `git log --oneline -5`
- Ensure build passes before starting: `npm run build` (or equivalent)

### 3. Implement the Code

Write the code following these principles:

**Code Quality Standards**:
- Self-documenting code (clear names, obvious structure)
- No commented-out code
- No debug prints in final code
- Explicit error handling
- Follow project style guide

**Implementation Approach**:
- Work on one file at a time
- Make small, incremental changes
- Document complex logic with comments

### 4. Write Tests

**Tests are required.** For each piece of functionality you implement:

- Write unit tests for core logic
- Write integration tests if the phase involves multiple components
- Test error cases and edge conditions
- Ensure tests are deterministic (no flaky tests)

**Test file locations** (follow project conventions):
- `tests/` or `__tests__/` directories
- `*.test.ts` or `*.spec.ts` naming

### 5. Verify Everything Works

Run both build and tests:

```bash
npm run build      # Must pass
npm test           # Must pass
```

**Important**: Don't assume these commands exist. Check `package.json` first.

Fix any errors before signaling completion.

### 6. Self-Review

Before signaling completion:
- Read through all code changes
- Read through all test changes
- Verify code matches the spec requirements
- Ensure no accidental debug code
- Check test coverage is adequate

## Output

When complete, you should have:
- Modified/created source files as specified in the plan phase
- Tests covering the new functionality
- All build checks passing
- All tests passing

## Signals

When implementation AND tests are complete and passing:

```
<signal>PHASE_COMPLETE</signal>
```

If you encounter a blocker:

```
<signal>BLOCKED:reason goes here</signal>
```

If you need spec/plan clarification:

```
<signal type=AWAITING_INPUT>
Your specific questions here
</signal>
```

## Important Notes

1. **Follow the plan** - Implement what's specified, not more
2. **Don't over-engineer** - Simplest solution that works
3. **Don't skip error handling** - But don't go overboard either
4. **Keep changes focused** - Only touch files in this phase
5. **Build AND tests must pass** - Don't signal complete until both pass
6. **Write tests** - Every implementation phase needs tests

## What NOT to Do

- Don't modify files outside this phase's scope
- Don't add features not in the spec
- Don't leave TODO comments for later (fix now or note as blocker)
- Don't skip writing tests
- Don't use `git add .` or `git add -A` when you commit (security risk)

## Handling Problems

**If the plan is unclear**:
Signal `AWAITING_INPUT` with your specific question.

**If you discover the spec is wrong**:
Signal `BLOCKED` and explain the issue. The Architect may need to update the spec.

**If a dependency is missing**:
Signal `BLOCKED` with details about what's missing.

**If build or tests fail and you can't fix it**:
Signal `BLOCKED` with the error message.
