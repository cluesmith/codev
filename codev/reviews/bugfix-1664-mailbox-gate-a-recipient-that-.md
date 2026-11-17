# Bugfix #1664: the mailbox gate waited on the recipient's output, not on the human

## Summary

Mail to a working agent queued behind its whole turn. Over 24 h of `~/.agent-farm/global.db`,
**227 deliveries waited more than 2 s, mean 54 s, max 561 s** — every one of them onto a composer
that was empty and safe to write to the entire time, because Claude Code and codex accept input
during a turn and queue it for the next one.

The gate proved "the composer has stopped being painted" by requiring the **whole screen** to be
free of output for 250 ms. That is a proxy, and on a working agent it is the wrong one: the
spinner and the streaming transcript live above the composer and repaint constantly, while the
composer itself does not move. The fix scopes the question to the composer region.

Owner's ruling, which is the invariant the whole change is measured against: *"If the AI is
producing output it shouldn't wait. It should only wait if the human is typing, because of the way
queueing works."*

## Root Cause

`packages/codev/src/agent-farm/servers/mailbox-delivery.ts`, two mechanisms, both keyed to output
*anywhere* on the screen:

1. `settled()` — required `now - lastDataAt >= SETTLE_BEFORE_WRITE_MS` (250 ms), i.e. no output
   byte anywhere.
2. `ringToken()` folded `bytesWritten`, so any repaint tripped the post-classify re-validation and
   the in-lock precheck.

Both returned `hold('busy')` with a **null detail** — the one verdict invisible to #1482's
diagnostic axis, so no surface could say "waiting on the agent, not a human".

### Measured, not assumed

Replaying a real streaming claude PTY capture split at its true repaint boundaries
(`ESC[?2026l`, end-of-synchronized-update):

| Signal | Result |
|---|---|
| Repaints while streaming | median **8/sec**, mean interval **122 ms**; only **3 of 728** seconds offered a 250 ms gap |
| Whole-screen hash changes, last 1500 frames | **1242** |
| Composer-region hash changes, same frames | **4** |
| Longest region-unchanged run | **716 frames** |
| Region-stable runs, wall clock | 107 s, 60 s, 304 s, 81 s, 149 s |

So the precondition was essentially unobtainable for the length of a turn, while the thing it
stood in for sat byte-identical for minutes.

## Fix

- **`render-gate.ts`** — `locateComposerRegion` extracted so the classifier and the new
  fingerprint can never disagree about which rows are the composer;
  `composerRegionFingerprint()` covers the region's rendered text (exactly the rows the classifier
  judges), its row span, the cursor, the geometry, and a per-cell **SGR attribute digest**
  (dim / inverse / fg-palette). `null` when no region can be located, which every caller treats as
  moved.
- **`session-screen.ts`** — `peek()`, a synchronous read that returns `null` while any fed byte is
  still unparsed, plus the `hasUnparsedOutput` counter behind it.
- **`mailbox-delivery.ts`** — a required `composerFingerprint` port; a per-session `WeakMap` of the
  last observed region with a bounded observation gap; deliver when the region has held still for
  a settle **or** the whole screen is quiet. The `bytesWritten` half of the TOCTOU token is gone;
  the `inputSeq` half is untouched.
- **`GateProfile.queuesInputMidTurn`** — the licence, granted per app.
- **New self-clearing detail `composer-redraw`** through `MailboxGateDetail`, `api.ts`, `sse.ts`,
  `hold-verdict.ts`, `afx inbox`, the dashboard badge and the VS Code toast, with a `retryAfterMs`
  sharing #1473's one-shot re-drain timer.

### The per-app licence, and where each value came from

This is the part most worth reading later, because the three profiles carry the same flag on two
different kinds of authority.

| Profile | `queuesInputMidTurn` | Basis |
|---|---|---|
| claude 2.1.266 | `true` | **Measured** — 100 delivering trials, 0 head-loss, every message submitted |
| codex-cli 0.153.4 | `true` | **Measured** — 20/20 intact and submitted, then confirmed 5/5 with the real profile value |
| agy | `true` | **Owner ruling, 2026-09-09 — UNMEASURED** |

The owner's ruling is that mid-turn delivery is universal and only human input holds mail, so agy
was granted the licence rather than waiting on a measurement.

**The failure mode that ruling accepts**, stated plainly: if agy drops or mishandles input
arriving mid-turn, the delivered body strands in its composer unsent; the classifier then reads it
as `user-text`, and every later message to that agent queues behind it until a human clears the
line. That is a stuck agent with a visible cause rather than silent data loss — but it is a real
failure mode, and nothing in this repository rules it out. Settling it is a harness run, not an
argument:

```bash
node --experimental-strip-types scripts/bugfix-1664-streaming-delivery-harness.mts \
  --harness agy --scenario streaming --trials 20 --assume-queues-input
```

An app added to `gate-profiles.ts` without the flag keeps the #1573 whole-screen settle end to
end, so a new profile is conservative until someone grants it.

## Testing

6051 unit tests pass; CI 7/7 green. The regression suite is verified **bisecting** — every fix in
it fails with that fix reverted, checked one at a time rather than asserted.

