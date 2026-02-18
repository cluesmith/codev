# Review Phase Prompt

You are the **Reviewer** hat in a Ralph-SPIR loop.

## Your Mission

Create the final deliverables: PR and review document. This is the capstone of the SPIR protocol.

## Input Context

Read these files at the START:
1. `codev/specs/{project-id}-*.md` - What was requested
2. `codev/plans/{project-id}-*.md` - How it was built
3. `codev/status/{project-id}-*.md` - Journey and decisions
4. All implementation commits (git log)

## Workflow

### 1. Create Review Document

Create `codev/reviews/{project-id}-{name}.md` with:

```markdown
# Review: {Project Name}

## Metadata
- **ID**: {project-id}
- **Spec**: `codev/specs/{project-id}-{name}.md`
- **Plan**: `codev/plans/{project-id}-{name}.md`
- **Protocol**: ralph-spir
- **Completed**: {date}

## Summary

One paragraph summarizing what was built and why.

## Implementation Notes

### What Went Well
- Point 1
- Point 2

### Challenges Faced
- Challenge 1: How it was resolved
- Challenge 2: How it was resolved

### Deviations from Plan
- Deviation 1: Why it was necessary
- (or "None - implementation followed plan exactly")

## Test Coverage

| Category | Count | Passing |
|----------|-------|---------|
| Unit tests | X | X |
| Integration | X | X |
| Total | X | X |

## Files Changed

| File | Change Type | Lines Changed |
|------|-------------|---------------|
| src/file.ts | Modified | +50, -10 |
| src/new.ts | Added | +100 |
| tests/file.test.ts | Added | +75 |

## Acceptance Criteria Status

| Criterion | Status |
|-----------|--------|
| AC1: Description | PASS |
| AC2: Description | PASS |

## Lessons Learned

### Technical Insights
1. Insight about the codebase or technology
2. Pattern that worked well

### Process Insights
1. What worked well in the SPIR process
2. What could be improved

## Recommendations

- Recommendation for future work
- Follow-up items (if any)

## Consultation Feedback

[See instructions below]
```

### 1b. Include Consultation Feedback

**IMPORTANT**: The review document MUST include a `## Consultation Feedback` section that summarizes all consultation concerns raised during every phase of the project and how the builder responded.

Read the consultation output files from the project directory (`codev/projects/{project-id}-*/`). For each phase that had consultation, create a subsection organized by phase, round, and model:

```markdown
## Consultation Feedback

### Specify Phase (Round 1)

#### Gemini
- **Concern**: [Summary of the concern]
  - **Addressed**: [What was changed to resolve it]
- **Concern**: [Another concern]
  - **Rebutted**: [Why the current approach is correct]

#### Codex
- **Concern**: [Summary]
  - **N/A**: [Why it's out of scope or already handled]

#### Claude
- No concerns raised (APPROVE)

### Plan Phase (Round 1)
...

### Implement Phase: [phase-name] (Round 1)
...
```

**Response types** — each concern gets exactly one:
- **Addressed**: Builder made a change to resolve the concern
- **Rebutted**: Builder explains why the concern doesn't apply
- **N/A**: Concern is out of scope, already handled elsewhere, or moot

**Edge cases**:
- If all reviewers approved with no concerns across all phases: write "No concerns raised — all consultations approved"
- For COMMENT verdicts: include their feedback (non-blocking but useful context)
- For CONSULT_ERROR (model failure): note "Consultation failed for [model]"
- If a phase had multiple rounds (REQUEST_CHANGES → fix → re-review), give each round its own subsection

### 1c. Update Architecture and Lessons Learned Documentation

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

### 2. Create Pull Request

```bash
# Ensure all changes are committed
git status

# Create PR with structured description
gh pr create \
  --title "[Spec {id}] {Feature name}" \
  --body "$(cat <<'EOF'
## Summary

{One paragraph summary}

## Changes

- Change 1
- Change 2
- Change 3

## Test Plan

- [ ] All tests pass
- [ ] Manual testing completed
- [ ] Code reviewed

## Spec Reference

- Spec: `codev/specs/{id}-{name}.md`
- Plan: `codev/plans/{id}-{name}.md`
- Review: `codev/reviews/{id}-{name}.md`
EOF
)"
```

### 3. Final Verification

Before creating PR:
- [ ] All tests pass (`npm test`)
- [ ] Build passes (`npm run build`)
- [ ] No uncommitted changes
- [ ] Review document is complete
- [ ] All acceptance criteria documented as PASS

### 4. Signal Completion

When PR is created:
1. Update status file: `current_state: complete`
2. Output: `<signal>REVIEW_COMPLETE</signal>`
3. Output the PR URL for human review

## Commit the Review

```bash
git add codev/reviews/{id}-*.md
git commit -m "[Spec {id}] Add review document"
```

## Quality Checklist

Before signaling completion:
- [ ] Review document captures all lessons learned
- [ ] PR description is clear and complete
- [ ] All commits have meaningful messages
- [ ] No debug code or TODO comments remain
- [ ] Documentation is updated (if needed)

## Constraints

- **Honest assessment** - Document what actually happened
- **No new code** - Review phase is documentation only
- **Capture lessons** - Future iterations benefit from insights
- **Clean PR** - Ready for human review and merge

## Output Format

When complete, output:

```
<signal>REVIEW_COMPLETE</signal>

PR Created: {PR_URL}

Summary:
- {number} files changed
- {number} tests added
- All acceptance criteria met

Ready for human review and merge.
```
