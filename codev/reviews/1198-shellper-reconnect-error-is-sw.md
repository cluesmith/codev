# PIR Review: Shellper reconnect error swallowed — silent zombie terminals

Fixes #1198

## Summary

A post-handshake socket or parser error on a shellper connection ran `cleanup()` before the socket's `'close'` event fired, so the `'close'` emission (decided by reading `_connected`, already cleared) was swallowed — and with it every downstream recovery path. The terminal became a silent zombie: reported `running`, all input dropped, `"Message sent"` logged for messages that went nowhere, until the next Tower restart. This PR makes the client record the owed `'close'` at teardown time (`_closePending`, captured inside `cleanup()` where the knowledge exists), and — because emitting `'close'` alone would have made a transient error *permanently orphan* a healthy shellper (the historical close path unlinks the live socket and deletes the SQLite row) — pairs it with in-place recovery: SessionManager reconnects to the still-alive shellper (bounded retry with PID/start-time/socket preflight), PtySession defers its destructive teardown behind a 15s grace timer that a successful re-attach cancels, and the Tower layer re-attaches the replacement client. Supporting fixes: `'session-error'` finally has a consumer (ERROR-logged), adoption awaits the REPLAY frame instead of racing it (blank-until-poked terminals), sends to a dead terminal return 503 `TERMINAL_NOT_WRITABLE` and log `Message DROPPED` instead of false success, and `afx tower stop` polls until the process exits (SIGKILL after 8s) so `stop && start` serializes instead of overlapping adoption with teardown.

## Files Changed

- `packages/codev/src/terminal/shellper-client.ts` (+31 / −8)
- `packages/codev/src/terminal/session-manager.ts` (+147 / −45)
- `packages/codev/src/terminal/pty-session.ts` (+65 / −11)
- `packages/codev/src/terminal/pty-manager.ts` (+15 / −0)
- `packages/codev/src/agent-farm/servers/tower-server.ts` (+27 / −0)
- `packages/codev/src/agent-farm/servers/tower-terminals.ts` (+7 / −2)
- `packages/codev/src/agent-farm/servers/tower-routes.ts` (+13 / −0)
- `packages/codev/src/agent-farm/servers/send-buffer.ts` (+14 / −0)
- `packages/codev/src/agent-farm/commands/tower.ts` (+35 / −0)
- `packages/codev/src/terminal/__tests__/shellper-client.test.ts` (+71 / −0)
- `packages/codev/src/terminal/__tests__/session-manager.test.ts` (+130 / −0)
- `packages/codev/src/terminal/__tests__/pty-session-attach.test.ts` (+34 / −1)
- `packages/codev/src/terminal/__tests__/tower-shellper-integration.test.ts` (+42 / −3)
- `packages/codev/src/agent-farm/__tests__/send-buffer.test.ts` (+41 / −1)
- `packages/codev/src/agent-farm/__tests__/tower-routes.test.ts` (+33 / −5)
- `packages/codev/src/agent-farm/__tests__/tower-terminals.test.ts` (+2 / −0)

## Commits

