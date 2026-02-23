# Specification: Language-Agnostic Porch Check Commands

<!--
SPEC vs PLAN BOUNDARY:
This spec defines WHAT and WHY. The plan defines HOW and WHEN.

DO NOT include in this spec:
- Implementation phases or steps
- File paths to modify
- Code examples or pseudocode
- "First we will... then we will..."

These belong in codev/plans/495-language-agnostic-porch-checks.md
-->

## Metadata
- **ID**: 495-language-agnostic-porch-checks
- **Status**: draft
- **Created**: 2026-02-23
- **Multi-Agent**: true (GPT-5.1 Codex, Gemini 3 Pro, O3)

## Clarifying Questions Asked

1. **Q: Are there existing issues or PRs about this?**
   A: No. Zero existing issues, PRs, or code addressing non-Node.js check commands in porch. The protocols have always assumed Node.js.

2. **Q: How do projects currently work around this?**
   A: Projects either (a) manually edit their local `protocol.json` after `codev adopt` (which gets overwritten on `codev update`), or (b) accept that `porch check` / `porch done` will always fail and work around it manually. Both are poor experiences.

3. **Q: Does `codev adopt` or `codev update` provide any language customization?**
   A: No. Protocols are copied verbatim from the codev skeleton. There is no variable substitution, template selection, or language detection during adoption.

4. **Q: What is the existing override pattern in codev?**
   A: `af-config.json` already provides project-level overrides for agent shell commands (architect, builder, shell) following a hierarchy: CLI flags > af-config.json > defaults. Porch does not currently read af-config.json.

## Problem Statement

All five active codev protocols (SPIR, ASPIR, TICK, BUGFIX, MAINTAIN) hardcode `npm run build` and `npm test` as their build and test check commands. This makes porch — the protocol orchestrator — unusable for any non-Node.js project. When a Python, Rust, Go, or other project runs `porch done` or `porch check`, the hardcoded npm commands fail, blocking phase advancement.

This is a fundamental adoption barrier: codev's methodology is language-agnostic, but its tooling is not.

## Current State

- All `protocol.json` files contain hardcoded npm commands in their check definitions:
  - `"build": {"command": "npm run build"}`
  - `"tests": {"command": "npm test -- --exclude='**/e2e/**'"}`
  - `"e2e_tests": {"command": "npm run test:e2e 2>&1 || echo 'e2e tests skipped (not configured)'"}`
  - `"phase_completion": {"build_succeeds": "npm run build 2>&1", "tests_pass": "npm test 2>&1"}`
- Protocols are copied verbatim by `codev adopt` and `codev update` — no substitution occurs
- `af-config.json` exists for project-level configuration but is only used by Agent Farm (shell commands, terminal backend, dashboard frontend) — porch ignores it entirely
- There is no mechanism to override, customize, or skip individual checks per project
- Non-Node.js projects must manually edit `protocol.json` files after every `codev update`, or accept permanent check failures

## Desired State

- Projects can define their own build, test, and verification commands without editing protocol templates
- Overrides are persistent across `codev update` (not stored in protocol.json)
- Porch logs when a protocol check is overridden or skipped, for auditability
- Existing Node.js projects see zero behavior change (full backward compatibility)
- The override mechanism follows the same precedence pattern already established by af-config.json for shell commands
- Individual checks can be skipped entirely (e.g., `e2e_tests` for projects without an e2e suite)

## Stakeholders

- **Primary Users**: Developers using codev on non-Node.js projects (Python, Rust, Go, Java, etc.)
- **Secondary Users**: Node.js developers who need custom build flags or monorepo-specific commands
- **Technical Team**: Codev maintainers
- **Community**: First-time contributors to non-Node.js ecosystems evaluating codev

## Success Criteria

- [ ] Non-Node.js projects can run `porch check`, `porch done`, and `porch approve` with project-appropriate commands
- [ ] Override configuration survives `codev update` (stored outside protocol.json)
- [ ] Existing projects with no overrides configured see identical behavior (backward compatible)
- [ ] Porch emits a visible log line when a check command is overridden or skipped
- [ ] `skip: true` can disable individual checks without removing them from the protocol
- [ ] `phase_completion` checks are also overridable
- [ ] All existing tests continue to pass
- [ ] New tests cover override merging, skip behavior, and precedence
- [ ] Documentation updated with examples for Python, Rust, and Go projects

