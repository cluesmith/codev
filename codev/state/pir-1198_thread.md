# Builder thread: pir-1198

PIR builder for issue #1198 (shellper reconnect error swallowed, terminal becomes silent zombie).

## Plan phase

- Verified every claim in the issue against the code. All confirmed:
  - `shellper-client.ts` `cleanup()` clears `_connected` before the socket `'close'` event fires, so the `wasConnected` guard suppresses `'close'` on every error-path close.
  - `session-manager.ts` close handlers (both createSession and reconnectSession paths) are the only code that logs "shellper disconnected unexpectedly" and removes the dead session. They never run on error-path closes.
  - `'session-error'` has zero consumers outside session-manager.ts (grep across packages/codev and packages/core).
  - `write()`/`resize()` are silent no-ops when `_connected` is false; the message router logs "Message sent" regardless.
  - `towerStop` sends SIGTERM and returns without waiting.
- Important extra finding: fixing the close emission ALONE is hazardous. The unexpected-close path calls `removeDeadSession` (unlinks the LIVE shellper's socket file) and PtySession's close handler emits 'exit', whose tower-side handler calls `deleteTerminalSession` (deletes the SQLite row). A transient socket error against a healthy shellper would permanently orphan a live Claude conversation. So the plan includes reconnect-in-place (bounded retry) before declaring the session dead. This is also what the issue's item 5 suggests ("re-run the reconnect for that session").
- Second extra finding (matches architect's fleet-sweep comment): both adoption call sites read `client.getReplayData()` synchronously right after `connect()` resolves, racing the REPLAY frame which often arrives in a later socket read. `waitForReplay()` exists and is unused there. This explains the blank-until-poked healthy terminals (6 false positives in the sweep).
- attach.ts (terminal-mode client) has the same swallowed-close symptom and gets fixed for free.

Plan written to codev/plans/1198-shellper-reconnect-error-is-sw.md. Waiting at plan-approval gate.

## Implement phase

Plan approved as written (architect confirmed the core = swallowed close + session-error consumer; heartbeat detection stays a follow-up). Implementation landed in six commits:

1. shellper-client.ts: `_everConnected` + `_intentionalDisconnect` flags; error-path closes now emit 'close'; write/resize return boolean.
2. session-manager.ts: wiring unified into `wireClientEvents`; unexpected close triggers `recoverSession` (up to 3 attempts, 500ms/1s/2s backoff, PID + start-time + socket-file preflight, 3-round cap with 30s stability reset) before the historical dead path; new 'session-reconnected' event. pty-manager.ts gained `findByShellperSessionId` (create flow keys SessionManager by a UUID distinct from the terminal id; adoption keys by terminal id — the helper handles both).
3. pty-session.ts: unexpected-close teardown deferred behind a 15s grace timer (`SHELLPER_CLOSE_GRACE_MS`), cancelled by attachShellper; `writable` getter; boolean write/resize.
4. Tower: session-error now logged at ERROR; session-reconnected re-attaches the replacement client (empty replay to avoid duplicating ring-buffer content); both adoption sites use `waitForReplay()` instead of racing the REPLAY frame; send router returns 503 TERMINAL_NOT_WRITABLE + logs "Message DROPPED" instead of "Message sent"; send-buffer holds messages while a session is unwritable and only drops (loudly) at max age.
5. tower.ts: towerStop polls for process exit (8s), SIGKILL escalation.

Notable test change: tower-shellper-integration's "emits exit with code -1 on unexpected disconnect" was asserting the OLD immediate-teardown behavior; rewritten for the grace-window semantics plus a re-attach-cancels-teardown case.

## Dev-approval gate iteration

Architect probed the design hard at the gate. Two code changes came out of it:
- The `_connected`/`_everConnected`/`_intentionalDisconnect` trio collapsed into a single `_closePending` recorded inside `cleanup(intentional)` — the reviewer's "these feel like duplicates" instinct was right; capturing the decision at the transition point is both smaller and clearer (41398bff).
- towerStop's 8000/200 literals extracted to STOP_EXIT_TIMEOUT_MS / STOP_CHECK_INTERVAL_MS (54ef5bd4).
Also surfaced honestly at the gate: replay-gap loss on re-attach, no handshake timeout in connect() (pre-existing), tuning numbers are heuristics, incident trigger (stop/start overlap) is probable-not-proven.

## Review phase

Review file written; arch.md gained "Connection-loss recovery (#1198)" under Shellper Process Architecture; lessons-learned.md gained two entries (transition-time state capture / audit consumers before un-swallowing an event; success-shaped logging). HOT tier untouched (at cap; nothing here displaces the current ten). Follow-up candidates for the architect to file: heartbeat detection, connect() handshake timeout, lifecycle enum consolidation.

## Live-deploy incident at the pr gate (2026-07-19)

First install of the branch KILLED two architects (shannon/app pid 4509, codev architect pid 6348). Log-driven RCA: their replay buffers exceeded MAX_FRAME_SIZE (17.6/17.7MB > 16MB) — the parser threw on the REPLAY frame deterministically on every connect. THIS was the original zombie trigger all along (not the stop/start overlap; explains why the same terminal re-zombified every restart). My recovery loop retried the deterministic failure, gave up after 3 rounds, dead path unlinked the LIVE sockets, and killOrphanedShellpers killed both processes. Fix: parser discards oversized frames ('frame-skipped') instead of erroring (required Tower-side: running shellpers are old binaries); removeDeadSession preserves a live process's socket; new shellpers cap replay to an 8MB tail. Lesson recorded: retry loops assume transience — classify the first failure, and the give-up path must preserve state, not destroy it. Post-fix fleet check: all 20 surviving sessions have live fds and non-empty buffers. The two killed conversations are unrecoverable.

PR #1204 opened. Consult (single pass): claude=APPROVE, codex=REQUEST_CHANGES. Codex's finding was a real regression: attachShellper() leaked one disk-log fd per recovery re-attach. Fixed (guard open on logFd===null) + regression test, documented in review + rebuttal file; consult validated the consult-trusting lesson once again. Also caught at final worktree check: the exitInfo.code ?? -1 type fix had been verified by every build but never staged — committed in 0db7c7b7. Waiting at pr gate.
