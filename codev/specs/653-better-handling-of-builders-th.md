# Specification: Better Handling of Builders That Stop Mid-Protocol

## Metadata
- **ID**: 653
- **Status**: draft
- **Created**: 2026-04-02

## Clarifying Questions Asked

The issue description and codebase analysis provide sufficient context. Key questions explored during research:

1. **Q: What are the concrete failure modes?** A: Three primary scenarios — context limit causing builder to lose track of protocol phase, phase misinterpretation causing premature jump to PR creation, and error-driven bailout where builder tries to "save" work via PR.

2. **Q: Does porch detect premature PR creation?** A: No. The `pr_exists` check only runs during the review phase. If a builder creates a PR during the implement phase, porch has no way to know until it reaches review, at which point the check passes by accident against a PR with incomplete code.

3. **Q: What recovery options exist today?** A: None. The architect must manually close the premature PR, potentially reset porch state, and restart the builder. There is no porch command for reconciling diverged state.

4. **Q: Are there guardrails in builder prompts?** A: No explicit instruction tells builders "do not create a PR until the review phase." The implement.md prompt doesn't mention PR creation at all. The review.md prompt says to create a PR but doesn't validate the builder is actually in the review phase.

## Problem Statement

Builders sometimes stop mid-protocol and create premature PRs. This happens when:

1. **Context limits**: The builder loses track of where it is in the SPIR protocol, forgets it's in the implement phase, and jumps to PR creation.
2. **Phase misinterpretation**: The builder completes an implement sub-phase and mistakes it for protocol completion, creating a PR.
3. **Error-driven bailout**: The builder encounters an error it can't fix, panics, and tries to "save" its work by creating a PR before being terminated.

When this happens, the consequences are:
- The PR contains incomplete code (not all plan phases implemented)
- The review document may be missing or incomplete
- Porch's state machine doesn't expect a PR at that stage
- There's no clean recovery path — the architect must manually intervene
- Porch's `pr_exists` check in the review phase passes by accident (it only checks existence, not timing)

This is a recurring pain point that wastes architect time and breaks the protocol flow.

## Current State

### No Phase-Aware PR Validation

The SPIR protocol has 4 phases: specify, plan, implement, review. PR creation is only expected during the **review** phase. However:

- The `pr_exists` check (`protocol.json` line 119-121) only runs as part of the review phase's checks
- There is no check in any earlier phase that warns "a PR should not exist yet"
- `porch done` runs checks for the current phase only — it doesn't check for unexpected artifacts from future phases

### No State Divergence Detection

`porch next` (the pure planner) reads state and computes tasks. It does not validate that the builder hasn't taken actions outside the expected phase:
- No check for unexpected PRs during implement phase
- No check for unexpected review artifacts during implement phase
- No timestamp validation (was this PR created during the right phase?)

### No Recovery Mechanism

When state diverges:
- `porch rollback` exists but only rewinds the status.yaml phase — it doesn't close premature PRs
- No `porch reconcile` or `porch recover` command exists
- The architect must manually: close the premature PR, potentially delete the branch, reset porch state, and respawn the builder

### Insufficient Builder Guardrails

- The implement.md prompt says nothing about not creating PRs
- The builder-prompt.md template's "ABSOLUTE RESTRICTIONS" section covers status.yaml edits and gate approvals, but not PR creation timing
- The builder role (`builder.md`) says "Merge your own PRs — After architect approves" but doesn't say "Only create PRs during the review phase"
- The resume notice (`spawn-roles.ts:176-184`) tells the builder to run `porch next` but doesn't warn about state divergence

## Desired State

### Detection: Catch premature PR creation early

When a builder creates a PR outside the review phase, porch should detect it immediately — not after the fact when the review phase check accidentally passes. This means adding a proactive check that runs during `porch next` and `porch done` for non-review phases.

### Prevention: Make it harder for builders to create premature PRs

Builder prompts should include explicit, prominent warnings against creating PRs before the review phase. The implement.md prompt's "What NOT to Do" section should include PR creation. The builder-prompt.md template should add PR timing to ABSOLUTE RESTRICTIONS.

### Recovery: Provide clean recovery when it happens anyway

When premature PR creation is detected, porch should:
1. Clearly report the divergence
2. Offer recovery options (close premature PR and continue, or adjust state)
3. Not require manual architect intervention for common recovery paths

