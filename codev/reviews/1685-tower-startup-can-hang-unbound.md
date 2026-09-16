# Review — #1685: tower startup can hang unbounded and unlogged in killOrphanedShellpers

**Protocol:** BUGFIX · **PR:** #1687 · **Follow-up filed:** #1688 (execFile maxBuffer)

## What the bug was

`afx tower start` failed on published 3.3.3 with "Tower server failed to respond within
30000ms". The orphan sweep (`killOrphanedShellpers`) ran on Tower's readiness-critical boot
path (before `markBootComplete()`), and was both **unbounded** and **silent on the zero-orphan
path**: `findShellperProcesses()` scans the whole process table via `ps -ww -eo pid,args` with
no timeout, then probes each orphan's socket sequentially (up to 2s each), and logged only when
`killed > 0`. On a wedged process table it stalled invisibly until the launcher's 30s timeout,
leaving no trace between "Reconciliation complete" and "Cron scheduler initialized".

## The fix that shipped

1. **Bounded** — 10s wall-clock budget (`ORPHAN_SWEEP_TIMEOUT_MS`); returns a `-1` sentinel on
   abandonment. Hygiene, not correctness — the next startup retries.
2. **Cooperative cancellation** — the deadline is checked at the top of each iteration and each
   socket probe is bounded by the remaining budget, so the sweep genuinely stops; no background
   tail that keeps killing. The `ps` scan is bounded by `execFile`'s timeout plus a `withDeadline`
   wrapper (with ~1s headroom so a wedged scan surfaces the WARN, not a false "0 killed").
3. **Kept pre-readiness** — the call stays before `markBootComplete()`. `killOrphanedShellpers`
   has no age guard, so post-readiness it could reap a just-spawned session. The 10s bound alone
   fixes the reported timeout (well under BOOT_READY 20s and launcher 30s).
4. **Logged** — entry + duration + kill count on success, WARN on abandonment. Plus an arch.md
   §6 boot-order note recording why step 6 must stay pre-readiness.

Tests: three regression tests (wedged `ps` scan; cooperative-cancellation under many slow probes;
a single probe outlasting the budget), each verified to hang/fail against the unbounded pre-fix.
94 unit tests + boot e2e green; `tsc` + build clean.

## Lessons

- **An issue's "Fix shape" (and an architect's relayed recommendation) is a hypothesis to
  validate, not a mandate.** The issue's part-3 and the architect both recommended moving the
  sweep OFF the readiness path. I implemented that; CMAP iter-1 (codex + claude, both HIGH)
  proved it unsafe — the un-aged sweep, run post-readiness, could SIGTERM a just-spawned session
  (in `ps` from `cpSpawn` but not yet registered/socket-listening). I reverted the move and
  shipped the bound alone. The owner framed this as "the streak now includes catching the
  architect": CMAP is expected to overturn even the architect's fix-shape when the code proves it
  wrong. (This is distinct from a Baked Decision, which must not be relitigated — there was none
  here.)
- **A bound must cancel the work, not just the wait.** The first cut used `Promise.race`, which
  abandoned the caller's wait while the sweep kept running and killing in the background — the
  WARN said "hygiene skipped" while it wasn't. Cooperative cancellation (a deadline checked in the
  loop, and each probe bounded by the remaining budget) is what actually stops it.
- **Moving a sweep off the readiness path is only safe with an age/grace predicate** (the #1227
  husk sweep's pattern). Without one, "run it post-readiness like the other sweeps" is a trap —
  documented now on the arch.md step-6 row so the next contributor doesn't repeat iter-1's move.

## Known limitation (follow-up #1688)

`execFile`'s default 1MB `maxBuffer` means a genuinely *flooded* `ps` table (huge output) hits
ENOBUFS → `[]` → a false "0 killed" INFO rather than the WARN. This implies the field hang was a
*wedged* `ps` (D-state), which this fix bounds; the flooded-volume path is a separate silent
no-op, pre-existing and not a regression. Fix shape for #1688: raise the buffer and read ENOBUFS
as a WARN-couldn't-look, never a silent zero.
