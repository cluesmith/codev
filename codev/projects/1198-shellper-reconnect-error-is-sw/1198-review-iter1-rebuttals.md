# Iteration 1 rebuttals — PIR #1198

## codex: REQUEST_CHANGES

**Finding**: `attachShellper()` (pty-session.ts) unconditionally opened `this.logPath` and assigned `this.logFd` without closing the previous handle. With #1198 making re-attach the routine recovery step after `'session-reconnected'`, each successful in-place reconnect leaked one append fd when disk logging is enabled.

**Assessment**: Real defect, accepted in full. A regression introduced by this PR's recovery flow (pre-#1198, `attachShellper` ran once per session lifetime, so the unconditional open was safe).

**Change made** (commit `0126d5d3`):
- The open is now guarded: `if (this.diskLogEnabled && this.logFd === null)`. A recovery re-attach reuses the existing handle; `cleanupShellper()` closes and nulls the fd, so a fresh attach after a genuine teardown still reopens it.
- Regression test added as requested: `pty-session-attach.test.ts` — "does not reopen the disk log when a recovery re-attach arrives" (attach → re-attach asserts exactly one open of the log path; detach → attach asserts the reopen). The test fails without the guard.
- Documented in the review file's "Things to Look At During PR Review" with an explicit note that PIR's single-pass consultation did not re-review the fix, so the human at the `pr` gate is the remaining reviewer of the guard.

Full suite after the fix: 3533 passed, 0 failed.

## claude: APPROVE

No findings to address. The review independently verified the `_closePending` simplification against the plan's original two-flag design and confirmed handshake-phase failures still only reject the connect promise.
