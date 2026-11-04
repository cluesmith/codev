# bugfix-1877 thread

## Investigate (2026-11-04)

**Reproduced live, read-only** (no state touched):
- `terminal_sessions` row `fea2d3f9…` (writing / guidebook architect): `pid = shellper_pid = 2217`,
  `shellper_start_time` = 2026-10-13 01:03 UTC.
- `ps -p 2217` → `/usr/libexec/diagnosticextensionsd`, started Sat Oct 24 12:24 (boot was 12:16).
- Socket `~/.codev/run/shellper-c8cb23cd….sock` is gone.
- `tower.log` repeats, every ~2s (on-the-fly path, driven by `/api/state` polls):
  `reconnect failed: PID 2217 reused (start time mismatch)` then
  `On-the-fly reconnect … failed but pid 2217 is alive — leaving row untouched`.

**Root cause.** `SessionManager.reconnectSession()` (`terminal/session-manager.ts`) proves the pid
was reused (start-time mismatch) but only returns `null`. Both #1686 guards in
`agent-farm/servers/tower-terminals.ts` — reconcile Phase 2 and the on-the-fly sibling in
`getTerminalsForWorkspace()` — then test only `processExists(shellper_pid)`. The reused pid is
alive, so the row is kept forever and retried on every pass.

**Trap for the fix.** Shellper rows persist `pid == shellper_pid`. Merely skipping the guard in
Phase 2 would fall through to the `session.pid && processExists(session.pid)` SIGTERM branch and
signal the unrelated process. The reused-pid branch must delete and `continue` before it.

**Scope.** Small: one exported positive-proof helper next to the existing PID-reuse rule in
session-manager.ts, two guard sites in tower-terminals.ts, tests. Well under 300 LOC.

**Out of scope, noted for follow-up:** the Phase 1 pre-filter (workspace path missing / temp dir)
SIGTERMs `shellper_pid` on `processExists` alone, and the #1809 `liveSessionsForWorkspace` treats a
live reused pid as a live session. Same hazard class, not part of this issue.

## Fix (2026-11-04)

- New `isShellperPidReused(pid, recordedStartTime)` in `terminal/session-manager.ts`, next to the
  reuse rule it shares (`PID_REUSE_TOLERANCE_MS`, now also used by `reconnectSession` and
  `isShellperProcessCurrent` instead of two `2000` literals). It is true **only** for a *known*
  mismatch: a null recorded or null live start time is not proof, so a transient `ps` failure
  cannot switch off the #1686 rule.
- Both guard sites in `tower-terminals.ts` now check it inside the `shellperAlive` branch:
  reused → INFO + delete + `continue` (before the stale-row SIGTERM branch); otherwise the #1686
  WARN/keep is unchanged.
- **Deviation from the issue's *suggested* shape.** I did not thread a `pid-reused` reason out of
  `reconnectSession()`. The sweep re-checks with the shared helper instead. Why: it keeps
  `reconnectSession`'s long-lived `client | null` contract (5 callers, ~50 test mocks), and it is
  stricter than reusing reconnect's verdict, because reconnect lumps "start time unknown" in with
  "mismatch". The prescribed *behaviour* is implemented as written.
- Tests: two new #1877 cases (reconcile + on-the-fly: row deleted, no non-zero signal, INFO, no
  WARN) fail on the unfixed code (`expected … to be called with 'bugfix-1877-reused-session'`) and
  pass with the fix. The four #1686 live-pid tests now record the process's real start time — a
  genuine live shellper always has a matching one, and `Date.now()` would now (correctly) read as
  reused. Four direct helper tests cover the unknown-start-time edges.

## PR (2026-11-04)

- PR #1878 opened. CMAP (needed `--issue 1877`; without it consult could not pick a project):
  codex=APPROVE, gemini=APPROVE, claude=APPROVE — all HIGH confidence, no blocking issues.
- Claude asked that the deferred Phase 1 pre-filter hazard get a tracker before merge → filed
  #1879 (area/tower), which also carries the non-blocking notes: #1809 `liveSessionsForWorkspace`,
  the third tolerance constant in `shellper-husk-sweep.ts`, and the two-clock start-time recording.
- Left as-is (non-blocking, cosmetic): reused-row deletions count under `cleaned`.
