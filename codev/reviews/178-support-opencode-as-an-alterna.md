# Review: Support OpenCode as an Alternative Agent Shell

## Summary

Added first-class OpenCode support as an alternative agent shell in Codev's agent farm. OpenCode (140K+ GitHub stars) supports 75+ LLM providers, giving users flexibility beyond Claude Code. The implementation extends the existing harness abstraction layer with a new built-in `OPENCODE_HARNESS` provider, auto-detection, JSON-merge-based role injection via `opencode.json`, `codev doctor` validation, and documentation.

**Files changed**: 4 source files, 2 test files, 1 documentation file
**Net LOC**: ~150 lines of production code, ~100 lines of tests

## Spec Compliance

- [x] `opencode` auto-detected by `detectHarnessFromCommand()` when command basename contains "opencode"
- [x] Built-in `OPENCODE_HARNESS` registered in `BUILTIN_HARNESSES`
- [x] Role injection via `opencode.json` `instructions` field referencing `.builder-role.md`
- [x] `codev doctor` checks for `opencode` binary with `VERIFY_CONFIGS` entry
- [x] Configuration example documented with correct `shell.builder` format
- [x] Documentation covers required `opencode.json` tool permissions for unattended execution
- [x] Known capability differences documented (builder-only, permission model, `run` subcommand)
- [x] All existing tests pass (2331 tests, 0 failures)
- [x] Unit tests cover harness provider, auto-detection, worktree file writing/merging

## Deviations from Plan

- **Phase 1**: `buildRoleInjection()` throws for architect use (as planned). No deviation.
- **Phase 2**: Extracted `writeWorktreeFiles()` as a helper function rather than inlining (minor improvement over plan).
- **Phase 3**: Used dynamic import for `loadConfig` in doctor.ts architect warning to handle non-project contexts gracefully. Type casting is heavier than ideal but functional inside try/catch.

## Lessons Learned

### What Went Well
- The harness abstraction was perfectly suited for this extension -- adding a new provider followed an established, well-tested pattern
- The 3-way consultation process caught real design issues early (opencode.json overwrite, architect silent failure, wrong function name)
- The spec phase correctly identified that OpenCode lacks `--system-prompt` CLI flag, which shaped the entire design

### Challenges Encountered
- **Gemini consultation failures**: Gemini repeatedly failed to produce review output during Phase 2 consultation (3 attempts). Eventually resolved on 4th attempt. Root cause unclear -- likely a transient Gemini service issue.
- **OpenCode lacks CLI-based role injection**: Unlike Claude (`--append-system-prompt`), Codex (`-c model_instructions_file=`), and Gemini (`GEMINI_SYSTEM_MD`), OpenCode has no CLI flag or env var for system prompt injection. Required introducing `getWorktreeFiles?()` interface extension.

### What Would Be Done Differently
- Would verify OpenCode's exact CLI capabilities earlier in the spec phase rather than leaving it as a "Critical" open question that had to be resolved mid-spec

### Methodology Improvements
- The SPIR consultation process is highly effective for catching design issues before implementation. All three reviewers consistently identified the same core issues (opencode.json overwrite, architect failure) independently.

## Technical Debt
- The type casting in doctor.ts architect warning (lines 599-601) could be cleaner if `loadConfig()` returned a fully typed config interface. Minor -- safe inside try/catch.
- No automated tests for doctor OpenCode output (plan specified manual testing for Phase 3).

## Consultation Feedback

### Specify Phase (Round 1)

#### Gemini (REQUEST_CHANGES)
- **Concern**: Role injection mechanism is an unresolved critical blocker
  - **Addressed**: Resolved by using `opencode.json` `instructions` field
- **Concern**: Interface constraint violation if AGENTS.md append is needed
  - **Addressed**: Dropped "no interface changes" constraint; added optional `getWorktreeFiles?()` method
- **Concern**: Config contradiction (`opencode` vs `opencode run`)
  - **Addressed**: Standardized on `"builder": "opencode run"`
- **Concern**: Doctor.ts architecture mismatch (static vs config-aware)
  - **Addressed**: Added to static list + VERIFY_CONFIGS entry

#### Codex (REQUEST_CHANGES)
- **Concern**: Role injection underspecified, suggests config-based approach
  - **Addressed**: Chose `opencode.json` instructions field approach
- **Concern**: Config examples use wrong format
  - **Addressed**: Fixed all examples to use `shell.builder` nested format

#### Claude (COMMENT)
- **Concern**: Role injection unresolved, suggests `preRun` hook
  - **Addressed**: Used `getWorktreeFiles?()` optional method instead
- **Concern**: Unattended execution needs to be a requirement
  - **Addressed**: Elevated to documented requirement with configuration examples

### Plan Phase (Round 1)

#### Gemini (REQUEST_CHANGES)
- **Concern**: Architect role silent failure
  - **Addressed**: `buildRoleInjection()` throws with clear error message
- **Concern**: Missing doctor warning for opencode-as-architect
  - **Addressed**: Added architect-shell warning in doctor
- **Concern**: Doctor verification shows misleading "unknown model" skip
  - **Addressed**: Added `VERIFY_CONFIGS` entry

#### Codex (REQUEST_CHANGES)
- **Concern**: opencode.json overwrite risk destroys user permissions
  - **Addressed**: Implemented JSON read/merge/write strategy
- **Concern**: Wrong function name (`buildBuilderStartScript`)
  - **Addressed**: Corrected to `buildWorktreeLaunchScript()`
- **Concern**: Need more integration tests
  - **Addressed**: Added tests for script shape and merge behavior

#### Claude (COMMENT)
- **Concern**: opencode.json overwrite can blow away user permissions
  - **Addressed**: Same merge strategy as Codex concern
- **Concern**: Wrong function name
  - **Addressed**: Same correction as Codex concern

### Implementation Phase 1 — harness_provider (Round 1)
- **Gemini**: APPROVE — no concerns
- **Codex**: APPROVE — no concerns
- **Claude**: APPROVE — no concerns

### Implementation Phase 2 — spawn_integration (Round 1)
- **Gemini**: APPROVE (on retry — first attempt produced empty output)
- **Codex**: APPROVE — no concerns
- **Claude**: APPROVE — minor suggestion to add `logger.warn()` in JSON parse catch block (non-blocking)

### Implementation Phase 3 — doctor_and_docs (Round 1)
- **Gemini**: APPROVE — no concerns
- **Codex**: COMMENT — minor note about type casting and missing doctor-specific tests (non-blocking)
- **Claude**: APPROVE — minor note about type casting in architect warning code (non-blocking)

## Architecture Updates

No architecture updates needed. This feature extends the existing harness abstraction layer (`packages/codev/src/agent-farm/utils/harness.ts`) with one new built-in provider following the established Claude/Codex/Gemini pattern. The new optional `getWorktreeFiles?()` method on `HarnessProvider` is a backward-compatible extension to the existing interface, not a new subsystem.

## Lessons Learned Updates

No lessons learned updates needed. The implementation was straightforward, following established patterns. The key insight (OpenCode's file-based config vs CLI-based role injection) is specific to this feature and documented in the spec.

## Flaky Tests

No flaky tests encountered.

## Follow-up Items
- Consider adding `logger.warn()` to the JSON parse catch block in `writeWorktreeFiles()` for better diagnostics
- Could improve type safety in doctor.ts architect warning by using a typed config interface
- Future: investigate OpenCode's ACP (Agent Client Protocol) mode for potentially better integration than PTY-based approach