### Resilience: Better state reconciliation for resumed builders

When a builder resumes (context reconnect), it should validate its state against reality before continuing. If a PR exists but porch is in the implement phase, the builder should be told what happened and what to do.

## Stakeholders
- **Primary Users**: Builder AI agents (the ones that create premature PRs)
- **Secondary Users**: Architect (human + AI) who must recover from diverged state
- **Technical Team**: Codev maintainers
- **Business Owners**: Anyone using the architect-builder pattern

## Success Criteria

- [ ] `porch next` during implement phase detects if a PR already exists and warns the builder
- [ ] `porch done` during non-review phases fails if a PR exists unexpectedly
- [ ] Builder prompts (implement.md, builder-prompt.md) include explicit warnings against premature PR creation
- [ ] `porch next` provides recovery instructions when premature PR is detected (e.g., "close the PR and continue")
- [ ] Resume sessions validate state consistency (PR existence vs expected phase)
- [ ] Unit tests cover all detection and recovery scenarios
- [ ] Documentation updated (arch.md, protocol.md as needed)

## Constraints

### Technical Constraints
- Must work with existing `gh` CLI for PR detection (already used in `pr_exists` check)
- Must not break existing valid workflows (e.g., pre-approved specs/plans that auto-advance)
- Detection must be fast — `porch next` is called frequently and must remain responsive
- Must work across all protocols that use porch (SPIR, ASPIR, TICK, BUGFIX, AIR)

