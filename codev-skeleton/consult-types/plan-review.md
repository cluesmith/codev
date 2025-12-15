# Plan Review Prompt

## Context
You are reviewing an implementation plan at Stage 2 (SPECIFIED) of the workflow. The spec has been approved - now you must evaluate whether the plan adequately describes HOW to implement it.

## Focus Areas

1. **Spec Coverage**
   - Does the plan address all requirements in the spec?
   - Are there spec requirements not covered by any phase?
   - Are there phases that go beyond the spec scope?

2. **Phase Breakdown**
   - Are phases appropriately sized (not too large or too small)?
   - Is the sequence logical (dependencies respected)?
   - Can each phase be completed and committed independently?

3. **Technical Approach**
   - Is the implementation approach sound?
   - Are the right files/modules being modified?
   - Are there obvious better approaches being missed?

4. **Testability**
   - Does each phase have clear test criteria?
   - Will the Defend step (writing tests) be feasible?
   - Are edge cases from the spec addressable?

5. **Risk Assessment**
   - Are there potential blockers not addressed?
   - Are dependencies on other systems identified?
   - Is the plan realistic given constraints?

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
- `APPROVE`: Plan is ready for human review
- `REQUEST_CHANGES`: Significant issues with approach or coverage
- `COMMENT`: Minor suggestions, plan is workable but could improve

## Notes

- The spec has already been approved - don't re-litigate spec decisions
- Focus on the quality of the plan as a guide for builders
- Consider: Would a builder be able to follow this plan successfully?
- If referencing existing code, verify file paths seem accurate
