# Specification: Parent-Delegated Consultation Mode for Porch

## Metadata
- **ID**: spec-2026-03-08-parent-delegated-consultation
- **Status**: draft
- **Created**: 2026-03-08

## Clarifying Questions Asked
- **Q**: Should builders ever run `consult` themselves when parent mode is active? **A**: No. The builder should stop and wait for the parent session to review.
- **Q**: Should we support a "skip" mode that auto-advances without any review? **A**: No. Use the `parent` mode with a gate — the parent session does the verification.
- **Q**: Should the parent session's review be per-phase or only at the PR? **A**: Per-phase — the builder blocks at each phase so the parent can review incrementally.

## Problem Statement

When a parent Claude Code session (Opus on Claude Max) spawns a builder via `af spawn`, the builder runs through ASPIR/SPIR phases. At each phase's verification step, porch tells the builder to run `consult -m {model}` commands which spawn **fresh API sessions**:

- `consult -m claude` spawns a new Opus session via the Agent SDK (200 turns, $25 budget cap, zero context)
- `consult -m codex` spawns a Codex SDK session
- `consult -m gemini` spawns a Gemini CLI subprocess

For a 7-phase implementation with 3-way consultation, that's 21 consultation sessions. Each `claude` consultation alone can cost up to $25 in API billing and take 10+ minutes as the fresh session re-explores the entire codebase from scratch.

Meanwhile, the parent Claude Code session sits idle. It has:
- Opus on Claude Max (effectively free — no per-token billing)
- Full project context already loaded in its context window
- All Claude Code tools (Explore agents, Glob, Grep, Read, etc.)
- Pal MCP for multi-model review when a second opinion is needed
- Deep understanding of the spec and plan it authored

The parent session is strictly better at reviewing than a cold-start API session, yet the builder wastes time and money spawning fresh sessions instead.

## Current State

- Porch generates `consult` commands in `next.ts` (lines 434-466) whenever a `build_verify` phase completes and `verifyConfig` is non-null
- `verifyConfig` comes from `protocol.json` (e.g., `verify.models: ["gemini", "codex", "claude"]`) — hardcoded per protocol
- There is no mechanism to override or disable consultation behavior per-repo
- The `af-config.json` supports `porch.checks` overrides (per Spec 550) but has no consultation override
- Both ASPIR and SPIR protocols require 3-way consultation on every phase — ASPIR only skips human approval gates, not consultations

## Desired State

- A new `porch.consultation` setting in `af-config.json` controls how verification is handled
- When set to `"parent"`, porch emits a scoped `phase-review-*` gate instead of `consult` commands
- Gate names are phase-specific: `phase-review-{phase}-{planPhase}-iter{iteration}` (e.g., `phase-review-implement-auth-login-iter1`)
- The builder blocks at the gate, the parent session reviews the work, and approves via `porch approve N phase-review-implement-auth-login-iter1 --a-human-explicitly-approved-this`
- The builder then advances to the next phase
- Default behavior (no config) is unchanged — builders run `consult` commands as before

## Stakeholders
- **Primary Users**: Developers using Claude Code as the orchestrating session with Claude Max subscription
- **Secondary Users**: All codev/porch users (must not be affected — fully backward compatible)
- **Technical Team**: Maintainers of codev (porch)

## Success Criteria
- [ ] `af-config.json` accepts `porch.consultation: "parent"` setting
- [ ] When set to `"parent"`, `porch next N` emits a scoped `phase-review-*` gate instead of consult commands after build_complete
- [ ] `next()` explicitly checks for pending `phase-review-*` gates and returns `gate_pending` (not just emitting tasks that say "stop")
- [ ] Builder receives clear instructions to stop and wait for parent review, including which gate to approve
- [ ] `porch approve N phase-review-{phase}-{planPhase}-iter{N} --a-human-explicitly-approved-this` advances the builder past verification
- [ ] Each plan phase gets a unique gate name — no gate reuse or clearing needed (preserves audit trail)
- [ ] Default behavior (no config or `"default"`) emits consult commands as before
- [ ] Existing tests continue to pass
- [ ] Works correctly from builder worktrees (reads config via `findConfigRoot`)
- [ ] Invalid config values (typos) fall back to default behavior rather than silently misconfiguring

## Constraints
### Technical Constraints
- Gates are dynamic string keys in `state.gates` — no pre-registration needed
- Each phase-review gate is unique (scoped by phase/planPhase/iteration) — no clearing or reuse needed
- `next()` currently only checks protocol-defined gates via `getPhaseGate()` (lines 286-332). Parent-review gates must be checked explicitly — either as an additional check before `handleBuildVerify()`, or by pattern-matching `phase-review-*` keys in `state.gates`
- `loadConsultationMode()` must use `findConfigRoot()` to resolve `af-config.json` from worktrees
- The change must be backward compatible — zero impact when config is absent
- The error at line 569 (`build_complete=true but no verify config`) must NOT be changed — it correctly surfaces malformed protocol specs. The parent-mode intercept happens inside the existing `if (state.build_complete && verifyConfig)` block

