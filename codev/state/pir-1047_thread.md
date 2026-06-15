# PIR #1047 — Tower terminals freeze until restart

## Phase: plan (in progress)

### Investigation summary
- Symptom (from issue + 4 diagnostic comments): CPU climbs linearly with uptime (0.6% → 93% over ~10h), ALL PTY terminals freeze, restart fixes it, memory grows only +76MB (minor), FD growth glacial. SSE clients churn/marked-dead is a *secondary* symptom of CPU starvation (and SSE 5-min max-age eviction is by-design, not the bug).
- Leak-shape: CPU-bound work proportional to a growing in-memory collection, iterated on a per-data-frame or per-tick hot path. Regression window points at PIR #991 (terminal reconnect / successor-session resolution).
- Comments already ruled out: cron firing (bursty, bounded), the SSE pump itself (well-defended), GC-stall/memory mechanism (RSS minor).

### Code findings (grounded)
- `PtySession.onPtyData` (pty-session.ts:251-281) is the per-data-frame hot path: pushes ring buffer, writes disk log, iterates `this.clients`, emits `'data'`. The shellper `client.on('data')` fan-out (attachShellper, pty-session.ts:142) feeds it.
- HAZARD 1: `createSessionRaw` (pty-manager.ts:126-163) does `this.sessions.set(id, session)` with NO teardown of a pre-existing entry under the same id. Its safety comment ("map is empty at reconcile time, can't collide") only holds at startup reconcile, NOT the on-the-fly reconnect path (tower-terminals.ts:923) which runs live.
- HAZARD 2: `attachShellper` (pty-session.ts:119-197) adds `data`/`exit`/`close` listeners to the shellper client with no prior-listener removal; nothing explicitly detaches the OLD PtySession from its OLD client on reconnect (relies on GC, which fails if the old client stays referenced/alive).
- On-the-fly reconnect (tower-terminals.ts:860-958) is guarded by `!session`, so it fires once per lost-session window (NOT every poll — the subagent over-claimed "every poll"). Exact trigger for repeated accumulation is not confirmable by static read alone.

### Plan direction (initial draft — superseded)
First draft led with an EventEmitter listener-leak theory + instrumentation. Demoted after empirical work below.

### ROOT CAUSE CONFIRMED (empirical, 2026-06-15)
Architect pushed back: do we have a real hypothesis, and is restart actually the fix? Investigated the live state + on-disk PTY logs.

- Tower currently DOWN; 12 shellpers persist (by design).
- Measured `~/.agent-farm/logs/*.log` (raw PTY output). Incident-window log `f02bedcb…` (14 Jun 21:01, 15 MB) has **0 newlines** — longest no-newline run = the entire 14.57 MB. Byte census: 1.5M ESC, 164K CR, 0 LF → a Claude full-screen TUI redraw stream (`\e[?1049h \e[2J \e[H … \e[3G \r`). Normal sessions: ~20 bytes/line, longest line ~5-7KB.
- Root cause: two buffers bound by NEWLINE COUNT, never bound for a no-newline TUI stream:
  1. `RingBuffer.pushData` (ring-buffer.ts:36-51): `partial + data` then `split('\n')` every frame → O(partial) per frame, O(n²)/session, partial unbounded. No byte cap (only the stderr ring at session-manager.ts:67 has maxLineLength=10000).
  2. `ShellperReplayBuffer.append` (shellper-replay-buffer.ts:45,58): evicts only when lineCount>maxLines → 0 newlines → never evicts → unbounded; fed by shellper-process.ts:143.
- Explains ALL symptoms incl. the two the listener theory couldn't: CPU-without-memory, and **restart-unreliability** (shellper replay is also unbounded → restart re-seeds a 15 MB partial → O(n²) resumes unless the heavy session is gone). That is the answer to "not sure restart resolves it."

### Fix (plan rewritten)
Primary: (1) RingBuffer.pushData scan only `data` + byte-cap `partial` (front-trim); (2) ShellperReplayBuffer byte cap. Secondary/optional: listener hygiene (attachShellper idempotent, createSessionRaw teardown). Plus targeted instrumentation (log partial/replay sizes on the 30s heartbeat). Accelerated unit tests compress the leak into CI; replay-correctness test guards no-regression.

Plan rewritten in codev/plans/1047-tower-terminals-architects-bui.md — still at plan-approval gate, awaiting review. Two open questions for reviewer: cap sizes, and whether to include listener-hygiene here or split it out.

