# PR Ready Review Prompt

## Context
You are performing a review of a pull request created under the AIR protocol. The builder implemented a small feature directly from a GitHub issue — there are no spec, plan, or review files. The review is embedded in the PR body.

## Focus Areas

1. **Completeness**
   - Are the issue requirements implemented?
   - Is the PR body review section filled out (summary, key decisions, test plan)?
   - Are commits properly formatted?

2. **Test Status**
   - Do all tests pass?
   - Is test coverage adequate for the changes?
   - Are there any skipped or flaky tests?

3. **Code Cleanliness**
   - Is there any debug code left in?
   - Are there any TODO comments that should be resolved?
   - Is the code properly formatted?

4. **Scope**
   - Is the change under 300 LOC?
   - Does the implementation stay focused on the issue?
   - Are there unrelated changes bundled in?

5. **PR Quality**
   - Does the PR link to the issue?
   - Is the PR body review section informative?
   - Is the branch up to date with main?

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
- `APPROVE`: Ready for architect review
- `REQUEST_CHANGES`: Issues to fix before review
- `COMMENT`: Minor items, can proceed but note feedback

## Notes

- AIR has no spec, plan, or review files — review the PR body and code diff
- Focus on "is this ready for someone else to review" not "is this perfect"
- Any issues found here are cheaper to fix than during integration review
