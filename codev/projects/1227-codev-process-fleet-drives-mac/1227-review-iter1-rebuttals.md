# Rebuttal — PIR #1227, review iteration 1

Verdicts: claude=APPROVE, codex=REQUEST_CHANGES.

Both findings from codex's `REQUEST_CHANGES` were real defects, not false positives. Both are fixed in commit `3a5083e3`.

## Finding 1: `execFileSync` blocking the event loop on `/health`

**Codex's claim**: `process-census.ts` used `execFileSync('ps', ...)`, called synchronously from `handleHealthCheck` (the `/health` route). Every `/health` request would block Tower's entire Node.js event loop for the duration of the `ps` call, freezing all open terminals' WebSocket traffic — and since `TowerClient.isRunning()`/`getHealth()` both hit `/health`, this is a common path, not a one-off admin route.

**Assessment**: Confirmed, real defect. `codev/resources/lessons-learned.md:160` documents this exact anti-pattern as a previously-fixed bug in this codebase ("`execSync` in HTTP request handlers blocks the entire Node.js event loop, freezing terminal WebSocket traffic"). My `process-census.ts` reintroduced it.

**Fix**: Rewrote `listProcessCensus()` to use non-blocking `execFile` with a hand-rolled `Promise` wrapper (matching the existing async convention already used by `session-manager.ts`'s `findShellperProcesses` — same shape, same non-throwing-on-failure contract), instead of `util.promisify(execFile)` (which I considered but rejected: `child_process.execFile` carries a built-in custom-promisify symbol resolving `{stdout, stderr}`, and a plain `vi.fn()` test mock wouldn't reproduce that symbol, silently promisifying to the wrong shape). All four call sites (`shellper-husk-sweep.ts`'s `findHuskShellpers`, `tower-routes.ts`'s `computeFleetHealthFields` and `handleHuskPreview`) updated to `await` the now-async function; the `census` seam type in `shellper-husk-sweep.ts` widened to accept a plain array in addition to a function, so existing synchronous test seams needed no changes.

**Regression test**: `process-census.test.ts` — `'never calls the synchronous execFileSync API'` mocks both `execFile` and `execFileSync`, asserts the sync API is never invoked. This fails against the pre-fix code (which called `execFileSync` directly) and passes now.

## Finding 2: redundant second `ps` scan in husk preview

**Codex's claim**: `handleHuskPreview` calls `findHuskShellpers()` (which internally scans once) and then immediately calls `listProcessCensus()` again just to build the RSS map — a second full-machine `ps` scan per preview request, and the displayed RSS could reflect a different process-table snapshot than the one that decided candidacy.

**Assessment**: Confirmed. (Independently corroborated: claude's own APPROVE review flagged the identical double-scan as a "minor observation," reaching the same conclusion via a different read of the same code.)

**Fix**: `handleHuskPreview` now takes one `census = await listProcessCensus()` snapshot up front, builds the RSS map from it, and passes it into `findHuskShellpers` via the (now array-accepting) `census` seam — so candidacy and displayed RSS are guaranteed to come from the same snapshot, and only one `ps` scan happens per preview request.

**Not changed**: `findHuskShellpers` still calls `getProcessStartTime(pid)` once per already-narrowed candidate (to check `aged`), and `handleHuskPreview` calls it again per candidate to compute display `ageMs`. This is a small duplicate cost (a per-PID `ps -p <pid> -o lstart=`, not a full-machine scan) bounded by the candidate count, not the process count — fixing it would mean changing `findHuskShellpers`'s tested return contract from `number[]` to richer objects, a larger and riskier change for marginal benefit. Flagged here for visibility; happy to revisit if reviewers feel strongly at the `pr` gate.

**Regression test**: not added as a dedicated unit test — `handleHuskPreview` is a private, unexported route handler, and asserting "internal call count" would require exporting it purely for testability. The existing `tower-routes-husks.e2e.test.ts` (real HTTP, real Tower) still passes and validates end-to-end correctness of the returned candidates/RSS; the fix itself is visible and reviewable directly in the diff.

## Verification after the fix

- `tsc --noEmit` clean (`packages/core` + `packages/codev`)
- Full unit suite: 2249 passed, 34 pre-existing skips, no regressions
- `process-census.test.ts`: 7/7 passing, including the new regression test
- E2E (real Tower, real `ps`, real signals): `shellper-husk-sweep.e2e.test.ts`, `tower-routes-husks.e2e.test.ts`, `shellper-cleanup.e2e.test.ts` — 6/6 passing, unmodified assertions
