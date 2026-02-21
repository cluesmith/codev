# Specification: Risk-Based PR Review Triage for Architect

## Metadata
- **ID**: spec-469
- **Status**: draft
- **Created**: 2026-02-21
- **GitHub Issue**: #469

## Problem Statement

The architect currently has no systematic guidance for choosing the appropriate level of PR review. When a builder PR comes in, the architect either:

1. **Manually reads the diff** and summarizes (ad hoc, lightweight, potentially insufficient)
2. **Runs a full 3-way CMAP integration review** with Gemini + Codex + Claude (thorough but expensive and slow)

There is no middle ground and no decision framework. This leads to two failure modes:
- **Over-reviewing**: Full CMAP on trivial bugfixes wastes ~$4-5 and ~3-5 minutes per PR
- **Under-reviewing**: Skipping review on complex changes risks merging integration problems

## Current State

### Architect Role (`codev/roles/architect.md`)
Section 4 "Integration Review" shows a single approach: always run 3-way parallel `consult` for every PR. No criteria exist for when this is necessary vs. when a lighter review would suffice.

### Workflow Reference (`codev/resources/workflow-reference.md`)
Stage 6 (COMMITTED) describes "Architect does 3-way integration review" as a fixed step with no conditional logic.

### Integration Review Prompt (`codev/consult-types/integration-review.md`)
A single review template used regardless of PR risk level. The template itself is fine — the problem is that it's always invoked via full 3-way CMAP.

### Consult CLI (`codev/resources/commands/consult.md`)
No `--risk` flag or risk-based routing. The CLI simply runs whatever model the user specifies.

## Desired State

A **risk-based triage system** that gives the architect a clear decision framework:

1. **Assess risk** of each incoming PR based on explicit criteria (size, scope, cross-cutting impact)
2. **Select review depth** based on risk level (low/medium/high)
3. **Execute the appropriate review** — from a quick architect summary to full 3-way CMAP

The system should be:
- **Documented** in the architect role and workflow reference so the process is explicit
- **Consistent** — same criteria applied to every PR, removing guesswork
- **Cost-efficient** — only invoke expensive multi-model reviews when warranted

## Stakeholders
- **Primary Users**: Architects managing builder PRs
- **Secondary Users**: Builders (benefit from faster review turnaround on low-risk PRs)
- **Technical Team**: Codev maintainers (implement and maintain the triage system)

## Success Criteria
- [ ] Architect role document includes a risk assessment decision framework with triage table
- [ ] Three triage levels (low/medium/high) are defined with clear criteria and corresponding actions
- [ ] Workflow reference documents the triage process at Stage 6 (replacing fixed 3-way review)
- [ ] `consult risk pr <N>` command assesses PR risk and recommends the appropriate review commands
- [ ] Risk triage reference document exists at `codev/resources/risk-triage.md` with subsystem path mappings
- [ ] Low-risk PRs can be reviewed and merged without invoking any external models
- [ ] High-risk PRs still receive full 3-way CMAP integration review
- [ ] `consult risk` fails cleanly when `gh` is unavailable or PR is not found
- [ ] Documentation is updated and consistent across all affected files

## Constraints

### Technical Constraints
- Must work with existing `consult` CLI infrastructure
- Must not break existing 3-way review workflows (explicit `--risk high` or no flag = current behavior)
- The `--risk auto` feature needs access to `gh pr diff --stat` or equivalent to compute diff stats
- Risk assessment must be deterministic given the same diff state — same PR at same commit always gets same risk level (force-pushes that change the diff may change the assessment)

### Business Constraints
- Backwards compatible — existing consult commands without `--risk` continue to work identically
- No new external dependencies

## Assumptions
- The `gh` CLI is available in the architect's environment
- PR diff stats (`gh pr diff --stat`) provide sufficient signal for size assessment
- Subsystem detection can be done via file path patterns (e.g., `packages/codev/src/commands/porch/` = protocol orchestration = high-risk)

## Solution Approaches

### Approach 1: Documentation-First with CLI Risk Assessment Command

Update architect documentation and role definition with the triage framework. Add a `consult risk` subcommand that assesses PR risk and recommends the appropriate review depth. The architect then runs the recommended commands manually.

**Risk assessment criteria:**

| Factor | Low | Medium | High |
|--------|-----|--------|------|
| **Lines changed** | < 100 | 100-500 | > 500 |
| **Files touched** | 1-3 | 4-10 | > 10 |
| **Subsystem** | UI, docs, cosmetic | Features, commands, tests | Protocol, state mgmt, security, schema |
| **Cross-cutting** | No shared interfaces | Some shared code | Database, APIs, core interfaces |

**Precedence rule (highest risk wins):** When risk signals conflict (e.g., low lines but high-risk subsystem), the **highest individual factor** determines the overall risk level. This is fail-safe: ambiguous signals escalate rather than downplay.

