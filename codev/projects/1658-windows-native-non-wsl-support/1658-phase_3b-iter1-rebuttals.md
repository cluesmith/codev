# Phase 3b iteration 1: responses to the 3-way review

Builder-run consult (architect order: 3b gets its own review before Phase 4). Scope: 23d5bbe37
plus a891d303c..23a4af7ac and the commits after it tagged `phase_3b`. Gemini skipped (agy not
signed in, non-blocking). Codex: REQUEST_CHANGES. Claude: REQUEST_CHANGES. Every finding was
checked against the code before acting.

## Codex

1. **Blocking: teardown can terminate a job the session refused to join.** Accepted. Rather
   than persist an "assigned" flag (a reconnected session after a Tower restart would not
   have it), the helper's `terminate` now takes the root pid and ends the job only when
   `IsProcessInJob(root, job)` is true; otherwise `member:false` and nothing is touched. That
   makes every teardown path (session, sweep, reap, cleanup, reconnected or not) safe.
   Windows test: a latecomer refused the name cannot terminate the owner's job.
2. **`OpenJobObjectW` failures read as not found.** Accepted. Only `ERROR_FILE_NOT_FOUND` maps
   to `found:false`; any other code is an error and is reported through `jobError`.
3. **Failed assign leaks the duplicated handle.** Accepted (same as Claude 6). Assign first,
   duplicate only after it succeeds, and with `JOB_OBJECT_QUERY` access instead of
   `DUPLICATE_SAME_ACCESS`. A duplicate that fails after a successful assign is reported (the
   process is then in a job that cannot be found by name).
4. **Crash-loop teardown drops `jobError`.** Accepted; logged there too.
5. **Stale header comment on detached breakaway.** Accepted; rewritten to the measured fact
   and the ruling.

## Claude

1. **Blocking: a helper exit after readiness is silent.** Accepted. The exit handler logs once
   (`reportOnce('exit')`) when the exit was not a `stop()`; the `!proc` branch logs the same
   cause. Unit test asserts one line across two exits and none for a stop.
2. **The assign wait can outrun the 30 s PTY-less deadline.** Accepted. One budget at the call
   site: `JOB_ASSIGN_BUDGET_MS = DEFER_PTY_DEADLINE_MS - 10s` races the assign; past it the
   session connects without a job and that is logged. The ready timeout dropped to 12 s (cold
   start measured 3.6-4.8 s). The deadline constant moved to `shellper-process.ts` so a unit
   test pins `ready + request < budget < deadline`.
3. **Two reap paths lack the job name.** Accepted as the same defect at sibling sites.
   `shellperTeardownIdentities` (shellper-cmdline.ts) derives creation times and job names
   from process entries once; the husk sweep, the superseded-architect reap and the
   remove-architect zombie reap all pass both to `reapShellpers`, whose teardown now reports a
   `jobError` as a failure.
4. **`signaled` is false once the job ends the tree first.** Accepted. A terminated job (found,
   root a member) counts as signaled; unit-tested.
5. **Stale header comment.** Same as Codex 5.
6. **Duplicate before assign.** Same as Codex 3.
7. Nits:
   - `jobError` when jobs are disabled: accepted. Results carry `disabled`, and teardown does
     not report it per session (Tower logs it at boot, doctor reports it, cleanup's helper
     logs it through the CLI logger).
   - Crash-loop path drops `jobError`: fixed (Codex 4).
   - `stop()` does not drain pending: fixed; unit-tested.
   - `shellper-main` deadline handler untested: not changed. The emission is unit-tested; the
     handler is three lines (log, `shutdown()`, `exit(1)`) in the entry script, which has no
     test seam. Noted for Phase 4's Tower restart CI test.
   - A null request id waits out its timeout: not changed; our own writer always sends an id.
   - `PreserveSig` not set: added (one line), Windows CI confirms the bind.
   - Reconnect can spawn a deferred PTY without a job: already recorded in the review doc
     under Windows limitations.

## Verified

POSIX: full suite 7001 passed, 0 failed; build and `tsc --noEmit` clean. Windows: run
39655013620 caught a real bug in the Codex 2 fix: `OpenJobObjectW` on a missing job reported
Win32 error 203, not 2, because the helper read the last error through a script function and
PowerShell's own interop overwrote it in between. Every call now reads
`Marshal::GetLastWin32Error()` on the very next statement. Run 39655482085: all 19
Windows-only tests pass (cold start 6.0 s, still inside the 12 s ready timeout).
