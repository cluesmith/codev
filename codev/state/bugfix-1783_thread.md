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

## Ruling (2026-10-05, main)
- Dir-gone/row-present edge: KEEP as is, no existsSync. Registry row is source of truth; that half-torn-down state (#1712 class) is for cleanup tooling, not identity resolution.
- Owner (2026-10-12): rule-then-exception wording was confusing. Rescoped the root-only rule to `afx spawn`/`afx cleanup` with the builder `afx send` case as its own sentence (CLAUDE/AGENTS, architect roles, scar-rules canonical, arch-critical); trimmed builder role + afx skill note to one sentence. Head moved off f277d603e with the owner's approval.
- Owner (2026-10-13): naming commands was wrong. findWorkspaceRoot (agent-farm/utils/config.ts:76) resolves a builder worktree as its own workspace, so most afx commands misbehave there, not just spawn/cleanup. Reverted all doc edits to the base: the blanket root-only rule stands with no exception. The CODEV_BUILDER_WORKTREE fix is what lets builders follow it (send from the main root now routes to the owner). PR is code-only now.
