# REVIEW Phase Prompt

You are executing the **REVIEW** phase of the SPIR protocol.

## Your Goal

Perform a comprehensive review, document lessons learned, and prepare for PR submission.

## Context

- **Project ID**: {{project_id}}
- **Project Title**: {{title}}
- **Current State**: {{current_state}}
- **Spec File**: `codev/specs/{{project_id}}-{{title}}.md`
- **Plan File**: `codev/plans/{{project_id}}-{{title}}.md`
- **Review File**: `codev/reviews/{{project_id}}-{{title}}.md`

## Prerequisites

Before review, verify:
1. All implementation phases are committed
2. All tests are passing
3. Build is passing
4. Spec compliance verified for all phases

Verify commits: `git log --oneline | grep "[Spec {{project_id}}]"`

## Process

### 1. Comprehensive Review

Review the entire implementation:

**Code Quality**:
- Is the code readable and maintainable?
- Are there any code smells?
- Is error handling consistent?
- Are there any security concerns?

**Architecture**:
- Does the implementation fit well with existing code?
- Are there any architectural concerns?
- Is the design scalable if needed?

**Documentation**:
- Is code adequately commented where needed?
- Are public APIs documented?
- Is README updated if needed?

### 2. Spec Comparison

Compare final implementation to original specification:

- What was delivered vs what was specified?
- Any deviations? Document why.
- All success criteria met?

### 3. Create Review Document

Create `codev/reviews/{{project_id}}-{{title}}.md`:

```markdown
# Review: {{title}}

## Summary
Brief description of what was implemented.

## Spec Compliance
- [x] Requirement 1: Implemented as specified
- [x] Requirement 2: Implemented with deviation (see below)
- [x] Requirement 3: Implemented as specified

## Deviations from Plan
- **Phase X**: [What changed and why]

## Lessons Learned

### What Went Well
- [Positive observation 1]
- [Positive observation 2]

### Challenges Encountered
- [Challenge 1]: [How it was resolved]
- [Challenge 2]: [How it was resolved]

### What Would Be Done Differently
- [Insight 1]
- [Insight 2]

### Methodology Improvements
- [Suggested improvement to SPIR protocol]
- [Suggested improvement to tooling]

## Technical Debt
- [Any shortcuts taken that should be addressed later]

## Follow-up Items
- [Any items identified for future work]
```

### 4. Update Documentation

If needed, update:
- README.md (new features, changed behavior)
- API documentation
- Architecture documentation (`codev/resources/arch.md`)

### 5. Final Verification

Before PR:
- [ ] All tests pass (use project-specific test command)
- [ ] Build passes (use project-specific build command)
- [ ] Lint passes (if configured)
- [ ] No uncommitted changes: `git status`
- [ ] Review document complete

### 6. Create Pull Request

After the review document is complete, signal completion. Porch will run 3-way consultation (Gemini, Codex, Claude) automatically via the verify step. If reviewers request changes, you'll be respawned with their feedback.

Prepare PR with:

**Title**: `[Spec {{project_id}}] {{title}}`

**Body**:
```markdown
## Summary
[Brief description of the implementation]

## Changes
- [Change 1]
- [Change 2]

## Testing
- All unit tests passing
- Integration tests added for [X]
- Manual testing completed for [Y]

## Spec
Link: codev/specs/{{project_id}}-{{title}}.md

## Review
Link: codev/reviews/{{project_id}}-{{title}}.md
```

## Output

- Review document at `codev/reviews/{{project_id}}-{{title}}.md`
- Updated documentation (if needed)
- Pull request ready for submission

## Signals

Emit appropriate signals based on your progress:

- After review document is complete:
  ```
  <signal>REVIEW_COMPLETE</signal>
  ```

- After PR is created:
  ```
  <signal>PR_CREATED</signal>
  ```

- When ready for Architect review:
  ```
  <signal>PR_READY</signal>
  ```

## Important Notes

1. **Be honest in lessons learned** - Future you will thank present you
3. **Document deviations** - They're not failures, they're learnings
4. **Update methodology** - If you found a better way, document it
5. **Don't skip the checklist** - It catches last-minute issues
6. **Clean PR description** - Makes review easier

## What NOT to Do

- Don't run `consult` commands yourself (porch handles consultations)
- Don't skip lessons learned ("nothing to report")
- Don't merge your own PR (Architect handles integration)
- Don't leave uncommitted changes
- Don't forget to update documentation
- Don't rush this phase - it's valuable for learning
- Don't use `git add .` or `git add -A` (security risk)

## Review Prompts for Reflection

Ask yourself:
- What surprised me during implementation?
- Where did I spend the most time? Was it avoidable?
- What would have helped me go faster?
- Did the spec adequately describe what was needed?
- Did the plan phases make sense in hindsight?
- What tests caught issues? What tests were unnecessary?

Capture these reflections in the lessons learned section.
