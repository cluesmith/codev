# Rebuttal — Spec 653 iter0 reviews

## Codex (REQUEST_CHANGES)

1. **Architect/builder ownership contradictory** — Fixed. The interaction model now explicitly carves out the verify phase and cold-start resume as human-driven exceptions to the "builder runs porch" rule.

2. **Terminal-state terminology** — Fixed. Corrected from `integrated` to `complete` (matching actual codebase). Success criteria updated.

3. **Cold-start resume underspecified** — Fixed. Cold-start resume is now explicitly scoped to verify and read-only phases. Code-writing phases (`implement`) require a worktree and fail with a clear "worktree required" error.

4. **status.yaml persistence** — Acknowledged as implementation work. Spec now says "the plan should enumerate which `writeState` calls currently commit and push, and fill any gaps." This is plan-phase detail, not spec-phase.

5. **Verify phase transition timing** — The verify phase is mechanically a post-review `once` phase. `handleOncePhase` runs after the review gate is approved. In the sequential-PR model, the review phase's PR includes `phase: verify` in status.yaml when it merges. The human then runs verify from main. This is an implementation detail for the plan phase, not a spec-level concern.

6. **`porch verify --skip` reason required/optional** — Fixed. Required. Resolved in spec and Open Questions.

7. **Security for main-branch fallback** — Plan-phase concern. The spec doesn't need to specify input validation for `projectId` — that's standard defensive coding in the implementation. Not adding a security section for this.

8. **Testing strategy should include E2E** — Accepted as valid. However, the spec says "unit tests cover" as a minimum; the plan phase determines whether Playwright coverage is needed for `afx status` / workspace view changes. Not adding E2E as a hard spec requirement since not all UI changes may be implemented in this spec (workspace view work may be out of scope depending on plan).

9. **#662 dependency decision** — Fixed. Spec now says #662 is a prerequisite; if it hasn't shipped, Slice B either waits or implements the path change as part of its own work.

## Gemini (REQUEST_CHANGES)

1. **Architect usage constraint contradiction** — Fixed. Same as Codex issue 1. Verify phase is explicitly a human-driven exception.

2. **`handleOncePhase` mechanics mismatch** — Valid concern about conflicting `porch done` vs `porch approve` instructions. However, this is an implementation detail: `handleOncePhase` can be extended to emit phase-specific task text rather than the hardcoded "run porch done" instruction. The verify phase's task says "run porch approve" and the `once` handler skips its default instruction when a gate is defined on the phase. Plan-phase work — the spec doesn't prescribe `handleOncePhase` internals.

3. **`porch verify` vs `porch approve` ambiguity** — `porch approve <id> verify-approval` is the standard gate-approval path (same as spec-approval, plan-approval). `porch verify <id> --skip` is the opt-out path. These are distinct commands for distinct outcomes. The task text directs the human to `porch approve` for the happy path; `--skip` is only for projects that don't need verification. No ambiguity — two different actions, two different commands.

4. **Conflict with Spec 0126 (issue-derived status)** — This is a real concern but out of scope for this spec. If the issue-derived status logic equates "issue closed" with "verified", that logic needs updating to check the `phase` field in status.yaml (which will now be `verify` or `verified`, not `complete`). This is mechanical and can be handled in Slice C's implementation without a spec-level change. Noting it as a plan-phase consideration.

## Claude (REQUEST_CHANGES)

1. **Terminal state is `complete`, not `integrated`** — Fixed. All references corrected.

2. **Component B mechanics underspecified** — Fixed. Added: the loop is builder-driven (not porch-driven), porch is unaware of branches/PRs, branch naming is up to the builder, porch tracks phases not git operations.

3. **Cold-start resume scope** — Fixed. Explicitly scoped to verify + read-only phases.

4. **Backward compatibility detection** — Fixed. Added detection mechanism: check whether `gates` map has a `verify-approval` entry; if the protocol defines verify but the project's phase is `complete` with no verify gate, auto-transition to `verified`.

5. **`porch verify` is a new command** — Fixed. Constraints now explicitly say "One new porch subcommand: `porch verify` (with `--skip`). Zero new gate machinery, zero new gate sub-states."

6. **Cut-and-merge loop orchestration** — Fixed (same as issue 2 above).

7. **Verified codebase facts** — Appreciated. All 7 verified claims confirmed.
