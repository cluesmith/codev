# bugfix-1685 — tower startup hangs unbounded in killOrphanedShellpers

## Issue
Field report on published 3.3.3: `afx tower start` failed with "Tower server failed to
respond within 30000ms". tower.log printed `Reconciliation complete: …` then **nothing** —
`Cron scheduler initialized` (normally ~30ms later) never appeared. A retry booted fine.
Machine showed storm-class symptoms (memory-pressure kills) that evening.

## Investigate phase — root cause (CONFIRMED)

The boot sequence in `tower-server.ts` runs, in order:
- L665 `await reconcileTerminalSessions()` → logs "Reconciliation complete"
- L671 `await shellperManager.killOrphanedShellpers()` → **silent on entry + zero-orphan path**
- L693 `initInstances(...)` → no log
- L709 `initCron(...)` → logs "Cron scheduler initialized"
- L718 `markBootComplete()` → logs "Tower ready"

`killOrphanedShellpers()` (`session-manager.ts:797`) is the one substantial, **unbounded,
unlogged** step between the two log lines:
1. `findShellperProcesses()` (L853) runs `ps -ww -eo pid,args` — unbounded; on a flooded /
   wedged process table (the #1645 gh-spawn storm, still shipping on 3.3.3) this stalls or
   returns a huge list.
2. For every orphan it `await`s `probeSocket()` (L813) **sequentially**, each up to **2s**
   (`probeSocket` timeout, L759). Many dead-socket orphans ⇒ cumulative multi-second-to-
   unbounded wall time on the readiness-critical path.
3. Logs **only** when `killed > 0` (L672-674 / L837-839) — the zero-orphan path is silent,
   so the stall leaves no diagnostic trace at all.

Critical detail: this whole step runs BEFORE `markBootComplete()` (L718), i.e. on the
readiness-critical path. The launcher's 30s timeout fires while boot sits inside it → the
observed failure. The husk sweep (`runHuskSweep`, L726) already runs **post**-readiness and
is the model to follow.

## Fix shape (per issue + architect main, 3-part, <300 LOC)
1. **Log** entry + duration + kill count ("Sweeping for orphaned shellpers…" / "Orphan sweep
   done in Nms (K killed)"). Makes the stall visible + attributable.
2. **Bound** it: ~10s timeout → WARN → proceed. The sweep is hygiene, not correctness; next
   startup retries it. Keep #341's semantics (coverage), bound its COST.
3. **Defer** off the readiness-critical path: move the call to AFTER `markBootComplete()`,
   like `runHuskSweep` / the log-retention scan, so a slow process table can never block
   serving.

## Fix phase — implemented (3 parts, ~60 LOC)
- `session-manager.ts`: `killOrphanedShellpers(timeoutMs = ORPHAN_SWEEP_TIMEOUT_MS)` now wraps
  the `ps` scan + probe loop in a `Promise.race` against a timeout. Past budget it abandons
  (sweep keeps running in background harmlessly) and returns **-1** as a timeout sentinel.
  New exported const `ORPHAN_SWEEP_TIMEOUT_MS = 10_000`.
- `tower-server.ts`: moved the sweep call from BEFORE `markBootComplete()` (readiness-critical)
  to AFTER it, alongside the husk sweep. Added `log('INFO', 'Sweeping for orphaned shellpers…')`
  + duration/kill-count on success, `log('WARN', …abandoned…)` on the -1 sentinel. Uses the
  proper WARN level (the SessionManager logger seam is level-less, so the WARN lives here).
- Test `session-manager.test.ts`: injects a never-resolving `probeSocket`; asserts
  `killOrphanedShellpers(50)` returns -1 in <2s. Verified it **hangs → fails** against a
  simulated pre-fix (unbounded) method, **passes** with the fix.

## Verification
- `tsc --noEmit`: clean (after building upstream workspace deps).
- `pnpm build`: clean.
- Full `session-manager.test.ts`: 92 passed (the 8 earlier "integration with real shellper"
  failures were missing `dist/shellper-main.js` — pre-existing, gone after build).
- e2e: `shellper-husk-sweep.e2e` + `tower-reconnect.e2e` (boot-sequence) — 3 passed.
- No `codev-skeleton/` twin: this is core Tower product code, not a shipped template.

## Scope decision
Fits BUGFIX. Focused change in `tower-server.ts` (move + log) + `session-manager.ts` (bound
the sweep). Well under 300 LOC. Regression test pattern exists: `session-manager.test.ts:384`
spies `findShellperProcesses` — inject a slow/hanging one and assert the sweep returns within
the bound (fails unbounded → hangs before fix; returns with WARN after).
