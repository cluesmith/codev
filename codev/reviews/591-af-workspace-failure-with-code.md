# Review: Agent Harness Abstraction

## Summary

Implemented an extensible agent harness system that replaces hardcoded Claude-specific `--append-system-prompt` flags with per-harness role injection. Built-in providers for Claude, Codex, and Gemini. Custom harness definitions configurable in `.codev/config.json`. Fixes GitHub issue #591 where `afx workspace start` fails with Codex.

## Spec Compliance

- [x] `afx workspace start` does not crash with `architect: "codex"` — role injected via `model_instructions_file`
- [x] `afx spawn` does not crash with `builder: "codex"`
- [x] Existing Claude-based workflows unchanged (no regression)
- [x] All existing tests pass (updated as needed)
- [x] Explicit `architectHarness`/`builderHarness` config resolves to built-in or custom providers
- [x] Gemini support via `GEMINI_SYSTEM_MD` env var
- [x] Custom harness definitions with template variable expansion (`${ROLE_FILE}`, `${ROLE_CONTENT}`)
- [x] Unknown harness names produce clear error and fail to launch
- [x] Deprecated `experimental_instructions_file` → `model_instructions_file` in consult

## Deviations from Plan

- **Phase 2**: Added `shellEscapeSingleQuote()` utility (not in original plan) — identified during Codex review as necessary for safe shell quoting in script fragments and env exports. Paths containing single quotes (e.g., `/Users/O'Neil/...`) would otherwise break generated bash scripts.
- **Phase 2**: Changed architect error message from "install claude" to generic "Check .codev/config.json shell.architect setting" — identified during Codex review.
- **Phase 3**: Added `workspaceRoot` parameter to `buildWorktreeLaunchScript()` — needed for harness resolution from config. Optional parameter, backward compatible.

## Lessons Learned

### What Went Well

- The forge/consult pattern was a good model for extensibility — the harness provider abstraction follows the same shape
- Splitting `buildRoleInjection` (Node spawn) from `buildScriptRoleInjection` (bash scripts) cleanly handles the two distinct integration patterns
- 3-way consultation caught real issues at every phase (env value validation, shell quoting, error message, call-site test coverage)

### Challenges Encountered

- **Gemini consultation reliability**: Gemini CLI frequently failed to produce verdicts, requiring re-runs. Appears to be an issue with the Gemini CLI's agent recursion prevention when reviewing complex codebases.
- **ESM module mocking in tests**: `vi.doMock` with dynamic imports didn't work as expected for changing mock behavior per-test. Solved by using shared mock functions with `mockReturnValue()` per-test instead.

### What Would Be Done Differently

- Would have included `shellEscapeSingleQuote()` in the original plan — shell quoting for generated scripts is a predictable need
- Would have tested call-site functions directly from the start in Phase 3 rather than testing providers in isolation (which overlapped with Phase 1 unit tests)

## Technical Debt

- `architect.ts` uses `spawn({ shell: true })` which means multiline role content passed as args may have escaping issues. This is a pre-existing issue, not introduced by this change. The harness abstraction doesn't make it worse (Claude passes content directly, Codex/Gemini use file paths).

## Consultation Feedback

### Specify Phase (Round 1)

#### Claude
- **Concern**: Codex `-c experimental_instructions_file` may only work via SDK, not CLI
  - **Addressed**: Verified via CLI testing — works, but deprecated. Updated to `model_instructions_file`.
- **Concern**: `--dangerously-skip-permissions` and equivalent flags not addressed
  - **N/A**: These are user-configured, not hardcoded in source.

#### Codex
- **Concern**: Generic fallback for interactive modes underspecified
  - **Addressed**: Changed to explicit config, no auto-detection, no fallback.
- **Concern**: Shell detection by substring too ambiguous
  - **Addressed**: Removed auto-detection per architect review.

#### Gemini
- **Concern**: `buildRoleArgs` array escaping breaks Claude via Node spawn
  - **Addressed**: Split into two APIs — `buildRoleInjection` (content) and `buildScriptRoleInjection` (file path).
- **Concern**: `architect.ts` doesn't write role to disk
  - **Addressed**: Added file write in architect.ts.

### Plan Phase (Round 1)

#### Claude: APPROVE — No concerns
#### Gemini: APPROVE — No concerns
#### Codex
- **Concern**: Missing `lib/config.ts` updates for custom harness validation
  - **Addressed**: Added `CodevConfig` updates and `validateHarnessConfig()` at load time.
- **Concern**: Missing `codex-sdk.test.ts` in deliverables
  - **Addressed**: Added to Phase 2 deliverables.

### Phase 1: harness-module (Implementation Round 1)

#### Claude: APPROVE
#### Gemini: APPROVE
#### Codex
- **Concern**: `roleEnv`/`roleScriptEnv` entries not validated as strings
  - **Addressed**: Added per-entry string validation with descriptive error messages.

### Phase 2: call-site-refactor (Implementation Round 1)

#### Claude: APPROVE
#### Gemini: APPROVE
#### Codex
- **Concern**: Unsafe shell quoting in script env exports
  - **Addressed**: Added `shellEscapeSingleQuote()` to all script fragments and env exports.
- **Concern**: Claude-specific "install claude" error message
  - **Addressed**: Changed to generic message.

### Phase 3: integration-tests (Implementation Round 1)

#### Gemini: APPROVE
#### Claude: COMMENT
- **Concern**: Scenario 7 is a no-op, Scenario 8 tests providers not call sites
  - **Addressed**: Rewrote with real call-site integration tests using dynamic imports and per-test mock configuration.
#### Codex
- **Concern**: Tests don't exercise real integration points
  - **Addressed**: Same fix as Claude.

## Architecture Updates

New module added: `packages/codev/src/agent-farm/utils/harness.ts` — agent harness provider abstraction. Provides `HarnessProvider` interface, built-in providers (Claude, Codex, Gemini), custom harness config parsing with template variable expansion, and resolution logic. Integrated at all 5 call sites that previously hardcoded `--append-system-prompt`. Config extended with `shell.architectHarness`, `shell.builderHarness`, and `harness` section in both `UserConfig` and `CodevConfig`.

## Lessons Learned Updates

No generalizable lessons beyond what's documented in the existing lessons-learned.md entries about extensibility patterns and consultation value.

## Flaky Tests

No flaky tests encountered.

## Follow-up Items

- Consider a standalone `harness` CLI command for testing harness configs without spawning a full workspace
- Consider addressing the pre-existing `shell: true` spawn issue in `architect.ts` where multiline content in args may have escaping problems
