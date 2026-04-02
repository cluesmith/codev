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

- [ ] `porch next` in any phase before the PR-allowed phase detects open PRs and warns the builder (advisory, alongside normal tasks)
- [ ] `porch done` in any phase before the PR-allowed phase blocks advancement if an open PR exists
- [ ] PR-allowed phase is derived from protocol definition (first phase with `pr_exists` check or `pr` gate), not hardcoded
- [ ] `pr-exists` forge scripts tightened to exclude CLOSED-not-merged PRs (only OPEN or MERGED satisfy the check)
- [ ] Recovery guidance tells builder to close the premature PR and explicitly states branch/commits are preserved
- [ ] Builder prompts across all protocols (SPIR, ASPIR, AIR, TICK, BUGFIX) include explicit warnings against premature PR creation
- [ ] Detection uses forge concept layer (`executeForgeCommand`), not raw `gh` CLI calls
- [ ] Unit tests cover all detection, recovery, and cross-protocol scenarios
- [ ] Documentation updated (arch.md as needed)

## Constraints

### Technical Constraints
- Must use the existing **forge concept layer** for PR detection (`executeForgeCommand`), not raw `gh` calls — the codebase already abstracts forge interactions to support GitHub, GitLab, and Gitea
- Must not break existing valid workflows (e.g., pre-approved specs/plans that auto-advance)
- Detection must be responsive — a single forge concept call per `porch next`/`porch done` is acceptable (< 2s typical), but no caching (porch is a per-invocation CLI, not a long-lived process)
- Must work across all protocols that use porch (SPIR, ASPIR, TICK, BUGFIX, AIR) — each protocol has a different phase structure for PR creation

### Design Constraints
- Recovery should be non-destructive — never auto-close a PR or auto-delete builder work
- Detection should be advisory in `porch next` (warn, still emit normal task list alongside)
- Detection should be blocking in `porch done` for non-PR phases (prevent silent state divergence)
- Must maintain backward compatibility with existing status.yaml format
- The "PR-allowed phase" must be derived from protocol definition, not hardcoded as "review"