- `adb335eb` [PIR #1198] Fix swallowed error-path close and make write/resize observable in ShellperClient
- `00afce9f` [PIR #1198] Reconnect in place on unexpected shellper socket close
- `8e224038` [PIR #1198] Grace-timer teardown on unexpected disconnect; observable write/resize in PtySession
- `f951a338` [PIR #1198] Tower layer: log session errors, re-attach reconnected clients, wait for replay, fail dropped sends loudly
- `fb61c59d` [PIR #1198] towerStop waits for process exit, escalating to SIGKILL after 8s
- `58fc3526` [PIR #1198] Tests: close emission, in-place reconnect, grace window, writable guards
- `41398bff` [PIR #1198] Collapse close-emission flags into a single _closePending recorded by cleanup
- `54ef5bd4` [PIR #1198] Extract towerStop wait timing into named constants

## Test Results

- `pnpm build` (workspace root): pass
- `pnpm test` (packages/codev): pass — 3532 tests, 0 failures (13 new tests)
- New coverage: error-path close emission (black-box: oversized frame header → parser error → `'close'` fires), intentional disconnect stays silent, write/resize delivery booleans, in-place reconnect success / dead-path / exhaustion (real Unix sockets against an in-process shellper), grace-window teardown and re-attach cancellation, `writable` guard, 503 send path, send-buffer hold-then-drop.
- One pre-existing test (`tower-shellper-integration`: "emits exit with code -1 on unexpected disconnect") asserted the old immediate-teardown behavior and was rewritten for the grace-window semantics.
- Manual verification: reviewed and dev-approval-gated by the human on the running worktree; the definitive live test (Tower restart on the patched build restoring the currently zombified architects) runs at deploy time — see How to Test Locally.

## Architecture Updates

Routed to **COLD** (`codev/resources/arch.md`, Shellper Process Architecture): a new "Connection-loss recovery (#1198)" subsection documenting the recovery pipeline (close-emission contract, in-place reconnect, grace-timer teardown, re-attach, write observability) and its invariant: never tear down a terminal's registry/DB state on a raw socket close without first checking whether the shellper process is alive. Nothing routed to HOT — `arch-critical.md` is at its 10-fact cap and this is subsystem-internal behavior, not a cross-cutting decision-changing fact; no existing hot fact is weaker than it.

## Lessons Learned Updates

Routed to **COLD** (`codev/resources/lessons-learned.md`, Debugging and Root Cause Analysis): two entries — (1) lifecycle emissions must be decided from state captured at the teardown transition, not re-read later, and un-swallowing a long-suppressed event requires auditing every consumer first (the naive fix would have converted zombies into permanently orphaned sessions); (2) success-shaped logging ("Message sent" with no delivery signal) turns an outage invisible — delivery paths need an observable failure contract at the API boundary, not just logs. Nothing routed to HOT (cap full; these are narrower than the current ten).

## Things to Look At During PR Review

- **Live-deploy incident (2026-07-19, fixed in this branch — read this first).** The first install of this branch surfaced the *true* trigger of the whole issue and a critical amplification in my recovery design. Two long-lived architects (shannon/app, codev architect) had **replay buffers over MAX_FRAME_SIZE (17.6MB / 17.7MB > 16MB)**. The shellper sends that as one REPLAY frame; the parser treated it as a fatal stream error — **deterministically, on every connect**. On the old code that error was swallowed → the original zombies (the stop/start-overlap theory was wrong; same terminal zombified every restart because the failure is deterministic). On this branch pre-fix, recovery retried the deterministic failure, exhausted its rounds, took the dead path, **unlinked the live sockets** → `killOrphanedShellpers` then killed both live shellpers and their Claude conversations. Fix, three layers: (1) `FrameParser` now **discards** oversized frames incrementally (`'frame-skipped'` event) and keeps the stream alive — mandatory Tower-side because running shellpers are old binaries; (2) `removeDeadSession` **never unlinks a live process's socket**, so any future deterministic failure degrades to a recoverable orphan instead of feeding the kill sweeper; (3) new shellpers cap replay to `REPLAY_PAYLOAD_MAX` (8MB tail; client resolves skipped replay as empty and viewers repaint via the post-connect resize nudge). Regression tests at all three layers (client-level oversized-REPLAY survival test reproduces the incident shape byte-for-byte). Verified post-fix on the live fleet: all 20 surviving sessions show live-Tower fds and non-empty output buffers.
- **Post-incident follow-ups (both fixed in-branch).** (1) *UI interactivity regression*: restoring the replay path meant adoption seeded up to 16MB of newline-free history into each ring buffer, and every viewer attach shipped that whole payload to xterm.js in one bracketed write (multi-second parse; webview stalls needing a reload). Adoption now caps the ring seed to the most recent 1MB (`RING_SEED_MAX_BYTES`, logged when trimming); the shellper retains full history and TUIs repaint via the resize nudge. (2) *Architect review finding (PID-reuse leak, Medium)*: `removeDeadSession` gated socket unlink on `isProcessAlive` alone, so a reused PID would leak a dead shellper's socket/log. The unlink decision is now async best-effort (`cleanupDeadSessionSocket`) using the same alive + start-time guard as reconnection (`isShellperProcessCurrent`, shared with `canReachShellper`); `removeDeadSession`'s map mutation stays synchronous.
- **Consultation round 2 (human-requested, on the post-incident diff)**: claude APPROVE; codex COMMENT with one accepted note — creation-time attach also raced the REPLAY frame (real for fast-starting children). Fixed with zero creation latency: new shellpers always send a REPLAY frame even when empty, and all four creation sites await it. Codex's second note (plan frontmatter) rebutted in the rebuttals file: porch-driven artifacts carry their approval in `status.yaml` gate history, not retroactive frontmatter.
- **Consultation finding (codex, REQUEST_CHANGES — fixed)**: `attachShellper()` opened the disk-log fd unconditionally; with re-attach now a routine recovery step, every reconnect leaked one append handle when disk logging is enabled. Fixed by guarding the open on `logFd === null` (`pty-session.ts`; `cleanupShellper()` closes and nulls the fd, so post-teardown attaches still reopen). Regression test pins it: `pty-session-attach.test.ts` "does not reopen the disk log when a recovery re-attach arrives" (attach → re-attach → one open; detach → attach → second open). PIR's consultation is single-pass, so this fix was not independently re-reviewed — worth a human glance at the guard. The claude consultation verdict was APPROVE.
- **The recovery loop guards** (`session-manager.ts`, `recoverSession`): the 3-attempt/3-round caps with the 30s stability reset, and the `session.client !== client` stale-wiring checks that prevent a replaced client's events from re-triggering recovery.
- **Grace-timer interplay** (`pty-session.ts`): the 15s `SHELLPER_CLOSE_GRACE_MS` teardown deferral is sized above SessionManager's worst-case recovery round (~4s); `attachShellper` cancels it. A genuinely dead terminal now reports `exited` up to 15s later than before (writes to it fail loudly during the window via the `writable` guard).
- **Re-attach passes empty replay deliberately** (`tower-server.ts`): the ring buffer already holds session history; replaying would duplicate output. Known limitation: bytes the PTY emitted during the disconnection window (seconds) are not spliced in — a full-screen TUI repaints past this; a plain shell's scrollback genuinely misses those lines.
- **`findByShellperSessionId`** (`pty-manager.ts`): needed because the create flow keys SessionManager by a fresh UUID while adoption keys by terminal id.
- **Known gaps, deliberately out of scope, for follow-up issues**: (a) PING/PONG heartbeat detection for a socket that hangs open without erroring (issue #1198 item 5, first half); (b) `connect()` has no handshake timeout — a shellper that accepts but never sends WELCOME would hang a recovery attempt (pre-existing exposure, shared with the adoption path; fails visible via the grace timer, not as a zombie); (c) possible enum consolidation of the client's connection-lifecycle state, best done together with (a).

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder pir-1198 → **Review Diff**
- **Run dev**: `afx dev pir-1198`, or for the definitive live test install this branch's build: `cd .builders/pir-1198 && pnpm build && pnpm -w run local-install`
- **What to verify** (maps to the plan's Test Plan):
  - After the Tower restart, every persistent terminal's `GET /api/terminals/:id/output` returns `total >= 1` immediately (previously blank-until-poked); the previously zombified architects respond to typed input and `afx send`.
  - `afx tower stop` returns only after the process exits (`lsof -i :4100` is empty when it returns); `stop && start` shows no port-in-use retries.
  - Kill a disposable terminal's shellper with SIGKILL, then `afx send` to it: the send errors with `TERMINAL_NOT_WRITABLE` and the Tower log shows `Message DROPPED`, never `Message sent`.
  - Tower log after any connection blip shows `connection lost unexpectedly` followed by `re-established` / `re-attached` (recovery) or an ERROR line (genuine death) — never silence.