## Constraints

### Technical Constraints

- Must work within the existing `af-config.json` loading mechanism (already parsed by Agent Farm)
- Porch currently has no dependency on Agent Farm's config module — a lightweight bridge is needed
- Check names must match between `protocol.json` and the override (no wildcards or regex)
- Override commands must be valid shell strings (same format as existing protocol.json checks)

### Business Constraints

- Must be a non-breaking change — existing Node.js projects with no af-config.json overrides must behave identically
- Should be a small, focused PR suitable for community contribution
- Should not require changes to protocol.json files themselves (those remain the opinionated defaults)

## Assumptions

- `af-config.json` is the right location for project-level configuration (established pattern)
- Check names are stable identifiers that can be matched across protocol versions (e.g., `build`, `tests`, `e2e_tests`)
- Projects know their own build and test commands (no auto-detection in this spec)
- The `porch` top-level key in af-config.json is currently unused and available

## Solution Approaches

### Approach 1: Runtime Override via af-config.json (Recommended)

**Description**: Add a `porch.checks` section to af-config.json. Porch reads overrides at runtime and merges them with protocol.json defaults. Override commands replace the protocol default; `skip: true` disables a check entirely.

Example af-config.json:
```json
{
  "shell": { "builder": "claude" },
  "porch": {
    "checks": {
      "build": { "command": "uv run pytest --co -q" },
      "tests": { "command": "uv run pytest" },
      "e2e_tests": { "skip": true },
      "build_succeeds": { "command": "uv run pytest --co -q" },
      "tests_pass": { "command": "uv run pytest" }
    }
  }
}
```

**Pros**:
- Smallest diff — 4-6 touch points in porch
- Follows existing af-config.json override pattern (CLI > config > defaults)
- Fully backward-compatible — absent config means existing behavior
- Persistent across `codev update` (af-config.json is not overwritten)
- Users already know af-config.json as the project config file
- Industry precedent: GitHub Actions, CircleCI, Azure Pipelines all support job-level overrides

**Cons**:
- Config-level override rather than fixing the root cause (hardcoded defaults)
- Could drift if check names change across protocol versions
- Does not auto-detect project language

**Estimated Complexity**: Low
**Risk Level**: Low

### Approach 2: Stack-Specific Protocol Templates

**Description**: Ship multiple `protocol.json` variants per language (e.g., `protocol-python.json`, `protocol-rust.json`). `codev adopt` detects project markers (`pyproject.toml`, `Cargo.toml`, `pom.xml`) and installs the appropriate variant, or accepts `--template python` flag.

**Pros**:
- Cleaner architecture — protocols remain the single source of truth
- Zero-config experience for supported languages
- Centrally maintainable — update Python build commands globally

**Cons**:
- Significant implementation scope: template detection, selection mechanism, multiple protocol variants to create and maintain
- Every new language requires a new template
- Doesn't handle projects with unusual or custom build systems
- Overwrites during `codev update` become more complex (which template was selected?)
- Much larger PR, inappropriate for a first contribution

**Estimated Complexity**: High
**Risk Level**: Medium

### Approach 3: Hybrid — Auto-Detection + Override Escape Hatch

**Description**: Combine Approach 2's auto-detection with Approach 1's af-config.json override. `codev adopt` auto-detects and writes appropriate defaults to protocol.json; af-config.json overrides serve as the escape hatch for custom setups.

**Pros**:
- Best long-term solution — zero-config defaults with full customizability
- Handles both common languages and exotic setups

**Cons**:
- Largest scope — combines both approaches
- Auto-detection heuristics can be wrong (polyglot repos, monorepos)
- Not appropriate as a single PR

**Estimated Complexity**: High
**Risk Level**: Medium

## Open Questions

### Critical (Blocks Progress)

- [x] Should overrides be flat (keyed by check name) or nested (by phase, then check name)? **Decision: Flat.** Check names are unique within a protocol. Flat is simpler and covers all current use cases. Phase-specific overrides can be added later if needed.

### Important (Affects Design)

- [ ] Should porch validate that override check names match known protocol checks, or silently ignore unknown names?
- [ ] Should `codev adopt` scaffold a commented-out `porch.checks` section in af-config.json with detected language defaults?