### CLINCHER: client-side replay storm (2026-06-15, from VSCode log)
Architect supplied tmp/vscode-log.txt (42,143 lines, 58 min) + screenshot. Storm confirmed:
- 14,026 "WebSocket connected" / 14,015 "Backpressure exceeded 1MB" / 14,026 "Connecting to" (1:1:1).
- 14,017 reconnects target ONE terminal: f2dc55d1. Its disk log = 1.9 MB, 0 newlines → replay 1.9 MB > client MAX_QUEUE (1 MB).
- Client handleData (terminal-adapter.ts:300-308): queuedBytes += payload; if >1MB → reconnect(). reconnect() (281-296) does backoff.reset() → instant retry, no backoff. Tower re-sends the 1.9 MB replay (tower-websocket.ts:62-65 getAll() = [partial]) → infinite loop.
- This replay storm (Tower re-serializing multi-MB replay ~14k×/hr on the single event loop) is the DOMINANT CPU driver; O(n²) split is secondary. Only ~1 MB of no-newline output is needed to trigger.

### Plan now has 3 coordinated fixes
A: RingBuffer.pushData scan-only-data + byte-cap partial (< MAX_QUEUE). B: ShellperReplayBuffer byte cap. C: client backpressure path must not infinite-loop (backoff + re-trip guard; ideally pause/resume bracket so replay isn't counted as live backpressure). Plus instrumentation. Still at plan-approval gate.

### Scope decision (2026-06-15): "do all together" — remote-resilient full fix
Architect asked for the most resilient approach given Tower may be hosted locally OR remotely (cloud/tunnel). Folded ALL into one coordinated PR:
- A: RingBuffer scan-only + byte-cap partial + **byte-addressable seq/getSince** (so resume works for no-newline streams).
- B: ShellperReplayBuffer byte cap.
- C: client redesign — **delta reconnect (?resume=lastSeq)** + replay excluded from backpressure (pause/resume bracket) + **live overload DROPS not reconnects** (mirror Tower bufferedAmount drop) + keep backoff/give-up safety net.
- D: Tower brackets replay with pause/resume + honors resume via byte-aware getSince.
- E: listener hygiene folded in (attachShellper idempotent, createSessionRaw teardown) — matters more remotely (frequent reconnects).
- Caps env-configurable; Fix C removes the hard MAX_PARTIAL_BYTES<MAX_QUEUE coupling (replay no longer counts as backpressure).
Key remote insight: reconnect-as-backpressure-remedy re-downloads the whole buffer over WAN = harmful; client must drop (like Tower already does) and resume-delta on reconnect. Sequenced commits A→B→D→C→E→instrumentation; reviewable incrementally; minimal safety net prevents storm even on partial landing.
Plan updated, still at plan-approval gate.

## Phase: implement (started 2026-06-15)
plan-approval gate approved. Building in order A→B→D→C→E→instrumentation, commit per logical unit. Will pause at dev-approval (run worktree) — no review file this phase.

## Implement progress (2026-06-15)
Committed in order:
- Fix A+E (8868ac86): RingBuffer scan-only pushData + byte-cap partial (DEFAULT_MAX_PARTIAL_BYTES=256KB, env CODEV_TERMINAL_MAX_PARTIAL_BYTES); createSessionRaw teardown + attachShellper idempotency.
- Fix B (prev): ShellperReplayBuffer byte cap (DEFAULT_MAX_REPLAY_BYTES=2MB, env CODEV_SHELLPER_MAX_REPLAY_BYTES).
- Fix C+D (f7e6b3a2): pause/resume replay bracket (server tower-websocket), client: replay excluded from backpressure + paced, live-overload DROPS (no reconnect), resume-delta reconnect (?resume=lastSeq), lastSeq reset on successor url.
- Instrumentation (9f282745): partialBytes getters + TerminalManager.inspectPartials + 60s Tower monitor log/WARN.
- Test fix (757a75a5): tower-websocket replay test now expects pause/replay/resume/seq.

DEVIATION from plan (byte-addressable seq): kept seq LINE-based. The byte-cap already bounds replay to <=256KB (<MAX_QUEUE), so line-based resume (delta for newline streams, bounded partial for no-newline) achieves the resilience goal WITHOUT breaking the wire contract + 14 existing ring-buffer tests. Will flag at gate.

Tests: ring-buffer (31), shellper-replay-buffer (new), vscode terminal-adapter (18, +5 new), full vscode suite (414) all green. Core suite: my changed-area tests green after test fix; remaining failures (session-manager integration, adopt/consult/update/hot-tier) are ENVIRONMENTAL (need dist/ + built skeleton from full `pnpm build`) — running full build to confirm.

## Course correction (2026-06-15): removed the byte caps — they broke replay
Dev-approval testing surfaced a regression: terminals open BLANK (cursor only), only a physical window resize paints them. Diagnosed: my Fix A/B byte caps (NEW in this PR; main had no byte cap, only line caps) front-trimmed the partial/replay, dropping the alt-screen-enter + screen-setup prefix. A full-screen TUI encodes its screen state in the cumulative stream from alt-screen-enter; truncating the front → xterm can't reconstruct → blank. The "reconnect repaints and heals it" assumption was WRONG: the app never sees the Tower↔client reconnect, so it doesn't repaint (only a real SIGWINCH/resize does).

Key realization: the byte caps were NOT needed for the freeze fix. CPU is fixed by scan-only pushData; the storm by the pause/resume bracket + drop-not-reconnect. The caps only bounded memory/replay-size — which the issue itself rated minor/orthogonal. And size-changes can't be handled by ANY replay (only by the app's repaint), so over-investing in replay bounding is wrong.

