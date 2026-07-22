# Consultation rebuttals — PIR #1198

## Iteration 2 (human-requested round, post-incident-fix diff)

**claude: APPROVE** — no findings.

**codex: COMMENT** (advisory, MEDIUM confidence), two notes:

1. *Creation sites still race REPLAY* (tower-routes.ts:609/2050, tower-instances.ts:581/1059). Accepted — real for fast-starting children whose first bytes land in the REPLAY frame. Fixed without adding creation latency: new shellpers now always send a REPLAY frame even when empty (so waiters resolve in milliseconds; creation always talks to a freshly spawned new-binary shellper), and all four creation sites await `waitForReplay()`. Test added: shellper sends an empty REPLAY when its buffer is empty. Old clients treat an empty REPLAY as no replay data (wire-compatible).
2. *Plan file lacks approval frontmatter*. Rebutted: the frontmatter convention exists for architect-pre-created artifacts committed to main before spawn, so porch can skip the authoring phase. This plan was authored inside porch's PIR run and approved at the `plan-approval` gate; the approval record lives in `codev/projects/1198-*/status.yaml` (gate history), which is the source of truth for porch-driven artifacts. Adding retroactive frontmatter would duplicate state the state machine already owns.

## Iteration 1 rebuttals — PIR #1198

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
