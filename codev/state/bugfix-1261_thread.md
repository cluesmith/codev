# bugfix-1261 — Tower serves API before internal wiring completes

## Investigate

Issue: `DELETE /api/terminals/:id` 404s for an existing terminal during Tower's
startup window, because the whole boot sequence lives inside the
`server.listen()` callback and `initInstances()` (which sets `_deps`) is the
*last* async step. `killTerminalWithShellper()` bails with `false` when
`_deps` is null; the DELETE route maps that to 404.

Confirmed by reading:
- `tower-server.ts:375` — `server.listen(...)` callback holds the entire boot.
- `tower-server.ts:575` — `initInstances()` is last, after stale-socket cleanup,
  consolidation, `reconcileTerminalSessions()`, `killOrphanedShellpers()`,
  the #1227 husk sweep, and the #1238 session-log retention scan.
- `tower-instances.ts:800` — `killTerminalWithShellper` → `if (!_deps) return false`.
- `tower-routes.ts:842` — DELETE translates that `false` into 404 NOT_FOUND.

Extra finding not in the issue: `afx tower start` treats a 200 from
`/api/status` as readiness (`commands/tower.ts:110`), and `/api/status`
answers 200 during the window (`getInstances()` returns `[]` when `_deps` is
null). So the CLI's "Tower started" is a *false* readiness signal — that is
what makes `afx tower start && <immediate afx cmd>` racy.

### Reproduced

Wrote a scratchpad repro that tight-loop-connects to the port and fires
create+DELETE the instant it binds (the e2e helper's 200ms poll adds slack that
usually hides it). On this machine, with an *empty* log dir:

```
POST   /api/terminals      -> 201 (269ms after port open)
DELETE /api/terminals/:id  -> 404 {"error":"NOT_FOUND", ...}
GET    /api/terminals/:id  -> 200   <-- terminal exists; the 404 was spurious
```

Deterministic, 100% of runs. So the window is not exotic — it just needs a
client that doesn't sleep before its first request.

Planned fix (three parts, all small):
1. Readiness gate in `tower-server.ts`: `server.listen()` still binds first
   (preserves EADDRINUSE detection + the single-Tower mutex), but
   `handleRequest` awaits a boot-complete promise before dispatching, with a
   bounded timeout → 503 + `Retry-After`.
2. Reorder boot: move `initInstances()` up to right after the ordering-
   constrained steps; push the disk-scaling husk sweep + log retention sweep
   after it. Shrinks the window from O(disk) to O(process scan).
3. Defense in depth: DELETE (and any `_deps`-dependent route) returns 503
   "Tower is starting up" instead of 404, generalizing what `stopInstance`
   already does.

## Fix

All three parts implemented.

- `tower-server.ts`: readiness gate (`bootComplete` + `whenBootComplete`) in
  the `http.createServer` handler; the listen callback now just logs and kicks
  off a named `bootSequence()`. Boot-throw still exits the process (was an
  unhandled rejection before, same net effect). Held requests get 503 +
  `Retry-After` if boot exceeds 20s.
- `tower-server.ts`: `initInstances()` + `initCron()` moved up to right after
  `killOrphanedShellpers()`; the #1227 husk sweep, the #1238 log-retention
  sweep, and `initTunnel()` now run *after* the gate opens. Tunnel especially:
  gating local readiness on a remote connect would make an unreachable cloud
  endpoint look like a broken Tower. Measured effect on this machine: boot
  reaches ready at ~90ms instead of running the disk scans first.
- `tower-instances.ts`: new `instancesReady()`; `tower-routes.ts`: DELETE
  `/api/terminals/:id` and the workspace tab-delete path return 503 instead of
  404 / a lying 204 when the module isn't wired.
- Test hook `AF_TEST_BOOT_DELAY_MS` widens the window deterministically —
  without it the race depends on this machine's process table and log volume,
  which is exactly why CI never saw it.

### Verification

Scratchpad repro, same invocation as before the fix:

```
POST   /api/terminals      -> 201
DELETE /api/terminals/:id  -> 204   (was 404)
GET    /api/terminals/:id  -> 404   (was 200 — i.e. it really is gone now)
```

New `tower-startup-readiness.e2e.test.ts` (2 tests) passes. Confirmed it
*fails* with the gate disabled in dist: DELETE 503 (the second-line guard
firing) and the status-hold assertion 2ms vs the required ≥1200ms.

Known adjacent case left alone: WebSocket upgrades bypass the gate
(`setupUpgradeHandler` attaches its own listener). Not reachable in practice —
every client does an HTTP call first — so out of BUGFIX scope; noted in the PR.

## PR

PR #1263 — "[Bugfix #1261] Hold Tower API requests until boot wiring completes".

CMAP (3-way, `--issue 1261 --project-id bugfix-1261`; note the bare
`consult --protocol bugfix --type pr` form bails with "Multiple projects
found" in this repo — it needs the issue/project flags):

| Model  | Verdict | Confidence | Key issues |
|--------|---------|------------|------------|
| gemini | APPROVE | HIGH       | None |
| codex  | APPROVE | HIGH       | None |
| claude | APPROVE | HIGH       | None |

No REQUEST_CHANGES, so nothing to address or rebut. Claude raised two
non-blocking observations and dismissed both itself: the `waitForPortImmediate`
name, and whether the `elapsed >= BOOT_DELAY_MS * 0.8` assertion is CI-timing
sensitive (it isn't — a slow machine only makes `>=` more true).

Awaiting the human `pr` gate.
