# Review: Spec 0044 - Architect-Builder Workflow

## Summary

This spec consolidated and documented the 7-stage architect-builder workflow, eliminated the redundant SPIDER-SOLO protocol, and added review-type prompts to the consult tool.

## What Was Delivered

### 1. SPIDER-SOLO Protocol Removed
- Deleted `codev/protocols/spider-solo/` and `codev-skeleton/protocols/spider-solo/`
- Removed from test files (deleted `11_fresh_spider_solo.bats`, updated helpers)
- Updated all documentation to remove SPIDER-SOLO references
- Added "without consultation" option to SPIDER for the same use case

### 2. Workflow Reference Document Created
- New file: `codev/resources/workflow-reference.md` (and skeleton version)
- Documents the 7-stage lifecycle: conceived → specified → planned → implementing → implemented → committed → integrated
- Clearly identifies human approval gates
- Provides quick reference for common commands

### 3. Review Type Prompts Created
Five new prompt files in `codev/roles/review-types/`:
- `spec-review.md` - For reviewing specifications at conceived stage
- `plan-review.md` - For reviewing plans at specified stage
- `impl-review.md` - For reviewing implementation during implementing stage
- `pr-ready.md` - For final self-check before creating PR
- `integration-review.md` - For architect's integration review

### 4. Consult Tool Updated
- Added `--type` parameter to CLI (`-t, --type <type>`)
- When `--type` is provided, loads prompt from `codev/roles/review-types/{type}.md`
- Appends type-specific prompt to the consultant role
- Validates type against allowed values, provides helpful error on invalid input
- Missing type file produces warning but doesn't fail

### 5. Documentation Updates
- Added workflow reference links to SPIDER protocol, architect/builder roles
- Updated CLAUDE.md and AGENTS.md with Review Types section
- Updated projectlist template with workflow reference link
- Removed Zen MCP references (replaced with consult CLI checks)

## Lessons Learned

### What Worked Well

1. **Phased approach**: Breaking the work into distinct phases made progress visible and commit messages meaningful.

2. **Pattern consistency**: Using the same structure for all five review type prompts made them easy to create and maintain.

3. **Test-first verification**: Running greps to find remaining references before committing caught issues early.

### What Could Be Improved

1. **MCP test helper complexity**: The `is_mcp_available` function needed multiple iterations to handle all cases (present, absent, no command). Consider simplifying the mock approach.

2. **Documentation synchronization burden**: Keeping CLAUDE.md, AGENTS.md, and skeleton versions in sync is error-prone. A single source might be better.

### Technical Decisions

1. **Review types as separate files**: Chose separate markdown files over inline strings for maintainability and to allow user customization.

2. **Appending type prompt to consultant role**: Rather than replacing the role, we append the type-specific prompt. This preserves the base consultant personality while adding specialized focus.

3. **Validation in CLI layer**: The `--type` parameter is validated at the CLI level with a clear error message listing valid types.

## Test Coverage

All 73 tests pass:
- Framework tests: OK
- SPIDER protocol tests: OK
- CLAUDE.md preservation tests: OK
- Claude isolation tests: OK (some skipped due to missing timeout utility)
- Codev updater tests: OK
- MCP mock helper tests: Fixed and passing

## Files Changed

### Deleted
- `codev/protocols/spider-solo/` (directory)
- `codev-skeleton/protocols/spider-solo/` (directory)
- `tests/11_fresh_spider_solo.bats`

### Created
- `codev/resources/workflow-reference.md`
- `codev-skeleton/resources/workflow-reference.md`
- `codev/roles/review-types/spec-review.md`
- `codev/roles/review-types/plan-review.md`
- `codev/roles/review-types/impl-review.md`
- `codev/roles/review-types/pr-ready.md`
- `codev/roles/review-types/integration-review.md`
- (Same files in codev-skeleton)
- `codev/reviews/0044-architect-builder-workflow.md` (this file)

### Modified
- `packages/codev/src/cli.ts` - Added --type option
- `packages/codev/src/commands/consult/index.ts` - Added review type loading
- `CLAUDE.md` and `AGENTS.md` - Added Review Types section
- `codev/protocols/spider/protocol.md` - Added workflow reference, updated prerequisites
- `codev/roles/architect.md` and `builder.md` - Added workflow reference
- `codev/projectlist.md` and template - Added workflow reference
- `tests/helpers/mock_mcp.bash` - Fixed is_mcp_available function
- `tests/10_fresh_spider.bats` - Removed Zen MCP references
- Various other doc files - Removed SPIDER-SOLO references

## Verdict

Spec requirements fully met. The 7-stage workflow is now clearly documented, SPIDER-SOLO is removed, and the consult tool supports stage-specific review prompts.
