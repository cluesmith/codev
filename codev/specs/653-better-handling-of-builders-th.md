# Specification: Decouple Worktree/Branch/PR and Add Optional Verify Phase

## Metadata
- **ID**: 653
- **Status**: draft (rewrite v3)
- **Created**: 2026-04-02
- **Reframed**: 2026-04-12 (architect reframing — earlier drafts were overengineered)
- **History**: Previous drafts explored checkpoint PRs, gate sub-states, `porch checkpoint`/`porch feedback` commands, structured verify notes, and a three-stage rigid team-visibility model. All of that is deleted. The architect reviewed the 752-line iter3 spec, left 12 inline review comments, and asked for a rewrite around a single core insight plus a much smaller verify phase.

## Problem Statement

Codev assumes **one builder = one branch = one PR**. That assumption drives two distinct pain points:

1. **Premature mid-protocol PRs (the original #653)**: when a builder opens a PR mid-protocol, there is no clean way to finish it, merge it, and open a fresh PR for the next stage. Architects work around this manually.
2. **No post-merge phase**: the project lifecycle ends when the PR merges. "Code merged" and "change works in the target environment" are collapsed into a single terminal state, and there is no protocol-level place for environmental verification.

Both issues share a root cause: the worktree, the branch, and the PR are conflated. Break them apart and the workarounds become unnecessary.

## Core Insight: Worktree ≠ Branch ≠ PR

A builder is a **persistent workspace**, not a PR factory.

- **Worktree**: persistent, keyed by project ID only (`.builders/<protocol>-<id>/`). Created once by `afx spawn`, destroyed only on explicit `afx cleanup`. Survives across many PR merges.
- **Branch**: transient. Cut from the worktree when a PR is needed, merged, then deleted. The worktree then pulls `main` and cuts a fresh branch for the next stage.
- **PR**: output of a branch. At most one open PR per worktree at any moment (matching git worktree semantics). Many PRs over a project's lifetime, sequentially.

The sequential PR flow looks like:

```
Stage 1: worktree cuts branch stage-1 → PR #1 → merge → delete stage-1
Stage 2: worktree pulls main → cuts stage-2 → PR #2 → merge → delete stage-2
Stage 3: worktree pulls main → cuts stage-3 → PR #3 → merge → delete stage-3
...
```

This is how the architect already thinks about the work. Codev needs to catch up.

## Desired State

### 1. Worktree / Branch / PR decoupling

- Worktree path depends on **project ID only**, not issue title (coordinates with #662).
- The builder can open a PR, wait for merge, pull `main`, cut a new branch, and open another PR — all within the same worktree.
- `afx cleanup` does **not** run automatically on PR merge. Cleanup is explicit and architect-driven.

### 2. Single state model: porch's phase + gate status is the canonical project state

**Design principle**: protocol definitions in `protocol.json` define phases. These ARE the project states. `status.yaml`'s `phase` field IS the project's current state. All consumers — `afx status`, the dashboard, reporting, CLAUDE.md tracking, GitHub issue labels — read `status.yaml` directly. No parallel state vocabulary exists. No translation layer, no derived states, no lossy compression.

If someone asks "what state is project 653 in?" the answer is `phase: review, gate pr: pending` — not "committed" or "implementing" or any other translated term. The mapping between phase names and human-readable meaning is 1:1.

A project that has no `status.yaml` simply doesn't exist in porch yet.

Concrete requirements:
- `status.yaml` is committed at every phase transition to `codev/projects/<id>/status.yaml`. When a PR merges, status.yaml lands on `main`. This is a **hard requirement**.
- Porch can read `status.yaml` from either the worktree's local copy or from `main`.
- **Cold-start fallback**: if the builder's shell is gone for a long time, porch can resume by reading `status.yaml` from `main`. Cold-start without a worktree is scoped to **verify and read-only phases**. Code-writing phases (`implement`) need a worktree and fail with a "worktree required" error directing the user to `afx spawn <id> --resume`.

### 3. Optional verify phase

- SPIR and ASPIR gain an **optional** post-`review` phase named `verify`, powered by the existing `handleOncePhase` at `packages/codev/src/commands/porch/next.ts:741` (same mechanism BUGFIX already uses).
- The **terminal state is renamed from `complete` to `verified`** (the current codebase uses `phase: 'complete'` for finished projects, not `integrated`).
- The verify phase has **no artifact, no template, no sign-off block, no checklist**. It emits one task: *"Verify the merged change in your environment, then run `porch approve <id> verify-approval` when you're satisfied."* The success criterion for verify is whatever the architect decides — porch does not model it.
- The `verify-approval` gate uses the same human-only guard as `spec-approval` and `plan-approval`.
- `porch verify <id> --skip "reason"` transitions directly to `verified` for projects that don't need environmental verification. One command, one flag, no note.

### 4. `pr-exists` tightening (standalone correctness fix)

- Change `pr-exists` forge scripts to return true only for `OPEN` or `MERGED` PRs, not `CLOSED`-not-merged.
- Ships independently of everything else.

## Architect-Builder Interaction Model

Porch runs in the **builder's** context throughout the entire lifecycle, **including verify**. The architect does not run porch commands — the architect gives high-level instructions via `afx send`, and the builder decides which porch operations to run:

- *"Create a draft PR with the current spec so I can share it with the team"* → builder creates the PR
- *"Team said we need X, Y, Z — revise the spec"* → builder revises and continues porch
- *"Spec looks good, let's merge it and start on the plan"* → builder merges, pulls main, cuts a new branch for the plan phase
- *"PR merged, verify it"* → builder pulls main into its worktree, runs the verify phase, and waits for the architect to approve `verify-approval`

The builder **stays alive through verify** by default. After the final PR merges, the builder pulls `main`, enters the verify phase, and drives it. The `ci-channel` delivers merge events so the builder knows when to proceed.

**Fallback — cold-start resume**: if the builder has been gone for a long time (terminal closed, context lost), the architect can resume the project from a cold start by reading `status.yaml` from `main`. This is the fallback, not the default. In this mode, the architect (or anyone) runs `porch next <id>` from the repo root to see verify tasks, and `porch approve <id> verify-approval` (or `porch verify <id> --skip`) to close the project.

## Solution Approach

### Component A — `pr-exists` tightening

Update `packages/codev/scripts/forge/{github,gitlab,gitea}/pr-exists.sh` to exclude `CLOSED`-not-merged PRs. Small, isolated change plus unit test. Ships on its own.

### Component B — Worktree/branch/PR decoupling

1. **Worktree path**: normalize to `.builders/<protocol>-<id>/` — no title suffix. #662 is a **prerequisite** for this; if #662 hasn't shipped yet, Slice B either waits or implements the path change as part of its own work.
2. **Cut-and-merge loop support**: the loop is **builder-driven** — the builder handles the git mechanics (create branch, open PR, wait for merge via `ci-channel`, pull `main`, cut next branch). Branch naming is up to the builder (e.g. `spir/653/specify`, `spir/653/implement-phase-1`); porch does not enforce it. However, **porch records PR history**: when a PR is created or merged, the builder tells porch (via status.yaml writes) the PR number, branch name, and merged status. status.yaml is the project's history. The exact schema for per-stage PR records is a plan-phase detail. `afx cleanup` must not run automatically on merge.
3. **status.yaml committed at every phase transition**: this is a **hard requirement**. Every phase transition, gate request, gate approval, and verify skip must commit and push `status.yaml` to the current branch. When the branch merges, status.yaml lands on `main` naturally. The plan must enumerate which `writeState` calls currently commit/push and fill any gaps — there must be zero gaps.
4. **Cold-start resume**: porch's lookup for `status.yaml` walks up from CWD; if not found locally (no worktree present), it falls back to reading `main:codev/projects/<id>/status.yaml`. `porch next <id>` run from the repo root works for verify and read-only phases; code-writing phases fail with a clear "worktree required" error.

### Component C — Optional verify phase

1. **Protocol definitions**: add a `verify` phase to `codev/protocols/{spir,aspir}/protocol.json` (and the skeleton equivalents) after `review`. Phase type: `once`. Next: `null`.
2. **Gate**: `verify-approval`, human-only, using the same guard as `spec-approval`/`plan-approval`.
3. **Task emission**: one task with a one-line description instructing the human to verify in their environment and run `porch approve <id> verify-approval` when satisfied. No other artifact.
4. **Terminal state rename**: the state reached after `verify-approval` is named `verified`. Update `ProjectState`, `afx status`, and workspace views accordingly.
5. **Opt-out**: `porch verify <id> --skip "reason"` transitions directly to `verified`. The reason is **required** (not optional) and recorded in `status.yaml` for audit.
6. **Backward compatibility**: porch detects pre-upgrade projects by checking whether `status.yaml` has a `verify-approval` entry in its `gates` map. If the loaded protocol definition includes a `verify` phase but `gates` has no `verify-approval` key and the project's `phase` is already `complete`, porch auto-transitions to `verified` on load. No protocol-version field is needed.

## Success Criteria

- [ ] `pr-exists` forge scripts exclude `CLOSED`-not-merged PRs
- [ ] Worktree path uses project ID only (#662 coordinated)
- [ ] A builder can open PR #1, wait for merge, pull main, cut stage-2, and open PR #2 without `afx cleanup` running
- [ ] `status.yaml` is committed and pushed at every phase transition, gate request, and gate approval — zero gaps
- [ ] `status.yaml` records PR numbers per stage (PR number, branch name, merged status). Exact schema is plan-phase detail.
- [ ] Single state model: porch's `phase` + gate status is the canonical project state. `afx status`, dashboard, reporting, and all consumers read `status.yaml` directly. No parallel vocabulary, no translation layer.
- [ ] Porch can resume a project from a cold start (verify + read-only phases) by reading `status.yaml` from main
- [ ] SPIR and ASPIR gain an optional `verify` phase after `review`
- [ ] The builder stays alive through verify by default; cold-start is the fallback
- [ ] `verify-approval` is a human-only gate
- [ ] Terminal state is named `verified` (renamed from `complete`; existing `phase: 'complete'` values must be migrated)
- [ ] `porch verify <id> --skip "reason"` transitions directly to `verified`
- [ ] `afx status` and the workspace view show `verified` as the terminal state
- [ ] One new porch subcommand (`porch verify`). Zero new gate sub-states.
- [ ] Unit tests cover: the decoupled cut-and-merge flow, cold-start resume, the verify phase transition, and the `--skip` path

## Implementation Ordering

Three shippable slices, in order:

- **Slice A — `pr-exists` tightening**: standalone correctness fix. Ships first.
- **Slice B — Worktree/branch/PR decoupling**: the core insight. Coordinates with #662 on worktree path. Largest of the three.
- **Slice C — Optional verify phase**: depends on Slice B's cold-start resume. Ships last.

Each slice is one PR. The three pieces together close the original issue.

## Constraints

- The builder drives the entire lifecycle including verify. Cold-start (architect runs porch directly) is the fallback only.
- One new porch subcommand: `porch verify` (with `--skip`). Zero new gate machinery, zero new gate sub-states.
- `verify-approval` uses the existing human-only gate guard. No new guard machinery.
- The verify phase reuses `handleOncePhase` at `next.ts:741`. Not reinvented.
- No `forge` CLI — if a PR-state check is needed anywhere, intercept it by name in `checks.ts` like `pr_exists` at `:262`.
- **Single state model**: porch's `phase` + gate status is the canonical project state for the entire system. No parallel vocabulary. All consumers read `status.yaml`.

## Out of Scope

Items deleted from earlier drafts (not deferred — not needed under the multi-PR model):

- `porch checkpoint`, `porch feedback` commands, gate sub-states (`external_review`, `feedback_received`)
- Verify note artifact, template, sign-off block, multi-verifier entries
- Three-stage rigid team-visibility framing
- Checkpoint PR commits accumulating on one long-lived branch
- One-builder-equals-one-PR assumption
- Separate project-tracking vocabulary (`conceived`, `specified`, `committed`, etc.)

**TICK protocol deprecation**: TICK (amendment workflow for existing specs) becomes redundant once multi-PR worktrees land — amendments during verify are just another PR from the same worktree. TICK was a workaround for the 1-builder-1-PR constraint. Actually deprecating/removing TICK from the codebase is a follow-up, not part of this spec. Protocol list after this ships: SPIR, ASPIR, AIR, BUGFIX, MAINTAIN, EXPERIMENT.

## Open Questions

- [x] When porch resumes from a cold start without a worktree, can every phase run from the repo root? — **No.** Code-writing phases (`implement`) need a worktree. Cold-start resume is scoped to verify and read-only phases. Resolved in Desired State section 2.
- [x] Should `porch verify --skip` require a `--reason`? — **Yes, required.** Resolved in Component C item 5.
- [ ] Does the verify phase need its own prompt file, or is the one-line task content inline in `protocol.json`? Minor — plan phase decides.

## Notes

The reframing collapses a 752-line spec into ~180 lines by removing everything that doesn't fall out of the worktree/branch/PR decoupling. The architect's 12 inline review comments on iter3 are all addressed in this rewrite.

Porch's `max_iterations=1` policy (commit `ebb68cb3`, 2026-02-15) is intentional: multi-iteration consultation rarely adds marginal value. This spec goes through a single verify pass; if reviewers REQUEST_CHANGES, the rebuttal flow handles it, not a manual consult loop.
