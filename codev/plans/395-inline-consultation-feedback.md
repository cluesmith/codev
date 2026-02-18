---
approved: 2026-02-18
validated: [architect]
---

# Plan 395: Inline Consultation Feedback

## Overview

Add a `## Consultation Feedback` section to review documents by updating the porch review phase prompt and review templates. This is a prompt-and-template-only change — no code modifications.

## Files to Modify

### 1. Porch Review Phase Prompt
**File**: `codev-skeleton/porch/prompts/review.md`

Add a new section instructing the builder to include a `## Consultation Feedback` section in the review document. The instruction should:
- Tell the builder to read all consultation output files from the project directory
- Summarize each reviewer's concerns with Addressed/Rebutted/N/A responses
- Organize by phase and round number
- Handle edge cases (all APPROVE, CONSULT_ERROR, COMMENT verdicts)

### 2. SPIR Review Template
**File**: `codev-skeleton/protocols/spir/templates/review.md`

Add a `## Consultation Feedback` placeholder section after the existing `Consultation Iteration Summary` section. The placeholder shows the expected format with phase/round/model subsections and response types.

### 3. TICK Review Template
**File**: `codev-skeleton/protocols/tick/templates/review.md`

Add the same `## Consultation Feedback` placeholder section. The TICK template already has a `## Multi-Agent Consultation` section — replace it with the new structured format.

### 4. SPIR Review Prompt (protocol-level)
**File**: `codev-skeleton/protocols/spir/prompts/review.md`

Add matching instructions to the SPIR protocol's own review prompt, ensuring consistency between porch-driven and manual SPIR flows.

### 5. Sync codev/ instance
The `codev/` directory is our own Codev instance. The SPIR and TICK review templates there should also be updated to match.

## Implementation Approach

Each file gets a targeted addition — no structural refactoring. The changes are additive: new sections appended, existing content untouched except where the TICK template's old consultation section is replaced.

## Out of Scope

- No changes to consultation process itself
- No changes to verdict parsing
- No programmatic enforcement (builder follows prompt instructions)
- No retroactive modification of existing reviews
