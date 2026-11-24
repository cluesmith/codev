# bugfix-1901 thread

Issue #1901: afx reports "Tower is not running" under high load while Tower is up; the real
`/health` probe error is discarded.

## 2026-11-16 — investigate (in progress, no code written yet)

**Where I stopped:** still in the porch `investigate` phase (`porch done` not yet run). Root cause
is mostly established (below). Next step: confirm it **without machine load**, using a stalled local
HTTP server or an injected fetch, then signal PHASE_COMPLETE.

### Architect ruling (binding)
- **No synthetic machine load on this Mac, ever.** My repro ran 36 CPU-burner `node -e` loops for
  ~90 s, twice. Load reached 76 and slowed the owner's machine. Reproduce only with an injected
  slow/failing fetch in a unit test, or one stalled local HTTP server.
- Run only the test files I touch until the PR step.

### Findings so far
- `TowerClient.isRunning()` (`packages/sdk/src/tower-client.ts` ~L358) collapses every `/health`
  failure to `false`. `request()` maps its catch to `{status: 0, error}`, and the error is dropped.
- Also: the `message.includes('ECONNREFUSED')` check in `request()` likely never matches with Node's
  undici fetch, because the thrown error is `TypeError: fetch failed` and the code lives on
  `err.cause`. This needs confirming with a closed port; that test is load-free.
- Tower binds `127.0.0.1:4100` (IPv4 only). The client uses `localhost`, which resolves to
  `[::1, 127.0.0.1]`, so `::1` is refused and `127.0.0.1` connects. Happy-eyeballs is not the cause
  in the data below.
- Probe that mirrors the SDK request (fresh node process per probe, captures the cause chain):
  - load ~13: 200/200 ok, p95 1.1 s.
  - load ~44: 59/300 failed, and **every failure was `TimeoutError` after the 10 s
    `AbortSignal.timeout`**. There were no ECONNREFUSED/ECONNRESET failures.
  - curl at load ~40: **connect was always ≤ 8 ms** (kernel accepts immediately), but
    time-to-first-byte reached 29 s on `/api/version`, and `/health` did not answer within 40 s.
- So, on this machine: **Tower is listening but answers slowly** (CPU starvation of Tower's single
  event loop). It is not an accept-queue or connect failure. `/health` is the heaviest route: it runs
  `getInstances()` plus a full `ps -A -ww` census (~1.2 MB, 757 lines) per request
  (`process-census.ts`, 5 s ps timeout). Caveat: my probes ran 10–12 `/health` calls concurrently,
  which inflated this.

## 2026-11-24 — investigate complete (resumed after reboot)

Load-free repro (`scratchpad/repro/stalled.mjs`: local servers on ephemeral ports, nothing
touching Tower or machine load) feeds each shape through an exact copy of the SDK's catch mapping:

| endpoint | fetch throws | `request()` keeps | `isRunning()` |
|---|---|---|---|
| nothing listening | `TypeError: fetch failed`, `cause.code=ECONNREFUSED` | `"fetch failed"` | false |
| listening, never answers | `TimeoutError` | `"Request timeout"` | false |
| listening, resets | `TypeError: fetch failed`, `cause.code=ECONNRESET` | `"fetch failed"` | false |

**Root cause.**
1. `isRunning()` returns a bare boolean, so every failure shape becomes "Tower is not running" in
   the callers.
2. `request()`'s `message.includes('ECONNREFUSED')` is dead code under Node's fetch, because the
   errno code lives on `err.cause`. So even the raw result cannot tell refused from reset.
3. Under load the live failure mode is (2) in the table: Tower is listening, but its event loop is
   starved past the 10 s abort.

**Worse adjacent paths found (same false negative, destructive follow-on):**
- `afx workspace start` (`start.ts`): a false negative calls `towerStart()`. That probes
  `/api/status` with a 2 s timeout, decides "port in use but not responding", and **SIGTERMs the PID
  on 4100, i.e. the live Tower**. Running `afx tower start` by hand, as the old message suggests,
  hits the same branch.
- `afx workspace stop` (`stop.ts`): a false negative skips the Tower kills but still runs
  `clearRuntime()`, wiping the builder registry while Tower keeps those builders running.
- `rename.ts`, `shell.ts` and `open.ts` print "not running" for any `status === 0`.
- `ide.ts` is already correct: it uses `http.request`, so `err.code` is reliable, and it reports
  timeouts separately. No change needed.

**Scope:** fits BUGFIX (estimate ~250 LOC with tests). One open decision is flagged to the
architect, not changed here: `towerStart()`'s zombie-kill policy, i.e. what `afx tower start`
should do when the port is held but `/api/status` misses a 2 s probe.

### Architect ruling 2026-11-24: towerStart in this PR, option (b)
1. `towerStart` goes through the same `probeHealth` helper.
   - not-running (refused): start, as today.
   - running: say it is already running, as today.
   - unresponsive: **do not kill**. Exit non-zero and print the listening PID and its command
     line. Say that if the machine is busy the user should wait and retry, and that to replace the
     process deliberately they run `afx tower stop` and then `afx tower start`. Stopping a Tower is
     a human decision, never a side effect of start.
2. `afx tower stop` must still stop an unresponsive Tower. Verified: `towerStop()` kills the PIDs
   from `getProcessesOnPort()` (lsof) and does no health probe. Leave it unrouted.
3. Tests use a stalled local server (child process, ephemeral port):
   - start does not signal the PID and exits non-zero with the message;
   - a refused port starts normally;
   - stop still kills the stalled server.
4. This is Tower lifecycle code: dispatch the Windows workflow on the branch and link the run in
   the PR.
5. The PRFT write-up gives the towerStart change its own paragraph, as a behaviour change: start no
   longer replaces a hung Tower by itself.

### Planned fix (per the issue's Fix section)
One shared helper over the SDK probe that classifies the failure:
- connect refused (nothing listening) → "Tower is not running. Start it with: afx tower start"
- timeout / reset / bad response → retry once after a short pause; if that also fails, report
  "Tower did not answer /health (<error>) after N ms; it appears to be up, retry", with no
  suggestion to start Tower.

Route `send`, `interrupt`, `reset`, `rename`, `ide`, `status`, `self-refresh` and the other
`isRunning()` callers through that helper. Unit tests use an injected fetch, as the issue's Testing
section describes.
