# PR Overview Template

Use this template to prepare context for architect-mediated PR reviews.

## PR Info
- **Number**: #<N>
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

To use this template for an architect-mediated review, fill it out, save it as `overview.md`,
and pass it as the prompt of a general-mode consultation:

```bash
consult -m gemini --prompt-file overview.md
```

For a 3-way review, run the same command with `-m codex` and `-m claude`, each as its own
background task (in Claude Code, `run_in_background: true`, not a trailing `&`). The consultant
can still read the repository; the overview tells it where to look.

For a review of the PR itself, without an overview, use the integration review:

```bash
consult -m claude --type integration --issue <N>
```
