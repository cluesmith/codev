# Plan: Language-Agnostic Porch Check Commands

## Metadata
- **ID**: 495-language-agnostic-porch-checks
- **Specification**: [codev/specs/495-language-agnostic-porch-checks.md](/codev/specs/495-language-agnostic-porch-checks.md)
- **Status**: draft
- **Created**: 2026-02-23

## Executive Summary

Implement runtime check overrides via `af-config.json` (Spec Approach 1). Porch reads a new `porch.checks` section from `af-config.json` and merges overrides with protocol.json defaults before executing checks. Override commands replace the protocol default; `skip: true` disables a check entirely. Porch logs all overrides and skips for auditability.

The key architectural decision is **not** importing from agent-farm. Instead, porch gets its own lightweight config reader (a single function) that reads only the `porch` section from `af-config.json`. This avoids circular dependencies and keeps porch self-contained.

## Success Metrics
- [ ] All specification criteria met
- [ ] Non-Node.js project can run `porch check` / `porch done` with custom commands
- [ ] Existing behavior unchanged when no overrides configured
- [ ] Porch logs when checks are overridden or skipped
- [ ] `skip: true` disables individual checks
- [ ] `phase_completion` checks also overridable
- [ ] New tests cover merging, skip, precedence, error handling
- [ ] Documentation with examples for Python, Rust, Go

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "config_and_types", "title": "Phase 1: Config Loading and Types"},
    {"id": "override_merging", "title": "Phase 2: Override Merging in Protocol"},
    {"id": "call_sites", "title": "Phase 3: Update Call Sites and Logging"},
    {"id": "tests_and_docs", "title": "Phase 4: Tests and Documentation"}
  ]
}
```

## Phase Breakdown

### Phase 1: Config Loading and Types
**Dependencies**: None

#### Objectives
- Define the TypeScript types for check overrides
- Add a self-contained config reader to porch that loads `porch.checks` from `af-config.json`

#### Deliverables
- [ ] `CheckOverride` interface in `commands/porch/types.ts`
- [ ] `loadCheckOverrides()` function in a new `commands/porch/config.ts`
- [ ] Unit tests for config loading (missing file, empty, malformed, valid)

#### Implementation Details

**New types in `commands/porch/types.ts`:**
```typescript
export interface CheckOverride {
  command?: string;    // Override the check command
  cwd?: string;        // Override the working directory
  skip?: boolean;      // Skip this check entirely
}

