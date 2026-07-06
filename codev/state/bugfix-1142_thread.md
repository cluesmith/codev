# Builder thread — bugfix-1142

Issue #1142: tower-cron conditions can't see `exitCode` (ReferenceError every run) and failure runs can never deliver alerts.

## Investigate (2026-07-06)

Reproduced and confirmed root cause, all in `packages/codev/src/agent-farm/servers/tower-cron.ts`:

1. `evaluateCondition()` builds `new Function('output', 'return ' + condition)` — `exitCode` is not in scope, so `condition: "exitCode != 0"` throws `ReferenceError` every run (12,453 occurrences in my local `~/.agent-farm/tower.log`). The catch at the call site forces `shouldNotify = false`.
2. `runCommand()` rejects on any non-zero exit, so the exit code is never captured as data — `executeTask` classifies it as `result = 'failure'`.
3. Delivery gate is `if (shouldNotify && result === 'success')` — failure runs only log a WARN. "Alert me when this command fails" is inexpressible.

Doc surfaces for the condition environment (`output: string`, `exitCode: number`):
- `.claude/skills/afx/SKILL.md` + `codev-skeleton/.claude/skills/afx/SKILL.md` (`## afx cron` section, currently CLI-commands-only)
- `codev/resources/commands/agent-farm.md` + `codev-skeleton/resources/commands/agent-farm.md` (no cron section yet — will add one)

Fix design is prescribed in the issue (carry it as-is): capture `{output, exitCode}` in `runCommand` (resolve on plain non-zero exit, keep rejecting on `error.killed`/`error.signal`/spawn failure), pass `exitCode` as second param to conditions, deliver on condition-true regardless of success/failure split, keep no-condition tasks delivering only on exit 0, keep `last_result` semantics by exit code.

Scope: ~100 LOC in one source file + regression tests + docs. Well within BUGFIX. → PHASE_COMPLETE

## Fix (2026-07-06)

Implemented the prescribed design in `tower-cron.ts` (commit ecf294ae):
- `runCommand` now resolves `{ output, exitCode }`; plain non-zero exits resolve (exit code is data), only spawn failures / timeout-kills reject (exitCode -1 / 124 in the catch).
- `evaluateCondition(condition, output, exitCode = 0)` — both variables in Function scope.
- Delivery: with a condition, the condition alone decides (failure runs can deliver); without one, deliver only on exit 0 (unchanged). `last_result` semantics unchanged.
- 8 new regression tests (34 total in tower-cron.test.ts, all pass). Full suite: 3440 passed / 48 pre-existing skips.
- Docs: condition environment (`output`, `exitCode`) documented in the afx skill `## afx cron` section and a new `### afx cron` section in agent-farm.md — BOTH trees (codev/ + codev-skeleton/, and .claude/skills + skeleton skills).
- Root `pnpm build` passes.
