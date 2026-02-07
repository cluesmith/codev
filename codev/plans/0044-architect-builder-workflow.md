# Plan: Architect-Builder Workflow Clarity

## Metadata
- **Spec**: [0044-architect-builder-workflow.md](../specs/0044-architect-builder-workflow.md)
- **Status**: draft
- **Created**: 2025-12-09
- **Protocol**: SPIR

## Overview

This plan implements clear documentation of the 7-stage architect-builder workflow, deletes the redundant SPIR-SOLO protocol, and adds the `--type` parameter to the consult tool for stage-specific review prompts.

## Phase 1: Delete SPIR-SOLO Protocol

**Goal**: Remove redundant protocol variant

### Tasks

1. Delete protocol directories:
   - [ ] `rm -rf codev/protocols/spider-solo/`
   - [ ] `rm -rf codev-skeleton/protocols/spider-solo/`
   - [ ] `rm -rf packages/codev/templates/protocols/spider-solo/` (if exists)

2. Delete test file:
   - [ ] `rm tests/11_fresh_spider_solo.bats`

3. Update test helpers:
   - [ ] Remove SPIR-SOLO functions from `tests/helpers/common.bash`
   - [ ] Update `tests/README.md` to remove SPIR-SOLO references

### Exit Criteria
- `grep -r "spider-solo" --include="*.md" --include="*.ts" --include="*.bats"` returns no hits
- All remaining tests pass

## Phase 2: Create Workflow Reference Document

**Goal**: Single source of truth for the 7-stage workflow

### Tasks

1. Create workflow doc for our instance:
   - [ ] Create `codev/resources/architect-builder-workflow.md`
   - [ ] Include 7-stage diagram from spec
   - [ ] Include stage details, review types, communication protocol
   - [ ] Include error recovery and abort paths

2. Create workflow doc for skeleton (template for other projects):
   - [ ] Create `codev-skeleton/resources/architect-builder-workflow.md`
   - [ ] Same content as our instance

### Exit Criteria
- Both workflow docs exist and are identical
- All cross-references resolve

## Phase 3: Create Review Type Prompts

**Goal**: Stage-specific prompts for the consult tool

### Tasks

1. Create review-types directory:
   - [ ] `mkdir -p codev/roles/review-types/`
   <!-- REVIEW(@architect): Is that the right place, in the roles directory? Maybe somewhere else? -->
   - [ ] `mkdir -p codev-skeleton/roles/review-types/`

2. Create prompt files (both locations):
   - [ ] `spec-review.md` - Focus: Is spec complete? Correct? Feasible?
   - [ ] `plan-review.md` - Focus: Is plan feasible? Complete? Follows spec?
   - [ ] `phase-review.md` - Focus: Does code match spec? Tests pass?
   - [ ] `pr-ready.md` - Focus: Final self-check before PR creation
   - [ ] `integration.md` - Focus: Does this fit the broader system?

### Prompt Template Structure
```markdown
# [Review Type] Review Prompt

## Context
You are reviewing [artifact type] for [purpose].

## Focus Areas
1. [Area 1]
2. [Area 2]
...

## Verdict Format
Return your verdict in this format:
---
VERDICT: [APPROVE | REQUEST_CHANGES | COMMENT]
SUMMARY: [One-line summary]
CONFIDENCE: [HIGH | MEDIUM | LOW]
---
KEY_ISSUES: [List or "None"]
```

### Exit Criteria
- 5 prompt files exist in both locations
- Prompts follow consistent format

## Phase 4: Update Consult Tool

**Goal**: Add `--type` parameter to load review-specific prompts

### Tasks

1. Update `codev/bin/consult`:
   - [ ] Add `--type` parameter (optional, choices: spec-review, plan-review, phase-review, pr-ready, integration)
   - [ ] When `--type` provided, load prompt from `codev/roles/review-types/{type}.md`
   - [ ] Append type-specific prompt to the consultant role
   - [ ] If type prompt file not found, warn but continue with default consultant role

2. Update help text:
   - [ ] Document `--type` parameter in `--help` output

### Implementation Notes
```python
# In consult script, after loading consultant role:
if args.type:
    type_prompt_path = f"codev/roles/review-types/{args.type}.md"
    if os.path.exists(type_prompt_path):
        with open(type_prompt_path) as f:
            role = role + "\n\n" + f.read()
    else:
        print(f"Warning: Review type prompt not found: {type_prompt_path}", file=sys.stderr)
```

### Exit Criteria
- `consult --help` shows `--type` parameter
- `consult --model gemini --type spec-review spec 44` works
- `consult --model codex --type integration pr 83` works
- Missing type file produces warning but doesn't fail

## Phase 5: Update Protocol and Role Documentation

**Goal**: All docs reference the new workflow

### Tasks

1. Update SPIR protocol:
   - [ ] Edit `codev/protocols/spir/protocol.md`
   - [ ] Add reference to workflow doc
   - [ ] Replace any "use spider-solo" with "request without consultation"
   - [ ] Update `codev-skeleton/protocols/spir/protocol.md` identically

