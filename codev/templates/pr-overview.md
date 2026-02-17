# PR Overview Template

Use this template to prepare context for architect-mediated PR reviews.

## PR Info
- **Number**: #NNN
- **Title**: [PR Title]
- **Branch**: [branch-name]
- **Author**: [author]
- **Spec**: [link to spec if applicable]
- **Plan**: [link to plan if applicable]

## Summary

[1-2 sentence summary of what this PR does and why]

## Key Changes

### File: `path/to/file1.ts`
**What**: [Brief description of changes]
**Why**: [Rationale for these changes]

### File: `path/to/file2.ts`
**What**: [Brief description of changes]
**Why**: [Rationale for these changes]

## Diff

```diff
[Include the relevant portions of the diff, or full diff if small]
[For large PRs, focus on the most significant changes]
```

## Test Coverage

- [ ] Unit tests added/updated
- [ ] Integration tests added/updated
- [ ] Manual testing completed

**Test summary**: [Brief description of test coverage]

## Questions for Reviewer

1. [Specific question about design decision]
2. [Question about edge case handling]
3. [Question about alternative approaches considered]

## Context from Spec/Plan

[Include relevant excerpts from the spec or plan that inform this PR]

---

## Usage

To use this template for architect-mediated reviews:

```bash
# Fill out this template and save as overview.md, then:
consult -m gemini --type pr --context overview.md

# Or pipe directly:
cat overview.md | consult -m gemini --type pr --context -

# For 3-way parallel reviews:
consult -m gemini --type pr --context overview.md &
consult -m codex --type pr --context overview.md &
consult -m claude --type pr --context overview.md &
wait
```

The consultant will analyze the provided context WITHOUT accessing the filesystem,
resulting in faster and more consistent reviews.
