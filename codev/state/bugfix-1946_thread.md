# bugfix-1946 thread

## Investigate
- File passes alone on this host (12 passed, 3 skipped).
- Reproduced under synthetic load (2x cores busy node workers + 8 loops launching cmd.exe), 300ms timeout:
  `sleep 3` -> 4454 / 3429 / 3187 ms (fails the 2500ms bound); `sleep 30` -> 2905 / 3199 / 3434 ms.
- So the kill lands late (~3s: census + job terminate + taskkill, each a process launch), it does not fail to land.
  No product bug; no escalation.
- Root cause is the test: with a 3s sleep the check can end on its own inside the teardown window and still
  report "Timed out" (`killed` is set when the timer fires, checks.ts:115), so 2500ms can't tell late kill from no kill.
- Plan: sleep 30 in the three tests; bound 2500ms on POSIX, 15000ms on win32 (half the sleep, ~4x the worst
  observed); assert the bound in all three; per-test timeout 45s so a missing kill fails on the bound, not on a timeout.

## Fix
- Test-only change in bugfix-1814-check-timeout.test.ts; checks.ts untouched.
- Mutation check: with the timeout's killGroup calls removed, all three tests fail at ~30.1s against the 15s bound.
- Full suite on this host, one run at a time, Tower PID 53132 before and after each:
  run 1 via `porch done` (build 51.7s, tests 146.6s, passed first try); runs 2 and 3 `npm test`:
  406 files passed / 9 skipped, 8110 tests passed / 247 skipped, both.
- Side note (not changed, out of scope): runCheck reports "Timed out" whenever the timer fired, even if the
  command then exited on its own before the kill landed (`killed` is set at checks.ts:115).
