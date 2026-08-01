# bugfix-1267 — builder launch loop: clean exit must rerun fresh

## Investigate

**Bug**: `startBuilderSession`'s resume branch (`spawn-worktree.ts`) bakes
`${baseCmd} ${resume.scriptFragment}` (`claude --resume <uuid>`) as the *only*
command inside `while true; do … done`. The shared `LAUNCH_LOOP_TAIL` clean-exit
branch does `read -r … continue`, so the Enter-gated relaunch reruns the same
line — resuming the conversation the user just deliberately ended. #1264's spec
for architects is: clean exit → rerun fresh, no recovery.

**Reproduced** with a fake agent + a copy of the generated resume script:

```
LAUNCH: --resume abc-1234-uuid     ← initial
LAUNCH: --resume abc-1234-uuid     ← after clean exit + Enter   (should be fresh)
```

**Scope decisions**

- Issue point 2 (Enter gate vs auto-rerun for builders) is an explicitly open
  product question in the issue. Out of scope: the gate stays as #1244 shipped it.
  Only *what* the relaunch runs changes, not *when* it runs.
- "Fresh" = exactly what a non-resume spawn of this builder would run
  (role injection + `.builder-prompt.txt`), which is what the other three script
  variants already rerun. Symmetric, and no new notion of freshness invented.
- **Do not rewrite `.builder-prompt.txt` on the resume path.** `afx reset`
  (`reset/context.ts:modeFromBuilderPrompt`) reads the literal `## Mode:` heading
  out of it as spawn-time ground truth, precisely because `--resume` never
  rewrites it — and `resolveMode` cannot recover a spawn-time `--soft`. So the
  fresh relaunch *reads* the existing file; it does not regenerate it.
- Crash restarts keep resuming (that is recovery, and correct) — but once a
  clean exit has switched the loop to fresh, later crashes rerun the fresh form,
  never the superseded session.

## Fix

`LAUNCH_LOOP_TAIL` (const) → `launchLoopTail(onCleanExit?)` + an exported
`buildLaunchLoop(initial, fresh)` that all five generated-script sites now go
through. When `initial === fresh` (every non-resume variant) it returns the
historical single-command loop byte for byte; when they differ it emits two
bash launcher functions and a `codev_launch` selector that the clean-exit branch
flips to `codev_launch_fresh` — sticky, so a later crash restarts fresh too.

Functions rather than a command string in a variable: the fresh invocation
carries its own quoting (`--append-system-prompt "$(cat '…')"`), which would be
word-split if re-expanded from a variable. There is a test for exactly that.

`startBuilderSession` restructured so role injection / harness worktree files
are prepared on the resume path too (the relaunch is a real fresh launch and
needs them), with `.builder-prompt.txt` the one thing resume still does not
rewrite.

Tests: `bugfix-1267-launch-loop.test.ts` **executes** the generated bash with a
fake agent and asserts the invocation sequence — string assertions could not
have caught this bug, since the old string was "correct" and the loop semantics
were wrong. Verified they fail against the pre-fix single-command loop (3 of 7
fail, restored after). Plus a guard that `afx reset`'s harness detection still
identifies `claude` through the new dual-launcher shape.

## PR

PR #1317. CMAP: gemini=APPROVE, codex=COMMENT, claude=APPROVE — no blocking
issues, four findings, all addressed and pushed:

- **codex**: the quoting test's fake agent logged `"$*"`, so one argument
  `"two words"` and two arguments `"two" "words"` rendered identically — the
  assertion proved nothing. Logs `"$@"` one-per-`|` now.
- **claude**: past the scripted exit codes the fake agent hit `exit ""` → bash
  255 → the loop auto-restarted and spun to the 30s timeout. A future regression
  should fail as a wrong invocation list, not a hang. Defaults to 0.
- **claude**: documented why `.builder-prompt.txt` is guaranteed present on the
  resume path (an invariant of `startBuilderSession`, not a worktree
  assumption) rather than adding a runtime guard that would mask a broken tree.
- **claude**: `reset/reorient.ts` called `.builder-role.md` "the copy injected
  at spawn"; resume refreshes it now too.

claude's one unreproducible `6 failed` run of `src/agent-farm` it closed itself
(3 clean directory runs, 10 clean isolated runs, clean `main` baseline).

Full suite after the fixes: 4051 passed / 0 failed / 48 skipped.
Awaiting the `pr` gate — human approval, then merge.
