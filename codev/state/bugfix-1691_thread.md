# bugfix-1691 thread

Issue #1691: `afx tower start` — surface the owner-guard refusal in the CLI instead of the
generic 30s timeout. Split from #1690 item 1; companion to #1689's owner guard (PR #1689,
`tower-owner.ts`). Scope is item 1 ONLY (per main's lane context). Items 2+3 (shutdown overlap,
clear-owner hatch, flock eval) stay in #1690 and are NOT mine.

Commit discipline (main): no closing keywords for #1690 — use `Refs #1690` if referencing;
`Fix #1691:` is fine. A `Fix #N` commit SUBJECT auto-closes on merge even with a clean PR body
(#1677 lesson).

## Investigate (done)

Root cause — `packages/codev/src/agent-farm/commands/tower.ts`:
- `towerStart()` spawns the tower-server daemon detached (`stdio: 'ignore'`, `unref()`), then
  `waitForServer(port)` (lines 149-160) polls ONLY `/api/status` for up to `STARTUP_TIMEOUT_MS`
  (30s). It has no awareness of the spawned pid's liveness.
- When the #1689 owner guard refuses, `bootSequence()` in `tower-server.ts` (lines 526-536) calls
  `log('ERROR', ownershipConflictMessage(...))` then `process.exit(1)`. The daemon dies within
  ~1s; the port never comes up.
- So `waitForServer` loops the full 30s, then prints the generic
  "Tower server failed to respond within 30000ms" (lines 266-271) — indistinguishable from the
  #1685 hang class. The teaching error is only in `tower.log`.
- Daemon log format (`tower-server.ts` `log()`, lines 142-161): `[iso] [ERROR] <message>\n`,
  first line prefixed, continuation lines (the multi-line `ownershipConflictMessage`) unprefixed.

Fix shape (implement phase):
1. Detect fast-exit: track the spawned child's `exit` event; the readiness wait stops immediately
   when the daemon dies before the port responds (no more burning 30s).
2. Surface verbatim: capture `tower.log` byte offset right before the daemon can write, then on
   fast-exit read everything appended since and print it (the guard's teaching error, or any
   other early-boot failure).
3. Three distinguishable outcomes: `started` / `exited` (refused-with-reason) /
   `timeout` (timed-out-still-unknown).

Testable seam: extract an injectable `waitForServerOutcome(probe, daemonAlive, opts)` returning
the discriminated outcome, plus a `readLogSince(offset)` helper. Regression test drives the seam
with fakes (daemon dies while probe stays false → `exited` well before timeout) and asserts the
launcher surfaces the teaching error + exits non-zero on fast-exit.

## Fix (done)

Changed one product file: `packages/codev/src/agent-farm/commands/tower.ts` (+89/-11). No
skeleton twin (the Tower launcher is product code, not a shipped template — confirmed no
`tower.ts` under `codev-skeleton/`).

- New exported `TowerStartupOutcome = 'started' | 'exited' | 'timeout'` and
  `waitForServerOutcome(isReady, isDaemonAlive, opts)` replacing the old boolean `waitForServer`.
  It short-circuits to `exited` the instant the daemon is seen dead (with a final readiness
  re-probe for the benign same-tick race), so a refusal no longer burns the 30s budget.
- `towerStart` registers `serverProcess.on('exit')` → `daemonExited`, and captures the tower.log
  byte offset right after the launcher's pre-spawn writes. On `exited` it reads everything the
  daemon appended since (`readLogSince`) and prints it verbatim on stderr (the guard's teaching
  error), then `exit(1)`. Three distinguishable outcomes: started / exited (refused-with-reason)
  / timeout (still-running, status unknown).

Regression test: `packages/codev/src/agent-farm/__tests__/bugfix-1691-tower-start-surface-refusal.test.ts`.
Unit tests pin the outcome logic incl. the "no 30s burn" timing; two towerStart tests
(mocked spawn/http/shell) prove the teaching error is surfaced verbatim + exit(1) within seconds,
and the empty-log fallback. Build clean, `tsc --noEmit` clean, tower-command + 1629 + 1691 suites
green.

## PR + CMAP (done)

PR #1692 (`Fixes #1691`, `Refs #1690` — non-closing form for #1690 per commit discipline).

CMAP: **claude=APPROVE** (HIGH, verified end-to-end), **codex=COMMENT** (HIGH), **gemini=skipped**
(agy unauthenticated, non-blocking). Addressed feedback in a second commit:
- codex #2 (no final liveness check after the wait loop → exit on the deadline misreports as
  `timeout`): added a post-loop `isDaemonAlive` check. New unit test pins it (asserts `exited`
  where the old code returned `timeout`).
- claude #2 (ternary vs project if/else preference): converted the `started/exited` ternary to
  if/else.
- claude #1 (implicit timing guarantee): added an explicit `< 5000ms` elapsed assertion to the
  towerStart fast-exit test so the "no 30s burn" bound is visible, not reliant on vitest's 5s
  default.
- codex #1 (capture log offset before spawn): NOT applied. Claude verified the daemon's
  boot-to-first-log (~100ms+: module load + bootSequence) far exceeds the sub-ms parent window
  between spawn() and offset capture, so the race is not practically reachable, and it degrades
  gracefully (the "No output captured" fallback points to the log) if it ever did. Claude
  explicitly praised the current placement for keeping the surfaced tail daemon-only (no launcher
  lines echoed at the user). Kept the clean placement over a theoretical hardening.

7 regression tests green; `tsc --noEmit` clean.

## Post-gate follow-up (owner-directed)

Owner reviewed the real end-to-end output and flagged that the refusal message references
internal issue numbers (`#1629`, `#1515`) — fine in comments, not in a user-visible string. This
is coupled to #1691: my fix is what promotes that message from a `tower.log` line to a CLI
message the user reads. Stripped `(Issue #1629)` / `(#1515)` from `ownershipConflictMessage`
(`db/tower-owner.ts`), keeping the actionable `CODEV_AGENT_FARM_DIR (NOT AGENT_FARM_DIR)` guidance;
moved the incident context into the function's JSDoc. Updated the #1629 test (asserts the message
now matches no `#\d+`) and my fixture. 46 tests green, tsc clean.
