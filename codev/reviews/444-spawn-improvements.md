# Review: af spawn Improvements

## Summary

Implemented two improvements to `af spawn` for SPIR/ASPIR protocols:
1. **No-spec spawn**: `af spawn N --protocol aspir` now works without a pre-existing spec file when the protocol's `input.required` is `false`. The project name is derived from the GitHub issue title.
2. **GitHub-based naming**: All protocols now prefer the GitHub issue title (via `slugify()`) for worktree/branch/porch naming, falling back to the spec filename when GitHub is unavailable.

A key insight during implementation was the need to decouple project naming (worktree, branch, porch — from GitHub issue title) from file references (spec/plan paths in the builder prompt — from actual files on disk). All three reviewers caught this bug in the Phase 2 review.

## Spec Compliance
- [x] `af spawn 444 --protocol aspir` succeeds without a spec file
- [x] `af spawn 444 --protocol spir` succeeds without a spec file
- [x] When no spec file exists, worktree/branch/porch use GitHub issue title slug
- [x] When spec file exists, porch behavior unchanged (spec used as pre-approved artifact)
- [x] Naming uses GitHub issue title even when spec file exists (intentional change)
- [x] TICK still requires spec file (via options.amends guard)
- [x] All existing tests pass
- [x] 17 new unit tests cover the no-spec spawn path
- [x] `spec_missing: boolean` flag added to TemplateContext

## Deviations from Plan

- **Phase 2 co-delivered in Phase 1**: The GitHub-based naming for existing specs was naturally implemented alongside the no-spec spawn logic. The code paths were cleaner as a unified change. Phase 2 review focused on fixing the file reference bug.
- **`actualSpecName` introduced**: Not in the original plan, but necessary to decouple naming from file references (caught by 3-way review).

## Lessons Learned

### What Went Well
- `input.required` field already existed in all protocol.json files — no schema changes needed
- `slugify()` and `fetchGitHubIssue` utilities already existed — minimal new code
- 3-way consultation caught the naming/file-reference decoupling bug in Phase 2

### Challenges Encountered
- **Naming vs file references**: When GitHub title differs from spec filename, the builder prompt pointed to non-existent files. All three reviewers caught this. Fixed by introducing `actualSpecName` for file paths.

### What Would Be Done Differently
- Plan the naming/file-reference decoupling upfront rather than discovering it during review

## Technical Debt
- `slugify()` can produce trailing hyphens after truncation at 30 chars (e.g., "af-spawn-should-not-require-a-"). Not blocking but could be improved.
- `spec_missing` flag is in TemplateContext but no template currently reads it. Available for future use.

## Consultation Feedback

### Specify Phase (Round 1)

#### Gemini
- No concerns raised (APPROVE)

#### Codex
- **Concern**: Naming precedence contradiction between "behavior unchanged" and "GitHub title preferred"
  - **Addressed**: Updated spec to clarify GitHub title is preferred even when spec exists

#### Claude
- **Concern**: Test scenario 3 contradicts Desired State §2; TICK also has `input.required: false`
  - **Addressed**: Split test scenario 3 into two; acknowledged TICK's `input.required` in constraints

### Plan Phase (Round 1)

#### Gemini
- No concerns raised (APPROVE)

#### Codex
- **Concern**: Missing prompt template update for `spec_missing`; missing doc scan step
  - **Addressed**: Added `spec_missing` to template context; doc scan handled during implementation

#### Claude
- **Concern**: TICK bypass guard missing from pseudocode (`&& !options.amends`)
  - **Addressed**: Added guard to pseudocode and added TICK test case

### Phase 1: no-spec-spawn (Round 1)

#### Gemini
- **Concern**: Missing `spec_missing: true` in template context
  - **Addressed**: Added to TemplateContext interface and spawn.ts

#### Codex
- **Concern**: Missing `spec_missing` flag; builder prompt doesn't indicate no spec
  - **Addressed**: Added flag; template path already points to expected location

#### Claude
- No concerns raised (APPROVE). Noted Phase 2 scope bleed as acceptable.

### Phase 2: github-naming (Round 1)

#### Gemini
- **Concern**: specRelPath/planRelPath use GitHub-derived name instead of actual files
  - **Addressed**: Introduced `actualSpecName` for file references

#### Codex
- **Concern**: Same file reference bug
  - **Addressed**: Same fix

#### Claude
- **Concern**: Same file reference bug with detailed trace-through
  - **Addressed**: Same fix

### Phase 3: tests (Round 1)

#### Gemini
- No concerns raised (APPROVE)

#### Codex
- **Concern**: Tests re-implement logic instead of testing spawnSpec(); missing failure paths
  - **Rebutted**: Re-implemented logic is the established pattern in this test file. Added two missing failure path tests.

#### Claude
- No concerns raised (APPROVE)

## Architecture Updates

No architecture updates needed. This change modifies the spawn command flow but doesn't introduce new subsystems, data flows, or architectural patterns. The `spawnSpec()` function's internal logic changed but its external interface and position in the architecture remain the same.

## Lessons Learned Updates

No lessons learned updates needed. The naming-vs-file-reference decoupling insight is specific to this implementation and already documented above. The existing lessons about 3-way consultation catching bugs (0045, 0065) already cover the general principle.

## Flaky Tests

No flaky tests encountered.

## Follow-up Items
- Consider stripping trailing hyphens in `slugify()` after truncation
- Consider adding `spec_missing` conditional messaging to builder-prompt templates