### Design Constraints
- Recovery should be non-destructive — never auto-close a PR or auto-delete builder work
- Detection should be advisory in implement phase (warn, don't block forward progress)
- Detection should be blocking in `porch done` for non-review phases (prevent silent state divergence)
- Must maintain backward compatibility with existing status.yaml format

## Assumptions
- `gh pr list --state all --head <branch>` is the reliable way to detect PRs on the current branch
- Builders can read and follow warnings in prompts (if sufficiently prominent)
- The `porch next` → `porch done` loop is the primary control path for strict-mode builders
- PR creation is always via `gh pr create` (builders don't use GitHub UI)

## Solution Approaches

### Approach 1: Proactive Detection in Porch State Machine (Recommended)

**Description**: Add PR existence detection to `porch next` and `porch done` for non-review phases. When a premature PR is detected, emit advisory warnings (in `porch next`) and blocking errors (in `porch done`). Add recovery guidance to the warning messages.

**Components**:
1. **Detection function**: `hasPrematurePR(workspaceRoot)` — runs `gh pr list --state open --head <branch>` and returns PR info if found
2. **Warning in `porch next`**: When premature PR detected during non-review phase, prepend a warning task telling builder to close the PR and continue normally
3. **Blocking in `porch done`**: When premature PR detected during non-review phase, refuse to advance and tell builder to close the PR first
4. **Recovery guidance**: Clear instructions in the warning about what to do (close PR with `gh pr close`, then continue)

**Pros**:
- Catches the problem at the source (porch state machine)
- Works for all protocols without protocol-specific changes
- Detection is automatic — doesn't rely on builder compliance
- Warnings are advisory in `porch next` (doesn't break flow), blocking in `porch done` (prevents silent divergence)

**Cons**:
- Adds a `gh pr list` call to `porch next` (latency concern, but can be cached or made optional)
- Requires careful handling of edge cases (merged PRs, draft PRs, multiple PRs on same branch)

**Estimated Complexity**: Medium
**Risk Level**: Low

### Approach 2: Prompt-Only Prevention

**Description**: Add explicit, prominent warnings to builder prompts about not creating PRs before the review phase. No code changes to porch.

**Pros**:
- Simple to implement (text changes only)
- No risk of breaking existing porch logic

**Cons**:
- Relies entirely on builder compliance (builders with context limits may forget)
- No detection or recovery — the failure mode still exists, just made less likely
- Doesn't address the fundamental gap in porch's state machine

**Estimated Complexity**: Low
**Risk Level**: Low (but doesn't solve the problem)

### Approach 3: Protocol-Level PR Phase Check

**Description**: Add a `no_open_pr` check to the implement phase in protocol.json. This check fails if any open PR exists on the current branch. Porch would run this as part of `porch done` for the implement phase.

**Pros**:
- Uses existing check infrastructure (no new code paths)
- Protocol-level solution means it's declarative and auditable

**Cons**:
- Only catches premature PRs at `porch done` time, not proactively
- Requires protocol.json changes for every protocol
- Doesn't provide recovery guidance

**Estimated Complexity**: Low
**Risk Level**: Low

### Recommended: Combination of Approach 1 + Approach 2

Use Approach 1 (proactive detection in porch) as the primary mechanism, plus Approach 2 (prompt improvements) as defense-in-depth. This provides both detection/recovery (for when things go wrong) and prevention (to make things go wrong less often).

## Traps to Avoid

1. **Don't auto-close PRs**: Recovery must be builder-initiated. Auto-closing could destroy legitimate work.
2. **Don't add latency to every `porch next` call**: The PR check involves a `gh` API call. Consider caching or only checking when in non-review phases.
3. **Don't block `porch next` on PR detection**: Advisory warnings only. The blocking happens at `porch done` to prevent phase advancement with diverged state.
4. **Don't add a new status.yaml field for PR state**: Keep detection filesystem/API-based so it works even when status.yaml is out of sync.
5. **Don't make this SPIR-specific**: The detection logic should work for any protocol that has a review phase with `pr_exists` check.

## Open Questions

### Critical (Blocks Progress)
- [x] Should detection be in `porch next`, `porch done`, or both? — **Both**: advisory in `porch next`, blocking in `porch done`

### Important (Affects Design)
- [x] Should the `gh pr list` call be cached to avoid latency on every `porch next`? — **Yes, use a simple TTL cache (e.g., 60 seconds)** to avoid hammering the API
- [x] How should multiple PRs on the same branch be handled? — **Detect any open PR as premature; if all PRs are closed/merged, no warning**

### Nice-to-Know (Optimization)
- [ ] Should we track PR creation timing in status.yaml for analytics? — Defer to follow-up

## Performance Requirements
- PR detection check should add < 2 seconds to `porch next` when cached
- No impact when in the review phase (check skipped)

## Security Considerations
- PR detection uses `gh` CLI which respects GitHub auth tokens already configured
- No new credentials or permissions needed

## Test Scenarios

### Functional Tests
1. **Happy path**: Builder completes all phases normally without premature PR — no warnings, no blocks
2. **Premature PR during implement**: Builder creates PR during implement phase — `porch next` warns, `porch done` blocks
3. **Premature PR closed before `porch done`**: Builder closes premature PR after warning — `porch done` succeeds normally
4. **PR in review phase**: Builder creates PR during review phase — no warning (this is expected behavior)
5. **Resumed builder with premature PR**: Builder resumes, `porch next` detects existing PR in non-review phase and warns
6. **Multiple protocols**: Detection works for SPIR, ASPIR, TICK (any protocol with review phase)
7. **Draft PRs**: Draft PRs are also detected as premature in non-review phases

### Non-Functional Tests
1. **Latency**: `porch next` with PR check cached completes in < 2s additional overhead
2. **No `gh` CLI**: Detection gracefully degrades if `gh` is not available (skip check, don't error)

## Dependencies
- **GitHub CLI (`gh`)**: Required for PR detection (already a dependency)
- **Porch state machine** (`packages/codev/src/commands/porch/next.ts`): Primary modification target
- **Porch done command** (`packages/codev/src/commands/porch/index.ts`): Secondary modification target
- **Builder prompts** (`codev-skeleton/protocols/spir/prompts/implement.md`, `builder-prompt.md`): Text changes

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|-------------------|
| `gh pr list` adds latency | Medium | Low | TTL cache (60s), skip in review phase |
| False positive (PR exists for valid reason) | Low | Medium | Only check for open PRs on current branch; skip in review phase |
| Builder ignores warnings | Medium | Low | Blocking check in `porch done` is the hard stop |
| Breaking existing workflows | Low | High | Unit tests for all detection scenarios; only check non-review phases |

## Notes

This spec focuses on the **detection + prevention + recovery** triad. Detection catches the problem, prevention reduces its frequency, and recovery provides clean resolution. The combination of porch-level detection (Approach 1) and prompt-level prevention (Approach 2) provides defense-in-depth.
