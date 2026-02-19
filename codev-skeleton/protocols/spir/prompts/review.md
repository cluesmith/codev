# REVIEW Phase Prompt

You are executing the **REVIEW** phase of the SPIR protocol.

## Your Goal

Perform a comprehensive review, document lessons learned, and prepare for PR submission.

## Context

- **Project ID**: {{project_id}}
- **Project Title**: {{title}}
- **Current State**: {{current_state}}
- **Spec File**: `codev/specs/{{artifact_name}}.md`
- **Plan File**: `codev/plans/{{artifact_name}}.md`
- **Review File**: `codev/reviews/{{artifact_name}}.md`

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

Create `codev/reviews/{{artifact_name}}.md`:

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

## Consultation Feedback

[See instructions below]

## Flaky Tests
- [Any pre-existing tests that were skipped as flaky during this project]
- [Include test name, file path, and observed failure mode]
- [If none: "No flaky tests encountered"]

## Follow-up Items
- [Any items identified for future work]
```

### 3b. Include Consultation Feedback

**IMPORTANT**: The review document MUST include a `## Consultation Feedback` section that summarizes all consultation concerns raised during every phase of the project and how the builder responded.

Read the consultation output files from the project directory (`codev/projects/{project-id}-*/`). For each phase that had consultation, create a subsection organized by phase, round, and model:

```markdown
## Consultation Feedback

### Specify Phase (Round 1)

#### Gemini
- **Concern**: [Summary of the concern]
  - **Addressed**: [What was changed to resolve it]

#### Codex
- **Concern**: [Summary]
  - **Rebutted**: [Why the current approach is correct]

#### Claude
- No concerns raised (APPROVE)

### Plan Phase (Round 1)
...
```

**Response types** — each concern gets exactly one:
- **Addressed**: Builder made a change to resolve the concern
- **Rebutted**: Builder explains why the concern doesn't apply
- **N/A**: Concern is out of scope, already handled elsewhere, or moot

**Edge cases**:
- If all reviewers approved with no concerns: "No concerns raised — all consultations approved"
- For COMMENT verdicts: include their feedback (non-blocking but useful context)
- For CONSULT_ERROR (model failure): note "Consultation failed for [model]"
- If a phase had multiple rounds, give each round its own subsection

### 4. Update Architecture and Lessons Learned Documentation

**MANDATORY**: The review document MUST include `## Architecture Updates` and `## Lessons Learned Updates` sections. Porch will block advancement if these are missing.

**Architecture Updates** (`codev/resources/arch.md`):
1. Read the current `codev/resources/arch.md`
2. Determine if this project introduced architectural changes worth documenting (new subsystems, data flows, design decisions, invariants, file locations)
3. If yes: make the updates to arch.md and describe what you changed in the `## Architecture Updates` section of the review
4. If no: write "No architecture updates needed" in the section with a brief explanation (e.g., "This was a template-only change with no new subsystems or data flows")

**Lessons Learned Updates** (`codev/resources/lessons-learned.md`):
1. Read the current `codev/resources/lessons-learned.md`
2. Determine if this project produced generalizable lessons (patterns, anti-patterns, debugging insights, process improvements)
3. If yes: add entries to lessons-learned.md and describe what you added in the `## Lessons Learned Updates` section of the review
4. If no: write "No lessons learned updates needed" in the section with a brief explanation (e.g., "Straightforward implementation with no novel insights beyond existing entries")

### 4b. Update Other Documentation

If needed, also update:
- README.md (new features, changed behavior)
- API documentation

### 5. Final Verification

Before PR:
- [ ] All tests pass (use project-specific test command)
- [ ] Build passes (use project-specific build command)
- [ ] Lint passes (if configured)
- [ ] No uncommitted changes: `git status`
- [ ] Review document complete

### 6. Create Pull Request

**IMPORTANT: Create the PR BEFORE signaling completion.** The PR must exist so that
porch consultation reviews the actual PR, and the architect can review a real PR
when the pr gate fires.

```bash
gh pr create --title "[Spec {{project_id}}] {{title}}" --body "$(cat <<'EOF'
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
Link: codev/specs/{{artifact_name}}.md

## Review
Link: codev/reviews/{{artifact_name}}.md
EOF
)"
```

### 7. Signal Completion

After the PR is created, signal completion. Porch will run 3-way consultation
(Gemini, Codex, Claude) automatically via the verify step. If reviewers request
changes, you'll be respawned with their feedback.

## Output

- Review document at `codev/reviews/{{artifact_name}}.md`
- Updated documentation (if needed)
- Pull request created and ready for review

## Signals

- After review document is complete:
  ```
  <signal>REVIEW_COMPLETE</signal>
  ```

- After PR is created — signal completion so porch runs consultation:
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
