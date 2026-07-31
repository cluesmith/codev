# Spike: afx send input corruption — line-occupancy detection & non-destructive delivery (#1265)

**Date**: 2026-07-31 (spike ran 2026-07-30–31 across ten review rounds; round-by-round history in `codev/state/spike-1265_thread.md` and git)

**Verdict**: **Feasible** — validated empirically on the real TUIs. The issue's recommended combination survives with major revisions: delivery forms are strictly **per-app** (claude needs the *unbracketed* atomic form, codex the *bracketed* one — each fails with the other's), the proposed composing clear-set was wrong on two keys (ESC does not clear codex; Ctrl+G opens `$EDITOR`), **H** is best-effort, journal-backed, bounded to window-fitting drafts, and sits behind a phase-2 build/skip gate, **K's hold core is a phase-1 requirement** (no phase may ever force-inject), **every session is born dirty**, and **every delivery is gated by an output-side rendered-empty check plus a post-delivery verify** — input-side tracking provably cannot see the builder launch-loop wrapper's silent-loss states (`i8`). The achievable phase-1 property is **no force-inject path and no *undetected* loss path**.

## Question

Issue #1265: `afx send` can land mid-draft and submit the user's half-typed input fused with the message, because deferral keys on a 3 s idle timer (`isUserIdle`) instead of real line occupancy. The issue analyzes options on three axes — detection (A/E/F/G), delivery (B/C/H/I/J), channel (D/K/L) — and recommends A+E core, H at the 60 s max-age, J framing, I/K hardening. This spike answers the empirical unknowns analysis could not settle, against the real TUIs, and delivers a go/no-go per building block plus the integration constraints a full implementation must honor. The output feeds the decision on whether/how to create the SPIR implementation project.

Versions tested: Claude Code 2.1.212 throughout; Codex 0.145.0, bumped mid-spike to 0.146.0 (the asserted codex suite re-ran green on 0.146; exploratory-tier codex measurements remain 0.145); agy (Antigravity CLI) 1.1.8 probed as a delivery target; emulator pinned at `@xterm/headless` 6.0.0 (recorded in every run's `.out`).

## Research Summary

**Prior art**: #450 added a `composing` flag; #492 tore it out (stuck-true bugs: Ctrl+C, arrows, Tab); #584 added char pacing for an Enter-swallow that no longer reproduces; Spec 403 added typing-awareness. #1264 (double-`^C` kills the agent) constrains which bytes are injectable.

**Code audit — today's pipeline corrupts or loses in at least six distinct places**:

- `shouldDefer` (`tower-routes.ts:1566-1589`) is timer-only: a 3.5 s pause delivers onto an occupied line.
- No write-layer serialization exists: `writeMessageToSession` schedules with bare `setTimeout`s; its `delayOffset` serialization parameter is passed only by `SendBuffer.flush` within a batch (`tower-routes.ts:120-124`). Two concurrent sends blob (measured, `w1a`).
- Cron writes straight to the PTY — no idle check, no buffer (`tower-cron.ts:303-323`, WARN-and-drop on dead targets, "delivered" logged unconditionally); `POST /api/terminals/:id/write` (`tower-routes.ts:902`) is an arbitrary-byte HTTP write path; `noEnter` sends (`tower-routes.ts:1586`) stage composer text no WebSocket frame ever carried.
- `SendBuffer` is in-memory: held messages die with a Tower crash; `stop()` **force-flushes on graceful shutdown** (`send-buffer.ts:76`); dead-session messages are discarded with a WARN (`:86-92`), unwritable-at-max-age messages dropped with an ERROR (`:103-110`).
- K has no substrate: `broadcastMessage` is live-only fire-and-forget over in-memory WS subscribers (`tower-messages.ts:430`), the only `/ws/messages` consumers in the repo are e2e tests, and `global.db` has no messages table. A K-escalated message would vanish while `afx send` reports success.
- Builder terminals run inside a launch-loop wrapper (`LAUNCH_LOOP_TAIL`, `spawn-worktree.ts:798`; architect sessions have none) whose prompt/restart states silently eat or strand deliveries — measured, see the wrapper finding under Approaches Tried.

**Method**: a node-pty + `@xterm/headless` harness (`codev/spikes/1265-poc/`) spawns the actual `claude`/`codex` binaries, injects keystroke bytes exactly as Tower's `session.write()` does, and asserts on the *rendered* composer. Claude submissions ran against an unroutable `ANTHROPIC_BASE_URL` (full submit mechanics, zero API calls); codex ignores base-URL overrides under ChatGPT OAuth, so codex submissions used the local `/status` command only (plus three accidental tiny prompts early on). Two evidence tiers: **exploratory** probes (`exp0*`–`exp-i4`, discovered the behaviors) and **regression-grade asserted suites** (`a3`, `i5`, `i6`, `w1`, `g2`, `i7`, `i8`, `i9`) — every claim an ASSERT, failures exit non-zero, full stdout committed under `1265-poc/results/`, sessions isolated per case (`i5` is single-session *by design* — a sequence test with exact-equality oracles; `i8` case B's landing spot and `i9c`'s at-cap outcomes are measured rather than asserted, though case B's never-looks-delivered safety property is asserted). The suite doubles as the version-bump smoke test — exercised in anger on codex 0.145→0.146, green, no divergence. Honest residual: driving live TUIs is timing-sensitive; mitigated with condition-based waits, double-sampled reference captures, and content (never chrome) assertions.