## Assumptions
- The parent session monitors builder progress (via `af status`, `porch status`, or polling)
- The parent session has the tools and context to perform meaningful code review
- The parent session can run `porch approve` from the main repo root

## Solution Approaches

### Approach 1: Phase-Review Gate (Recommended)
**Description**: When `porch.consultation: "parent"`, porch emits a `phase-review` gate instead of consult tasks. The builder blocks until the parent approves.

**Pros**:
- Uses existing gate mechanism — no new abstractions
- Builder explicitly stops, preventing wasted work
- Parent reviews at natural breakpoints (per-phase)
- Fully backward compatible

**Cons**:
- Requires parent session to actively monitor and approve each phase
- More blocking than a fully autonomous flow

**Estimated Complexity**: Low
**Risk Level**: Low

### Approach 2: Auto-Skip with PR-Only Review
**Description**: Skip all per-phase consultations, only review at the PR gate.

**Pros**:
- Simpler — no per-phase blocking
- Builder runs autonomously to completion

**Cons**:
- No feedback until all work is done — late-stage issues are expensive to fix
- Misses the benefit of incremental review

**Estimated Complexity**: Low
**Risk Level**: Medium (quality risk from no intermediate review)

## Open Questions

### Critical (Blocks Progress)
- None — all questions resolved in clarifying questions above.

### Important (Affects Design)
- [x] Should `porch status` display the consultation mode? Yes — helps debugging.

## Security Considerations
- The `--a-human-explicitly-approved-this` flag on `porch approve` is preserved — automated approval is still prevented.

## Test Scenarios
### Functional Tests
1. Parent mode: `porch next` after build_complete emits scoped `phase-review-*` gate
2. Parent mode: `porch next` returns `gate_pending` when phase-review gate is pending
3. Parent mode: `porch approve N phase-review-specify-main-iter1` advances to next phase
4. Parent mode: each plan phase gets a unique gate name (audit trail preserved)
5. Default mode: `porch next` after build_complete emits consult commands (unchanged)
6. Config resolution: `loadConsultationMode` works from builder worktrees
7. Invalid config value: `porch.consultation: "typo"` falls back to default (consult) behavior
8. Gate message includes the exact `porch approve` command for the parent to copy-paste

## 3-Way Consensus Results

### Models Consulted
- **Gemini 3.1 Pro** (stance: for) — Confidence: 9/10
- **GPT 5.1 Codex** (stance: against) — Confidence: 7/10
- **GPT 5.2** (stance: neutral) — Confidence: 8/10

### Unanimous Agreement
1. Gate-based approach is correct — uses existing infrastructure, idiomatic for porch
2. Preserve line 569 error — don't auto-advance when verifyConfig is missing
3. Use scoped gate names — reusing a single `phase-review` gate risks mis-approval and destroys audit trail

### Split: Timeout Policy
- Gemini: No timeout — builder blocks indefinitely, keeps state machine simple
- Codex: 30-60min timeout with auto-escalation
- GPT-5.2: No auto-approve, but maybe notification after N minutes

**Decision**: No timeout. The parent session actively monitors builders via `af status` / `porch status`. Adding timeout complexity for a problem that doesn't exist in practice is over-engineering.

### Key Design Improvements Adopted
1. **Scoped gate names**: `phase-review-${state.phase}-${state.current_plan_phase || 'main'}-iter${state.iteration}` — each phase gets a unique gate, preserving full audit trail
2. **Explicit gate check**: `next()` must pattern-match `phase-review-*` keys in `state.gates` and return `gate_pending` when any are pending
3. **Intercept point**: Inside existing `if (state.build_complete && verifyConfig)` block — before consult command generation, not at line 569
4. **Schema validation**: Invalid `porch.consultation` values fall back to default behavior

## Risks and Mitigation
| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|-------------------|
| Parent forgets to approve gate | Medium | Low | Builder shows clear "waiting" message; `porch pending` lists it with exact approve command |
| Config not found from worktree | Low | Medium | Uses `findConfigRoot()` which is already tested |
| Mis-approval (approving wrong phase's gate) | Low | Medium | Scoped gate names prevent this — each phase has a unique key |
| Invalid config value silently misconfigures | Low | High | Validate against allowed values; fall back to default on unknown |
