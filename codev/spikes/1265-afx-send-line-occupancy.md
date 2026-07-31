# Spike: afx send input corruption — line-occupancy detection & non-destructive delivery (#1265)

**Date**: 2026-07-30 (updated 2026-07-31 after review rounds 2–3)

**Verdict**: **Feasible** — the recommended combination (A+E core, H for max-age, per-app atomic delivery) is validated empirically against both target TUIs, with one significant revision: **Option I is app-specific** (claude wants the *unbracketed* atomic form, codex the *bracketed* one — each fails with the other's form), and the issue's proposed composing clear-set was wrong on two keys (ESC, Ctrl+G).

## Question

Issue #1265: `afx send` can land in the middle of a half-typed draft and submit the blob as one message, because the defer decision uses a 3s idle timer (`isUserIdle`) instead of real line-occupancy. The issue proposes options across detection (A/E/F/G), delivery (B/C/H/I/J), and channel (D/K/L) axes, recommending **A+E** core, **H** for the 60s max-age case, **J** framing, **I/K** hardening. This spike answers the empirical unknowns analysis could not settle, **against the real Ink-based TUIs** (Claude Code 2.1.212, Codex 0.145.0), and gives a go/no-go per building block.

Method: a node-pty + `@xterm/headless` harness (`codev/spikes/1265-poc/`) spawns the actual `claude`/`codex` binaries, injects keystroke bytes exactly as Tower's `session.write()` does, and asserts on the *rendered* composer. Evidence tags (`b3`, `p4`, …) refer to the `exp-*.cjs` experiments there; `p*` tags are the end-to-end max-age sequence (`exp-i5-maxage-fullseq.cjs`, added after review flagged the kill-ring interaction), and `i6*` tags are the integration-semantics demos (`exp-i6-gating.cjs`, review round 3: input gating, flush ordering, menu/modal Enter-ambiguity). Submission-heavy tests ran claude against an unroutable `ANTHROPIC_BASE_URL` (full submit mechanics, zero API calls). Codex ignores base-URL overrides under ChatGPT OAuth, so codex submissions used only the local `/status` command (plus three accidental tiny prompts, lesson learned below).

## Per-option verdicts

| Option | Verdict | Evidence |
|---|---|---|
| **A** — fixed `composing` occupancy | **GO (revised)** | Clear-keys differ from the issue's proposal; see classification table. With the corrected lifecycle the #492 stuck-true scenarios (Ctrl+C, arrows, Tab) are all resolved or safely conservative. |
| **E** — event-driven flush on submit | **GO** | Delivering **0 ms after the user's Enter** lands clean: the injected message became its own (queued) entry, no concatenation, even while the agent was busy retrying (`e1`). Needs a smarter submit-detector than today's `data.includes('\r')` (see hazards). |
| **H** — draft byte capture + verbatim replay | **GO (the load-bearing result)** | On **both** TUIs, a 3-line draft containing a backspace edit was cleared, a message injected+submitted, and the captured bytes replayed — composer reconstructed **byte-identical** (`h3`, `c4`; full end-to-end max-age sequence re-verified in `p5`). An app-agnostic clear exists: `(Ctrl+E Ctrl+U Backspace) × lines` verified on both (`c2`, `i2c`). Restore is the replay **alone** — the inject step must not end in `^Y` (kill-ring interaction, `p4`). Preconditions: the **input gate** (`i6a`) and a **high-confidence tracker state** — H is forbidden in dirty states (`i6c`; integration constraints below). |
| **J** — bracketed-paste framing | **GO for codex / NOT for claude's atomic path** | Required to make atomic delivery work on codex (`i2a`); actively harmful in claude's atomic write (`i3` — draft got submitted). Not a control-char sanitizer: codex neutralizes fully, claude's ESC-in-brackets swallowed following chars (`j3`). |
| **B/C** — kill/yank restore | **GO, single-line only — subsumed by I** | Single-line restore works on both (kill-ring/deleted-text buffer real). Ctrl+U kills only the current line of a multi-line draft (confirmed both, `b4`) — multi-line restore impossible, exactly as the issue said. |
| **I** — atomic single-write | **GO, per-app forms — single-line drafts only** | claude: `^E ^U <msg> \r ^Y` as ONE write works for single- AND multi-line *messages* (`b3`, `i4`); bracketed variant FAILS (`i3`). codex: unbracketed FAILS (`\r` becomes newline, `b3`-codex); bracketed variant works (`i2a`). Atomicity genuinely closes the race: a user byte 5 ms later appended cleanly after the restored draft. ⚠ The trailing `^Y` is the *single-line-draft restore* — chained after H's per-line clear it duplicates the first draft line on both TUIs (`p4`); the H path uses the same forms **minus `^Y`** (`p5`). |
| **F** — DSR cursor probe | Not tested | Superseded: H's draft buffer gives a better signal than cursor column; no need for fragile probe/response parsing. |
| **G** — output-stream line modeling | Not tested | Unnecessary — A+H's input-side model proved sufficient; G remains the fallback if future TUIs break input-side assumptions. |
| **K** — side-channel escalation at max-age | Not tested (no TUI unknowns) — **required component** | Pure Tower-side; `broadcastMessage` exists. Upgraded from optional hardening to required (round 3): the escalation target for every ambiguous state — dirty sessions, recovered-after-restart sessions, unknown apps, oversized drafts. |
| **#584 pacing** (context) | **Obsolete on current TUIs** | The Enter-swallow does NOT reproduce on claude 2.1.212 or codex 0.145: a 5-line message in ONE plain write + `\r` after 50 ms submits fine on both (`j1`). Pacing can be retired for known-current agents once this ships (keep as fallback for unknown apps). |

## Baseline corruption reproduced

Today's exact failure reproduced under the harness (`e0`): type `deploy the hotfix to prod once`, pause 3.5 s (`isUserIdle(3000)` → true), deliver today-style (`write(msg)` + `\r` at 50 ms) → one blob submitted:

```
deploy the hotfix to prod once[builder spir-999] tests green, ready to merge
```

(recalled verbatim from claude's history in `e2` — draft and message fused into a single submission).

## Keystroke → occupancy classification (measured)

| Key | Claude Code 2.1.212 | Codex 0.145.0 | Tracker action |
|---|---|---|---|
| printable | occupies | occupies | append to draft buffer |
| bare `\r` | **submits** (composer clears) | **submits** | clear buffer; **flush trigger (E)** |
| `\x1b\r` (Alt+Enter) | newline in draft | newline in draft | append newline — **NOT submit** |
| `\n` (Ctrl+J) | newline in draft | newline in draft | append newline — **NOT submit** |
| `\\` then `\r` | newline in draft (continuation) | **submits** (`ccc\` went to the model) | treat as non-submit (safe direction: worst case is deferral, not corruption) |
| Ctrl+U | kills whole current line | kills whole current line | drop current line from buffer |
| Ctrl+C | clears draft (⚠ arms exit when line already empty — unsafe as an *injected* primitive) | clears draft | clear buffer |
| ESC ×1 | nothing ("Esc again to clear") | nothing | no-op |
| ESC ×2 | clears draft (⚠ opens rewind/queued-edit overlays when composer empty) | does **NOT** clear | app-dependent — unusable as a portable clear |
| **Ctrl+G** | **opens $EDITOR (vim) with draft** | **same** | ⚠ modal — must NOT be in any clear-set (issue proposed it; wrong) |
| Up | occupies (history/queued recall, `e2`) | occupies — recalls even **cross-session persisted** input | mark composing (genuinely occupies) |
| Down | may return to empty | may return to empty | keep composing (conservative) |
| Tab | hint only, line unchanged | line unchanged | neutral — do not set composing (was a #492 stuck-true source) |
| Left/Right | cursor only | cursor only | neutral |
| Backspace | may empty the line | same | drop last char from buffer (buffer-empty ⇒ not composing) |

**Key insight that simplifies the design**: H's per-session **draft byte buffer subsumes A's boolean**. Occupancy = "draft buffer non-empty" (with Up/Down marking a conservative `dirty` flag). One `DraftTracker` — tapped at `PtySession.write()` so every writer feeds it (integration constraint 5) — powers all three: the defer decision (A), the flush-now event (E: buffer transitioned to empty via `\r`/Ctrl+C/Ctrl+U), and the replay payload (H).

## Submit-detector hazards (for E)

Today's `tower-websocket.ts:96` heuristic (`data.includes('\r') || data.includes('\n')` ⇒ stopComposing) is wrong in both directions:
- **False submit** (would flush mid-draft — the corruption we're fixing): Alt+Enter frames (`\x1b\r`), Ctrl+J (`\n`), backslash-continuation `\r` (claude), and `\r`/`\n` inside bracketed-paste content (user pasting a multi-line draft).
- Correct rule: submit ⇔ frame is bare `\r` (or `\r` not preceded by `\x1b` in-frame, not inside `ESC[200~…201~`, previous frame not ending in `\\`). Kitty-protocol Enter (`\x1b[13u` style, if a client terminal ever sends it) should also be matched; missing it only degrades to max-age deferral (safe direction).
- Even a correctly-classified bare `\r` is only a submit **when no menu/mode is open** (`i6c`) — the dirty-state machine in the integration constraints governs when the flush may actually fire.
- **Ordering**: the flush must write the message strictly *after* the user's Enter byte has been written to the PTY — the current handler tracks before `session.write(data)`, and flushing from there submits the blob (`i6b`; integration constraint 3).

## Delivery matrix (for the max-age / busy-line path)

Two **non-overlapping** paths, selected by whether the captured draft is single- or multi-line. The trailing `^Y` is the *single-line restore mechanism* and must appear **only** there — on the multi-line path the byte-replay is the restore, and a trailing `^Y` measurably corrupts it (see the kill-ring constraint below and `i5`).

**Single-line drafts — kill/yank restore (Options I/B). Form ENDS in `^Y`:**

| Target | Verified atomic form | Result |
|---|---|---|
| claude | `^E ^U` + msg (raw, multi-line msg ok) + `\r` + `^Y` — one write | message submitted intact, draft restored by the yank, user bytes cannot interleave (`b3`, `i4`) |
| codex | `^E ^U` + `ESC[200~` msg `ESC[201~` + `\r` + `^Y` — one write | same (`i2a`) |

**Multi-line drafts — H byte-replay restore. NO trailing `^Y` anywhere:**

| Target | Verified sequence | Result |
|---|---|---|
| claude | per-line clear `(^E ^U BS) × N` → `^E ^U` + msg + `\r` (one write, **no `^Y`**) → byte-replay | draft reconstructed byte-identical (`p5`, claude) |
| codex | per-line clear `(^E ^U BS) × N` → `^E ^U` + `ESC[200~` msg `ESC[201~` + `\r` (one write, **no `^Y`**) → byte-replay | same (`p5`, codex) |
| unknown app | per-line clear → kill + bracketed msg in one write, `\r` after ~50 ms (**no `^Y`**), then replay | verified shape on both (`i2b`, `j2`); residual ~50 ms window is covered by the input gate below (divert + append) — or prefer **K** over injecting at all for unverified apps |

On the multi-line path, N comes from the captured buffer's newline count + harmless slack rounds (extra Backspace on an empty composer is a no-op). The kill/yank restore is off the table for multi-line (`b4`: `^U` kills only the current line).

⚠ **The maneuver requires an input gate.** User keystrokes are currently written straight through to the PTY (`tower-websocket.ts:101`), so without a gate a keystroke arriving mid-maneuver interleaves with the clear/inject/replay byte stream. Measured (`i6a`): a `Z` arriving between inject and replay, with the naive "also append it to the replay" policy, appears **twice** (`Zfirst line\n second lineZ`). During the maneuver, Tower must **divert** that session's user input frames into the capture queue instead of writing them, then append them after the replay — the diverted-and-appended variant reconstructs `draft + Z` exactly (`i6a` gated run). The gate is short-lived (a maneuver is a few hundred ms) and must fail open on a timeout so a wedged maneuver can never eat input.

### Kill-ring interaction (measured — do not re-introduce)

The per-line clear **primes the kill-ring**: it kills bottom-up and consecutive kills **overwrite** (not accumulate) on both TUIs, so after clearing an N-line draft the ring holds exactly the **first draft line** (`p3` ring probe, identical on claude and codex). Chaining the single-line atomic form (which ends in `^Y`) after that clear yanks the stale line onto the fresh prompt before the replay lands — measured outcome on **both** TUIs (`p4`):

```
before:  first line\n  second line\n  third
buggy:   first linefirst line\n  second line\n  third   ← first line duplicated
fixed:   first line\n  second line\n  third             ← no ^Y; byte-identical (p5)
```

There is **no cheap ring neutralizer**: `^U` on an *empty* composer does NOT scrub the ring on either TUI (`p4` still yanked despite the inject form's leading empty `^U`). The fix is structural — the multi-line/H path simply never sends `^Y`.

## Integration constraints (review round 3 — measured + code-verified)

1. **Tower restarts orphan the tracker while shellper preserves the draft.** Shellper-backed sessions survive a Tower restart (the TUI process — and any half-typed composer content — keeps living); the startup reconcile re-registers them as *fresh* `PtySession` objects. Any in-memory `DraftTracker` is lost. Today this is actually worse: `_lastInputAt` initializes to `0` (`pty-session.ts:98`), so a recovered session reports `isUserIdle() === true` immediately and a send delivers instantly onto a possibly-surviving draft. **Recovered sessions must start in `dirty/unknown` state**: defer + K only, converging to tracked state on the next provably-clean event (a user bare-`\r` submit with no modal-suspect frames since recovery).
2. **H requires the input gate** described in the delivery-matrix section (`i6a`: ungated byte applied twice; gated variant byte-identical). WebSocket frames must be divertible per-session for the duration of a maneuver, with a fail-open timeout.
3. **E's flush must fire strictly *after* the user's Enter byte is written to the PTY.** The current handler tracks *before* `session.write(data)` (`tower-websocket.ts:92-101`); a flush triggered synchronously from that spot writes the message ahead of the user's `\r`, and the user's own Enter then submits the blob — measured: `abc[architect] wrongorder` recalled as one history entry (`i6b`). Writing the message after the `session.write(data)` call is sufficient (PTY fd writes are FIFO): the correct ordering delivered two clean, separate entries (`i6b` right-order, `e1`).
4. **Enter does not prove an empty (or even known) composer.** Measured divergences: (a) claude, "/" menu open — bare `\r` submitted the menu *selection* `/afx` while the captured buffer held `/` (`i6c`); (b) codex, "/" menu open — bare `\r` opened a **full-screen model-picker modal**; injected bytes would land inside the picker (`i6c`); (c) claude **restores queued messages into the composer on ESC** — content re-entered the composer with no input frame carrying it (observed during `i6a` setup); (d) codex's own UI tip: ESC on an empty composer enters "edit your last message", where "Enter confirms". Consequence for H: a missed or misclassified submit leaves a stale capture buffer, and a later max-age maneuver would clear an unknown composer and **replay already-submitted content**. Rule: frames that can open menus/modes (leading `/` on an empty buffer, ESC, Up/Down, Ctrl+G, Tab, unrecognized CSI, codex `\`+`\r`) mark the session **dirty**; while dirty, H and I are forbidden — defer, then **K at max-age**. Dirty clears only on a provably-clean convergence event.
5. **Programmatic writers bypass tracking — and cron bypasses even today's defer.** `tower-cron.ts:303-323` writes cron messages straight to the PTY with no idle check and no SendBuffer; a `noEnter` delivery (`/api/send`, `tower-routes.ts:1586`) intentionally leaves unsubmitted text in the composer that no WebSocket frame ever carried; the `interrupt`/`escape` paths write control bytes directly. Occupancy tracking therefore cannot live in the WebSocket handler alone — **hoist the tap to the single choke point, `PtySession.write()`**, classifying all inbound bytes regardless of writer. `noEnter` text then lands in the capture buffer (correct occupancy *and* replayable); cron must additionally route through the same defer pipeline as `handleSend`.

## Constraints discovered

- **The per-line clear and the trailing `^Y` must never appear in the same sequence.** The clear primes the kill-ring with the first draft line (bottom-up kills, overwrite semantics, both TUIs), a later `^Y` yanks it back ahead of the replay, and no injectable primitive scrubs the ring (empty-composer `^U` doesn't). Duplication measured on both TUIs (`p4`); details in "Kill-ring interaction" above.
- **Per-app divergence is real and version-sensitive.** The bracketed/unbracketed atomicity split (i3 vs i2a) is the sharpest example. Tower knows the configured agent command per terminal — key the delivery form on it, default unknown apps to defer-only + K escalation. Keep the POC harness as a smoke-test to re-verify the matrix when agent versions bump.
- **Ctrl+C is not an injectable clear**: on an empty claude composer it arms "press again to exit" — an injected Ctrl+C adjacent to a user's own could kill the agent (cf. regression #1264). Ctrl+U/Backspace primitives are side-effect-free on both TUIs.
- **Ctrl+G opens `$EDITOR` on both TUIs** — any occupancy design must treat it as modal (set dirty, never clear).
- Codex leaves an **unrecognized `/slash` message in the composer** (with an error) instead of submitting it — a formatted afx message starting with `/` would strand. Current formats start with `[architect]`/`[builder]` so this is only a `--raw` edge; worth a guard.
- Bracketed paste is **not a control-char sanitizer** on claude (ESC inside brackets swallowed following chars, `j3`). Raw control-byte payloads stay on the existing `--raw`/escape path.
- Drafts built via Up-recall replay imperfectly (history mutates once the injected message submits). Edge case; acceptable — or treat nav-dirty drafts as K-escalation candidates.
- Tower must hold draft bytes in memory per session (privacy: never log them; cap the buffer, e.g. 8 KB, falling back to defer-only when exceeded).
- Multi-client sessions (dashboard + VSCode attached to one PTY) interleave input frames; the capture stream is the merged order the PTY itself sees, so replay fidelity holds.

## Recommended approach (confirms the issue's, with revisions)

1. **Core: A+E via a single `DraftTracker`, tapped at `PtySession.write()`** — not the WebSocket handler — so every writer (user frames, sends, `noEnter`, cron, escape) feeds the same occupancy model. Draft buffer + dirty flag; defer while non-empty/dirty; flush event the moment the buffer empties (bare-`\r` submit, Ctrl+C, Ctrl+U-to-empty), fired **strictly after** the triggering bytes are written to the PTY (`i6b` ordering constraint). Replaces `shouldDefer`'s timer-only check (`tower-routes.ts:1570`) and `SendBuffer`'s 500 ms poll (keep the poll as backstop; keep the 60 s max-age valve). Route cron's `deliverMessage` through this same pipeline.
2. **Dirty-state machine**: modal/mode-suspect frames (leading `/` on empty buffer, ESC, Up/Down, Ctrl+G, Tab, unrecognized CSI, codex `\`+`\r`) and **recovered-after-restart sessions** mark the session dirty; dirty forbids H/I injection outright. Converge back to tracked on a provably-clean event; otherwise K at max-age.
3. **Max-age path, multi-line drafts: H** — under the **input gate** (divert user frames for the maneuver's duration, append after replay, fail-open timeout): per-line clear, per-app atomic inject **without the trailing `^Y`**, verbatim replay. The replay is the sole restore mechanism on this path.
4. **Max-age path, single-line drafts: I/B** — the per-app atomic kill/yank form (ends in `^Y`, no per-line clear, no replay). Keep the two paths non-overlapping: `^Y` restores, or replay restores — never both in one sequence (`p4` duplication).
5. **I/J forms**: per-app as specified — J's framing only where verified (codex, unknown-app semi-atomic); never in claude's atomic write.
6. **K is a required component, not optional hardening**: the escalation target (`broadcastMessage` + log, no injection) for every ambiguous state — dirty sessions, recovered sessions, unknown apps, oversized drafts. It is what makes "when in doubt, don't inject" a safe default.
7. Retire #584 pacing for verified-current claude/codex once this ships (keep for unknown apps).
8. Ship the POC harness as a re-verification script for future TUI version bumps.

## Effort estimate

**Medium, upper end** (~700–1100 LOC): DraftTracker + `PtySession.write()` tap (~180), submit-detector (~80), defer/flush rewiring in tower-routes/send-buffer incl. flush-after-write ordering (~120), input gate (~60), dirty-state machine + restart-recovery dirty (~110), delivery matrix + H maneuver in message-write (~150), K valve + cron rerouting (~80), tests (~350, incl. a keystroke-sequence unit suite derived from the classification table). No architectural change — every hook sits at an existing choke point (`PtySession.write`, `SendBuffer`, `handleSend`, `broadcastMessage`) — but the round-3 constraints (gate, dirty machine, recovery) push this to the top of Medium; if shipped monolithically it borders Large, which is another reason to phase it (A+E core → H/matrix + gate → K + cron + recovery).

## Flaky Tests

None encountered (spike ran no repo test suites; all POC runs were against live TUIs).

## Next Steps

- [ ] Create a SPIR spec for the implementation referencing this spike (recommend the phasing from the effort section: DraftTracker A+E core + write-tap → H/matrix + input gate → K + cron rerouting + restart recovery — independently shippable).
- [ ] Decide policy for unknown target apps (defer-only + K vs. semi-atomic injection).
- [ ] Optional: extend the matrix to the Gemini CLI (`agy`) if it becomes a terminal-hosted agent target.

## References

- POC + harness: `codev/spikes/1265-poc/` (this branch; runs need `XTERM_DIR` pointing at a dir with `@xterm/headless` installed — see `harness.cjs` header)
- Issue #1265 (full option analysis); bugfix #450 (composing added), #492 (removed — `8ac64ab1`), #584 (pacing — `36556338`), Spec 403 (typing awareness)
- Code: `tower-routes.ts:1566-1589` (defer), `send-buffer.ts` (flush loop), `message-write.ts` (pacing), `pty-session.ts:548-581` (idle/composing), `tower-websocket.ts:87-132` (input path)
