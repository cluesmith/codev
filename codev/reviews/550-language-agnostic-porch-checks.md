# Review: Language-Agnostic Porch Check Commands (Spec 550)

## Summary

Implemented runtime check overrides via `porch.checks` in `af-config.json` (Spec Approach 1). Non-Node.js projects can now override or skip any porch check without editing `protocol.json`.

## Spec vs Implementation Comparison

### Spec Goals (all satisfied)

- [x] Non-Node.js projects can run `porch check`, `porch done`, `porch approve` with project-appropriate commands
- [x] Override configuration survives `codev update` (stored in af-config.json, not protocol.json)
- [x] Existing projects with no overrides see identical behavior (backward compatible)
- [x] Porch emits a visible yellow log line when a check command is overridden or skipped
- [x] `skip: true` can disable individual checks
- [x] `phase_completion` checks are also overridable
- [x] All existing tests continue to pass (203 porch tests)
- [x] New tests cover override merging, skip behavior, and precedence
- [x] Documentation updated with examples for Python, Rust, and Go projects

### Deviations from Plan

None. All four phases completed as specified.

**One additional fix (in scope):** `normalizeProtocol()` in `protocol.ts` previously silently dropped `phase_completion` from the parsed Protocol object, causing `getPhaseCompletionChecks()` to always return `{}`. Fixed this as part of Phase 2 since it's a prerequisite for `phase_completion` overrides to work.

## Files Changed

**New files:**
- `packages/codev/src/commands/porch/config.ts` — Self-contained `loadCheckOverrides()` reader
- `packages/codev/src/commands/porch/__tests__/config.test.ts` — 11 unit tests
- `packages/codev/src/commands/porch/__tests__/protocol-overrides.test.ts` — 17 unit tests

**Modified files:**
- `packages/codev/src/commands/porch/types.ts` — Added `CheckOverride` interface and `CheckOverrides` type alias
- `packages/codev/src/commands/porch/protocol.ts` — Updated `getPhaseChecks()` and `getPhaseCompletionChecks()`, fixed `normalizeProtocol()` to extract `phase_completion`
- `packages/codev/src/commands/porch/index.ts` — Wired overrides into `check()`, `done()`, `approve()`
- `packages/codev/src/commands/porch/next.ts` — Wired overrides into `handleBuildVerify()`
- `codev/resources/commands/agent-farm.md` — Documentation for `porch.checks`

## Architecture Notes

**Self-contained config reader:** `config.ts` reads only the `porch.*` section of `af-config.json` without importing from `agent-farm/utils/config.ts`. This keeps porch independent of the af dependency tree (no import cycles). The two readers don't overlap in what they read.

**Flat override map:** Check names are globally unique within a protocol, so a flat `Record<string, CheckOverride>` is sufficient. Phase-nested overrides can be added later if needed without breaking existing configs.

**Unknown name warning:** `getPhaseChecks()` emits a yellow stderr warning for override keys that don't match any check in the current phase. This catches typos without blocking execution.

**phase_completion semantics:** Skipping a `phase_completion` check removes that gating condition; it does NOT auto-pass. An empty result means no gating conditions (all plan phases can complete immediately after build).

## Test Coverage

| Test file | Scenarios |
|-----------|-----------|
| `config.test.ts` | no file, no porch key, no checks key, valid overrides, malformed JSON, non-object values, cwd field, extra keys |
| `protocol-overrides.test.ts` | defaults (no override), command override, cwd override, skip, command+cwd, mixed, empty phase, unknown phase, unknown override name |
| `protocol-overrides.test.ts` (completion) | defaults, command override, skip (condition removed), all-skipped, mixed, unknown-name warning |
| `protocol-overrides.test.ts` (loading) | phase_completion loaded from JSON, absent phase_completion |

205 porch tests pass (203 pre-existing + 2 new from consultation fixes: Array.isArray guard test + getPhaseCompletionChecks unknown-name warning test).

## Lessons Learned

1. **Pre-existing bug discovered:** `normalizeProtocol()` was not extracting `phase_completion` from the protocol JSON. This was a latent bug unrelated to this feature but needed fixing for overrides to work on phase_completion checks. Always read the full data flow before implementing overrides.

2. **Optional parameters are the cleanest backward-compat story:** Adding `overrides?: CheckOverrides` as an optional parameter to `getPhaseChecks()` and `getPhaseCompletionChecks()` required zero changes to existing callers that don't need overrides. TypeScript enforced this.

3. **Self-contained readers prevent dependency hell:** Resisting the temptation to reuse agent-farm's config module was the right call. The two modules have different concerns and different parts of the config file. A shared "parse af-config.json once" optimization can be done later without breaking the override semantics.

## Consultation Feedback

### Phase 1 (config_and_types) — Round 1

#### Gemini, Codex, Claude — APPROVE
- **Concern (MEDIUM)**: `Array.isArray` guard missing for `porch.checks` — arrays pass the `typeof 'object'` check.
  - **Addressed**: Added `Array.isArray(porch.checks)` guard in `config.ts:54`; added test case.

### Phase 2 (override_merging) — Round 1

#### Gemini, Codex, Claude — APPROVE
- **Concern (MEDIUM)**: Warning scope too narrow — `getPhaseChecks()` only warned for names absent from the current phase, creating false positives for cross-phase overrides.
  - **Addressed**: Warning logic now checks all `protocol.checks` AND `protocol.phase_completion` keys; only truly unknown names trigger the warning.

### Phase 3 (call_sites) — Round 1

#### Gemini, Codex, Claude — APPROVE
- **Concern (MEDIUM)**: `status()` showed full protocol check list without applying overrides — skipped checks appeared as pending criteria.
  - **Addressed**: `status()` now calls `loadCheckOverrides()` and passes result to `getPhaseChecks()`.
- **Concern (MEDIUM)**: `logCheckOverrides()` only logged command overrides; cwd-only overrides were silent, violating spec visibility requirement.
  - **Addressed**: Condition updated to `override.command || override.cwd`; cwd included in log line.

### Phase 4 (tests_and_docs) — Round 1

#### Gemini — APPROVE
- **Concern (LOW)**: Raw ANSI escape codes in `protocol.ts` instead of chalk — may not respect `NO_COLOR`.
  - **Rebutted**: The raw codes were used to avoid importing chalk into `protocol.ts` (keeping the module dependency-light). The warnings are informational and non-critical; NO_COLOR support can be addressed in a follow-up.
- **Concern (LOW)**: `cwd` silently ignored in phase_completion overrides.
  - **Rebutted**: By design — `phase_completion` checks are string predicates run by porch's own runner which handles cwd through the override's cwd field (this path is covered by the override runner, not the string value). The return type `Record<string, string>` documents this constraint.

#### Codex, Claude — APPROVE
- No blocking concerns raised.

## Architecture Updates

No changes to `codev/resources/arch.md` needed. This is a targeted addition to porch with no new external dependencies or architectural patterns beyond what already exists (af-config.json already served as the project-level config file).

## Lessons Learned Updates

Added above under "Lessons Learned" section.
