# Implementation Review Prompt (PIR)

## Context

You are reviewing the implementation of a PIR protocol project before it reaches the `code-review` human gate. A builder has implemented the approved plan and written a code-review summary. Your job is to verify the implementation matches the plan and is ready for human review.

## CRITICAL: Verify Before Flagging

Before requesting changes for missing configuration, incorrect patterns, or framework issues:
1. **Check `package.json`** for actual dependency versions — framework conventions change between major versions
2. **Read the actual config files** (or confirm their deliberate absence) before flagging missing configs
3. **Do not assume** your training data reflects the version in use — verify against project files
4. If "Previous Iteration Context" is provided, read it carefully before re-raising concerns that were already disputed

## Focus Areas

1. **Plan Adherence**
   - Does the implementation fulfill the approved plan?
   - Are all "Files to Change" actually changed?
   - Are the changes scoped to what the plan described, or has scope crept?

2. **Code Quality**
   - Is the code readable and maintainable?
   - Are there obvious bugs?
   - Are error cases handled appropriately?
   - Is the change minimal — no unnecessary refactoring or unrelated tidy-ups?

3. **Test Coverage**
   - Are the tests adequate for the changes?
   - Do tests cover both the main path and the edge cases the plan called out?
   - For a bug fix: is there a regression test that would fail without the fix?

4. **Review File Quality**
   - Does `codev/reviews/pir-<id>-<slug>.md` exist and follow the template?
   - Does it accurately describe what changed?
   - Is "Things to Look At" honest about tricky spots?
   - Is "How to Test Locally" specific enough that the human reviewer can act on it?

5. **PIR-Specific Concerns**
   - For UI / mobile / cross-platform changes: does the review file explain platform-specific behavior the human should verify?
   - For changes with external integrations: are the integration points documented?

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
- `APPROVE`: Ready for human at the `code-review` gate
- `REQUEST_CHANGES`: Issues that must be fixed before reaching the human
- `COMMENT`: Minor suggestions, can proceed but note feedback

## Scope

- **DO** review the implementation against the approved plan
- **DO** flag missing regression tests for bug fixes
- **DO** flag obvious bugs, code smells, security issues
- **DO NOT** redesign the approach — that was settled at `plan-approval`
- **DO NOT** demand changes outside the plan's scope
- **DO NOT** request architecture-level refactors unless the change introduces a clear new problem

## Notes

- This is a pre-gate review; the human is the final authority
- Focus on "is this ready for someone else to test in a browser / simulator"
- If referencing line numbers, use `file:line` format
- The builder needs actionable feedback to iterate
