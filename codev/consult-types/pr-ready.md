# PR Ready Review Prompt

## Context
You are performing a final self-check at Stage 5 (IMPLEMENTED) of the workflow. The builder has completed all implementation phases and is about to create a PR. This is the last check before the work goes to the architect for integration review.

## Focus Areas

1. **Completeness**
   - Are all spec requirements implemented?
   - Are all plan phases complete?
   - Is the review document written (`codev/reviews/XXXX-name.md`)?
   - Are all commits properly formatted (`[Spec XXXX][Phase]`)?

2. **Test Status**
   - Do all tests pass?
   - Is test coverage adequate for the changes?
   - Are there any skipped or flaky tests?

3. **Code Cleanliness**
   - Is there any debug code left in?
   - Are there any TODO comments that should be resolved?
   - Are there any `// REVIEW:` comments that weren't addressed?
   - Is the code properly formatted?

4. **Documentation**
   - Are inline comments clear where needed?
   - Is the review document comprehensive?
   - Are any new APIs documented?

5. **PR Readiness**
   - Is the branch up to date with main?
   - Are commits atomic and well-described?
   - Is the change diff reasonable in size?

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

PR_SUMMARY: |
  ## Summary
  [2-3 sentences describing what this PR does]

  ## Key Changes
  - [Change 1]
  - [Change 2]

  ## Test Plan
  - [How to test]
```

**Verdict meanings:**
- `APPROVE`: Ready to create PR
- `REQUEST_CHANGES`: Issues to fix before PR creation
- `COMMENT`: Minor items, can create PR but note feedback

## Notes

- This is the builder's final self-review before hand-off
- The PR_SUMMARY in your output can be used as the PR description
- Focus on "is this ready for someone else to review" not "is this perfect"
- Any issues found here are cheaper to fix than during integration review
