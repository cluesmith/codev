# Review iteration 1 — rebuttals

Verdicts: Gemini **APPROVE**; Codex **REQUEST_CHANGES**; Claude **REQUEST_CHANGES**.
All REQUEST_CHANGES points accepted as correct and addressed on the branch — no disagreements.

## Claude #1 (BLOCKING) — synchronous `lsof` on every forwarded request blocks the event loop
**Accepted; fixed.** `forwardIdeHttp`/`forwardIdeWebSocket` called `ensureIdeServerLive()` →
`getProcessesOnPort()` (`execSync('lsof')`, ~98 ms sync) per request. Removed from the hot path:
the forward now resolves the port from the record via `getRecordedIdePort()` (a plain read, no
scan) and lets the upstream connect error be the liveness truth-teller — on
`ECONNREFUSED`/`ECONNRESET` it fires an off-hot-path respawn (`ensureIdeServerLive`, where the
`lsof` now lives) and 502s. `lsof` is now COLD-path only (status / reconcile / start-collision),
per the architect's steer. This also corrects my earlier "no non-IDE-user disruption" claim to
the reviewer — recorded in the review file.

## Claude #2 / Codex — `BLOCKED_PATH_SEGMENT` regex widened with no test
**Accepted; fixed.** Added to `tunnel-client.test.ts`'s `isBlockedPath` block: `/api/ide` → true,
`/api/ide/start` → true, workspace-scoped `/workspace/<enc>/api/ide` → true, `/ide/` (+ subpaths,
+ `?folder`) → **false** (the load-bearing negative), `/api/ideas` → false.

## Codex / Claude #3 — `stopIdeServer` drops SIGTERM→SIGKILL escalation; deletes record before exit
**Accepted; fixed.** `stopIdeServer` is now async: SIGTERM → poll `process.kill(pid,0)` to a
deadline → SIGKILL survivors → then delete the record (mirrors `towerStop`, plan §4). Prevents a
survivor being re-adopted. `handleIdeApi` awaits it.

## Codex — start-on-a-different-port overwrites the singleton record, orphaning the old server
**Accepted; fixed.** `spawnIdeServer` now reads any existing record and, if it names a *different*
port that is still live, stops that server first (`stopIdeServer`) before starting/adopting on the
new port — closing the no-orphan gap.

## Codex — `0600` not enforced on existing record/token files
**Accepted; fixed.** `writeIdeRecord` and `ensureIdeConnectionToken` now `chmodSync(path, 0o600)`
after write (the `cloud-config.ts` pattern), since `writeFileSync({mode})` only applies on creation.

## Claude #4 — review file overstates which rows the integration suite asserts
**Accepted; fixed.** The behavior matrix now attributes each row: the `401` is verified via
`isRequestAllowed` + `isPublicRoute('/ide/') === false` (new unit assertions), not through a full
`handleRequest` harness; the `Cache-Control`/`ETag` preservation is asserted through
`forwardIdeHttp` in the integration test and confirmed on the real-relay cloud run. A scope note on
the integration harness was added.

## Claude #5 (minor) — no log fn in `forwardIdeHttp`'s respawn; Open-IDE link builder
**Addressed.** The connect-error respawn path now passes the forward's `log` fn, so a failed
respawn is visible in Tower's log. The Open-IDE link builder is recorded as **deferred** in the
review file's corrections section (the plan permitted deferral).

## Codex — "required lifecycle / routed-auth / marker-integrity tests absent"
**Partially pre-existing, now strengthened.** Marker integrity and header hygiene were already
unit-asserted; added routed-auth (`isPublicRoute`) and tunnel-block (`isBlockedPath`) tests plus a
connect-refused → 502 integration case. Full lifecycle spawn/respawn against a *real* server binary
remains covered by the cloud run (codev-ide's Mac) rather than a unit test, since it requires the
private-fork build — noted in the review file.

**Build**: `pnpm --filter @cluesmith/codev build` green. **Tests**: IDE suites + all touched
existing suites green (see the follow-up commit).
