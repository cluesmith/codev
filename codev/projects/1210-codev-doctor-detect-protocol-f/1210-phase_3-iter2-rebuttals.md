# Phase 3 (tests) iteration 2 — Rebuttals

**Verdicts**: gemini APPROVE · claude APPROVE · codex REQUEST_CHANGES (MEDIUM confidence)

## Codex (blocking): no assertion for the bounded offline-timeout non-functional scenario

> behind/equal/offline behavior is covered functionally, but there is still no assertion that the
> offline/unreachable path completes within a bounded time. Phase 3 explicitly promised assertions
> for both non-functional scenarios, and only the no-mutation one is asserted today. Add a
> timing-bounded test for the real offline path.

**Accepted — legitimate and distinct from the iter-1 points.** The plan's Phase 3 non-functional
list was: (1) staleness completes within a bounded timeout offline, and (2) no mutation. I had
asserted (2) but only exercised (1) through an injected instant `() => null` stub, which never runs
the real `npm view` timeout that actually provides the bound.

Fix:
- Exported the real default fetcher as `fetchLatestVersion()` (was the private `defaultFetchLatest`)
  and a named constant `NPM_LATEST_TIMEOUT_MS = 2500`. `checkSkeletonStaleness`'s default param now
  references the exported function; no behavior change.
- Added unit test **"the REAL default lookup is offline-tolerant AND bounded when the registry is
  unreachable"**: points npm at `http://127.0.0.1:1` (immediate ECONNREFUSED) with
  `fetch_retries=0`, calls the real `fetchLatestVersion()`, and asserts it returns `null` **and**
  completes in `< NPM_LATEST_TIMEOUT_MS + 5000` ms. ECONNREFUSED is immediate and the spawnSync
  timeout is the hard backstop, so the generous ceiling can't flake; env vars are restored in a
  `finally`. This exercises the real bounded path rather than a stub.

Unit suite now 20/20 (added the timing test); e2e unchanged at 4/4. `tsc` clean.

Not a cycling nitpick: iter-1 addressed the staleness-*behind* integration branch; this addresses a
separate promised non-functional assertion (bounded offline timing) that neither iter-1 fix touched.

## gemini / claude
Both APPROVE, no issues.
