# Phase 2 iter 1: responses to consultation

Verdicts: gemini APPROVE, codex REQUEST_CHANGES, claude COMMENT.

## codex
- **Node dir not moved to front when already later on PATH.** Accepted. `buildIdeServerEnv` now removes every existing occurrence and prepends; test asserts index 0 and no duplicates.
- **Leading zeroes accepted by the strict parser.** Accepted. Each component is now `0|[1-9]\d*`; test covers `01.128.0`, `1.0128.0`, `1.128.00`.

## claude
- **execFile timeout is SIGTERM-based, so not a hard bound.** Accepted, and widened: `execFile`'s callback also waits for stdio to close, so `killSignal: 'SIGKILL'` alone would still hang when a grandchild holds stdout. `runVersion` now uses its own timer that SIGKILLs the child, destroys its pipes and rejects immediately. New test: a server that traps TERM and leaves a sleeping grandchild is refused within 2 s of a 300 ms bound (the old implementation takes ~5 s). Phase 3's install call will reuse the same shape.
- **Tautological source assertion in the floor-tie test.** Accepted. The test now always reads `apps/vscode/package.json` and additionally the embedded manifest when built, asserting the floor against each source with the source named in the failure message; it asserts the manifest is included exactly when it exists.
- **compareVersions returns NaN on non-strict input.** Accepted. It now throws on any non-strict operand; test added.
- **190 s start budget.** Noted, no change: the formula is the plan's, and phase 5 prints a progress line while waiting.

## gemini
- No issues.
