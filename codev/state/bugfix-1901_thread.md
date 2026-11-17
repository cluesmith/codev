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

### Planned fix (per the issue's Fix section)
One shared helper over the SDK probe that classifies the failure:
- connect refused (nothing listening) → "Tower is not running. Start it with: afx tower start"
- timeout / reset / bad response → retry once after a short pause; if that also fails, report
  "Tower did not answer /health (<error>) after N ms; it appears to be up, retry", with no
  suggestion to start Tower.

Route `send`, `interrupt`, `reset`, `rename`, `ide`, `status`, `self-refresh` and the other
`isRunning()` callers through that helper. Unit tests use an injected fetch, as the issue's Testing
section describes.
