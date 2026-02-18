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
<!-- REVIEW(@architect): It's not just the rebuttal parts. It should also have concern: Addressed as well if it wasnt just a rebuttal. -->

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

### Concern Extraction Method

Concerns are extracted from the `KEY_ISSUES` section of each reviewer's verdict block. All consult review templates already produce a structured `KEY_ISSUES` block:

```
KEY_ISSUES:
- [Issue 1 or "None"]
- [Issue 2]
```

**Extraction rules:**
1. Parse the `KEY_ISSUES:` block from each review output (same parsing location as `VERDICT:`)
2. Each bullet item under `KEY_ISSUES:` becomes a `**Concern**` entry
3. If `KEY_ISSUES` cannot be parsed, fall back to the `SUMMARY:` line
4. If neither exists, append "No structured concerns extracted — see raw review"

### Append Ownership
<!-- REVIEW(@architect): I don't think that's necessary. The builder can do it. We can just give it instructions to do so. We don't need to hardwire this. Just tell it to include any concerns and rebuttals for each phase at the end. -->

**Porch owns all file appending.** The builder never directly edits the consultation sections.
<!-- REVIEW(@architect): IS this the right choice? Let's discuss -->

1. **After consultations complete**: Porch's `next.ts` logic (when all review files arrive and any REQUEST_CHANGES exist) programmatically appends the `## Consultation` section to the target file with extracted concerns and empty `**Rebuttal**:` placeholders
2. **After builder writes rebuttals**: The builder writes rebuttals to the same location as today — a standalone rebuttal file. Porch then reads the rebuttal file, fills in the `**Rebuttal**` placeholders in the consultation section, and deletes the standalone rebuttal file
3. **On all APPROVE**: Porch appends the consultation section with concerns but marks rebuttals as "N/A — approved"

This two-step approach means:
- Porch always controls what's written to spec/plan files (no parser fragility from builder edits)
- The builder's rebuttal workflow is unchanged (write a markdown file)
- The standalone rebuttal file is transient — created by builder, consumed and deleted by porch

### Rebuttal Signal Replacement

The existing `findRebuttalFile()` check in `next.ts` remains the signal for rebuttal completion. The standalone rebuttal file still gets created by the builder. The change is what happens *after* porch detects it:

**Before**: Porch records the rebuttal in history and advances
**After**: Porch reads the rebuttal file, appends concerns+rebuttals to the spec/plan, deletes the standalone rebuttal file, then advances

### Target File Selection

Based on the current porch phase:
- `specify` phase → append to `codev/specs/${PROJECT_TITLE}.md`
- `plan` phase → append to `codev/plans/${PROJECT_TITLE}.md`
- `implement` phase (per_plan_phase) → append to `codev/plans/${PROJECT_TITLE}.md` with plan phase name in header
- `review` phase → append to `codev/reviews/${PROJECT_TITLE}.md`

For `per_plan_phase` reviews, multiple consultation sections accumulate on the plan file (one per plan phase per iteration). The `[phase-name]` in the header disambiguates them.
<!-- REVIEW(@architect): What if we put everytihing in the review file? -->

### Multi-Iteration Behavior

All consultation rounds accumulate at the bottom of the file. Each round gets its own `## Consultation: [phase-name] (Round N)` header. This provides a complete review history in chronological order.

The `buildReviewContext()` function in `next.ts` should be updated to read from the inline sections rather than separate files when building context for later iterations.

### Error Handling

- If the append fails (file not found, permissions), porch logs the error and continues — the raw review files still exist as fallback
- If concern extraction fails for one model, that model's section shows the fallback text
- No rollback needed — appending is additive and the raw files are the source of truth during the session

### What Changes

1. **Porch `next.ts` — consultation result processing** — after all reviews arrive, extract KEY_ISSUES from each and append a `## Consultation` section to the target file
2. **Porch `next.ts` — rebuttal processing** — after detecting rebuttal file, read it, fill in rebuttals in the consultation section, delete the standalone rebuttal file
3. **Porch `next.ts` — context building** — `buildReviewContext()` reads inline sections from spec/plan instead of separate files
4. **Consult CLI output** — unchanged; raw review output still goes to file for porch to parse
5. **Spec/plan templates** — no template changes needed; the sections are appended dynamically

### What Stays The Same

- The consultation process itself (3-way parallel review)
- The verdict system (APPROVE / REQUEST_CHANGES)
- Gate approval flow
- Raw review output still available during the session

## Scope

- Modify porch's defend phase to inline concerns + rebuttals
<!-- REVIEW(@architect): What defend phase? I only know about build and verify phases. -->
- Modify porch's consultation capture to extract and append key concerns
- Keep raw review files as ephemeral session artifacts (not committed)
- Existing specs/plans are not retroactively modified

### Edge Cases

- **All APPROVE, no concerns**: Append a consultation section with "No concerns raised" under each model for traceability
- **COMMENT verdicts**: Include their KEY_ISSUES — comments are non-blocking but may have useful feedback
- **CONSULT_ERROR (model failure)**: Append "Consultation failed — see raw output" for that model's section
- **Zero KEY_ISSUES parsed**: Use SUMMARY line as fallback, or "No structured concerns" note
- **Multiple plan phases**: Each gets its own consultation section with the plan phase name in the header

## Acceptance Criteria

- [ ] After a consultation round, concerns appear at the bottom of the spec/plan file, extracted from KEY_ISSUES blocks
- [ ] Rebuttals are filled in by porch after the builder writes the standalone rebuttal file
- [ ] Format is consistent and parseable (markdown headers + bullet lists)
- [ ] Raw review output still available for detailed reading during session
- [ ] Standalone rebuttal files are consumed by porch and deleted after inline integration
- [ ] Works for both SPIR spec reviews and plan reviews
- [ ] Works for phase-level implementation reviews (appended to plan)
- [ ] All APPROVE rounds still get a consultation section for traceability
- [ ] Fallback behavior when KEY_ISSUES cannot be parsed
