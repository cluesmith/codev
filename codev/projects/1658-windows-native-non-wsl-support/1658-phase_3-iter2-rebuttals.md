# Phase 3, iteration 2: responses to review

claude: APPROVE. gemini: skipped (agy not signed in). codex: REQUEST_CHANGES, two points, both
addressed. Fixed in commit "Address iter2 review: start times through every reap, reap failures
reported".

## codex

1. **Windows callers omit `rootStartTime`.** Partly fixed, partly disputed with a reason.
   - **Fixed, where the caller already had the creation time from a census and discarded it.**
     The husk sweep now hands the reap each candidate's census creation time
     (`reap(pids, startTimes)`). Architect reconcile builds the same map from its snapshot
     (`ProcessEntry.creationTime`, populated by the Windows census). The remove-architect zombie
     reap takes one snapshot, shares it between the identity match and the reap, and passes its
     creation times. `reapShellpers` threads the map into `killSessionTree(..., { rootStartTime })`.
     Test: `windows-sweeps.test.ts` asserts the reap receives `Map([[100, <creation time>]])`.
   - **Not changed: `PtySession`, the shellper's PTY kill, and porch checks.** Each of these kills
     a child it spawned and still holds an open process handle to: the node-pty `IPty`, and the
     libuv `ChildProcess` before its `close`. Windows does not reuse a process id while a handle
     to that process is open, so the root pid cannot have been reused at these sites, and no
     census check is needed. The root-identity check exists for pids learned from a census or
     the DB, where no handle is held. Those are the sites fixed above, plus `killSession`, the
     max-restart give-up, the orphan sweep, and `afx cleanup`, from iteration 1.
2. **`architect-session-holder.ts` swallowed teardown failures.** Fixed. `killProcessGroup` no
   longer catches. `reapShellpers` still runs every kill and both death polls (best effort), then
   rejects with `shellper teardown incomplete: pid N: <reason>` if any teardown failed. Callers:
   - **The husk sweep** propagates it, so the periodic and on-demand sweeps log
     `Husk sweep failed: ...` and never report the pid as swept.
   - **Architect reconcile** logs a WARN and returns `foreignHolder: true` (mint fresh), because
     a holder that may still be alive must not be resumed into a collision.
   - **The remove-architect zombie reap** logs a WARN.

   Tests: the reap still kills and polls every pid and then reports the failure; reconcile mints
   fresh when the reap fails; the husk sweep rejects on a failed reap.

POSIX is unchanged: the husk sweep still calls `reap(pids)` (POSIX has no creation times, and the
existing call-shape assertion passes untouched).
