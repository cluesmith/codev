# Issue #1664 — a recipient that is producing output must not hold mail

Owner ruling: *"If the AI is producing output it shouldn't wait. It should only wait if the human
is typing, because of the way queueing works."*

All runs: a REAL TUI under node-pty in an empty scratch directory — `claude 2.1.266`
(`--dangerously-skip-permissions --model haiku`) except where the table says codex, which is
`codex-cli 0.153.4` (`--dangerously-bypass-approvals-and-sandbox`) — at 120x40, driven by
`packages/codev/scripts/bugfix-1664-streaming-delivery-harness.mts`. No Tower, no shellper,
nothing under `~/.agent-farm` touched.

**The harness re-implements no gate.** Each delivery goes through the production
`deliverAgentMail` over a real sqlite mailbox, with the live bindings — `classifyBuffer` +
`composerRegionFingerprint` over a `SessionScreen` mirror — and the production write edge
(`submitMessagePaced`). The harness supplies only the terminal and the clock, so what it
measures is what Tower does.

## What each column means

- **delivered at a moment the retired whole-screen settle would have refused** — at the pass that
  wrote the bytes, `now - lastDataAt < SETTLE_BEFORE_WRITE_MS`. This is the acceptance claim
  stated as a check, not a description: those writes are ones the old gate could not have made.
- **head-loss** — the trial's unique TAIL token rendered on the terminal and its HEAD token never
  did. That is #1521/#1567's failure shape.
- **body left the composer for the transcript** — the composer classified as a verified-empty
  prompt again once the trial settled, so the message was submitted rather than stranded on the
  line. Reported over DELIVERED trials only: with nothing delivered (the `draft` scenario, by
  design) a clean composer says only that the harness tidied up after itself, and reporting it as
  20/20 read like a success line for a run whose whole point was zero deliveries.

