# bugfix-1783 thread

## Investigate (2026-10-05)
- Root cause: `detectCurrentBuilderId()` and `detectWorkspaceRoot()` (packages/codev/src/agent-farm/commands/send.ts)
  derive identity ONLY from `process.cwd()` matching `/.builders/<id>`. Builder terminals carry no identity env
  (the start script only `cd`s), so a builder running `cd <main root> && afx send architect` resolves as a
  non-builder -> `architectSenderId()` -> bare `architect` -> Tower routes to `main`, and the `architect:<name>`
  spoofing guard is skipped.
- All identity consumers (send, reset, interrupt, self-refresh, whoami) share these two functions, so one fix covers all.
- Plan: export `CODEV_BUILDER_WORKTREE` from `.builder-start.sh` (both script builders in spawn-worktree.ts),
  prefer it over cwd in both resolvers (still verified against global.db), strip it in `sanitizeAgentEnv` so a
  Tower started from a builder shell can't leak it into other terminals, clear it in vitest-setup so tests run
  inside a builder session stay hermetic. Plus narrow the "afx only from main root" doc rule to spawn/cleanup.
- Existing builders get the env var on their next `afx spawn --resume` (script is regenerated on resume).

## PR #1784 + CMAP (2026-10-05)
- First CMAP run failed lookup ("No PR found for branch") right after PR creation; reran with `--issue 1784`.
- Verdicts: gemini=APPROVE, codex=APPROVE, claude=APPROVE (no blocking issues).
- Applied claude's cheap non-blocking notes: scar-rules.yaml `afx-from-root` canonical now carries the send exception;
  vitest-setup imports BUILDER_WORKTREE_ENV; identityPath requires an absolute path (relative value falls back to cwd).
- Out of scope, raised to architect as follow-ups: consult's `isBuilderContext()` (commands/consult/index.ts:296) is the
  same cwd-only derivation; `codev doctor`'s Tower env check is blind to CODEV_BUILDER_WORKTREE.