Measured acceptance drove real TUIs through the **production `deliverAgentMail`** (real sqlite
mailbox, live gate bindings, `submitMessagePaced` — the harness re-implements no gate), 20 trials
each:

| Run | Gate | Delivered | Head-loss | Median | Max | Waits >2 s |
|---|---|---|---|---|---|---|
| claude streaming | current | **20/20 intact** | **0/20** | 394 ms | 396 ms | **0/20** |
| claude streaming | **retired** whole-screen settle | 20/20 intact | 0/20 | 2505 ms | 6432 ms | **11/20** |
| claude, human draft on the line | current | **0/20 — 20/20 held `busy:user-text`** | — | — | — | — |
| claude, across a turn end (#1521) | current | **20/20 intact** | **0/20** | 393 ms | 404 ms | **0/20** |
| **codex** streaming | current | **20/20 intact** | **0/20** | 395 ms | 397 ms | **0/20** |

All 20 claude and all 20 codex deliveries were written at instants where
`now - lastDataAt < 250 ms` — writes the retired gate could not have made. The draft run had a
turn concurrently running in all 20 trials: **streaming does not hold mail; a person does.**
Across every delivering run, head-loss is **0/100**.

Acceptance criterion 3 from the issue — a before/after over a comparable window of the
maintainer's own `global.db` — needs the fix actually running in Tower, so it belongs to the
post-merge verify. The controlled same-TUI comparison above is what could be measured pre-merge.

## Known Limits

- **A turn ending during the paced write.** The write spans ~100 ms across `setTimeout` gaps and
  is fingerprint-checked once, at its first byte. Under the old settle this could not arise — a
  delivery only ever wrote to an agent silent for 250 ms — whereas a delivery to a working agent
  can now be overtaken by that agent's own turn-end repaint. Detected rather than prevented, and
  the detection is **partial**: `watchEcho` matches the message's header (or a paste placard) and
  nothing else, so it catches a lost *head* (#1521's shape → `verified: false`) and is blind to a
  truncated *tail*. Follow-up under **#1578**. Measured 0/100 head-loss, and the harness trials do
  assert a unique trailing token, so the empirical bound covers what the production watch cannot.
- **A composer that redraws and returns byte-identical inside an unobserved gap.**
  `MAX_COMPOSER_SAMPLE_GAP_MS` (2 s) bounds it; `peek()`'s unparsed-output refusal closes the
  parse-queue variant.
- **A `null` fingerprint reports the self-clearing `composer-redraw`**, not the classifier-stuck
  family, so a *systematic* classify/peek divergence would hold without classifier-stuck
  telemetry (age-based escalation still fires).
- **agy's licence is unmeasured** — see above.

## CMAP Review

Four rounds. Rounds 1–3 returned `REQUEST_CHANGES` and caught four real defects, none of which I
found myself:

1. **A delivery's own write moved the composer, but the stability sample survived it** (codex). A
   second delivery 250–2000 ms later could reuse the pre-write observation and write into the
   redraw following our own submit — #1521's window reopened by our own hand, and inside the gap
   bound, so nothing else could catch it.
2. **A `!verdict.clean` pass is evidence of movement, and it was skipped** (claude), so a later
   clean pass with a coincidentally identical fingerprint claimed stability across the very
   interval we watched the composer change.
3. **`peek()` could hand back a grid missing bytes fed but not yet parsed** (codex), so a redraw
   could hide in the parse queue. I had *documented* this as an accepted one-parse-turn residual;
   closing it was cheaper than accepting it.
4. **The owner starvation notice told humans to `afx interrupt` a self-clearing hold** (codex and
   claude independently). Routing on `if (info.detail || …)` put every detail but `user-text` into
   the "gate CANNOT VERIFY / will never deliver / run `afx interrupt`" arm.

Final: gemini APPROVE, codex COMMENT, claude APPROVE.

## Lessons

- **A proxy signal is only as good as its scope.** "The screen is quiet" stood in for "the
  composer is quiet" for two issues (#1573, #1521) and was never wrong until the recipient became
  something that talks continuously. The measurement that settled it — 1242 whole-screen changes
  against 4 region changes over the same frames — took one afternoon and would have been just as
  available when the proxy was chosen.
- **Discarding evidence is its own bug class.** Three of the four CMAP findings were the same
  mistake in different places: something we had *already observed* about the composer was dropped
  instead of resetting the stability clock. A stability claim needs to name what it observed and
  when, not merely compare two values.
- **Writing "accepted residual" is a decision, and it deserves the same scrutiny as code.** Two of
  my documented residuals were closable in a few lines; a reviewer had to point that out. The
  comment made the gap look considered rather than open.
- **Fixing a bug widens the blast radius of adjacent wrong code.** The owner-notice branch had
  been telling operators to interrupt a typing human since #1473; adding a second self-clearing
  detail to the same arm is what made anyone look.
- **A TUI detector that can silently match nothing is worse than no detector.** `esc to interrupt`
  is codex-only — claude 2.1.266 renders no such hint — so the #1567 harness reports a working
  claude as idle, which makes a harness race ahead and measure nothing while looking healthy.
