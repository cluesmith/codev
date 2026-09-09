# Issue #1664 — a recipient that is producing output must not hold mail

Owner ruling: *"If the AI is producing output it shouldn't wait. It should only wait if the human
is typing, because of the way queueing works."*

All runs: a REAL Claude Code TUI (`claude 2.1.266`, `--dangerously-skip-permissions --model
haiku`, 120x40) under node-pty in an empty scratch directory, driven by
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
  line.

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
| `fixed-streaming-*` | recipient mid-turn, empty composer | current | **20/20 intact** | **0/20** | 397 ms | 400 ms | **0/20** |
| `legacy-streaming-legacy-*` | *the same scenario* | **retired** whole-screen settle | 20/20 intact | 0/20 | 2505 ms | 6432 ms | **11/20** |
| `fixed-draft-*` | recipient mid-turn, human draft on the line | current | **0/20 — 20/20 held `busy:user-text`** | 0/20 | — | — | — |
| `fixed-turn-end-*` | delivery attempted across a turn end (#1521's window) | current | **20/20 intact** | **0/20** | 393 ms | 404 ms | **0/20** |

### What each run establishes

1. **streaming, current gate** — 20/20 landed intact and were submitted, and **18/20 were written
   at a moment when `now - lastDataAt < 250 ms`**, i.e. at an instant the retired gate would have
   refused outright. Median wait 397 ms; nothing waited past 400 ms. Hold verdicts seen while
   waiting: `busy:composer-redraw` only.

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

The `legacy` run models the pre-#1664 rule — a pass may proceed only once the whole screen has
been free of output for `SETTLE_BEFORE_WRITE_MS` — so the improvement is a comparison against the
same TUI rather than an assertion. It is generous to the old behaviour: it omits the
`bytesWritten` half of the change token, which could only add holds.

## Note on the #1567 harness

`bugfix-1567-head-loss-harness.mts` matches `esc to interrupt` to decide whether a turn is
running. **claude 2.1.266 does not render that hint at all**, so on this version the detector
reports a working agent as idle. This harness reads claude's live working line instead (a
parenthesised elapsed counter, `✽ Bunning… (17m 7s · ↓ 70.5k tokens · …)`, which its finished
counterpart `✻ Sautéed for 15s · done 8:52 AM` does not carry) and also refuses to call the TUI
idle while messages sit in its queue.
