# Review: Documentation Sweep (Spec 422)

## Summary

Comprehensive documentation sweep of all ~121 unique spec numbers (~293 source documents) to update `codev/resources/arch.md` and `codev/resources/lessons-learned.md`. Used a two-pass approach: Pass 1 extracted content via 10 parallel agents across 2 batches, Pass 2 refined both documents through deduplication, consistency normalization, and consolidation.

**Results**:
- **arch.md**: 2,346 -> 3,352 lines (+43%). Added "Historical Architecture Evolution" section covering all specs chronologically, with cross-references to existing sections.
- **lessons-learned.md**: 83 -> 413 lines (+398%). Grew from ~38 entries to 366 entries across 11 topical categories.

## Spec Compliance

- [x] Every spec, plan, and review document read and relevant content extracted (121 spec number groups)
- [x] arch.md reflects architectural decisions from project history (303 `(Spec XXXX)` attributions)
- [x] lessons-learned.md captures generalizable wisdom from reviews (366 `[From XXXX]` entries)
- [x] No duplicate entries in either document (verified during refinement)
- [x] Both documents internally consistent (terminology, formatting, zero-padding)
- [x] Refinement passes complete (dedup + consistency + consolidation + read-through)
- [x] Attribution preserved for all entries

## Deviations from Plan

- **Refinement capped at 4 passes** instead of the max 7. After dedup, consistency, consolidation, and read-through, no further meaningful changes were identified. This is expected behavior per the spec: "stop earlier if a pass produces no changes."
- **Three zero-yield specs** (0004, 0024, 0119): Draft/unimplemented specs with no review documents. Zero yield was expected per spec: "Not every document will yield extractable content."

## Lessons Learned

### What Went Well

- **Parallel agent extraction**: Spawning 5 agents per batch maximized throughput. Each agent handled ~12 spec groups independently, with extraction files merged afterward. Total extraction time was dominated by the slowest agent, not the sum.
- **Intermediate extraction files**: Writing to per-agent extraction files before merging into target docs was a good isolation pattern. It prevented merge conflicts and allowed quality review of each agent's output.
- **Two-batch approach**: Splitting 121 spec groups into 2 batches (64 + 57) kept context manageable while still achieving full coverage in 2 rounds.
- **Rebuttal mechanism**: Codex raised valid attribution concerns on batch 2 (bugfix entries) and refinement (zero-padding). Rebuttals allowed addressing the valid points while documenting why others were intentional design choices.

### Challenges Encountered

- **consult --project-id disambiguation**: Multiple projects in `codev/projects/` caused consultation commands to fail. Solved by using `--issue 422` instead.
- **consult --type impl requires a PR**: Implementation consultations need a GitHub PR to review. Had to create a draft PR early and push the branch.
- **consult --type phase not available in worktree context**: Used `--type impl` as a workaround.
- **npm install needed in worktree**: The builder worktree didn't have `node_modules`. Had to run `npm install` before porch build checks would pass.
- **replace_all side effects**: The arch.md agent's `replace_all` on `ProjectTerminals` inadvertently changed a Spec 0112 changelog entry that documented the rename itself (`ProjectTerminals -> WorkspaceTerminals` became `WorkspaceTerminals -> WorkspaceTerminals`). Caught and fixed during verification.

### What Would Be Done Differently

- **Pre-create the draft PR before any impl consultations**: This would avoid the "No PR found" error that blocked the first consultation attempt.
- **Use explicit spec number lists in agent prompts from the start**: The plan initially used ranges, but Claude's consultation correctly identified that sparse numbering required explicit lists. This should be the default for any sweep-type task.

### Methodology Improvements

- **Documentation sweep could be a MAINTAIN protocol variant**: The spec notes this is a one-off, but the pattern (extract from source docs -> merge -> refine) is reusable for periodic documentation reconciliation.
- **Porch should auto-detect worktree for --project-id**: The `--project-id` flag failed when multiple projects existed in the directory. Porch should use the worktree path to disambiguate automatically.

## Technical Debt

- None. This was a documentation-only project.

## Consultation Feedback

### Specify Phase (Round 1)

#### Gemini
- No concerns raised (APPROVE). Noted batching would be needed for 293 documents.

#### Codex
- **Concern**: Conflicting processing order (chronological vs specs-plans-reviews grouping)
  - **Addressed**: Switched to per-feature ordering (all doc types for spec N before N+1)
