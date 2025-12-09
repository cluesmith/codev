# TICK Review: Consolidate Consult to TypeScript Only

## Metadata
- **ID**: 0039-tick-001
- **Protocol**: TICK
- **Date**: 2025-12-09
- **Specification**: codev/specs/0039-codev-cli.md
- **Plan**: codev/plans/0039-codev-cli.md
- **Status**: completed

## Implementation Summary

This TICK amendment consolidates the `consult` tool to TypeScript only by:
1. Porting Codex improvements (from Spec 0043) to the TypeScript implementation
2. Deleting the Python `codev/bin/consult` script entirely

The primary goals were eliminating drift between two implementations and removing the Python/uv dependency from the toolchain.

## Success Criteria Status
- [x] TypeScript consult has Codex `experimental_instructions_file` approach
- [x] TypeScript consult has `model_reasoning_effort=low` tuning
- [x] Python `codev/bin/consult` is deleted
- [x] All existing `consult` invocations work via TypeScript version
- [x] Tests updated/passing

## Files Changed

### Deleted
- `codev/bin/consult` (1487 lines) - Python implementation removed

### Modified
- `packages/codev/src/commands/consult/index.ts` - Updated Codex handling to use:
  - `experimental_instructions_file` config flag instead of `CODEX_SYSTEM_MESSAGE` env var
  - `model_reasoning_effort=low` for faster responses
  - Proper temp file creation and cleanup matching Gemini's approach

- `packages/codev/src/__tests__/consult.test.ts` - Added tests documenting the new Codex configuration approach

## Deviations from Plan

None. Plan was followed exactly:
1. Port Codex improvements to TypeScript
2. Delete Python implementation
3. Update tests

## Testing Results

### Automated Tests
- **Unit Tests**: 164 passed (16 consult-specific tests)
- **Build**: TypeScript compilation successful

### E2E Tests (existing)
The e2e tests in `tests/e2e/consult.bats` already validate:
- `experimental_instructions_file` is used (lines 114-121)
- `model_reasoning_effort=low` is used (lines 123-129)
- Temp file cleanup works (lines 131-147)

## Challenges Encountered

1. **Relative path handling in worktree**
   - **Solution**: Used absolute paths when staging files for commit

No significant technical challenges - the Python implementation was well-documented and the TypeScript port was straightforward.

## Lessons Learned

### What Went Well
- The Python implementation had comprehensive comments documenting why each approach was chosen
- E2E tests already existed for the Codex configuration, validating the port
- Clean separation of model-specific logic made the update isolated

### What Could Improve
- Earlier consolidation would have prevented the drift that necessitated this TICK
- Could add integration tests that actually invoke the CLIs (with mocks) to verify command construction

## Multi-Agent Consultation

**Models Consulted**: Gemini Pro, GPT-5 Codex
**Date**: 2025-12-09
**Verdict**: Both APPROVE

### Key Feedback

**Gemini Pro:**
- Implementation correctly handles Codex logic with `experimental_instructions_file` and `model_reasoning_effort=low`
- Proper error handling for missing roles, tools, and process execution
- Clean path handling and environment variable management
- Correctly handles `GOOGLE_API_KEY` vs `GEMINI_API_KEY` conflicts
- Properly pads spec/plan numbers and cleans up temp files

**GPT-5 Codex:**
- TypeScript implementation correctly builds Codex CLI command with `-c experimental_instructions_file=<tmp role>` and `-c model_reasoning_effort=low` before `--full-auto`
- Process management and logging remain solid - spawn with inherited stdio, failures propagate via rejected promises
- Runtime entry points are consistent after deleting Python shim
- No risk of Python/TypeScript implementations drifting apart

### Issues Identified

**Minor (Non-blocking):**
- `MODEL_CONFIGS` entry for `codex` defines `args: ['exec', '--full-auto']`, but these are ignored in favor of hardcoded command construction. This is acceptable but makes the config object slightly misleading.

### Recommendations

- Consider a targeted unit test that spies on `spawn` and asserts the Codex arguments include both `experimental_instructions_file` and `model_reasoning_effort=low`
- Current tests document the expectation but don't fail if the command builder regresses

## TICK Protocol Feedback
- **Autonomous execution**: Worked well - clear requirements, isolated scope
- **Single-phase approach**: Appropriate - straightforward port with deletion
- **Speed vs quality trade-off**: Balanced - took time to verify all tests pass
- **End-only consultation**: Appropriate for this scope

## Follow-Up Actions
- [x] Update CLAUDE.md/AGENTS.md documentation to remove Python/typer dependency mentions
- [ ] Consider adding more integration tests for command construction

## Conclusion

TICK was appropriate for this task. The amendment scope was well-defined (port one model's configuration, delete Python file) and the existing test infrastructure validated correctness. Total lines changed: -1458 (net reduction from removing Python file).
