# Spec 422: Documentation Sweep — arch.md and lessons-learned.md

## Problem

`codev/resources/arch.md` and `codev/resources/lessons-learned.md` are incomplete. While arch.md is substantial (2346 lines), it was largely written from the perspective of a few major features and misses many smaller architectural decisions scattered across 115+ specs, 90+ plans, and 88+ reviews. Meanwhile, lessons-learned.md references only ~25 source documents out of 88+ reviews.

Key gaps:
- **arch.md**: Missing coverage of many specs (especially 0003-0007, 0010-0014, 0017, 0020-0021, 0024, 0028, 0030, 0035-0038, 0040, 0049, 0063-0064, 0066-0072, 0082, 0089, 0093, 0119, 0123-0124, 0325, 0350, 0364, 0376, 0386, 0395, 0399, 0403). Architectural decisions from these features were never documented centrally.
- **lessons-learned.md**: Only 25 source references vs 88+ review documents. Most reviews have unextracted lessons.

## Solution

A two-pass approach to bring both documents fully up to date.

### Pass 1: Incremental Extraction

Process every document in `codev/specs/`, `codev/plans/`, and `codev/reviews/` in chronological order (by spec number). For each document:

**For arch.md, extract:**
- New components, modules, or subsystems introduced
- Architectural patterns adopted (and why)
- Technology choices and their rationale
- API designs and interface contracts
- Data flow changes
- Configuration or infrastructure changes
- Security model additions
- Key file references not already documented

**For lessons-learned.md, extract:**
- Debugging insights and root cause analyses
- Process improvements and workflow refinements
- Testing strategies that worked (or didn't)
- Patterns that should be repeated or avoided
- Performance insights
- Security lessons
- UI/UX discoveries
- Multi-agent consultation patterns
- Common failure modes and their solutions

**Extraction rules:**
- Read each source document fully — depth matters, don't skim
- Append new content to the appropriate section in the target doc; use existing sections where possible, create new subsections only when no appropriate section exists
- Use `[From XXXX]` attribution format in lessons-learned.md
- Use `(Spec XXXX)` attribution format in arch.md section headers/descriptions
- "Already adequately captured" means the same point with the same attribution is already present — if a different spec adds a nuance or different perspective on the same topic, extract it
- Not every document will yield extractable content — many specs (especially small bug fixes or minor UI tweaks) may have nothing new for either target doc. That's expected. Don't force additions where none are warranted
- Don't reorganize or deduplicate during this pass — just capture everything

**Processing order:**
Process all document types for each spec number before moving to the next number. For spec N, read:
1. `codev/specs/N-*.md`
2. `codev/plans/N-*.md` (if exists)
3. `codev/reviews/N-*.md` (if exists)

Then move to spec N+1. This ensures full context for each feature before moving on.

**Batching and checkpointing:**
- Process documents in batches of ~20 spec numbers at a time
- Commit intermediate results after each batch with message format: `[Spec 422] Pass 1: extract batch N (specs XXXX-YYYY)`
- This prevents context loss and creates recovery points

### Pass 2: Refinement (Iterative)

Once all documents have been processed, refine both target documents:

**Deduplication:**
- Identify and merge duplicate entries that say the same thing in different words
- Keep the most complete/accurate version of each duplicate
- Preserve all unique attributions even when merging content

**Consistency alignment:**
- Standardize terminology (e.g., "Builder" not "builder agent", "Shellper" not "shepherd")
- Align formatting (heading levels, list styles, code block usage)
- Ensure section organization follows the existing structure of each document
- Fix any cross-references broken by merges

**Consolidation:**
- Group related entries that ended up in different sections during Pass 1
- Merge entries about the same component/topic into cohesive paragraphs
- Remove sections that are now empty after dedup

**Iteration:**
- Re-read the refined document end-to-end
- Maximum 3 refinement passes — stop earlier if a pass produces no changes
- "Meaningful" = changes that improve clarity, remove redundancy, or fix inconsistency

### Scope boundaries

**In scope:**
- All files in `codev/specs/`, `codev/plans/`, `codev/reviews/`
- Updates to `codev/resources/arch.md` and `codev/resources/lessons-learned.md`

**Out of scope:**
- Protocol documents (`codev/protocols/`)
- CLAUDE.md / AGENTS.md updates
- Code changes
- New documentation files

## Notes

- This is a one-off catch-up project — going forward, Spec 395 ensures every SPIR review updates these docs
- Future consideration: build this sweep into the MAINTAIN protocol for periodic reconciliation
- The builder should read each source document fully, not skim — depth matters here
- No code is written in this project — the deliverables are purely documentation updates

## Source Document Inventory

| Directory | Count | Description |
|-----------|-------|-------------|
| `codev/specs/` | ~115 | Feature specifications |
| `codev/plans/` | ~90 | Implementation plans |
| `codev/reviews/` | ~88 | Post-implementation reviews |
| **Total** | **~293** | Source documents to process |

## Acceptance Criteria

- [ ] Every spec, plan, and review document has been read and relevant content extracted
- [ ] arch.md reflects all architectural decisions from the project's history
- [ ] lessons-learned.md captures all generalizable wisdom from reviews
- [ ] No duplicate entries in either document
- [ ] Both documents are internally consistent (terminology, formatting)
- [ ] Refinement passes complete (max 3, or earlier if no changes produced)
- [ ] Attribution is preserved for all entries (spec numbers in arch.md, `[From XXXX]` in lessons-learned)

## Consultation Log

### Iteration 1 (3-way: Gemini, Codex, Claude)

**Gemini**: APPROVE. Notes that batching (20-50 docs at a time) will be needed to avoid context window exhaustion. No blocking issues.

**Codex**: REQUEST_CHANGES. Key issues:
- Ordering conflict between "chronological" and "specs→plans→reviews" — resolved by switching to per-feature ordering (all doc types for spec N before moving to N+1)
- Open-ended refinement stop condition — resolved by capping at 3 passes
- Missing verification/processing criteria — addressed with batching commits that serve as audit trail

**Claude**: COMMENT. Key issues:
- No batching/checkpointing strategy — resolved with batch-of-20 approach and intermediate commits
- No tracking mechanism for completeness — batch commits with spec ranges serve as audit trail
- Unbounded refinement — capped at 3 passes
- Not every doc yields content — added explicit note about zero-yield docs being expected
