# Bugfix 1079 thread

## Investigate
Started BUGFIX investigation in strict mode. Issue reports `agy --print` is followed by another option, causing Antigravity CLI 1.0.10 to consume that option as the prompt.

Reproduced with installed `agy` 1.0.10:

- `agy --print --sandbox --print-timeout 45s 'Reply with exactly: AGY_ORDER_OK'` returned generic readiness text instead of the marker.
- `agy --sandbox --print-timeout 45s --print 'Reply with exactly: AGY_ORDER_OK'` returned exactly `AGY_ORDER_OK`.
- The installed `consult -m gemini --prompt 'Reply with exactly: CONSULT_GEMINI_OK'` returned empty-sandbox guidance, confirming the user-facing path is affected.

Root cause confirmed at `packages/codev/src/commands/consult/index.ts`: argv begins `--print --sandbox`, so agy consumes `--sandbox` as the string value of `--print`; the folded role/query is left as a trailing positional. `packages/codev/src/commands/doctor.ts` repeats the same contract violation with `--print --print-timeout ...`. Existing unit assertions check token presence or assume the prompt is simply the final token, so they do not enforce adjacency. A guarded real-agy integration test exists but currently exercises a file-reading task rather than explicitly locking the 1.0.10 print-value contract.

Scope assessment: minimal argv reordering plus focused unit/integration assertions across the two call sites; well under 300 LOC and no architecture change. BUGFIX remains appropriate.

## Fix

Reordered both call sites so all agy options precede the final `--print <prompt>` pair. Regression tests now assert adjacency for direct prompts, the `pro` alias, prompt files, folded role/query text, large-prompt indirection, and the doctor probe (including its `20s` timeout). Added a guarded real-agy contract test.

Verification:

- New unit assertions failed against the old ordering (`--sandbox` / `--print-timeout` observed as the print value), then passed after the fix.
- `pnpm build` passed.
- `pnpm test -- --run` passed: 166 files passed, 3 skipped; 3339 tests passed, 48 skipped.
- Guarded real-agy 1.0.10 inline contract test passed and returned its unique marker.
- Guarded real-agy file-access test passed and returned the planted file marker.
- Built front doors returned exact markers for `-m gemini --prompt`, `-m pro --prompt`, and `-m gemini --prompt-file`.

## PR

Opened PR #1081. CMAP results so far: Gemini APPROVE (HIGH) and Codex APPROVE (HIGH), both with no key issues. The initially invoked globally installed Gemini lane reproduced the very bug being fixed, so the review was rerun through the freshly built local CLI and then approved. Claude consultation is blocked by the Claude Code session limit until its stated 8:30pm America/Toronto reset; architect notified. Holding before the PR gate until the required third verdict is available.