**Triage levels and actions:**

| Risk | Action | Models Used | Cost |
|------|--------|-------------|------|
| **Low** | Architect reads PR, summarizes root cause + fix, merges | None (architect only) | $0 |
| **Medium** | Architect runs single-model integration review: `consult -m claude --type integration pr N` | 1 model (Claude, recommended for speed and cost) | ~$1-2 |
| **High** | Full 3-way CMAP integration review (architect runs 3 parallel consult commands) | 3 models (Gemini + Codex + Claude) | ~$4-5 |

**Medium-risk review detail:** The architect picks a single model (Claude is recommended as the fastest at ~60-120s) and runs the standard integration review prompt. The same `integration-review.md` template is used — the review depth comes from having fewer independent perspectives, not a different prompt.

**Typical mappings:**
- **Low**: Most bugfixes, ASPIR features, documentation changes, UI tweaks, config updates
- **Medium**: SPIR features, new commands, refactors touching 3+ files, new utility modules
- **High**: Protocol changes, porch state machine, Tower architecture, security model changes, database schema changes

**Subsystem-to-risk mapping** is stored in `codev/resources/risk-triage.md` as a human-readable reference table. The `consult risk` command hardcodes the same path patterns for auto-detection. When the mapping needs updating, both the doc and the code are updated together.

**Subsystem path patterns (initial set):**

| Path Pattern | Subsystem | Risk |
|-------------|-----------|------|
| `packages/codev/src/commands/porch/` | Protocol orchestrator | High |
| `packages/codev/src/tower/` | Tower architecture | High |
| `packages/codev/src/state/` | State management | High |
| `codev/protocols/` | Protocol definitions | High |
| `codev-skeleton/protocols/` | Protocol templates | High |
| `packages/codev/src/commands/consult/` | Consultation system | Medium |
| `packages/codev/src/commands/af/` | Agent Farm commands | Medium |
| `packages/codev/src/commands/` (other) | CLI commands | Medium |
| `packages/codev/src/lib/` | Shared libraries | Medium |
| `codev/roles/` | Role definitions | Medium |
| `codev/resources/` | Documentation | Low |
| `codev/specs/`, `codev/plans/`, `codev/reviews/` | Project artifacts | Low |
| `packages/codev/tests/` | Tests only | Low |
| `*.md` (not in protocols/) | Documentation | Low |

**CLI interaction model:** The `consult risk` command is a **reporter, not an orchestrator**. It assesses the PR and outputs the recommended risk level and commands. The architect then decides whether to follow the recommendation or override it. This avoids the architectural complexity of making `consult` spawn multiple sub-processes.

Example usage:
```bash
# Assess risk for PR #83
consult risk pr 83

# Output:
# Risk: MEDIUM (178 lines, 6 files)
# Subsystems: commands (medium), tests (low)
# Highest factor: files=6 (medium)
#
# Recommended action:
#   consult -m claude --type integration pr 83
```

For high-risk:
```bash
# Output:
# Risk: HIGH (620 lines, 14 files)
# Subsystems: porch (high), state (high), commands (medium)
# Highest factor: subsystem=porch (high)
#
# Recommended action:
#   consult -m gemini --type integration pr 83 &
#   consult -m codex --type integration pr 83 &
#   consult -m claude --type integration pr 83 &
#   wait
```

For low-risk:
```bash
# Output:
# Risk: LOW (23 lines, 1 file)
# Subsystems: docs (low)
# Highest factor: none above low
#
# Recommended action:
#   No consultation needed. Read PR and merge.
```

**PR identification:** The `consult risk` command takes a PR number as a positional argument (`consult risk pr 83`), consistent with existing `consult` patterns. It runs `gh pr diff --stat <N>` and `gh pr view <N> --json files` to get the diff stats and file list.

**Error handling:**
- If `gh` is unavailable or unauthenticated: fail with clear error message (no fallback)
- If `gh pr diff --stat` fails (network, rate limit, PR not found): fail with error (no silent default)
- Binary files and renames: excluded from line counts, but file count still reflects them
- Generated files: no special handling (subsystem path pattern is the primary signal)

**Pros**:
- Simple to understand and implement
- Backwards compatible — no changes to existing `consult` commands
- Reporter model avoids orchestration complexity
- Documentation improvements have immediate value even without CLI changes

**Cons**:
- Architect must copy/paste recommended commands (minor friction)
- Auto-detection heuristics may need tuning over time

**Estimated Complexity**: Medium
**Risk Level**: Low

### Approach 2: Documentation Only (No CLI Changes)

Update only the architect role and workflow docs. The architect manually decides risk level and runs the appropriate commands.

**Pros**:
- Simplest to implement — just documentation
- No code changes, no risk of bugs

**Cons**:
- No automation — architect must remember criteria and compute diff stats manually
- More error-prone, relies on architect discipline

**Estimated Complexity**: Low
**Risk Level**: Low

