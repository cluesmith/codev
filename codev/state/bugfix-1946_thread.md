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