Two oracles were tried and discarded, and are worth recording so nobody re-derives them:
counting copies of the body on screen does not measure submissions (a composer repaints its own
contents every frame, and those intermediate states scroll into the mirror's history), and asking
the model to echo a token back does not either — measured, claude correctly **declines**
instructions embedded in a delivered message while acknowledging that it received it.

## Runs

See each run's `summary.md` and `results.json`. `pty.raw` (the full byte log) is written next to
them but not committed.

| run | scenario | gate | delivered | head-loss | median wait | max wait | waits >2 s |
|---|---|---|---|---|---|---|---|
| `fixed-r4-streaming-*` | recipient mid-turn, empty composer | current | **20/20 intact** | **0/20** | 394 ms | 396 ms | **0/20** |
| `legacy-streaming-legacy-*` | *the same scenario* | **retired** whole-screen settle | 20/20 intact | 0/20 | 2505 ms | 6432 ms | **11/20** |
| `fixed-draft-*` | recipient mid-turn, human draft on the line | current | **0/20 — 20/20 held `busy:user-text`** | — | — | — | — |
| `fixed-turn-end-*` | delivery attempted across a turn end (#1521's window) | current | **20/20 intact** | **0/20** | 393 ms | 404 ms | **0/20** |
| `codex-streaming-*` | **codex** recipient mid-turn, empty composer | current | **20/20 intact** | **0/20** | 395 ms | 397 ms | **0/20** |

### What each run establishes

1. **streaming, current gate** — 20/20 landed intact and were submitted, and **20/20 were written
   at a moment when `now - lastDataAt < 250 ms`**, i.e. at an instant the retired gate would have
   refused outright, with a turn running in all 20. Median wait 395 ms; nothing waited past
   399 ms. Hold verdicts seen while waiting: `busy:composer-redraw` only.

   This scenario was re-measured after each CMAP round that changed delivery semantics, since a
   hardening that can only ADD holds must be measured rather than assumed. Only the final run is
   kept here; the progression was: **18/20** on the "would have refused" column before the round-1
   stale-sample fixes (a stale sample could occasionally let a delivery through on its first
   pass — the numbers got *better* by getting stricter), then **20/20** at median 395 ms, 394 ms
   and 394 ms across rounds 1, 2 and 3 respectively. Round 2 made `peek()` refuse a grid with
   unparsed output; round 3 narrowed the fingerprint to exactly the rows the classifier judges.
   Neither cost anything measurable, because the window in which a fed chunk is still unparsed is
   far shorter than the interval between delivery passes.

   **Across all four streaming runs plus the turn-end run — 100 delivering trials against a real
   claude — head-loss is 0/100.**

2. **streaming, legacy gate** — the identical scenario measured against the rule this issue
   removes: still 20/20 eventually, but the median wait is **6.3× longer** and **11 of 20 rows
   waited past 2 s**, against 0 of 20 for the current gate. This run understates the field cost
   by a lot: it uses `--model haiku`, whose turns are short, whereas the 24 h of production
   `global.db` behind this issue shows a mean wait of 54 s and a maximum of 561 s against the
   longer turns real agents run.

3. **draft, current gate** — the owner ruling's other half. A human draft on the line held
   **20/20** as `busy:user-text`, with a turn concurrently running in all 20, and not one byte
   was written. Streaming does not hold mail; a person does.

4. **turn-end, current gate** — #1521's window, the reason the settle existed. Deliveries were
   attempted continuously across the end of a turn, so some attempts met a composer mid-redraw:
   those were held (`busy:composer-redraw`) and the message then landed. **0/20 head-loss.**

5. **codex, current gate** — the run that DECIDES `CODEX_PROFILE.queuesInputMidTurn`. Composer
   stability is a licence granted per app by measurement, and the production default for an
   unmeasured app is the conservative whole-screen settle — which never fires for a streaming
   agent, so the experiment cannot run under it. The harness's `--assume-queues-input` grants the
   licence for the duration of the measurement only; the result then decides the profile value.
   codex-cli 0.153.4 answered **20/20 intact, 0 head-loss, 20/20 submitted**, every one written
   at an instant the retired settle would have refused — so the flag is set, on evidence.

   **agy has no run here, deliberately.** Its `queuesInputMidTurn` was set by owner ruling on
   2026-09-09 (mid-turn delivery is universal; only human input holds mail) rather than by
   measurement, so there is no evidence directory to point at and this README must not imply
   there is. The failure mode that ruling accepts, and the harness invocation that would settle
   it, are recorded in `AGY_PROFILE`'s comment and in
   `codev/reviews/bugfix-1664-mailbox-gate-a-recipient-that-.md`.

   One measured quirk, recorded because it looks like a bug and is not: codex's composer **slides
   down the screen** as its transcript grows (rows 13 → 37 over ~11 s) before pinning at the
   bottom. Its row span is part of the fingerprint, so during that phase the region legitimately
   counts as moving and mail holds — a fresh codex session's first delivery waits for the screen
   to fill. Transient and self-correcting; a long-lived builder's screen is always full.

The `legacy` run models the pre-#1664 rule — a pass may proceed only once the whole screen has
been free of output for `SETTLE_BEFORE_WRITE_MS` — so the improvement is a comparison against the
same TUI rather than an assertion. It is generous to the old behaviour: it omits the
`bytesWritten` half of the change token, which could only add holds.

## Note on the #1567 harness

`bugfix-1567-head-loss-harness.mts` matches `esc to interrupt` to decide whether a turn is
running. **claude 2.1.266 does not render that hint at all**, so on this version the detector
reports a working agent as idle — which makes a harness race ahead and stack every prompt into
the TUI's queue without a single turn ever running. (It is correct for **codex** 0.153.4, which
does render `• Working (2s • esc to interrupt)`; the two TUIs simply say it differently.) This
harness matches a union of both — the `esc to interrupt` hint OR a parenthesised elapsed counter,
`✽ Bunning… (17m 7s · ↓ 70.5k tokens · …)`, which claude's finished line (`✻ Sautéed for 15s ·
done 8:52 AM`) does not carry — and also refuses to call a TUI idle while messages sit in its
queue. A detector that silently matches nothing is the failure mode here, so the union is
deliberate.