### Nice-to-Know (Optimization)

- [ ] Should auto-detection (Approach 2/3) be tracked as a follow-up issue for long-term improvement?

## Performance Requirements

- **Check loading**: Adding af-config.json reads should add <10ms to porch startup (single JSON parse, already cached by Agent Farm)
- **No runtime impact**: Override resolution happens once at check collection time, not during command execution

## Security Considerations

- Override commands execute with the same privileges as protocol.json commands (no escalation)
- `skip: true` could be used to silently bypass security-relevant checks — mitigated by mandatory log output when a check is skipped
- No new attack surface: porch already executes arbitrary shell commands from protocol.json

## Test Scenarios

### Functional Tests

1. **No overrides configured**: Porch uses protocol.json defaults unchanged (backward compat)
2. **Command override**: af-config.json specifies `"build": {"command": "cargo build"}` — porch runs `cargo build` instead of `npm run build`
3. **Skip override**: af-config.json specifies `"e2e_tests": {"skip": true}` — porch skips e2e_tests entirely and logs the skip
4. **Unknown check name in override**: af-config.json specifies a check name not in the protocol — graceful handling (ignore or warn)
5. **Override with cwd**: af-config.json specifies `"build": {"command": "make", "cwd": "src/"}` — porch runs from the specified directory
6. **phase_completion override**: Global fallback checks (`build_succeeds`, `tests_pass`) are also overridable

### Non-Functional Tests

1. **Performance**: af-config.json parsing adds negligible overhead to `porch check` execution
2. **Logging**: Console output clearly shows when a check is overridden or skipped
3. **Error handling**: Malformed `porch.checks` in af-config.json produces a clear error message

## Dependencies

- **Internal**: Porch check runner (`checks.ts`), protocol loader (`protocol.ts`), af-config loader (`config.ts`)
- **External**: None — no new dependencies required

## References

- Existing af-config.json documentation and shell command override pattern
- Protocol.json check format (string and object variants)
- Industry precedent: GitHub Actions job-level overrides, CircleCI `when` conditions

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|-------------------|
| Check name mismatch between protocol versions | Low | Medium | Document stable check names; warn on unknown override names |
| Users skip critical checks inadvertently | Low | High | Mandatory log output on skip; consider `--strict` flag in future |
| af-config.json schema changes conflict | Low | Low | Use new `porch` top-level key, isolated from existing fields |
| Configuration drift across projects | Medium | Low | Document recommended patterns per language in README |

## Expert Consultation

**Date**: 2026-02-23
**Models Consulted**: GPT-5.1 Codex (FOR), Gemini 3 Pro (AGAINST), O3 (NEUTRAL)
**Sections Updated**:
- **Solution Approaches**: Added Approach 2 (stack-specific templates) and Approach 3 (hybrid) based on Gemini 3 Pro's counterargument that runtime overrides treat the symptom, not the root cause
- **Desired State**: Added logging requirement (porch must log when checks are overridden/skipped) based on O3's auditability concern
- **Open Questions**: Added auto-detection as a follow-up issue per O3's recommendation to plan protocol modularization longer-term
- **Risks**: Added configuration drift risk per Gemini 3 Pro's concern about distributed override management

**Consensus Summary**: 2 of 3 models (GPT-5.1 Codex at 7/10, O3 at 8/10) recommend the af-config.json override approach as the pragmatic near-term fix. Gemini 3 Pro (9/10) argues for stack-specific protocol templates but acknowledges that approach requires significantly more scope. All three agree the hardcoded npm commands must be addressed. The recommended approach (Approach 1) is positioned as an immediate fix that does not preclude the longer-term auto-detection improvement.

## Approval

- [ ] Technical Lead Review
- [ ] Product Owner Review
- [ ] Stakeholder Sign-off
- [x] Expert AI Consultation Complete

## Notes

This is a community contribution motivated by real-world usage: adopting codev for a Python project where all porch checks fail due to hardcoded npm commands. The fix intentionally minimizes scope to be a clean, reviewable first PR while acknowledging that a more comprehensive language-detection system could follow as future work.

---

## Amendments

This section tracks all TICK amendments to this specification. TICKs are lightweight changes that refine an existing spec rather than creating a new one.

<!-- When adding a TICK amendment, add a new entry below this line in chronological order -->
