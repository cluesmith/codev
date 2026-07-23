### Iteration 1 Reviews
- gemini: APPROVE — The implementation perfectly aligns with the plan for the `porch_toggle` phase, cleanly toggling the auto-open behavior while preserving gate state integrity.
- codex: REQUEST_CHANGES — The toggle implementation itself looks correct, but Phase 1 is not complete because the required gate-boundary Porch tests were not added.
- claude: COMMENT — Implementation is clean, correct, and well-tested — all Phase 1 acceptance criteria are met in the code, but implementation files need to be committed to the branch before the phase is truly complete.

### Builder Response to Iteration 1
# Rebuttal — `porch_toggle` iteration 1

## Codex: required gate-boundary tests appeared absent

The requested behavioral test already exists at
`packages/codev/src/commands/porch/__tests__/gate-auto-open.test.ts`. It was
untracked when Consult generated Codex's changed-file list, so that static list
omitted the file even though it was present in the worktree. The file is now
explicitly staged so the next review prompt includes it.

The test calls the real exported `gate()` command with temporary protocol,
state, config, and artifact fixtures while mocking only
`node:child_process.spawn`. It covers:

- unset and explicit `true` enabled behavior, including spawn arguments,
  detached execution, and `unref()`;
- explicit `false` for specification, plan, and review artifacts;
- truthful disabled-path output and persisted pending-gate state;
- missing mapped artifacts under unset, `true`, and `false`; and
- an unmapped phase.

No implementation change was required in response to this review; the issue was
review-input visibility, not missing coverage. The focused suites pass 96/96,
and Porch's full build and test checks pass.

## Claude: implementation changes are not yet committed

This is expected during Porch's build/verify cycle. Porch commits the complete
plan-phase change only after reviewers approve it; committing manually before
that transition would bypass the strict-mode orchestration. The implementation,
tests, and adjacent HOME-isolation regression fix remain ready for Porch's
phase-completion commit after re-verification.


### Iteration 2 Reviews
- gemini: APPROVE — The implementation perfectly aligns with the plan for the porch_toggle phase, correctly introducing the autoOpenArtifacts config and gating the afx open behavior while preserving gate semantics.
- codex: REQUEST_CHANGES — The Phase 1 implementation is correct, but the gate-boundary test matrix is still narrower than the approved `porch_toggle` plan requires.
- claude: APPROVE — Clean, minimal toggle implementation with comprehensive gate-boundary tests covering all config states, artifact phases, and missing/unmapped edge cases — all Phase 1 acceptance criteria are met.

### Builder Response to Iteration 2
# Rebuttal — `porch_toggle` iteration 2

## Codex: enabled-path phase matrix and persisted state

This was legitimate feedback and is now addressed in
`gate-auto-open.test.ts`.

The enabled cases are the Cartesian product of all three mapped artifact phases
(`specify`, `plan`, and `review`) and both enabled configuration states (unset
and explicit `true`). Every case now asserts:

- the exact `afx open` spawn arguments;
- detached execution and `unref()`;
- truthful opening output; and
- the persisted pending gate with a `requested_at` timestamp.

The focused gate suite passes all 13 tests after the change.


### IMPORTANT: Stateful Review Context
This is NOT the first review iteration. Previous reviewers raised concerns and the builder has responded.
Before re-raising a previous concern:
1. Check if the builder has already addressed it in code
2. If the builder disputes a concern with evidence, verify the claim against actual project files before insisting
3. Do not re-raise concerns that have been explained as false positives with valid justification
4. Check package.json and config files for version numbers before flagging missing configuration