Evidence-tag map: `a3` cursor-relative editing semantics; `b*`/`c*`/`e*`/`h*`/`i2*`–`i4`/`j*` exploratory detection/delivery probes; `p*` end-to-end max-age sequence (`exp-i5`); `i6*` gating/flush-ordering/menu demos (`i6a`/`i6b` need the dead-API rig — claude-only; codex runs the `i6c` menu demos, 2 of 11 assertions); `w1*` writer-race demos driving the real `message-write.ts` at unit level (no TUI — the subject is Tower's own scheduling); `g2*` G-lite classifier on the production ring-replay data path; `i7*` bulk-maneuver timings; `i8*` wrapper-loss demos (production `LAUNCH_LOOP_TAIL` extracted from source at runtime) + detectability; `i9*` verification-oracle audit.

## Approaches Tried

### Per-option verdicts

| Option | Verdict | Evidence |
|---|---|---|
| **A** — fixed `composing` occupancy | **GO (revised)** | The issue's clear-set was wrong on two keys (see keystroke table); with the corrected lifecycle the #492 stuck-true scenarios resolve or go safely conservative. Subsumed by the DraftTracker. |
| **E** — flush on user submit | **GO** | Delivery 0 ms after the user's Enter lands as its own queued entry, no concatenation, even mid-retry (`e1`). Needs a real submit-detector plus after-the-Enter-write ordering (`i6b`). |
| **H** — draft byte capture + verbatim replay | **GO — best-effort, journal-backed, window-bounded, phase-2-gated** | A 3-line draft containing a backspace edit was cleared, a message injected+submitted, and the captured bytes replayed — composer reconstructed **byte-identical** on both TUIs (`h3`, `c4`; end-to-end `p5`). Sequence, bounds, and preconditions in the delivery matrix below. |
| **I** — atomic single-write | **GO, per-app forms — single-line drafts only** | claude: unbracketed `^E ^U msg \r ^Y` in one write works for single- and multi-line *messages* (`b3`, `i4`); the bracketed variant **submitted the draft** (`i3`). codex: bracketed works (`i2a`); unbracketed fails (`\r` becomes a newline). Atomicity genuinely closes the race — a user byte 5 ms later appended cleanly. |
| **B/C** — kill/yank restore | **GO, single-line only — subsumed by I** | Kill-ring/deleted-text buffers are real on both, but `^U` kills only the current line of a multi-line draft (`b4`) — multi-line restore impossible, as the issue predicted. |
| **J** — bracketed-paste framing | **GO for codex / NOT in claude's atomic path** | Required for codex atomic delivery (`i2a`); actively harmful in claude's (`i3`). Not a control-char sanitizer: claude swallowed chars after an in-bracket ESC (`j3`). |
| **F** — DSR cursor probe | Not tested | Superseded: H's capture is a better occupancy signal than cursor column; no fragile probe/response parsing needed. |
| **G** — output-stream line modeling | **G-lite slice REQUIRED; full G not needed** | The rendered-empty check is both the universal pre-delivery gate and the post-delivery verify (below). Full line modeling stays a fallback if future TUIs break input-side assumptions. |
| **K** — side-channel escalation | **REQUIRED — substrate must be built, not reused** | See code audit: today a K-escalated message would silently vanish. Needs a persisted mailbox, a visible surface, and honest response semantics (constraint 6). |
| **#584 pacing** (context) | **Obsolete on current TUIs** | The Enter-swallow does not reproduce: a 5-line message in ONE write + `\r` at 50 ms submits fine on both (`j1`). Retire for verified apps; keep for unknown. |

### Baseline reproduced

`e0`: type `deploy the hotfix to prod once`, pause 3.5 s (`isUserIdle(3000)` → true), deliver today-style (`write(msg)` + `\r` at 50 ms) → one blob submitted: `deploy the hotfix to prod once[builder spir-999] tests green, ready to merge` (recalled verbatim from claude's history, `e2`).

### Keystroke → occupancy classification (measured)

| Key | claude 2.1.212 | codex 0.145/0.146 | Tracker action |
|---|---|---|---|
| printable | occupies | occupies | append (exception: leading `/` on an empty buffer opens the slash menu → **dirty**) |
| bare `\r` | **submits** | **submits** | clear buffer; **flush trigger (E)** |
| `\x1b\r` (Alt+Enter) | newline in draft | newline in draft | append newline — NOT submit |
| `\n` (Ctrl+J) | newline in draft | newline in draft | append newline — NOT submit |
| `\\` then `\r` | newline (continuation) | **submits** | treat as non-submit (worst case is deferral, not corruption) |
| Ctrl+U | kills `[line-start, cursor)` (`a3a`) | same | cursor-aware delete; unmodeled cursor → **dirty** |
| Ctrl+C | clears draft (arms exit if already empty) | clears draft | clear buffer; model-already-empty → **dirty** (deliberate-exit gesture; a second `^C` kills the agent, #1264) |
| ESC ×1 | nothing ("Esc again to clear") | nothing | occupancy no-op; **dirty** (interrupts in-flight turns; queued-restore / edit-last hazards) |
| ESC ×2 | clears draft (overlay hazards when empty) | does **NOT** clear | app-dependent — no portable clear exists; **dirty** |
| Ctrl+G | **opens `$EDITOR`** | same | modal — never in any clear-set (the issue proposed it; wrong) |
| Up | occupies (history/queued recall) | occupies (recalls cross-session) | composing; **dirty** |
| Down | may return to empty | same | keep composing (conservative); **dirty** |
| Tab | hint only, line unchanged | line unchanged | occupancy-neutral (a #492 stuck-true source); **dirty** (context-dependent, e.g. `@`-mention completion) |
| Left/Right | cursor only | cursor only | move the modeled cursor |
| Backspace | deletes **at the cursor** (`a3b`) | same | cursor-aware delete; model-empty ⇒ not composing |

Two orthogonal axes: **occupancy** (does the composer hold text — drives A's defer and E's flush; Tab/ESC are genuinely neutral here, the #492 lesson) and **mode confidence** (could a menu/overlay be consuming keys — drives the dirty machine; ESC/Tab/Up/Down/leading-`/` are suspects). Occupancy-neutral never means safe-to-inject: injection requires clean on **both** axes.

The tracker needs **two structures**, because Ctrl+U/Backspace are cursor-relative (`a3`): a **raw replay log** (verbatim bytes — ground truth for H; editing keys replay faithfully, so modeling errors can never corrupt a replay) and a **modeled line state** (per-line text + cursor) answering "is the composer empty?" for A/E. A naive clear-on-`^U` model declares `abcdef`+Left×3+`^U` empty while the line shows `def` — delivery onto an occupied line. Any byte the model can't confidently apply → **dirty** → defer + K. The clear maneuver is cursor-safe by construction: its `^E` prefix moves to end-of-line before each `^U` (`a3c`).

### Submit-detector hazards (E)

Today's `data.includes('\r') || data.includes('\n')` heuristic (`tower-websocket.ts:96`) is wrong in both directions. Submit ⇔ bare `\r`: not `\x1b\r`, not `\n`, not a `\r` after `\\` (claude continuation), not inside `ESC[200~…201~` paste content. (Kitty-protocol Enter `\x1b[13u` is worth matching; missing it only defers — safe direction.) Even a correctly classified bare `\r` is a submit only when no menu/mode is open (`i6c`) — the dirty machine governs whether the flush may fire. **Ordering**: the flush must write strictly *after* the user's Enter byte reaches the PTY — the current handler tracks before `session.write(data)`, and flushing from there submits the blob (`i6b`; PTY fd writes are FIFO, so writing after the call suffices).

### Delivery matrix (max-age / busy-line path)

Two non-overlapping paths selected by captured draft shape. The trailing `^Y` is the *single-line restore* and appears **only** there (see kill-ring below).

**Single-line drafts — I/B kill/yank restore; form ENDS in `^Y` (one write):**

| Target | Form | Evidence |
|---|---|---|
| claude | `^E ^U` + msg (raw; multi-line msg ok) + `\r` + `^Y` | `b3`, `i4` |
| codex | `^E ^U` + `ESC[200~` msg `ESC[201~` + `\r` + `^Y` | `i2a` |

**Multi-line drafts — H byte-replay restore; NO `^Y` anywhere:**

| Target | Sequence | Evidence |
|---|---|---|
| claude | per-line clear `(^E ^U BS)×N` → `^E ^U` + msg + `\r` (one write) → byte-replay | `p5` |
| codex | same, message bracketed | `p5` |
| unknown app | **no injection form — defer-only + K** (constraint 10; the `i2b`/`j2` semi-atomic shape is a future onboarding recipe, not a default) | `i2b`, `j2` |

N = captured newline count + slack rounds (extra Backspace on an empty composer is a no-op).

**Maneuver bounds (`i7`, `i9c`)**: every step bulks to one write for typical drafts — whole maneuver **~1–3 s** including verify settles at ≤~12 lines — with per-app O(lines) fallbacks at size: claude's bulk clear stalls beyond ~13 lines (paced 150 ms/line fallback), codex's bulk replay paste-collapses beyond ~0.5 KB into a `[Pasted Content …]` attachment (content preserved, composer NOT restored — line-chunked replay at 40 ms/line is its validated form, 3.2 s at 40 lines). The divert-gate fail-open timeout is therefore **specifiable as f(app, lines)** (~40-line worst case ≈ 7 s claude / 3.5 s codex). At ~8.2 KB (41×199-char wrapped lines, `i9c`) the TUIs diverge oppositely: codex completes the whole maneuver **editor-verified byte-identical** (8199/8199 chars); claude's CLEAR step fails outright (85 rounds left ~27 wrapped lines; fail-safe — the condition-wait sees the unemptied composer and aborts with the draft intact). The clear primitive degrades with line *width*, not just count. **8 KB survives only as the capture/journal cap, not a validated maneuver envelope.**

**Verification is window-bounded (`i9b`)**: tall drafts scroll — the rendered composer is a *window* (~11 composer rows claude / ~28 codex at 32-row terminals) — and a replay missing its first line renders a window **byte-identical to the reference on both TUIs**. A lab-only full-content oracle proved the loss is real (Ctrl+G opens `$EDITOR`; a capture-script EDITOR copies the whole draft file; `i9a` validates it byte-identical with a composer-preserving roundtrip). Production has no such oracle — Ctrl+G is modal — so H gains a **fits-the-rendered-window entry precondition**, read from the live render at maneuver entry, where the tracked draft must equal the rendered composer *in full* (doubling as the capture-consistency proof; any mismatch aborts to K before the first destructive byte). Within the window, the equality attests the whole draft, making journal deletion on verify-pass sound.

**Kill-ring (`p3`, `p4`)**: the per-line clear primes the ring with exactly the **first draft line** (bottom-up kills, overwrite semantics, both TUIs); a later `^Y` yanks it back ahead of the replay — first line duplicated, measured on both. No injectable ring neutralizer exists (`^U` on an empty composer doesn't scrub it). The fix is structural: the multi-line/H path never sends `^Y`; the replay alone restores (`p5` byte-identical).

**Transaction + divert (`i6a`)**: the maneuver runs as a transaction on the per-session write queue with user input **diverted** and appended after the replay — an ungated mid-maneuver keystroke was applied **twice** (naive also-append policy); the diverted-and-appended variant reconstructed `draft + Z` exactly. Journal-first (constraint 7), fail-open timeout.

### Output-side gate and post-delivery verify (G-lite)

The rendered-empty check runs on the **production data path**: `ringBuffer.getAll().join('\n')` — the exact reconnect-replay join (`tower-websocket.ts:66-67`) — written into a transient `@xterm/headless` instance, disposed after the check. Classifier: composer marker present AND zero normal-intensity non-whitespace cells in the composer region. Placeholder text is SGR-**dim** on both TUIs while user text is normal-intensity (`g2a`/`g2f`; four rotating codex placeholders classified clean in one run — no placeholder allowlist to rot); the two tripwires are independent (codex's full-screen model picker *finds* a marker in its `›`-prefixed rows and trips on 116 normal-intensity cells, `g2j`; agy trips on no-marker). Validated on both TUIs across idle / draft / menu-with-filter / model picker / churn / arbitrary mid-byte truncation (the `capRingSeed` cut) / resize-nudge in draft and empty variants (`g2*`); stream shapes differ (claude emits no newlines at all, `g2d`; codex mixes 16 lines + 17 KB partial, `g2m`) and both reconstruct. **Cost: 2 ms @ 13 KB, 22 ms @ 1 MB (= `RING_SEED_MAX_BYTES`, `tower-terminals.ts:38`), 67 ms @ 4 MB** (a live ring's unbounded partial can exceed the seed cap, #1047) — cheap enough to gate every delivery. Triggers: a submit-classified user `\r`; the drain poll after ~2 s output quiescence (**no keystroke — builder terminals converge too**); an explicit human act. The resize nudge is occupancy-neutral on both TUIs and runs on-demand per convergence attempt with a minimum interval — never periodic. Codex ESC-on-empty renders no change (`g2h`, asserted two-sided: a future codex that renders an ESC signature fails the suite loudly).

**Post-delivery verify (`i8c`/`i8d`)**: the same render re-run after a submitting delivery settles asks whether the delivery *looks delivered* (own transcript entry — the `i6` transcript oracle) and classifies both wrapper-loss signatures as not-delivered: eaten → **`lost`** (token nowhere, no composer marker), boot-window landing → **`stranded`** (token as composer user-text) — asserted on the live emulator AND on a raw-stream reconstruction (the production ring-replay shape). Verdicts post to the mailbox row as async outcomes (verified / re-held / escalated / unverified). Auto-re-hold fires only on the high-confidence loss signature; **ambiguity never auto-redelivers** (duplicate delivery is the failure direction to protect against).

### Launch-loop wrapper loss (`i8`)

Every builder terminal runs `.builder-start.sh` — `while true; do <agent>; …; done` with the shared `LAUNCH_LOOP_TAIL` (extracted from `spawn-worktree.ts` at runtime, so the wrapper under test is the shipped one). Two states own the PTY's stdin with no agent behind it: **(a) deliberate exit** — `read -r` on "Press Enter to relaunch" consumes a Tower-shaped delivery into `$REPLY` and the `\r` **relaunches the agent as a side effect**; the successor's stdin drain finds nothing (`i8a`, four assertions) — the sender was told "delivered". **(b) crash restart** — bytes sent into the 2 s sleep window are drained by the *booting* successor: with real claude, the message landed in the fresh composer as **unsubmitted text**, the `\r` never fired as a submit (`i8b`). Both states are invisible to input-side tracking (zero input frames in (a); boot semantics mis-model in (b)); both *steady* states fail the pre-delivery gate (no composer marker). The *transition* — a process exit inside the check→write gap — is covered by ring-advance invalidation plus the verify (wrapper transitions print: relaunch prompt, crash banner, boot screen — so exits become ring-visible).

## Constraints Discovered

1. **Every session is born dirty.** Fresh spawns render Enter-traps (agy's per-folder trust dialog, `exp0c`; codex's "Press enter to continue" onboarding; claude first-run flows); recovered sessions may carry surviving drafts/menus — shellper keeps the TUI (and any half-typed composer) alive across a Tower restart while the in-memory tracker dies, and today `_lastInputAt` initializes to 0 (`pty-session.ts:98`) so a recovered session delivers instantly. Deliverable only via the rendered proof; known apps converge on the first post-boot quiescence poll; unknown apps never converge (= defer-only + K).
2. **Occupancy tracking taps `PtySession.write()`**, not the WebSocket handler — cron, `noEnter`, the raw HTTP write route, and escape/interrupt all bypass the WS path (see code audit). All inbound bytes classify regardless of writer; `noEnter` text lands in the capture buffer (correct occupancy *and* replayable). (`afx reset` is a client-side multi-step sequence — each step its own transaction; whole-sequence ordering is an implementation-spec note, not a corruption risk.)
3. **E's flush fires strictly after the user's Enter byte is written** (`i6b`; see submit-detector hazards).
4. **Enter does not prove an empty (or known) composer.** claude `/`-menu Enter submits the *selection*; codex `/`-menu Enter opens a full-screen model picker (`i6c`); claude ESC restores queued messages into the composer with **no input frame**; codex ESC-on-empty arms edit-last-message. Mode-suspect frames (leading `/` on empty, ESC, Up/Down, Ctrl+G, Tab, unrecognized CSI, codex `\`+`\r`, `^C` on an empty model) mark **dirty**; dirty forbids H/I — defer, then K at max-age. A missed submit otherwise leaves a stale capture that a later maneuver would replay as already-submitted content.
5. **No cross-writer serialization exists — build a per-session write transaction queue.** Measured today-bugs with no draft involved (`w1`, real `message-write.ts`): two concurrent sends blob into `msg1msg2\r\r` (`w1a`); concurrent paced sends interleave line-by-line (`w1b`); a send lands inside an escape's ESC…`\r` window (`w1c`); offset-chaining works where actually used (`w1d`). Every multi-step write (send, batch, cron, escape/interrupt, E flush, H maneuver) becomes a transaction on one per-session FIFO with completion-based chaining (retire `delayOffset`); user frames pass through untouched when idle, divert-then-append during transactions (fail-open timeout). **Preemption lane**: interrupt/escape aborts an in-flight preemptible transaction at its next chunk boundary — a strict FIFO would make the interrupt deferrable, which the current code explicitly forbids (`tower-routes.ts:1501-1506`). The lane itself is serialized, and concurrent identical interrupts **coalesce** — unserialized preemptors re-create #1264's double-`^C` kill (the `--interrupt` prelude writes `^C`, `tower-routes.ts:1562`). Abort semantics are per-type and never silent: an aborted H resolves through its journal; an aborted paced delivery re-holds its unwritten tail while the written prefix stays tracked as occupancy.
6. **K must be built as a real mailbox** (substrate gaps in the code audit). Requirements: (a) rows **persisted at enqueue**, before the send response — every deferral is a hold from t0; the in-memory `SendBuffer` queue collapses into the mailbox (also fixes crash loss); (b) a synchronous vocabulary the response can honestly keep — `delivered` | `held`+id; max-age escalation is a *visibility transition* on the persisted row (it happens up to 60 s after the response), and final outcomes are async by row id (`--wait`, status route, broadcast event); (c) a default visible surface — dashboard/VSCode indicator + `afx inbox` (phase 3); (d) persist-on-shutdown replacing `stop()`'s force-inject; (e) machine senders stamp a **supersede key** (cron: task id) — a newer snapshot replaces the older held row (recorded, bounded drain bursts); the no-TTL rule for human messages is unchanged, and cron's run log gains the delivery outcome. Retention: held until delivered or explicitly dismissed. Drain: triggered by the convergence proof / E's flush moment / the backstop poll / recovery convergence; oldest-first, ahead of younger `SendBuffer`-era entries for the same target; each drained message re-runs the pre-delivery gate; rows address **agents, not PTYs** (`(workspacePath, agent)`, terminalId as hint), so a respawned terminal drains its predecessor's mail.
7. **H destroys the only durable copy of the draft mid-maneuver — journal first.** The clear erases the draft from the TUI while the sole replay copy sits in Tower memory; shellper then works against the user (the emptied TUI survives a Tower crash, the capture doesn't). Journal the capture to disk **before the first destructive byte** (≤8 KB; a transient row deleted only on a **complete** verify — which the fits-window precondition is what makes possible; same privacy posture as mailbox content, draft bytes never logged). Crash/timeout mid-maneuver → recovered session starts dirty and the journal surfaces as a **held draft-recovery entry**, never auto-replayed. H is **best-effort by classification**: worst case is "composer copy lost, journaled bytes surfaced" — never silent loss; any doubt (dirty state, journal failure, queue contention) resolves to K. A fully-atomic H is not available: clear/inject/replay must stay separate writes with verify settles (the one atomic form tried submitted the draft, `i3`).
8. **The rendered-empty check is the universal pre-delivery gate — and the guarantee is detection, not prevention, at the edges.** Input-side tracking is the *scheduling* signal (free, per-keystroke); the rendered check gates **every** delivery write (direct, E-flush, drain, maneuver entry) at ~2–22 ms — required because the wrapper can swap the process behind the PTY with zero input frames. The check→write gap is a real process-exit race, closed to *detected* by (i) **ring-advance invalidation** — the gate snapshots the ring byte offset and delivery re-reads it immediately before the first byte (same event loop; wrapper transitions print, so exits become ring-visible; residual shrinks to pipe latency) — and (ii) the **post-delivery verify**. Residual, stated honestly: a mode that captures Enter while rendering *nothing* is pre-write-undetectable by any rendered check, by definition — the verify converts such a mis-fire into `lost`/`stranded`/`unverified`, never believed-sent. **Phase-1 property: no force-inject path and no *undetected* loss path.**
9. **Classifier profiles are per-app data — design for drift.** Marker regex + region bounds are profile entries keyed by the identity table (the POC's bounds are POC-grade stand-ins), version-pinned, re-verified by the smoke suite. Profile drift → permanently dirty → **all sends to that target held forever**: fail-safe but a liveness regression. Phase 1 ships **classifier-health telemetry**: a session with recent output whose checks return not-clean N consecutive times with no tracked occupancy raises a loud diagnostic (ERROR + broadcast + reason on held rows). `--interrupt` and phase 3's "deliver now" remain the human bypasses.
10. **Delivery forms key on a strict app-identity table — not the harness resolver.** `detectHarnessFromCommand` matches only claude/codex/gemini/opencode basenames and `resolveHarness` **falls back to `CLAUDE_HARNESS`** (`harness.ts:329-392`) — keyed on it, an agy terminal IS claude and would get claude's atomic form. Verified apps match exactly; everything else is first-class `unknown` → defer-only + K. (The fallback is correct for the resolver's own job — role injection — and a correctness bug here.)
11. **The per-line clear and a trailing `^Y` must never share a sequence** (`p4`; see kill-ring).
12. **Per-app divergence is real and version-sensitive.** The bracketed/unbracketed split and the *opposite* at-size failure modes (claude: clear stalls; codex: replay collapses) are the sharpest examples. Pin the delivery matrix to verified versions; ship the POC harness as the re-verification smoke test (exercised on codex 0.145→0.146: green).
13. **agy today**: the per-folder trust dialog makes every fresh worktree an Enter-trap (a blind text+`\r` delivery would *confirm a filesystem-trust decision*); its `> ` marker and normal-intensity hint text fit no existing profile — it can never classify clean, so it auto-holds. Defer-only + K by mechanism until onboarded through the matrix with its own G-lite profile. The dim-placeholder rule is per-app measured fact, not universal law.
14. **`noEnter` is composer-mutating by design** — never injectable onto a non-empty/dirty line, and H cannot rescue it (nothing to submit; replay would merge). At max-age it K-holds; on drain the staged text registers as occupancy via the tap, so followers defer behind it — no second special case.
15. **Misc measured**: `^C` is not an injectable clear (arms exit on empty; #1264). Ctrl+G is modal — never in a clear-set. Codex strands unrecognized `/slash` messages in the composer (only a `--raw` edge today; worth a guard). Bracketed paste is not a control-char sanitizer on claude (`j3`) — raw control bytes stay on the `--raw`/escape path. Up-recall drafts replay imperfectly (nav-dirty drafts are K-bound anyway). Multi-client input interleave is safe (the capture is the PTY's own merged order). Draft bytes are held in memory per session, capped 8 KB, never logged.

## Recommended Approach

1. **One `DraftTracker`** (raw replay log + cursor-aware line model) tapped at `PtySession.write()` so every writer feeds it; defer while non-empty/dirty; flush event on model-empty transitions, fired after the triggering write. Replaces `shouldDefer`'s timer; keep the 500 ms poll as backstop and the 60 s max-age valve. Powers all three: A's defer, E's flush, H's replay payload.
2. **Per-session write transaction queue** with completion-based chaining, divert mode, and the serialized/coalescing preemption lane (constraint 5) — this alone fixes today's concurrent-sender blob.
3. **Dirty-state machine** with born-dirty initialization for every session; convergence only via the G-lite rendered proof (quiescence-triggered, keystroke-free — builder terminals converge too); otherwise K at max-age.
4. **G-lite gate before every delivery write** + ring-advance invalidation + post-delivery verify posting async outcomes to the mailbox row; per-app classifier profiles with drift-health telemetry (constraints 8–9).
5. **Strict app-identity table** for delivery-form keying; unknown apps defer-only + K (constraint 10).
6. **K hold core** per constraint 6; honest guarantee: *eventual delivery or persistent visible escalation, never silent loss* (a drain that fails its verify re-holds; a hard composer-delivery guarantee would re-introduce forced injection). `--interrupt` remains the explicit human-invoked exception.
7. **Max-age delivery**: single-line drafts via the per-app I/B atomic form (ends in `^Y`); multi-line via H — journal-first, divert-mode transaction, fits-window entry precondition, per-app clear/replay forms, no `^Y`. H's addressable population is narrow (linearly typed, window-fitting, multi-line, tracked-clean, at max-age): build it only if phase-1 why-held data shows the population exists.
8. Retire #584 pacing for verified-current claude/codex; keep for unknown apps. Ship the POC harness as the version-bump re-verification script.

**Phasing — no phase may ever force-inject:**

- **Phase 1 — safe core**: DraftTracker + submit-detector + defer/flush rewiring + transaction queue/lane + dirty machine (born-dirty) + G-lite universal gate with profiles/telemetry + ring-advance invalidation + post-delivery verify + identity table + minimal K hold core (enqueue-persisted rows, `held`/`delivered` responses, drain-on-clean/poll, persist-on-shutdown, supersede keys, **why-held metadata**) + minimal cron reroute. Kills the common-case corruption, the concurrent-sender blob, the wrapper eat-and-relaunch path in its steady states (transition race detected-and-held), and every message force-inject path.
- **Phase 2 — delivery quality**: per-app atomic forms, single-line I/B path, draft journal; **H behind a build/skip gate** fed by phase-1 why-held data (~220 LOC of maneuver+journal it may not earn).
- **Phase 3 — K surface + integrations**: inbox UI/indicator/`afx inbox`, outcome events/`--wait`, cron inbox attribution, drain-order refinements, #584 retirement.

Each phase is an independently shippable Medium. Interim visibility before phase 3 = the `held` response, Tower log, and existing broadcast — acceptable because nothing is dropped (rows persist and drain on the next clean event).

## Effort Estimate

**Medium-to-Large, phased**: ~1690–1875 LOC of code + ~460–570 of tests ⇒ **~2150–2445 total by component sum**.

| Component | ~LOC | Phase |
|---|---|---|
| DraftTracker (replay log + cursor-aware line model) — the one component with **no POC code behind it**; risk contained: pure function over classified frames, fails toward dirty, unit-testable against the classification table + committed capture logs | 250 | 1 |
| Submit-detector | 80 | 1 |
| Defer/flush rewiring (incl. flush-after-write ordering) | 120 | 1 |
| Write transaction queue + divert mode + serialized/coalescing preemption lane | 190 | 1 |
| Dirty-state machine (incl. born-dirty) | 110 | 1 |
| G-lite gate: transient headless render + dim-attribute classifier + quiescence/nudge triggers + per-app profiles + drift telemetry (+~10 ring-advance invalidation) | 200–260 | 1 |
| Post-delivery verify + verdict/outcome wiring + no-auto-redeliver policy | 60–80 | 1 |
| Strict app-identity table | 35 | 1 |
| K mailbox: schema/migration, enqueue-persist (absorbs `SendBuffer`), inbox routes/surfacing, `held`/`delivered` + async outcomes, supersede keys, drain scheduling, persist-on-shutdown, cron attribution | 420–520 | 1+3 |
| Minimal cron reroute (incl. outcome in run log) | 55 | 1 |
| Delivery matrix + H maneuver (incl. fits-window entry check) | 150 | 2 (gated) |
| Draft journal + maneuver-crash recovery surfacing | 70 | 2 |
| Tests: keystroke-corpus unit suite, wrapper-state delivery, identity/profile-drift, verify-verdict suites | 460+ | all |

The one genuinely new architectural element is G-lite's transient server-side screen reconstruction — Tower's first runtime terminal-emulator dependency (`@xterm/headless`; created per check, disposed, never a persistent per-session emulator). All other hooks sit at existing choke points (`PtySession.write`, `SendBuffer`, `handleSend`).

## Flaky Tests

None in repo test suites (the spike ran none). POC flakes, all root-caused: dead-API retry/queue state interacting with claude's ESC-restore contaminated shared-session demos (fixed with per-case session isolation + transcript-based, collision-proof assertions), and settle/paint races in the timing harnesses (fixed with condition-based waits, double-sampled reference captures, and verify-and-retry draft builds). All asserted suites are green post-fix; committed `.out`s under `1265-poc/results/` are the record.

## Next Steps

- [ ] Create a SPIR spec referencing this spike; adopt the three-phase structure above (phase 1 delivers the no-force-inject / no-undetected-loss property on its own).
- [ ] Spec the H window-capacity check as a **live-render read**, not constants (~11/~28 rows were one terminal size); the operative test is rendered-window == tracked-draft in full at maneuver entry.
- [ ] Run the delivery matrix against agy before ever enabling injection for it, and build it a G-lite profile (its `> ` marker and normal-intensity hints fit neither existing profile).
- [ ] Verify codex's *with-history* ESC behavior (edit-last arming) renders a visible signature once real submissions are testable — the fresh-session case shows no rendered change (`g2h`); this is constraint 8's stated residual.
- [ ] Prototype the DraftTracker line model early in phase 1 — the only component with no POC behind it; seed its unit corpus from the classification table + `1265-poc/results/` capture logs.

## References

- POC + harness: `codev/spikes/1265-poc/` (this branch; runs need `XTERM_DIR` pointing at a dir with `@xterm/headless` **6.0.0** — see `harness.cjs` header; the resolved version prints into every `.out`)
- Round-by-round review history: `codev/state/spike-1265_thread.md` (this branch) and the spike branch's commit log
- Issue #1265 (full option analysis); #450 (composing added), #492 (removed — `8ac64ab1`), #584 (pacing — `36556338`), Spec 403 (typing awareness); #1264 (double-`^C` exit regression), #1198 (ring seed cap), #1047 (unbounded ring partial)
- Code: `tower-routes.ts:1566-1589` (defer), `tower-routes.ts:902` (raw HTTP write route), `send-buffer.ts` (flush loop), `message-write.ts` (pacing), `pty-session.ts:548-581` (idle/composing), `tower-websocket.ts:87-132` (input path), `spawn-worktree.ts:798` (`LAUNCH_LOOP_TAIL`), `harness.ts:329-392` (detection + claude fallback), `tower-terminals.ts:38` (`RING_SEED_MAX_BYTES`)
