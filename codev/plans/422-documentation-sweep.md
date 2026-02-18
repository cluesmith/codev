# Plan 422: Documentation Sweep — arch.md and lessons-learned.md

## Metadata
- **Specification**: `codev/specs/422-documentation-sweep.md`
- **Created**: 2026-02-18

## Executive Summary

Process ~121 unique spec numbers (with their associated plans and reviews, ~293 documents total) to extract architectural decisions and lessons learned into `arch.md` and `lessons-learned.md`. Uses parallel agent batches for extraction, followed by iterative refinement.

## Success Metrics
- [ ] All 121 spec number groups processed (all specs, plans, reviews read)
- [ ] arch.md updated with all architectural decisions
- [ ] lessons-learned.md updated with all generalizable wisdom
- [ ] No duplicate entries in either document
- [ ] Both documents internally consistent
- [ ] Refinement passes complete (max 7)
- [ ] Attribution preserved throughout

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "extraction_batch_1", "title": "Extraction Batch 1 (specs 0001-0082)"},
    {"id": "extraction_batch_2", "title": "Extraction Batch 2 (specs 0083-0422 + misc)"},
    {"id": "refinement", "title": "Refinement"}
  ]
}
```

## Phase Breakdown

### Phase 1: Extraction Batch 1 (specs 0001-0082)
**Dependencies**: None

#### Objectives
- Extract architectural decisions and lessons from the first 64 spec numbers (0001-0082)
- Populate arch.md and lessons-learned.md with raw extraction content

#### Agent Assignments

Spawn 5 parallel agents, each reading its assigned spec/plan/review documents and writing extraction output to a file. **Each agent must process documents per-feature**: for each spec number, read spec → plan → review before moving to the next number.

| Agent | Spec Numbers | Output File |
|-------|-------------|-------------|
| 1 | 0001, 0002, 0003, 0004, 0005, 0006, 0007, 0008, 0009, 0010, 0011, 0012 | `extraction-0001-0012.md` |
| 2 | 0013, 0014, 0015, 0017, 0019, 0020, 0021, 0022, 0024, 0028, 0029, 0030, 0031 | `extraction-0013-0031.md` |
| 3 | 0032, 0034, 0035, 0036, 0037, 0038, 0039, 0040, 0041, 0043, 0044 | `extraction-0032-0044.md` |
| 4 | 0045, 0046, 0047, 0048, 0049, 0050, 0051, 0052, 0053, 0054, 0055 | `extraction-0045-0055.md` |
| 5 | 0056, 0057, 0058, 0059, 0060, 0061, 0062, 0063, 0064, 0065, 0066, 0067, 0068, 0069, 0070, 0071, 0072, 0073, 0075, 0076, 0078, 0081, 0082 | `extraction-0056-0082.md` |

Each agent's extraction file follows this format:
```markdown
# Extraction: Specs XXXX-YYYY

## arch.md additions

### [Section Name] (Spec XXXX)
[content]

## lessons-learned.md additions

### [Category]
- [From XXXX] [lesson]
```

After all 5 agents complete, merge all extraction files into arch.md and lessons-learned.md at once.

#### Deliverables
- [ ] 5 extraction files generated in `codev/projects/422-documentation-sweep/`
- [ ] All extraction content merged into arch.md
- [ ] All extraction content merged into lessons-learned.md
- [ ] Intermediate commit: `[Spec 422] Pass 1: extract batch 1 (specs 0001-0082)`

#### Acceptance Criteria
- [ ] Every spec/plan/review in the 0001-0082 range has been read
- [ ] Extraction files contain properly attributed content
- [ ] Merge into target docs preserves existing content

#### Rollback Strategy
Git revert the batch commit.

---

### Phase 2: Extraction Batch 2 (specs 0083-0422 + misc)
**Dependencies**: Phase 1

#### Objectives
- Extract architectural decisions and lessons from the remaining ~57 spec numbers
- Complete the raw extraction into both target documents

#### Agent Assignments

Same rules as Phase 1: per-feature processing (spec → plan → review for each number).

| Agent | Spec Numbers | Output File |
|-------|-------------|-------------|
| 1 | 0083, 0085, 0086, 0087, 0089, 0090, 0092, 0093, 0094, 0095, 0096 | `extraction-0083-0096.md` |
| 2 | 0097, 0098, 0099, 0100, 0101, 0102, 0103, 0104, 0105, 0106 | `extraction-0097-0106.md` |
| 3 | 0107, 0108, 0109, 0110, 0111, 0112, 0113, 0115, 0116, 0117, 0118 | `extraction-0107-0118.md` |
| 4 | 0119, 0120, 0121, 0122, 0123, 0124, 0126, 0127, 0325, 0350 | `extraction-0119-0350.md` |
| 5 | 0364, 0376, 386, 395, 399, 403, 422, bugfix-274, 324 | `extraction-misc.md` |

**Naming inconsistencies to note:**
- Specs 386, 395, 399, 403 lack leading-zero padding — agents must look for both `0386-*` and `386-*` patterns
- `0364` (spec) and `364` (plan/review prefix `364-0364-*`) are the same feature — treat as one group
- `324` exists only as a review (`reviews/324-shellper-processes-do-not-survive.md`)
- `bugfix-274` exists only as a review (`reviews/bugfix-274-architect-terminal-should-surv.md`)

Same extraction file format as Phase 1. After all 5 complete, merge into target docs.

#### Deliverables
- [ ] 5 extraction files generated
- [ ] All extraction content merged into arch.md
- [ ] All extraction content merged into lessons-learned.md
- [ ] Intermediate commit: `[Spec 422] Pass 1: extract batch 2 (specs 0083-0422 + misc)`

#### Acceptance Criteria
- [ ] Every remaining spec/plan/review has been read
- [ ] Full document inventory processed (all 121 spec number groups)

#### Rollback Strategy
Git revert the batch commit.

---

### Phase 3: Refinement
**Dependencies**: Phase 2

#### Objectives
- Deduplicate, consolidate, and polish both arch.md and lessons-learned.md
- Achieve consistent terminology, formatting, and organization

#### Process
1. **Deduplication pass**: Identify and merge duplicate entries, keeping the most complete version
2. **Consistency pass**: Standardize terminology and formatting across both docs
3. **Consolidation pass**: Group related entries, merge fragmented sections
4. **Read-through passes**: Re-read end-to-end and fix remaining issues
5. Maximum 7 refinement passes total — stop earlier if a pass produces no changes

#### Deliverables
- [ ] arch.md fully deduplicated and internally consistent
- [ ] lessons-learned.md fully deduplicated and internally consistent
- [ ] Final commit: `[Spec 422] Pass 2: refinement complete`

#### Acceptance Criteria
- [ ] No duplicate entries in either document
- [ ] Consistent terminology throughout
- [ ] Consistent formatting throughout
- [ ] All cross-references valid
- [ ] No empty sections remaining

#### Rollback Strategy
Git revert the refinement commit.

## Agent Prompt Template

Each extraction agent receives a prompt like:

```
Read all spec, plan, and review documents for the following spec numbers: [LIST].

