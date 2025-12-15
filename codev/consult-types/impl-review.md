# Implementation Review Prompt

## Context
You are reviewing implementation work at Stage 4 (IMPLEMENTING) of the workflow. A builder has completed a phase (Implement + Defend) and needs feedback before proceeding. Your job is to verify the implementation matches the spec and plan.

## Focus Areas

1. **Spec Adherence**
   - Does the implementation fulfill the spec requirements for this phase?
   - Are acceptance criteria met?
   - Are there deviations from the spec that need explanation?

2. **Code Quality**
   - Is the code readable and maintainable?
   - Are there obvious bugs or issues?
   - Are error cases handled appropriately?
   - Does it follow project conventions?

3. **Test Coverage**
   - Are the tests adequate for this phase?
   - Do tests cover the main paths AND edge cases?
   - Are tests testing the right things (behavior, not implementation)?
   - Would the tests catch regressions?

4. **Plan Alignment**
   - Does the implementation follow the plan?
   - Are there deviations that make sense?
   - Are there plan items skipped or partially completed?

## Verdict Format

After your review, provide your verdict in exactly this format:

```
---
VERDICT: [APPROVE | REQUEST_CHANGES | COMMENT]
SUMMARY: [One-line summary of your assessment]
CONFIDENCE: [HIGH | MEDIUM | LOW]
---
KEY_ISSUES:
- [Issue 1 or "None"]
- [Issue 2]
...
```

**Verdict meanings:**
- `APPROVE`: Phase is complete, builder can proceed
- `REQUEST_CHANGES`: Issues that must be fixed before proceeding
- `COMMENT`: Minor suggestions, can proceed but note feedback

## Notes

- This is a phase-level review, not the final PR review
- Focus on "does this phase work" not "is the whole feature done"
- If referencing line numbers, use `file:line` format
- The builder needs actionable feedback to continue
