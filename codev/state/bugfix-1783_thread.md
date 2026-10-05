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