For each spec number, process in order: spec first, then plan, then review.
Look for files matching these patterns:
- codev/specs/XXXX-*.md
- codev/plans/XXXX-*.md
- codev/reviews/XXXX-*.md
Note: some spec numbers lack zero-padding (e.g., "386" not "0386"). Check both patterns.

For each document, extract:
- Architectural decisions, patterns, components → format for arch.md
- Lessons learned, debugging insights, process improvements → format for lessons-learned.md

Use these attribution formats:
- arch.md: "(Spec XXXX)" in descriptions
- lessons-learned.md: "[From XXXX]" prefix

Skip content that adds nothing new. Not every doc will have extractable content.
Read each document fully — depth matters, don't skim.

Output a single markdown file with two sections:
## arch.md additions
## lessons-learned.md additions
```

## Merge Ordering

When merging extraction files from a batch of 5 agents into the target documents, merge in spec-number order (Agent 1 first, then Agent 2, etc.) to maintain chronological consistency. Append new content to the appropriate existing section in each target document.

## Risk Analysis

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Agent context overflow on large docs | M | L | Agents handle ~12 specs each, well within limits |
| Extraction quality varies across agents | M | M | Merge step reviews all outputs; refinement phase catches issues |
| Excessive arch.md growth | L | M | Refinement phase deduplicates and consolidates |
| Naming inconsistency causes missed files | M | M | Explicit spec number lists + note about non-padded names |
| 0364/364 double-processing | L | L | Documented as same feature; Agent 5 Batch 2 handles both |

## Validation Checkpoints
1. **After Phase 1**: Verify extraction files are well-formed, merged content is attributed
2. **After Phase 2**: Verify all 121 spec groups are covered
3. **After Phase 3**: Final quality check — no dupes, consistent formatting, all attributions present

## Notes
- This is documentation-only work — no code, no tests, no infrastructure changes
- The agent prompt template will be refined during implementation based on actual extraction quality
- Extraction files are intermediate artifacts stored in `codev/projects/422-documentation-sweep/` and not committed to the repo

## Consultation Log

### Iteration 1 (3-way: Gemini, Codex, Claude)

**Gemini**: APPROVE. Plan is well-aligned with spec, batching covers full range. No blocking issues.

**Codex**: REQUEST_CHANGES. Key issues:
- Phase titles conflicted with actual ranges — fixed (now "0001-0082" and "0083-0422 + misc")
- Per-spec ordering (spec → plan → review) not enforced in agent instructions — added to agent assignments and prompt template
- Coverage gaps alleged for 0128-0324 — false alarm, those specs don't exist (numbering is sparse)

**Claude**: COMMENT. Key issues:
- Agent assignments used ranges instead of explicit lists — replaced with exact spec number lists per agent
- Non-zero-padded naming (386, 395, 399, 403) and bugfix-274 needed explicit callouts — added naming inconsistency notes to Phase 2
- 0364/364 collision documented — grouped under single agent with explanation
- No merge ordering — added Merge Ordering section (chronological by agent/spec number)