## Assumptions
- The forge concept layer (`executeForgeCommand`) is the correct abstraction for forge-agnostic PR detection
- Builders can read and follow warnings in prompts (if sufficiently prominent)
- The `porch next` → `porch done` loop is the primary control path for strict-mode builders
- PR creation is always via forge tooling (builders don't use GitHub UI directly)

## Cross-Protocol PR Phase Model

Different protocols allow PR creation at different phases. The detection logic must derive the "PR-allowed phase" from the protocol definition rather than assuming it's always `review`.

| Protocol | Phases | PR-Allowed Phase | How to Identify |
|----------|--------|------------------|-----------------|
| SPIR     | specify → plan → implement → review | review | Has `pr_exists` check + `pr` gate |
| ASPIR    | specify → plan → implement → review | review | Has `pr_exists` check + `pr` gate |
| AIR      | implement → pr | pr | Has `pr_exists` check + `pr` gate |
| TICK     | identify → amend_spec → amend_plan → implement → defend → evaluate → review | review | Has `pr` gate |
| BUGFIX   | investigate → fix → pr | pr | Terminal phase (no phases after it) |

**Rule**: The PR-allowed phase is the **first phase** that has either a `pr_exists` check in its `checks` definition OR a gate named `pr`. Any open PR detected in a phase before this is premature.

## Solution Approaches

### Approach 1: Proactive Detection in Porch + Tightened PR Validation (Recommended)

**Description**: Three coordinated changes that work together:

**Component A — Tighten `pr-exists` forge concept**: Change the `pr-exists` forge scripts (`github/pr-exists.sh`, `gitlab/pr-exists.sh`, `gitea/pr-exists.sh`) to only return `true` for OPEN or MERGED PRs. Currently they use `--state all` which includes CLOSED PRs. A CLOSED-but-not-merged PR should not satisfy `pr_exists` — it's either abandoned or was prematurely closed as part of recovery.

This directly fixes the stale-closed-PR bug: if a builder creates a premature PR, closes it after warning, then reaches the review phase, the `pr_exists` check will correctly fail because the closed PR no longer counts. The builder must create a proper new PR during review.

**Component B — Premature PR detection in porch**: Add a `detectPrematurePR()` function to porch that:
1. Determines the PR-allowed phase from the protocol definition (first phase with `pr_exists` check or `pr` gate)
2. Compares the current phase to the PR-allowed phase
3. If the current phase is before the PR-allowed phase, calls the `pr-exists` forge concept to check for open PRs
4. Returns PR info (number, URL) if a premature PR is detected

Integrate into:
- **`porch next`**: Prepend an advisory warning task alongside the normal task list. The builder can see the warning AND still get their regular tasks. Warning includes recovery instructions.
- **`porch done`**: Block advancement if an open premature PR exists. Fail with clear error message and recovery instructions.

**Component C — Builder prompt guardrails**: Add explicit warnings to builder prompts across all protocols that use PR creation:
- Add "NEVER create a PR until porch tells you to" to the ABSOLUTE RESTRICTIONS section of `builder-prompt.md` templates for SPIR, ASPIR, AIR, TICK, and BUGFIX protocols
- Add "Don't create a PR — PRs are created in the review phase" to the "What NOT to Do" sections of `implement.md` prompts
- Update both `codev/` and `codev-skeleton/` copies to stay in sync

**Pros**:
- Detection uses forge abstraction (works with GitHub, GitLab, Gitea)
- Tightened `pr-exists` fixes the closed-PR correctness hole
- No caching needed — one forge call per porch invocation is acceptable
- Protocol-agnostic detection (derives PR-allowed phase from protocol definition)
- Defense-in-depth: detection catches failures, prompts reduce their frequency

**Cons**:
- Tightening `pr-exists` changes existing behavior (CLOSED PRs no longer satisfy it) — low risk since CLOSED-not-merged PRs are almost always abandoned
- One additional forge API call per `porch next`/`porch done` in non-PR phases

**Estimated Complexity**: Medium
**Risk Level**: Low

### Approach 2: Prompt-Only Prevention

**Description**: Add explicit, prominent warnings to builder prompts about not creating PRs before the PR-allowed phase. No code changes to porch.

**Pros**:
- Simple to implement (text changes only)
- No risk of breaking existing porch logic

**Cons**:
- Relies entirely on builder compliance (builders with context limits may forget)
- No detection or recovery — the failure mode still exists, just made less likely
- Doesn't address the fundamental gap in porch's state machine
- Doesn't fix the stale-closed-PR correctness hole

**Estimated Complexity**: Low
**Risk Level**: Low (but doesn't solve the problem)

### Approach 3: Protocol-Level PR Phase Check

**Description**: Add a `no_open_pr` check to non-PR phases in protocol.json. This check fails if any open PR exists on the current branch.

**Pros**:
- Uses existing check infrastructure (no new code paths)
- Protocol-level solution means it's declarative and auditable

**Cons**:
- Only catches premature PRs at `porch done` time, not proactively in `porch next`
- Requires protocol.json changes for every protocol (and new protocols must remember to add it)
- Doesn't provide recovery guidance
- Doesn't fix the stale-closed-PR correctness hole

**Estimated Complexity**: Low
**Risk Level**: Low

### Recommended: Approach 1

Approach 1 is the recommended approach because it addresses all three layers (detection, prevention, recovery) and fixes the stale-closed-PR correctness hole. The forge abstraction ensures it works across all forge providers, and the protocol-derived PR-allowed phase makes it work across all protocols without per-protocol configuration.

## Traps to Avoid

1. **Don't auto-close PRs**: Recovery must be builder-initiated. Auto-closing could destroy legitimate work.
2. **Don't use in-memory or file-based caching**: Porch is a per-invocation CLI process. In-memory TTL caches don't survive across invocations. File-based caches create race conditions and stale state (e.g., builder closes PR but cache still reports it as open, trapping builder in a warning loop). Just make a live forge call each time — it's fast enough.
3. **Don't block `porch next` on PR detection**: Advisory warnings only (prepend to normal task list). The blocking happens at `porch done` to prevent phase advancement with diverged state.
4. **Don't add a new status.yaml field for PR state**: Keep detection forge-API-based so it works even when status.yaml is out of sync.
5. **Don't hardcode "review" as the PR-allowed phase**: Derive it from the protocol definition. Different protocols (BUGFIX, AIR, TICK) have different PR phase structures.
6. **Don't hardcode `gh` CLI calls**: Use the forge concept layer (`executeForgeCommand`) for all PR detection. This ensures compatibility with GitHub, GitLab, and Gitea.
7. **Don't forget to preserve branch/commits during recovery**: When recovery guidance says "close the premature PR," it must explicitly state that the branch and commits are preserved — a confused builder might try to reset the branch too.

## Design Decisions

1. **Detection in both `porch next` and `porch done`**: Advisory in `porch next` (builder sees warning alongside normal tasks), blocking in `porch done` (hard stop on phase advancement).
2. **No caching**: Live forge concept call per invocation. `porch next` is called once per task cycle (not in a tight loop). Typical latency < 1-2 seconds, acceptable trade-off for correctness.
3. **PR-allowed phase derived from protocol**: First phase with `pr_exists` check or `pr` gate. Works across SPIR, ASPIR, AIR, TICK, BUGFIX.
4. **CLOSED PRs don't satisfy `pr_exists`**: Tightening `pr-exists.sh` to only count OPEN or MERGED PRs. This is correct — a CLOSED-not-merged PR is abandoned. This fixes both the premature recovery path and the general correctness hole identified in bugfix #568's follow-on.
5. **Recovery = "close premature PR + continue"**: Builder closes the PR with forge tooling (e.g., `gh pr close`). Since tightened `pr-exists` excludes CLOSED PRs, the recovery cleanly removes the premature PR from detection. The builder must create a fresh PR during the proper PR-allowed phase.

## Performance Requirements
- PR detection check should add < 2 seconds to `porch next` (live forge call, no cache)
- No impact when in the PR-allowed phase or later (check skipped)

## Security Considerations
- PR detection uses `gh` CLI which respects GitHub auth tokens already configured
- No new credentials or permissions needed

## Test Scenarios

### Functional Tests — Detection
1. **Happy path**: Builder completes all phases normally without premature PR — no warnings, no blocks
2. **Premature PR during implement (SPIR)**: Builder creates open PR during implement phase — `porch next` warns, `porch done` blocks
3. **Premature PR during specify (SPIR)**: Detection works in early phases, not just implement
4. **Premature PR during plan (SPIR)**: Same — confirms detection works in all pre-PR phases
5. **Premature PR during implement (AIR)**: Detection works for AIR protocol where PR phase is `pr`, not `review`
6. **BUGFIX pr phase not blocked**: Builder creating PR during BUGFIX `pr` phase is NOT flagged (this is the PR-allowed phase)
7. **TICK review phase not blocked**: Builder creating PR during TICK `review` phase is NOT flagged
8. **Draft PRs detected**: Draft PRs are also detected as premature in non-PR phases
9. **PR on different branch**: An open PR on a different branch does NOT trigger false positive

### Functional Tests — Recovery
10. **Premature PR closed before `porch done`**: Builder closes premature PR after warning — `porch done` succeeds normally
11. **Closed premature PR doesn't satisfy `pr_exists`**: Builder closes premature PR, reaches review phase, `pr_exists` check correctly fails (must create new PR)
12. **Merged premature PR still satisfies `pr_exists`**: Edge case — if a premature PR was merged before detection, `pr_exists` passes. (This is intentionally accepted — a merged PR is a delivered artifact regardless of timing.)
13. **Multiple open PRs on same branch**: Multiple premature PRs — detection warns about all of them, recovery requires closing all

### Functional Tests — Tightened `pr-exists`
14. **OPEN PR satisfies `pr-exists`**: Existing behavior preserved
15. **MERGED PR satisfies `pr-exists`**: Existing behavior preserved (bugfix #568 scenario)
16. **CLOSED PR does NOT satisfy `pr-exists`**: New behavior — CLOSED-not-merged PRs are excluded

### Functional Tests — Prompts
17. **SPIR implement.md**: Contains "Don't create a PR" in What NOT to Do
18. **SPIR builder-prompt.md**: Contains PR timing in ABSOLUTE RESTRICTIONS
19. **All protocol builder-prompt.md files**: ASPIR, AIR, TICK, BUGFIX builder prompts updated

### Non-Functional Tests
20. **Latency**: `porch next` with live forge call completes in < 2s additional overhead
21. **No forge available**: Detection gracefully degrades if forge concept fails (skip check, don't error)
22. **PR-allowed phase derivation**: Unit test that extracts PR-allowed phase correctly from each protocol definition (SPIR, ASPIR, AIR, TICK, BUGFIX)

## Dependencies
- **Forge concept layer** (`packages/codev/src/lib/forge.ts`): Used for PR detection via `executeForgeCommand`
- **Forge PR scripts** (`packages/codev/scripts/forge/{github,gitlab,gitea}/pr-exists.sh`): Tightening to exclude CLOSED PRs
- **Porch state machine** (`packages/codev/src/commands/porch/next.ts`): Primary modification target for premature PR detection
- **Porch done command** (`packages/codev/src/commands/porch/index.ts`): Secondary modification target for blocking check
- **Protocol loader** (`packages/codev/src/commands/porch/protocol.ts`): For deriving PR-allowed phase from protocol definition
- **Builder prompts** (all protocols in both `codev/protocols/` and `codev-skeleton/protocols/`):
  - `spir/builder-prompt.md`, `spir/prompts/implement.md`
  - `aspir/builder-prompt.md`, `aspir/prompts/implement.md`
  - `air/builder-prompt.md`, `air/prompts/implement.md`
  - `tick/builder-prompt.md`, `tick/prompts/implement.md`
  - `bugfix/builder-prompt.md`, `bugfix/prompts/fix.md`
- **Builder role** (`codev/roles/builder.md`, `codev-skeleton/roles/builder.md`): Update Constraints section

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|-------------------|
| Forge call adds latency | Medium | Low | Live call is < 1-2s typical; skip in PR-allowed phase and later |
| False positive (PR exists for valid reason) | Low | Medium | Only check for OPEN PRs on current branch; skip in PR-allowed phase |
| Builder ignores advisory warning | Medium | Low | Blocking check in `porch done` is the hard stop |
| Tightened `pr-exists` breaks legitimate workflow | Low | Medium | Only excludes CLOSED-not-merged PRs; OPEN and MERGED preserved. No known workflow depends on CLOSED PRs satisfying `pr_exists` |
| New protocol doesn't have standard PR phase | Low | Low | Falls back gracefully — if no `pr_exists` check or `pr` gate found, skip premature detection |

## Notes

This spec focuses on the **detection + prevention + recovery** triad. Detection catches the problem, prevention reduces its frequency, and recovery provides clean resolution.

The tightened `pr-exists` check (excluding CLOSED PRs) is a correctness fix that benefits the codebase independently of the premature PR detection feature. It closes a subtle bug where a prematurely-created-then-closed PR could accidentally satisfy the review phase's `pr_exists` check.

## Consultation Log

### Round 1

**Claude** (APPROVE): Confirmed all codebase claims are accurate. Suggested clarifying whether `porch next` should emit normal tasks alongside warnings (yes — addressed in Design Decisions), how to generically identify the PR phase (addressed in Cross-Protocol PR Phase Model), and that recovery guidance should state branch/commits are preserved (addressed in Traps to Avoid #7).

**Codex** (REQUEST_CHANGES): Five issues raised:
1. Cross-protocol phase model mismatch — **Addressed**: Added "Cross-Protocol PR Phase Model" section with per-protocol analysis and generic derivation rule.
2. Closed premature PRs bypass `pr_exists` — **Addressed**: Component A of recommended approach tightens `pr-exists` to exclude CLOSED PRs.
3. Raw `gh` calls bypass forge abstraction — **Addressed**: All detection now uses `executeForgeCommand` via forge concept layer.
4. TTL cache not implementable for per-invocation CLI — **Addressed**: Dropped caching entirely. Live forge call per invocation is acceptable.
5. Prompt coverage incomplete (only SPIR mentioned) — **Addressed**: Dependencies now lists all protocol prompt files across SPIR, ASPIR, AIR, TICK, BUGFIX.

**Gemini** (REQUEST_CHANGES): Three issues raised (overlapping with Codex):
1. Closed premature PRs satisfy `--state all` — **Addressed**: Same as Codex #2 above.
2. TTL cache creates infinite loop — **Addressed**: Same as Codex #4 above.
3. Breaks forge abstraction — **Addressed**: Same as Codex #3 above.