export type CheckOverrides = Record<string, CheckOverride>;
```

**New file `commands/porch/config.ts`:**
A standalone config reader — does NOT import from `agent-farm/utils/config.ts`. Reads `af-config.json` from the workspace root (passed as parameter), parses only the `porch.checks` section. Returns `CheckOverrides | null`.

This avoids introducing a dependency from porch → agent-farm, keeping the module boundary clean.

#### Acceptance Criteria
- [ ] `loadCheckOverrides(cwd)` returns null when no af-config.json exists
- [ ] `loadCheckOverrides(cwd)` returns null when af-config.json has no `porch` key
- [ ] `loadCheckOverrides(cwd)` returns the overrides map when `porch.checks` is present
- [ ] Malformed af-config.json produces a clear error message
- [ ] Types compile without import cycles

#### Test Plan
- **Unit Tests**: loadCheckOverrides with fixtures (no file, empty object, valid overrides, malformed JSON, missing porch key)
- **Manual Testing**: Create af-config.json with `porch.checks`, verify it loads

#### Rollback Strategy
Delete `commands/porch/config.ts` and the new types. No existing files modified.

#### Risks
- **Risk**: Porch's config reader could drift from agent-farm's af-config.json parsing
  - **Mitigation**: Porch only reads `porch.*` — it ignores all other keys. The two parsers don't overlap.

---

### Phase 2: Override Merging in Protocol
**Dependencies**: Phase 1

#### Objectives
- Modify `getPhaseChecks()` to accept and apply overrides
- Modify `getPhaseCompletionChecks()` to accept and apply overrides
- Support `skip: true`, `command` override, and `cwd` override

#### Deliverables
- [ ] Updated `getPhaseChecks()` signature and logic in `commands/porch/protocol.ts`
- [ ] Updated `getPhaseCompletionChecks()` signature and logic
- [ ] Unit tests for override merging (command override, cwd override, skip, no override, unknown check name)

#### Implementation Details

**Modified `getPhaseChecks()` in `protocol.ts`:**
```
getPhaseChecks(protocol, phaseId, overrides?)
```
For each check the phase requests:
1. Look up the base `CheckDef` from `protocol.checks`
2. If `overrides[checkName]` exists:
   - If `skip: true` → omit from result
   - If `command` set → replace `CheckDef.command`
   - If `cwd` set → replace `CheckDef.cwd`
3. If no override → use protocol default unchanged

**Modified `getPhaseCompletionChecks()` in `protocol.ts`:**
Same pattern — accept optional overrides, apply command/skip substitution to the `phase_completion` check map. Note: `phase_completion` checks are currently simple string predicates (e.g., `"build_succeeds": "npm run build 2>&1"`), not `CheckDef` objects. The merging logic must wrap these strings into a compatible shape before applying `command`/`skip` overrides. Skipping a `phase_completion` check removes that condition from the gating — the phase can complete without it passing (it does NOT auto-pass).

#### Acceptance Criteria
- [ ] Passing no overrides produces identical behavior to current code
- [ ] Override `command` replaces the protocol command
- [ ] Override `cwd` replaces the protocol cwd
- [ ] `skip: true` removes the check from the result
- [ ] Unknown check names in overrides emit a `chalk.yellow` warning (not silently ignored)
- [ ] `phase_completion` checks are also overridable (string predicates wrapped for override compatibility)
- [ ] Skipping a `phase_completion` check removes the condition from gating

#### Test Plan
- **Unit Tests**: getPhaseChecks with mock protocol + various override combinations
- **Unit Tests**: getPhaseCompletionChecks with overrides

#### Rollback Strategy
Revert the two function signatures to their original forms (remove the optional parameter).

#### Risks
- **Risk**: Changing a public function signature could break external callers
  - **Mitigation**: The new parameter is optional with default `undefined` — all existing call sites work unchanged until updated.

---

### Phase 3: Update Call Sites and Logging
**Dependencies**: Phase 2

#### Objectives
- Wire up override loading at all porch command entry points
- Add visible console output when checks are overridden or skipped

#### Deliverables
- [ ] Updated `check()`, `done()`, `approve()` in `commands/porch/index.ts`
- [ ] Updated `handleBuildVerify()` in `commands/porch/next.ts`
- [ ] Console log lines for overridden and skipped checks
- [ ] Integration test: end-to-end porch check with af-config.json overrides

#### Implementation Details

**In `index.ts` — at each of the 3 call sites (`check`, `done`, `approve`):**
1. After resolving `workspaceRoot`, call `loadCheckOverrides(workspaceRoot)`
2. Pass overrides to `getPhaseChecks(protocol, state.phase, overrides)`
3. Before running checks, log any overrides/skips:
   - `chalk.yellow('  ⚠ Check "build" overridden: uv run pytest --co -q')`
   - `chalk.yellow('  ⚠ Check "e2e_tests" skipped (af-config.json)')`

**In `next.ts` — `handleBuildVerify()`:**
Same pattern — load overrides, pass to `getPhaseChecks()`, emit override info in the task descriptions.

**Logging approach:** Log BEFORE running checks, not after. This ensures the user sees what will happen before it executes. Use `chalk.yellow` (warning level) for visibility.

#### Acceptance Criteria
- [ ] `porch check` with af-config.json overrides runs the overridden commands
- [ ] `porch done` with overrides runs overridden commands and advances on success
- [ ] `porch approve` with overrides runs overridden commands
- [ ] `porch next` task output reflects overridden commands
- [ ] Console shows yellow log for each override and skip
- [ ] Without af-config.json, zero console changes (fully silent)

#### Test Plan
- **Integration Tests**: Run `porch check` with a temp project, af-config.json, and a trivial protocol
- **Manual Testing**: Test in a real Python project with `uv run pytest` overrides

#### Rollback Strategy
Revert the 4 call sites to not load/pass overrides. The Phase 2 changes remain safe (optional parameter unused).

#### Risks
- **Risk**: Loading af-config.json on every porch invocation adds latency
  - **Mitigation**: Single JSON.parse of a small file — <1ms. Not cached because porch is a one-shot CLI, not a long-running server.

---

### Phase 4: Tests and Documentation
**Dependencies**: Phase 3

#### Objectives
- Comprehensive test coverage for the full override feature
- Documentation with practical examples for non-Node.js projects

#### Deliverables
- [ ] Test suite for config loading, merging, call-site integration
- [ ] Updated README or CONFIGURATION.md with `porch.checks` documentation
- [ ] Example af-config.json snippets for Python, Rust, Go

#### Implementation Details

**Test coverage targets:**
- Config loading: no file, empty, valid, malformed, missing porch key
- Override merging: command, cwd, skip, no-op, unknown name, phase_completion string wrapping
- Mixed scenarios: skip + command override + defaults coexisting in a single phase
- Integration: end-to-end check execution with overridden commands
- Multi-protocol: test against both SPIR and TICK protocols (different check structures)
- Backward compat: all existing tests pass unchanged

**Documentation additions:**
- `af-config.json` reference section for `porch.checks`
- Example snippets:
  - Python: `{"build": {"command": "uv run pytest --co -q"}, "tests": {"command": "uv run pytest"}}`
  - Rust: `{"build": {"command": "cargo build"}, "tests": {"command": "cargo test"}}`
  - Go: `{"build": {"command": "go build ./..."}, "tests": {"command": "go test ./..."}}`

#### Acceptance Criteria
- [ ] All new tests pass
- [ ] All existing tests pass (no regressions)
- [ ] Documentation reviewed and clear
- [ ] Example configs tested in at least one real project (Python)

#### Test Plan
- **Unit Tests**: All config and merging paths
- **Integration Tests**: porch check with real af-config.json
- **Manual Testing**: Apply to an actual Python project, run full SPIR cycle

#### Rollback Strategy
Remove test files and docs. No production code changes in this phase.

#### Risks
- **Risk**: Test fixtures may not cover all protocol variations
  - **Mitigation**: Test against both SPIR and TICK protocols (they have different check structures)

## Dependency Map
```
Phase 1 (types + config) ──→ Phase 2 (merging) ──→ Phase 3 (call sites) ──→ Phase 4 (tests + docs)
```

Linear dependency chain. Each phase produces a working, testable increment.

## Resource Requirements
### Development Resources
- **Engineers**: 1 (TypeScript, familiar with CLI tooling)
- **Environment**: Node.js dev environment, npm test runner

### Infrastructure
- No database changes
- No new services
- No configuration changes beyond the feature itself

## Risk Analysis
### Technical Risks
| Risk | Probability | Impact | Mitigation | Owner |
|------|------------|--------|------------|-------|
| Import cycle porch → agent-farm | Low | High | Self-contained config reader in porch | Builder |
| Check name instability across versions | Low | Medium | Document stable names, warn on unknown | Builder |
| Silent skip of critical checks | Low | High | Mandatory yellow log on skip | Builder |
| phase_completion string predicate mismatch | Medium | Medium | Wrap strings into CheckDef shape before override merge | Builder |

## Validation Checkpoints
1. **After Phase 1**: Config loads correctly, types compile, no import cycles
2. **After Phase 2**: getPhaseChecks returns overridden results, unit tests pass
3. **After Phase 3**: `porch check` runs custom commands end-to-end, logs visible
4. **Before PR**: All tests pass, docs reviewed, tested on real Python project

## Documentation Updates Required
- [ ] af-config.json reference (add `porch.checks` section)
- [ ] README contributing section (mention language-agnostic check support)
- [ ] Example af-config.json files for Python, Rust, Go

## Expert Review
**Date**: 2026-02-23
**Models**: GPT-5.1 Codex (FOR, 8/10), O3 (NEUTRAL, 8/10) via Pal MCP consensus
**Key Feedback**:
- Confirmed self-contained config reader approach avoids import cycles
- Confirmed flat override structure (check name keyed) over nested (phase → check)
- `phase_completion` checks are string predicates, not CheckDef objects — need wrapping logic for override compatibility
- Unknown check names should emit a yellow warning, not be silently ignored (catches typos)
- Skipping a `phase_completion` check needs explicit semantics: condition removed from gating, not auto-pass
- Integration tests must cover mixed scenarios (skip + command + default coexisting)
- Test against multiple protocol types (SPIR, TICK) since they have different check structures
- Flat override map assumes global check-name uniqueness — document this constraint
- Self-contained reader acceptable short-term; shared util can consolidate later

**Plan Adjustments**:
- Phase 2: Changed unknown check names from "silently ignored" to "emit chalk.yellow warning"
- Phase 2: Added phase_completion string-to-CheckDef wrapping requirement
- Phase 2: Added skip semantics for phase_completion (condition removed, not auto-pass)
- Phase 4: Added mixed override test scenarios and multi-protocol test matrix
- Confirmed linear phase dependency is appropriate for this scope

## Approval
- [ ] Technical Lead Review
- [ ] Engineering Manager Approval
- [ ] Resource Allocation Confirmed
- [x] Expert AI Consultation Complete

## Notes

This is a focused, low-risk change. The self-contained config reader is the key architectural decision — it keeps porch independent of agent-farm while reusing the same af-config.json file. If codev later wants to consolidate config loading, the porch reader can be replaced with a shared utility without changing the override semantics.

---

## Amendment History

<!-- When adding a TICK amendment, add a new entry below this line in chronological order -->
