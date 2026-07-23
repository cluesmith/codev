# Review: Configurable Porch Gate Artifact Auto-Open

## Summary

Implemented an opt-out for Porch's automatic specification, plan, and review
artifact opens. `porch.autoOpenArtifacts: false` suppresses the producer-side
`afx open` action while leaving gate persistence, output, approval, manual file
opens, and Tower's generic new-tab focus behavior unchanged.

Agent Farm now makes the main workspace's personal
`.codev/config.local.json` effective in builders through an atomically refreshed
regular-file snapshot during spawn and `afx setup`. Documentation in the
project and shipped skeleton describes the setting, precedence, and snapshot
ownership model.

## Spec Compliance

- [x] Unset and explicit `true` retain the existing automatic open.
- [x] Explicit `false` suppresses automatic opens for specification, plan, and
  review gates.
- [x] Disabled gates retain pending state, audit commits, artifact output, and
  approval instructions without claiming the artifact is opening.
- [x] Missing and unmapped artifacts remain no-op open paths.
- [x] Global, project, and project-local precedence remains authoritative.
- [x] Fresh-worktree and `afx setup` paths refresh a non-symlink personal-config
  snapshot without letting builder writes mutate the main source.
- [x] Manual `afx open` and dashboard focus behavior remain unchanged.
- [x] Project and skeleton documentation contain equivalent public guidance.
- [x] Focused, full-suite, build, and Tower integration verification passed.

## Deviations from Plan

- The Tower verification used a disposable main-config source with the
  production snapshot helper targeting the real builder worktree rather than
  modifying the developer's actual gitignored main-workspace config. This
  preserved the personal-file ownership boundary while exercising the same
  loader, Porch gate, Tower tabs API, and browser focus path. The real
  `createWorktree` and `afx setup` entry points are separately covered by
  ordering and filesystem integration tests.
- Phase 2 gained an additional real-filesystem `setup()` test after review to
  prove refreshed bytes exist before post-spawn hooks.
- The package-wide test check exposed global `HOME` leakage in
  `tower-utils.test.ts`; with architect approval, that test now isolates
  `HOME` so default-harness assertions cannot inherit an engineer's global
  shell configuration.

## Test Results

- Focused config, gate, spawn, setup, and snapshot suites: **140 passed**.
- Package-wide Vitest suite: **3,638 passed, 48 existing skips, 0 failed**.
- Root `pnpm build`: **passed**.
- Porch build and test checks: **passed**.
- Headless Tower flow: disabled gate created **0** file tabs and left **Work**
  active; manual `afx open` created and focused the expected file tab.

## Architecture Updates

Updated the COLD `codev/resources/arch.md` Worktree Creation section to record
the current setup order and ownership model: shared config is symlinked,
personal config is copied atomically as a regular-file snapshot, `afx setup`
refreshes it, and post-spawn hooks run afterward. No HOT
`arch-critical.md` change was needed because this is Agent Farm reference
detail rather than an always-on, cross-cutting invariant.

## Lessons Learned

### What Went Well

- The producer-side guard was a narrow authoritative boundary and required no
  dashboard change.
- Parameterized gate tests covered all mapped phases and both enabled states
  without mocking Porch itself.
- Combining filesystem tests with Tower/browser verification established both
  the mutation boundary and the user-visible outcome.

### Challenges Encountered

- Untracked new test files were absent from early consultation diff scopes,
  causing reviewers to report missing coverage that existed on disk.
- Porch hardcodes pushes to upstream `origin`; the contributor lacks upstream
  write access, so each committed state transition had to be pushed separately
  to `fork` after Porch reported the expected permission error.
- The full suite initially inherited a developer-global architect harness,
  making default-harness tests environment-dependent.

### What Would Be Done Differently

- Stage or commit new test files before the first implementation consultation
  so every reviewer receives the complete canonical diff.
- Plan contributor/fork push behavior before the first mutating Porch command
  so protocol state synchronization does not repeatedly fail after local
  commits.

### Methodology Improvements

- Consultation tooling should include intended untracked phase files or warn
  clearly that its changed-file scope omits them.
- Porch should support a configured push remote for cross-fork contributors
  instead of assuming `origin` is writable.

## Lessons Learned Updates