### Approach 3: Full Automation with Orchestrator

Build `consult --risk auto` as a full orchestrator that auto-spawns the right number of models, handles parallel execution, and buffers output.

**Pros**:
- Fully automated, single command
- Most consistent

**Cons**:
- Major architectural change to `consult` CLI (currently one-model-per-invocation)
- Hard to get right (process management, interleaved output, error handling)
- Removes architect judgment from the process
- Over-engineered for current scale

**Estimated Complexity**: High
**Risk Level**: Medium

### Recommended Approach

**Approach 1** — Documentation-first with the `consult risk` reporter command. It provides the right balance: clear documentation for the architect to follow, plus a CLI tool that computes risk and recommends commands without taking over orchestration.

## Open Questions

### Critical (Blocks Progress)
- [x] Which subsystem paths map to which risk levels? → Defined in subsystem path patterns table above
- [x] How does `consult` interact with `-m` flag for risk? → Resolved: `consult risk` is a separate subcommand (reporter), does not invoke models. Existing `consult -m X --type integration` is unchanged.
- [x] How does the CLI determine PR context? → Resolved: `consult risk pr <N>` takes PR number as positional arg
- [x] What is the precedence rule when signals conflict? → Resolved: Highest individual factor wins (fail-safe)

### Important (Affects Design)
- [x] Should the risk assessment result be logged/stored for audit purposes? → Yes, logged to `.consult/history.log` with `type=risk` entries
- [x] What happens when `gh` fails? → Fail with clear error, no silent fallback

### Nice-to-Know (Optimization)
- [ ] Could the builder include risk metadata in its PR description to help the architect?

## Performance Requirements
- **Risk assessment** (`consult risk`): < 3 seconds (two `gh` API calls)
- **Low-risk review**: < 30 seconds (architect reads + summarizes, no external models)
- **Medium-risk review**: ~60-120 seconds (single-model consult)
- **High-risk review**: ~120-250 seconds (3-way parallel consult)

## Security Considerations
- No new authentication or authorization needed — uses existing `gh` and `consult` authentication
- Risk level should never bypass review entirely — even "low" risk still requires architect to read and summarize

## Test Scenarios

### Functional Tests
1. **Low-risk assessment**: PR with 1 file, 15 lines, docs subsystem → `consult risk` outputs LOW
2. **Medium-risk assessment**: PR with 5 files, 200 lines, commands subsystem → outputs MEDIUM
3. **High-risk assessment**: PR with 12 files, 600 lines, porch subsystem → outputs HIGH
4. **Precedence rule**: PR with 20 lines (low) but touching `porch/` (high) → outputs HIGH (highest factor wins)
5. **Recommended commands**: Low outputs "no consultation needed"; Medium outputs single `consult -m claude`; High outputs 3-way parallel commands
6. **Backwards compatibility**: All existing `consult` commands work exactly as before (no changes to `-m`, `--type`, `--protocol`)
7. **Error handling — `gh` unavailable**: `consult risk` fails with clear error message, does not default to a risk level
8. **Error handling — PR not found**: `consult risk pr 99999` fails with "PR not found" error
9. **Binary/rename files**: Excluded from line counts, included in file counts
10. **Mixed subsystems**: PR touching both `tests/` (low) and `porch/` (high) → outputs HIGH

### Non-Functional Tests
1. `consult risk` completes in < 3 seconds
2. All existing `consult` commands continue to work without modification
3. Risk assessment is logged to `.consult/history.log`

## Dependencies
- **External Services**: `gh` CLI for diff stats
- **Internal Systems**: `consult` CLI, architect role docs, workflow reference
- **Libraries/Frameworks**: None new

## Risks and Mitigation
| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|-------------------|
| Auto-detection miscategorizes risk | Medium | Low | Architect can override with `--risk high/medium/low`; log assessments for tuning |
| Subsystem path patterns become outdated | Low | Low | Document path→subsystem mappings in a config section that's easy to update |
| Architects bypass triage and always use CMAP | Low | Low | Documentation makes the cost/benefit clear; consult stats show usage patterns |

## Notes

The issue mentions that "typical mappings" include protocol types (ASPIR → low, SPIR → medium). While useful as a heuristic, the primary signal should be the actual diff characteristics, not the protocol used. An ASPIR PR that changes core state management should still be high-risk.

The architect always retains final judgment. The `consult risk` command is advisory — the architect can ignore the recommendation and run whatever review depth they choose. This is intentional: the tool assists but does not dictate.

Risk triage applies to all PR types (SPIR, TICK, bugfix, ASPIR). The subsystem-based assessment is agnostic to the protocol that produced the PR.

---

## Amendments

This section tracks all TICK amendments to this specification. TICKs are lightweight changes that refine an existing spec rather than creating a new one.

<!-- When adding a TICK amendment, add a new entry below this line in chronological order -->
