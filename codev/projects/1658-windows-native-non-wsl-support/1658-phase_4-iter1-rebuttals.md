# Phase 4 iteration 1: responses to the 3-way review

Porch's slot `phase_4` carries plan phases 3b (a891d303c..cfedc4f1e, reviewed separately in
`1658-phase_3b-iter1-rebuttals.md`) and 4 (b980eceaf onward). Gemini skipped (agy not
signed in). Codex: REQUEST_CHANGES. Claude: APPROVE with minor notes.

Between the consult's start and these responses, the architect's own review found a
must-fix in `POST /api/shutdown`: a tunnel-borne request arrives over loopback with the real
key, so it passed both checks. Fixed in 6617ad72e (the route refuses the tunnel proxy marker,
and the proxy blocks the path) and d4fd2e7b6 (the refusal is logged through `logSafe`), with
tests. Claude's review predates the fix, so its "loopback-gated, a keyed tunnel client cannot
stop the daemon" line describes the code before 6617ad72e.

## Codex

1. **Scenario 4 checks only the shellper pid, not the agent's.** Accepted. The stub's banner
   carries its own pid; the test now records it, asserts that pid is alive after the stop and
   after the restart, and waits for the replay to contain that same pid's banner.

## Claude (non-blocking)

1. **A wedged Tower (alive, not answering, not listening) is reported not running.** Not
   changed in Phase 4. A Tower that holds no listener is not serving anything, and the lock
   pid alone is not trusted on purpose (pid reuse). Verifying the lock pid through the census
   (`tower-server.js` in the command line plus a matching creation time) would cover it
   without the reuse risk. Noted as a follow-up in the review doc; the criteria do not need it.
2. **EPERM read as dead in the CIM start's liveness probe, as alive in the stop.** Accepted:
   both treat EPERM as alive now.
3. **`servers/tower-routes.ts` imports from `commands/`.** Accepted: `isInsideCodevSession`
   moved to `terminal/shellper-endpoint.ts`, next to the marker it reads, and the route
   imports it from there. (`tower-start-windows.ts` re-exports it for its own callers.)
4. **The force path sweeps shellpers even with no Tower listening.** Kept: the flag says "all
   child processes", and a shellper left behind by a dead Tower is exactly what it is for.
5. **Dev mode through CIM depends on `cmd.exe` parsing.** Kept: dev mode only (`npx tsx`
   needs `cmd.exe` to resolve `npx.cmd`), and every argument there is a path this code builds.

## Verified

POSIX: the touched suites pass (158 in the route, stop and launch files); the full suite ran
green before the review (7023 passed). Windows: run 39660493868 on the fix commit, all 23
Windows-only tests pass (scenarios 3, 4 with the agent pid, 5, the CIM survival test, and
the 3b job and teardown tests).
