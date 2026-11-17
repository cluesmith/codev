# Phase 3, iteration 1: responses to review

All points accepted; fixed in commit "Address iter1 review: awaited reap, root identity before
taskkill, Windows sweep budget". POSIX suite green (6958 passed). Windows targeted run
39577175053 green (5 passed, 1 expected fail: the pinned Phase 3b gap).

## codex (REQUEST_CHANGES)

1. **`reapShellpers` did not await the asynchronous Windows teardown.** Fixed.
   `killProcessGroup` is async and awaits `killSessionTree`. `reapShellpers` awaits every kill
   (SIGTERM and the SIGKILL escalation) before it polls for death, and its `kill` seam accepts a
   Promise. New test: "waits for each teardown to finish before polling for death" (the kill
   seam resolves after a delay; every probe comes after both kills).
2. **`taskkill` on an unverified root pid.** Fixed. On Windows, `taskkill` runs only on a root
   the census shows alive. When the caller knows the root's start time (`rootStartTime`), the
   root's creation time must also match within 2 s. Otherwise it is a reused pid, and nothing is
   killed. A root absent from the census is dead, so `taskkill` is skipped and only the recorded
   descendants are killed. Callers that know the start time pass it: `killSession`, the
   max-restart give-up, the orphan sweep, and `afx cleanup` (the last two read it from the
   census entry). Tests cover a reused root, a root within tolerance, and a dead root with no
   taskkill.
   One case stays caller-trusted: when the census itself fails, there is nothing to check
   against, so the root gets `taskkill` on the caller's word and the call rejects (reported).
   That is the same trust POSIX `process.kill(-pid)` has always given the caller. Documented on
   `killSessionTree`.

## claude (COMMENT)

1. **Dead-root membership had no creation-time anchor.** Fixed alongside codex 2.
   `collectTree` takes `rootStartTime`. For a dead root, a ppid-matching process created before
   that start (minus tolerance) is not counted as its child. Test: "for a dead root with a known
   start, skips ppid matches created before it". Without a known start, ppid matches are still
   taken; the residual case needs a pid reuse plus an exact ppid match from a process that has
   also died.
2. **Windows orphan-sweep budget equal to the census timeout.** Fixed. `orphanSweepBudgetMs()`
   is the POSIX budget plus `WINDOWS_CENSUS_TIMEOUT_MS` on Windows. A timed-out census rejects
   (logged as "sweep disabled") rather than resolving `[]`, so the headroom rationale holds; the
   comment says so.
3. **`it.fails` also passes on setup failure.** Accepted. The Phase 3b acceptance criterion now
   says to confirm that the test's own setup still works before un-pinning.
4. **Kill counters counted rejected teardowns.** Fixed. `killOrphanedShellpers` and the Windows
   `afx cleanup` path count only teardowns that resolved with `signaled`. A rejection is logged.
5. **Doctor's Tower Environment check on Windows belongs in the limitations list.** Added to the
   review doc's new "Windows limitations (collected for the docs, Phase 11)" section, with the
   census and Job Object requirements.

The "repository moved" warning in the claude review was my own plan-only commit (bdff381f3,
architect's Phase 3b conditions) landing during the review; no code changed.

## gemini

Skipped (agy not signed in). Non-blocking.
