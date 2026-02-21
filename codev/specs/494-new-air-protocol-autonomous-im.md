# Specification: AIR Protocol — Autonomous Implement & Review

## Metadata
- **ID**: spec-2026-02-21-air-protocol
- **Status**: draft
- **Created**: 2026-02-21

## Clarifying Questions Asked

Requirements were stated clearly in GitHub Issue #494. No additional clarification needed — the issue defines the scope, use cases, and deliverables.

## Problem Statement

The current protocol selection has a gap between BUGFIX (bug-only, investigate-then-fix) and SPIR/ASPIR (full spec → plan → implement → review). Small features that are clearly defined in a GitHub issue don't need specification or planning artifacts, but they also aren't bugs. Today, teams either use BUGFIX (which is semantically wrong for features) or ASPIR (which generates unnecessary spec/plan docs for trivial work).

## Current State

Existing protocols:

| Protocol | Use Case | Phases | Artifacts |
|----------|----------|--------|-----------|
| **SPIR** | New features (human-gated) | Specify → Plan → Implement → Review | spec, plan, review |
| **ASPIR** | New features (autonomous) | Specify → Plan → Implement → Review | spec, plan, review |
| **TICK** | Amendments to existing specs | Task ID → Coding → Kickout | amends spec/plan, new review |
| **BUGFIX** | Bug fixes | Investigate → Fix → PR | none (issue-based) |
| **EXPERIMENT** | Research spikes | Hypothesis → Experiment → Conclude | experiment doc |
| **MAINTAIN** | Code hygiene | Dead code, doc sync | none |

The gap: small, well-defined features (< 300 LOC) with clear requirements in a GitHub issue have no lightweight protocol. They don't warrant SPIR's spec/plan ceremony, and BUGFIX is semantically wrong (it's not a bug).

## Desired State

A new **AIR** (Autonomous Implement & Review) protocol that:

1. Has only two phases: **Implement** and **Review**
2. Produces **no spec, plan, or review files** in `codev/specs/`, `codev/plans/`, or `codev/reviews/`
3. Captures the review in the **PR body** instead of a separate file
4. Uses **worktrees** for isolation (like all protocols)
5. Uses **PRs** for integration (like all protocols)
6. Has **no human approval gates** — runs autonomously until PR
7. Makes consultation **optional** — builder decides based on complexity
8. Uses **GitHub Issues** as the source of truth (like BUGFIX)

## Stakeholders
- **Primary Users**: Builders (AI agents implementing small features)
- **Secondary Users**: Architects (spawning and reviewing AIR work)
- **Technical Team**: Codev maintainers

## Success Criteria
- [ ] `af spawn 42 --protocol air` works and creates a builder
- [ ] Porch drives the AIR protocol through Implement → Review phases
- [ ] No spec/plan/review files are created in `codev/specs/`, `codev/plans/`, or `codev/reviews/`
- [ ] Review content appears in the PR body
- [ ] Builder runs autonomously with no gates until the PR gate
- [ ] Consultation is optional (not mandatory per phase)
- [ ] Protocol selection guides in CLAUDE.md/AGENTS.md are updated
- [ ] Cheatsheet includes AIR
- [ ] Build passes, unit tests pass

## Constraints

### Technical Constraints
- Must use the existing `protocol.json` schema (no schema changes)
- Must work with porch's existing state machine (phases, gates, signals)
- Must follow the `codev-skeleton/protocols/` directory convention
- Input type must be `github-issue` (like BUGFIX)

### Design Constraints
- The protocol should be as minimal as possible — two phases, not three or four
- Must NOT create spec/plan artifacts — this is a key differentiator from ASPIR
- Review goes in PR body only, not as a committed file
- Consultation is opt-in, not mandatory

## Assumptions
- Porch can handle protocols without `build_verify` phases (BUGFIX already proves this with `once` type)
- The `once` phase type from bugfix can be reused for AIR's implement and review phases
- The existing protocol schema supports `github-issue` as an input type
- No new phase types are needed

## Solution Approaches

### Approach 1: Minimal two-phase protocol (Recommended)

**Description**: Create AIR with two `once`-type phases (implement, pr), mirroring the bugfix pattern but for features instead of bugs.

**Pros**:
- Minimal surface area — easiest to implement and maintain
- Follows the proven bugfix pattern
- No schema changes needed
- Clear differentiation from SPIR/ASPIR (no spec/plan phases)

**Cons**:
- Less structured than ASPIR — no forced consultation checkpoints

**Estimated Complexity**: Low
**Risk Level**: Low

### Approach 2: Three-phase with optional planning

**Description**: Add an optional "assess" phase before implement, where the builder can optionally sketch a plan.

**Pros**:
- More flexibility for slightly larger features

**Cons**:
- Muddies the distinction between AIR and ASPIR
- Adds complexity for marginal benefit
- "Optional" phases are confusing in a state machine

**Estimated Complexity**: Medium
**Risk Level**: Medium

**Selected**: Approach 1 — the minimal two-phase design. If a feature needs planning, use ASPIR.

## Open Questions

### Critical (Blocks Progress)
- None — requirements are clear from the issue

### Important (Affects Design)
- [x] Should the review phase have a `pr` gate? **Yes** — all protocols gate on PR review before merge
- [x] Should AIR have a complexity guard like BUGFIX's `TOO_COMPLEX` signal? **Yes** — escalate to ASPIR if > 300 LOC

### Nice-to-Know (Optimization)
- [ ] Should AIR support an alias? (e.g., "quick" → "air") — defer to future TICK if desired

## Performance Requirements
- No runtime performance requirements — this is a protocol definition (static files + porch integration)

## Security Considerations
- Same security model as all protocols — worktree isolation, PR-based integration
- No new security surfaces introduced

## Test Scenarios

### Functional Tests
1. `porch init air <id> <name>` creates valid project state
2. `porch run <id>` drives through implement → review phases
3. `porch status <id>` shows correct phase and gate status
4. Protocol validates against `protocol-schema.json`
5. Builder prompt renders correctly with Handlebars variables

### Non-Functional Tests
1. Protocol loads correctly from both `codev/protocols/air/` and `codev-skeleton/protocols/air/`
2. Progress calculation works in dashboard overview

## Dependencies
- **Porch**: Existing state machine handles `once`-type phases and `github-issue` input
- **Protocol Schema**: Existing `protocol-schema.json` supports all needed features
- **Dashboard**: `overview.ts` needs protocol-specific progress calculation (or can use the generic `calculateEvenProgress`)

## Risks and Mitigation
| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|-------------------|
| Confusion between AIR and BUGFIX | Medium | Low | Clear documentation distinguishing "features" vs "bugs" |
| Scope creep — features that should be ASPIR using AIR | Low | Medium | 300 LOC guard + `TOO_COMPLEX` signal for escalation |

## Notes

AIR fills the gap between BUGFIX (bugs only) and ASPIR (full spec/plan ceremony). The key insight is that many small features are fully specified by their GitHub issue — they don't need a separate spec file. AIR trusts the issue as the spec and skips straight to implementation.

The name "AIR" was chosen to be memorable and to convey lightness — lighter than SPIR/ASPIR but still structured.
