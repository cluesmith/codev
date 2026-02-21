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
- [ ] Architect role document includes a risk assessment decision framework
- [ ] Three triage levels are defined with clear criteria and corresponding actions
- [ ] Workflow reference documents the triage process at Stage 6
- [ ] Architect can quickly assess PR risk using diff stats
- [ ] `consult --type integration --risk auto` flag auto-selects review depth based on diff stats
- [ ] Low-risk PRs can be reviewed and merged without invoking any external models
- [ ] High-risk PRs still receive full 3-way CMAP integration review
- [ ] Documentation is updated and consistent across all affected files

## Constraints

### Technical Constraints
- Must work with existing `consult` CLI infrastructure
- Must not break existing 3-way review workflows (explicit `--risk high` or no flag = current behavior)
- The `--risk auto` feature needs access to `gh pr diff --stat` or equivalent to compute diff stats
- Risk assessment must be deterministic — same PR always gets same risk level

### Business Constraints
- Backwards compatible — existing consult commands without `--risk` continue to work identically
- No new external dependencies

## Assumptions
- The `gh` CLI is available in the architect's environment
- PR diff stats (`gh pr diff --stat`) provide sufficient signal for size assessment
- Subsystem detection can be done via file path patterns (e.g., `packages/codev/src/commands/porch/` = protocol orchestration = high-risk)

## Solution Approaches

### Approach 1: Documentation-First with Optional CLI Enhancement

Update architect documentation and role definition with the triage framework. Add a `--risk` flag to `consult` that enables auto-detection.

**Risk assessment criteria:**

| Factor | Low | Medium | High |
|--------|-----|--------|------|
| **Lines changed** | < 100 | 100-500 | > 500 |
| **Files touched** | 1-3 | 4-10 | > 10 |
| **Subsystem** | UI, docs, cosmetic | Features, commands, tests | Protocol, state mgmt, security, schema |
| **Cross-cutting** | No shared interfaces | Some shared code | Database, APIs, core interfaces |

**Triage levels and actions:**

| Risk | Action | Models Used | Cost |
|------|--------|-------------|------|
| **Low** | Architect reads PR, summarizes root cause + fix, merges | None (architect only) | $0 |
| **Medium** | Architect conducts single-model in-context integration review | 1 model (architect's choice) | ~$1-2 |
| **High** | Full 3-way CMAP integration review | 3 models (Gemini + Codex + Claude) | ~$4-5 |

**Typical mappings:**
- **Low**: Most bugfixes, ASPIR features, documentation changes, UI tweaks, config updates
- **Medium**: SPIR features, new commands, refactors touching 3+ files, new utility modules
- **High**: Protocol changes, porch state machine, Tower architecture, security model changes, database schema changes

**Pros**:
- Simple to understand and implement
- Backwards compatible (existing commands unchanged)
- Documentation improvements have immediate value even without CLI changes

**Cons**:
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

### Approach 3: Full Automation with Risk Engine

Build a dedicated risk analysis engine that parses diffs, detects subsystems, and automatically runs the appropriate review level.

**Pros**:
- Fully automated, no human judgment needed
- Most consistent

**Cons**:
- Over-engineered for current scale
- Hard to get right (edge cases in subsystem detection)
- Removes architect judgment from the process

**Estimated Complexity**: High
**Risk Level**: Medium

### Recommended Approach

**Approach 1** — Documentation-first with the `--risk auto` CLI enhancement. It provides the right balance: clear documentation for the architect to follow, plus a convenience flag that automates the common case.

## Open Questions

### Critical (Blocks Progress)
- [x] Which subsystem paths map to which risk levels? → Defined in the risk criteria table above; can be refined during implementation

### Important (Affects Design)
- [ ] Should `--risk auto` be the default behavior for `consult --type integration`, or must it be explicitly opted into?
- [ ] Should the risk assessment result be logged/stored for audit purposes?

### Nice-to-Know (Optimization)
- [ ] Could the builder include risk metadata in its PR description to help the architect?
- [ ] Should there be a `--risk override` mechanism if the architect disagrees with auto-assessment?

## Performance Requirements
- **Risk assessment**: < 5 seconds (gh pr diff --stat is fast)
- **Low-risk review**: < 30 seconds (architect reads + summarizes)
- **Medium-risk review**: ~60-120 seconds (single-model consult)
- **High-risk review**: ~120-250 seconds (3-way parallel consult)

## Security Considerations
- No new authentication or authorization needed — uses existing `gh` and `consult` authentication
- Risk level should never bypass review entirely — even "low" risk still requires architect to read and summarize

## Test Scenarios

### Functional Tests
1. **Low-risk PR**: Bugfix touching 1 file with 15 lines changed → architect reads and merges, no consult invoked
2. **Medium-risk PR**: New feature touching 5 files with 200 lines → single-model integration review
3. **High-risk PR**: Protocol change touching 12 files with 600 lines → full 3-way CMAP review
4. **`--risk auto` flag**: Given a PR number, consult auto-detects risk level and runs appropriate number of models
5. **`--risk low/medium/high` override**: Architect can force a specific risk level
6. **Backwards compatibility**: `consult -m gemini --type integration` without `--risk` works exactly as before

### Non-Functional Tests
1. Risk assessment adds < 2 seconds to consult startup time
2. All existing consult commands continue to work without modification

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

The `--risk auto` feature should output the assessed risk level so the architect can see and override it:
```
Risk assessment: MEDIUM (178 lines, 6 files, touches: commands, tests)
Running single-model integration review...
```

---

## Amendments

This section tracks all TICK amendments to this specification. TICKs are lightweight changes that refine an existing spec rather than creating a new one.

<!-- When adding a TICK amendment, add a new entry below this line in chronological order -->
