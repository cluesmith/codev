# Phase 4 iteration 2: responses to the 3-way review

Gemini skipped (agy not signed in). Codex: REQUEST_CHANGES. Claude: APPROVE with comments.

## Codex

1. **A bridge-mode Tower bound to a LAN address cannot be stopped gracefully.** Accepted. The
   stop sends its request to the recorded bind host, so it arrives from that address rather
   than loopback, and the route refused it. The route now accepts a peer that is this machine:
   loopback or one of its own interface addresses (`isLocalMachineAddress`). A remote host
   cannot complete a TCP handshake from one of our addresses, so only local callers pass; the
   key and the tunnel-marker refusal still apply. Unit-tested (own LAN and link-local addresses
   accepted, IPv4-mapped too; another LAN address, documentation-range addresses and a
   missing address refused). Windows: a new bridge-mode test binds Tower to the runner's LAN
   address, and `afx tower stop` shuts it down gracefully (log "Graceful shutdown complete",
   owner lock released). `afx tower start` probes readiness on loopback, which a LAN-bound
   Tower does not answer; that is a limitation of the start command on every platform, out of
   this phase's scope, so the test waits on the daemon itself.

## Claude (comments)

1. **The replay match would also pass a respawned stub.** Accepted: scenario 4 asserts exactly
   one banner after the restart.
2. **Phase 4 (b) never checks PTY output under the CIM-created Tower.** Accepted: it waits for
   the stub's banner through that Tower.
3. **With the census blocked, the force path reports "not running" after a taskkill.**
   Accepted: Tower trees are counted by outcome (the pid is gone afterwards), so a teardown
   that rejects after acting still counts. Unit-tested both ways.
4. **The dev-mode CIM branch has no unit coverage.** Accepted: a test puts
   `tower-server.ts` in place and checks the CIM command is `cmd.exe /d /c npx tsx <server>`.
5. **Wedged Tower** remains the documented follow-up.

## Verified

POSIX: touched suites green (161 in the route, stop and launch files). Windows: run
39662352535, all 24 Windows-only tests pass, the bridge-mode test included.