2. Update role files:
   - [ ] Edit `codev/roles/architect.md` - reference workflow doc, clarify stages 1-5, 7-9
   - [ ] Edit `codev/roles/builder.md` - reference workflow doc, clarify stages 5-8
   - [ ] Update skeleton versions identically

3. Update CLAUDE.md and AGENTS.md:
   - [ ] Remove SPIR-SOLO from protocol list
   - [ ] Update protocol selection guide
   - [ ] Add note about `consult --type` for reviews
   - [ ] Keep both files synchronized

4. Update other docs:
   - [ ] `README.md` - Remove SPIR-SOLO from available protocols
   - [ ] `INSTALL.md` - Remove SPIR-SOLO setup instructions (if any)
   - [ ] `codev/resources/arch.md` - Remove SPIR-SOLO references

5. Update codev-updater agents:
   - [ ] `.claude/agents/codev-updater.md` - Remove SPIR-SOLO references
   - [ ] `codev-skeleton/agents/codev-updater.md` - Remove SPIR-SOLO references
   - [ ] `packages/codev/templates/agents/codev-updater.md` - Remove SPIR-SOLO references

### Exit Criteria
- No SPIR-SOLO references remain
- All docs reference workflow doc where appropriate
<!-- REVIEW(@architect): And the Zen mcp server. -->
- CLAUDE.md and AGENTS.md are identical

## Phase 6: Update Projectlist States Documentation

**Goal**: Document the 7-state lifecycle

### Tasks

1. Update projectlist template:
   - [ ] Edit `codev-skeleton/projectlist.md` (template)
   - [ ] Add state definitions comment block
   - [ ] Document state transitions

2. Update live projectlist:
   - [ ] Scan `codev/projectlist.md` for any SPIR-SOLO references
   - [ ] Update protocol references from "spider-solo" to "spider" with note
   - [ ] Add state definitions comment block to match template

3. Add state documentation to workflow doc:
   - [ ] Include state enum in workflow reference
   - [ ] Document which states are human-gated

### Exit Criteria
- State definitions documented in workflow doc
- Template includes state guidance
- Live projectlist has no SPIR-SOLO references

## Phase 7: Verification and Cleanup

**Goal**: Ensure all changes are correct and complete

### Tasks

1. Run verification greps:
   - [ ] `grep -r "spider-solo"` returns no hits
   - [ ] `grep -ri "zen.*mcp\|mcp.*zen"` returns no hits

2. Run tests:
   - [ ] `./tests/run_tests.sh` passes

3. Add automated tests for consult --type:
   - [ ] Add bats test: `consult --type spec-review spec 44` parses correctly
   - [ ] Add bats test: `consult --type invalid-type` produces warning
   - [ ] Add bats test: verify type prompt file is appended to role

4. Manual verification:
   - [ ] `consult --type spec-review spec 44` works with all 3 models
   - [ ] Workflow doc renders correctly
   - [ ] `af --help` doesn't reference SPIR-SOLO

### Exit Criteria
- All greps clean
- All tests pass
- Manual verification complete

## Files to Create

| File | Location |
|------|----------|
| `architect-builder-workflow.md` | `codev/resources/` |
| `architect-builder-workflow.md` | `codev-skeleton/resources/` |
| `spec-review.md` | `codev/roles/review-types/` |
| `plan-review.md` | `codev/roles/review-types/` |
| `phase-review.md` | `codev/roles/review-types/` |
| `pr-ready.md` | `codev/roles/review-types/` |
| `integration.md` | `codev/roles/review-types/` |
| (same 5 prompts) | `codev-skeleton/roles/review-types/` |

## Files to Delete

| File | Reason |
|------|--------|
| `codev/protocols/spider-solo/` | Redundant protocol |
| `codev-skeleton/protocols/spider-solo/` | Redundant protocol |
| `tests/11_fresh_spider_solo.bats` | Tests deleted protocol |

## Files to Modify

| File | Changes |
|------|---------|
| `codev/bin/consult` | Add `--type` parameter |
| `codev/protocols/spir/protocol.md` | Reference workflow, remove spider-solo mention |
| `codev/roles/architect.md` | Reference workflow doc |
| `codev/roles/builder.md` | Reference workflow doc |
| `CLAUDE.md` | Remove SPIR-SOLO, add consult --type |
| `AGENTS.md` | Same as CLAUDE.md |
| `README.md` | Remove SPIR-SOLO |
| `tests/helpers/common.bash` | Remove SPIR-SOLO helpers |
| `tests/README.md` | Update test descriptions |

## Risks

| Risk | Mitigation |
|------|------------|
| Breaking existing builders mid-flight | No SPIR-SOLO builders currently active (verified) |
| Missing file references | Grep verification in Phase 7 |
| Inconsistent skeleton vs instance | Create both simultaneously, diff to verify |

## Success Metrics

- [ ] Zero SPIR-SOLO references in codebase
- [ ] Zero zen/mcp references in codebase
- [ ] `consult --type` works with all 5 review types
- [ ] All tests pass
- [ ] Workflow doc is single source of truth for stages
