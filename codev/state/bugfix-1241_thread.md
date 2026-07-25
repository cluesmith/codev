# bugfix-1241 — auto-restart should only trigger on unnatural exits

## Investigate

**Repro / mechanism** (read from code, plus a node-pty probe):

- Builder terminals: `.builder-start.sh` is a `while true; do <agent>; echo "Agent exited.
  Restarting in 2 seconds..."; sleep 2; done` loop, generated in 5 places in
  `packages/codev/src/agent-farm/commands/spawn-worktree.ts`
  (resume / role / no-role in `startBuilderSession`, role / no-role in
  `buildWorktreeLaunchScript`). The loop is exit-code blind — a clean `/quit`
  (exit 0) respawns exactly like a crash.
- Architect terminals: launched directly by Tower (`tower-instances.ts`, no bash
  loop) with `restartOnExit: true`, so the respawn comes from
  `session-manager.ts` `setupAutoRestart`, which is also exit-code blind: it
  increments `restartCount` and re-SPAWNs on *any* exit.
- Builder sessions do NOT set `restartOnExit`, so the two layers are cleanly
  split: layer 1 = builders, layer 2 = architects.

**Key finding — the naive `code === 0` test is wrong.** node-pty reports signal
deaths as `exitCode 0` plus a signal (probed here: SIGKILL →
`{exitCode: 0, signal: 9}`; normal exit → `{exitCode: 0, signal: 0}`), and
`shellper-process.ts` stringifies that field. So "deliberate quit" must be
`code === 0 && signal in (null, '', '0')`, otherwise a SIGKILLed agent would
stop restarting — the opposite of what the issue asks.

**Note on the issue text**: it mentions "the Kimi provider-owned variants" of
the launch script. There is no Kimi provider in this repo (`grep -ri kimi` is
empty); all launch-loop generation lives in the 5 sites above, and they are all
covered.

**Third surface found (not named in the issue)**: `pty-session.ts`
`attachShellper`'s exit handler prints `[Process exited — restarting...]` and
arms a 10s "wait for the restart" timer whenever `restartOnExit` is set. With
the layer-2 fix in place that restart never comes, so it must also branch on a
deliberate exit — otherwise a clean architect quit shows a false "restarting"
notice and then tears down 10 seconds later.

Scope: 3 source files + tests, well under 300 LOC. BUGFIX-appropriate.

## Fix

- `shellper-protocol.ts`: `isDeliberateExit()` — the one predicate both layers use.
- `session-manager.ts`: deliberate exit → log, emit `session-clean-exit`, drop
  the dead session, do not count it, do not respawn.
- `pty-session.ts`: deliberate exit → print the clean-exit line and end cleanly
  (no false "restarting" notice, no 10s timer).
- `spawn-worktree.ts`: all 5 loops share one `LAUNCH_LOOP_TAIL` — exit 0 clears
  the screen and gates the relaunch on Enter; EOF on stdin exits instead of
  spinning; nonzero/signal keeps the 2s auto-restart.

Deviation from the issue's "leave the PTY open" for the architect: the session
is dropped from SessionManager and PtySession emits `exit`, because Tower's
`workspace start` is gated on `!entry.architects.has('main')` — keeping the
registered-but-dead terminal would make the architect unrelaunchable without a
full workspace stop/start. Ending cleanly clears the architect row, so
`afx workspace start` brings it back. The shellper husk itself is not killed.

## PR

PR #1244 opened. CMAP 3-way: gemini=APPROVE, codex=APPROVE, claude=APPROVE — all
HIGH confidence, zero key issues, nothing to address. Results posted as a PR
comment. Architect notified. Waiting at the `pr` gate.

Full suite green throughout: 3655 passed / 0 failures; build green.