Added a COLD `codev/resources/lessons-learned.md` architecture lesson: when
personal gitignored configuration must enter a mutable builder worktree, use a
managed copy rather than a write-through symlink and refresh it before setup
hooks. No HOT `lessons-critical.md` update was needed; this is a useful
worktree/config recipe, not a universal behavior-changing rule.

## Consultation Feedback

### Specify Phase (Round 1)

#### Gemini

- No concerns raised (APPROVE).

#### Codex

- **Concern**: The personal config propagation requirement did not explicitly
  protect the main file from builder-side mutation or directly require fresh
  spawn plus `afx setup` coverage.
  - **Addressed**: Added the mutation boundary, fresh-spawn, refresh, and
    idempotency requirements to the specification.

#### Claude

- No concerns raised (APPROVE).

### Plan Phase (Round 1)

#### Gemini

- No concerns raised (APPROVE).

#### Codex

- **Concern**: Builder-worktree execution and the canonical documentation
  target needed to be explicit.
  - **Addressed**: Required the integration flow to run from the builder and
    confirmed `agent-farm.md` as the Porch configuration reference.

#### Claude

- No concerns raised (APPROVE).

### Producer-Side Porch Toggle (Round 1)

#### Gemini

- No concerns raised (APPROVE).

#### Codex

- **Concern**: The new gate test was absent from the generated changed-file
  scope.
  - **Addressed**: Made the existing real-`gate()` test visible in the tracked
    diff and retained its spawn/output/state assertions.

#### Claude

- **Concern**: Correct implementation files were not yet committed.
  - **Addressed**: Committed the Phase 1 implementation and tests before phase
    completion.

### Producer-Side Porch Toggle (Round 2)

#### Gemini

- No concerns raised (APPROVE).

#### Codex

- **Concern**: Enabled-path coverage only exercised `specify` and omitted
  persisted state assertions.
  - **Addressed**: Expanded to the full specify/plan/review × unset/true matrix
    and asserted the pending gate plus `requested_at`.

#### Claude

- No concerns raised (APPROVE).

### Producer-Side Porch Toggle (Round 3)

- No concerns raised — Gemini, Codex, and Claude approved.

### Safe Builder Personal-Config Snapshot (Round 1)

#### Gemini

- **Concern**: The filesystem snapshot test appeared absent from the review
  scope.
  - **Addressed**: Committed the existing real-filesystem snapshot test,
    covering regular-file copies, loader behavior, refresh, idempotency,
    source immutability, and absent-source behavior.

#### Codex

- **Concern**: The review lacked real-filesystem proof for both snapshot
  semantics and the `afx setup` path.
  - **Addressed**: Made the snapshot test visible and added a real `setup()`
    filesystem test that observes refreshed bytes before hooks.

#### Claude

- **Concern**: Phase 1 and Phase 2 code plus tests were uncommitted, and a setup
  test was outside the canonical changed-file list.
  - **Addressed**: Committed both phases and all planned test files before the
    next round.

### Safe Builder Personal-Config Snapshot (Round 2)

- No concerns raised — Gemini, Codex, and Claude approved.

### Documentation and End-to-End Verification (Round 1)

- No concerns raised — Gemini, Codex, and Claude approved the synchronized
  documentation and recorded Tower/manual-open verification.

### Review / PR (Round 1)

#### Gemini

- No concerns raised (APPROVE).

#### Codex

- **Concern**: A supplemental builder-thread checkpoint did not use the
  implementation-phase commit format.
  - **Rebutted**: The phase-qualified form applies to implementation commits;
    the checkpoint only updated documentation and all product-phase commits
    use the required format. Rewriting published history would invalidate
    recorded hashes without changing product traceability.
- **Concern**: Agent Farm harness inputs and protocol context files left the
  worktree dirty.
  - **Addressed**: Committed all remaining `codev/projects/1216-*` Markdown
    protocol artifacts at architect request and intentionally excluded only
    the generated builder harness files from this PR.

#### Claude

- No concerns raised (APPROVE).

## Technical Debt

- Porch's fixed `git push -u origin HEAD` policy does not support contributors
  who must push state transitions to a fork remote.

## Flaky Tests

No flaky tests were skipped during this project.

## Follow-up Items

- Consider a configurable Porch push remote for fork-based contribution
  workflows.
- Consider warning when consultation scope excludes untracked phase files.