- **Concern**: Open-ended refinement stop condition
  - **Addressed**: Capped at max 7 passes (later reduced from initial 3 per architect feedback)
- **Concern**: Missing verification criteria
  - **Addressed**: Batch commits with spec ranges serve as audit trail

#### Claude
- **Concern**: No batching/checkpointing strategy
  - **Addressed**: Added batch-of-5-agents approach with intermediate commits
- **Concern**: No tracking mechanism for completeness
  - **Addressed**: Explicit spec number lists per agent + batch commits
- **Concern**: Unbounded refinement
  - **Addressed**: Capped at max 7 passes
- **Concern**: Not every doc yields content
  - **Addressed**: Added explicit note about zero-yield docs being expected

### Plan Phase (Round 1)

#### Gemini
- No concerns raised (APPROVE).

#### Codex
- **Concern**: Missing coverage for specs 0128-0324 and 0404-0421
  - **Rebutted**: Those specs don't exist (numbering is sparse between 0127 and 0325)
- **Concern**: Per-spec processing order not enforced in agent instructions
  - **Addressed**: Added explicit per-feature ordering to agent assignments and prompt template

#### Claude
- **Concern**: Agent assignments use ranges instead of explicit lists
  - **Addressed**: Replaced with exact spec number lists per agent
- **Concern**: Non-zero-padded naming and special cases not called out
  - **Addressed**: Added naming inconsistency notes to Phase 2 and documented 0364/364, bugfix-274, 324
- **Concern**: No merge ordering guidance
  - **Addressed**: Added "Merge Ordering" section (chronological by agent/spec number)

### Extraction Batch 1 (Round 1)

#### Gemini, Codex, Claude
- All APPROVE. No concerns raised.

### Extraction Batch 2 (Round 1)

#### Gemini
- No concerns raised (APPROVE).

#### Codex
- **Concern**: Missing explicit attribution for Bugfix #274 and Bugfix #324 in arch.md
  - **Addressed**: Added `(Bugfix 274)` and `(Bugfix 324)` to section headers
- **Concern**: Inconsistent zero-padding for non-padded spec numbers
  - **Rebutted**: Deferred to refinement phase per spec design (raw extraction preserves original numbering)

#### Claude
- No concerns raised (APPROVE). Minor note about arch.md footer date (deferred to refinement).

### Refinement (Round 1)

#### Gemini
- No concerns raised (APPROVE).

#### Codex
- **Concern**: `(Bugfix 274)` and `(Bugfix 324)` don't follow `(Spec XXXX)` format
  - **Rebutted**: These are bugfixes with no associated spec numbers. Using `(Bugfix NNN)` is the most accurate attribution.
- **Concern**: `[From bug reports]`, `[From scroll saga]`, `[From CMAP analysis]` use non-spec attribution
  - **Rebutted**: Pre-existing entries from before the sweep, referencing non-spec sources that have no spec numbers.
- **Concern**: `[From 324]` not zero-padded
  - **Addressed**: Changed to `[From 0324]`

#### Claude
- No concerns raised (APPROVE). Noted 3 zero-yield specs (0004, 0024, 0119) are plausible given their draft/unimplemented status.

## Architecture Updates

This project IS the architecture documentation update. arch.md was updated extensively as the primary deliverable:
- Added "Historical Architecture Evolution" section (lines 2144-3260) covering all 121 spec groups chronologically
- Updated Last Updated date to 2026-02-18
- Removed duplicate content between original reference sections and new historical entries
- Standardized terminology (project -> workspace per Spec 0112, Shellper capitalization)
- Normalized zero-padding across all spec number references

## Lessons Learned Updates

This project IS the lessons learned documentation update. lessons-learned.md was updated extensively as the primary deliverable:
- Grew from ~38 entries to 366 entries across 11 categories
- All new entries use `[From XXXX]` attribution format
- Deduplicated 9 duplicate entries during refinement
- Normalized zero-padding for all spec number references
- Updated footer to reflect Phase 3: Refinement completion

## Follow-up Items

- Consider building documentation sweep into the MAINTAIN protocol for periodic reconciliation
- Fix porch `--project-id` disambiguation when multiple projects exist in worktree
- The 3 zero-yield specs (0004, 0024, 0119) may gain content if/when they're implemented
