---
approved: 2026-02-17
validated: [architect]
---

# Spec 395: Inline Consultation Feedback

## Problem

Consultation feedback (concerns from reviewers and rebuttals from builders) is currently stored in separate files in the porch project directory:

```
codev/projects/386-documentation-audit/
  386-tier_1_public-iter1-gemini.txt
  386-tier_1_public-iter1-codex.txt
  386-tier_1_public-iter1-claude.txt
  386-tier_1_public-iter1-rebuttals.md
  386-tier_2_developer-iter1-gemini.txt
  ...
```

This has several problems:
1. **Context is scattered** — to understand a spec's review history, you have to hunt through multiple files in a different directory
2. **Review files are ephemeral** — they live in porch project dirs that get cleaned up, losing valuable context
3. **No single source of truth** — the spec/plan says one thing, the reviews say another, and you have to cross-reference manually
4. **Clutter** — each consultation round generates 3-4 files per phase, accumulating dozens of files

## Solution

Append consultation concerns and builder rebuttals directly to the spec or plan file as structured sections at the bottom.

### Format

After each consultation round, append a section like:

```markdown
## Consultation: [phase-name] (Round N)

### Gemini
- **Concern**: [summary of concern]
  - **Rebuttal**: [builder's response / action taken]
- **Concern**: [summary of concern]
  - **Rebuttal**: Addressed in [commit/change description]

### Codex
- **Concern**: [summary]
  - **Rebuttal**: [response]

### Claude
- **Concern**: [summary]
  - **Rebuttal**: [response]
```

### What Changes

1. **Porch `defend` phase** — instead of writing rebuttals to a separate file, append them to the spec or plan file (whichever was being reviewed)
2. **Porch consultation capture** — instead of saving full review text to separate `.txt` files, extract key concerns and append them inline
3. **Consult CLI output** — the raw review output can still go to stdout/file for detailed reading, but the actionable concerns get inlined
4. **Spec/plan templates** — no template changes needed; the sections are appended dynamically

### What Stays The Same

- The consultation process itself (3-way parallel review)
- The verdict system (APPROVE / REQUEST_CHANGES)
- Gate approval flow
- Raw review output still available during the session

## Scope

- Modify porch's defend phase to inline concerns + rebuttals
- Modify porch's consultation capture to extract and append key concerns
- Keep raw review files as ephemeral session artifacts (not committed)
- Existing specs/plans are not retroactively modified

## Acceptance Criteria

- [ ] After a consultation round, concerns and rebuttals appear at the bottom of the spec/plan file
- [ ] Format is consistent and parseable (markdown headers + bullet lists)
- [ ] Raw review output still available for detailed reading during session
- [ ] Separate rebuttal files are no longer created
- [ ] Works for both SPIR spec reviews and plan reviews
- [ ] Works for phase-level implementation reviews (appended to plan)
