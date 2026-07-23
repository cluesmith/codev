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