Action (architect-approved): stripped both byte caps, reverting partial/replay to main's faithful-unbounded behavior. Kept: scan-only pushData (CPU), Fix D bracket (no storm), client drop-not-reconnect + resume-delta + resize-deferral, Fix E listener hygiene, instrumentation (partialBytes monitor; WARN threshold raised to 4MB, reworded — it now surfaces unbounded growth for observability, not a cap). Removed env vars CODEV_TERMINAL_MAX_PARTIAL_BYTES / CODEV_SHELLPER_MAX_REPLAY_BYTES. Memory bounding (if ever needed) = screen-aware anchoring as a separate follow-up.

Tests after revert: core 3308 pass / 0 fail; vscode terminal-adapter 18 pass; build green. Awaiting re-test at dev-approval.

## Blank-on-open: Option A + diagnostics (2026-06-15)
Removing byte caps did NOT fix the blank-on-first-open → truncation wasn't the cause. The blank is the resize path: on first open the PTY stays at spawn-time size, the real setDimensions is deferred/lost during the replay window, app never gets SIGWINCH → blank until manual resize. (Confirmed empirically: manual window resize paints it.)

Fix = Option A (suggested earlier this session): in the `resume` control handler, always re-assert size via `sendResize(pendingResize ?? lastDimensions)` instead of only-if-pendingResize. Automates the known-good manual-resize action → SIGWINCH → repaint. #625 deferral-during-replay protection intact (we only send AFTER resume).

Also added temporary diagnostic logging (all tagged `[#1047-diag]`, greppable, to be stripped before gate): logs open(dims), setDimensions (deferred vs now), WS-open resize, sendResize source, pause/resume/seq controls, handleData replay-vs-live + byte counts. User builds+installs the extension directly, so these surface in the Terminal output channel.

NEXT: user rebuilds/installs extension, opens a terminal, pastes [#1047-diag] log. Confirms whether Option A paints it AND shows the exact event sequence.

## Blank-on-open ROOT CAUSE found via web-vs-vscode comparison (2026-06-15)
User asked the decisive question: why does the WEB dashboard render terminals fine but VS Code blanks? Both hit the same Tower/WS/PTY/Claude. → the bug is in the VS Code CLIENT's connect path, not Tower/PTY/SIGWINCH; the app DOES paint (web proves it).

Read packages/dashboard/src/components/Terminal.tsx. The web client's flushInitialBuffer (lines 463-506) UNCONDITIONALLY sends a resize ~500ms after connect, in every branch, with the comment "send SIGWINCH to make the shell redraw at the correct size". It even has a skipReplay mode: "discard replay, just send SIGWINCH to make the running program redraw from scratch". So the web's rendering robustness = forcing a post-connect redraw-SIGWINCH. The VS Code adapter had NO equivalent — only the on-open resize (which is a no-op if it matches the PTY size) → app never redraws → blank until manual resize.

FIX (mirrors the web): after WS open, schedule a settle-delay (500ms) repaint nudge — if nothing rendered yet, send resize(cols,rows-1) then resize(cols,rows) to guarantee a real SIGWINCH at the correct size. Gated on renderedSinceConnect so reconnects that painted via replay don't reflow. Cleared on close/reconnect. Nudge (vs plain resend) chosen because VS Code can't rely on the web's fit-difference; the 1-row delta guarantees the SIGWINCH even at same size.

This also resolves the earlier "how do you know it painted?" concern: the web client DOESN'T detect paint — it sends an unconditional delayed resize and trusts it. So we do the same (single gated nudge), not retry-until-painted.

Reverted Option A (resume-handler change) — log proved it never runs (empty buffer, no resume). Diagnostics still in (tagged [#1047-diag]) for this test. NEXT: user rebuilds/installs, opens terminal, confirms it paints + pastes [#1047-diag] log (should show "repaint nudge: ...→..." then handleData LIVE).

## Blank-on-open CONFIRMED FIXED (2026-06-15)
User confirmed terminals now paint on open with the repaint-nudge fix. Stripped all [#1047-diag] diagnostic logging from terminal-adapter.ts (13 lines). Typecheck clean, adapter tests 18/18. The nudge + WS-open resize (#737) remain separate as decided.
