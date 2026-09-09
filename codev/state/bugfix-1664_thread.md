# bugfix-1664 — mailbox gate holds on the recipient's OUTPUT, not on the human

Issue #1664. Owner ruling is the invariant: **only a human at the line holds mail.** If the AI
is producing output, the write is safe — Claude Code and codex accept input mid-turn and queue
it for the next one.

## INVESTIGATE (2026-09-09)

### Reproduced, from a real streaming session

The architect pointed at live evidence: a builder in an adopter workspace holding mail with a
plain `busy` and a streak past 120, while its screen was nothing but a spinner over an empty
composer. Its raw PTY log (11 MB, read-only, on this machine) replays into `@xterm/headless` at
200x50 and lands on exactly that screen (adopter content elided):

```
42 "✽ Bunning… (17m 7s · ↓ 70.5k tokens · thinking some more)"   ← the spinner, repainting
44 "──────────────────────────────────────────────────────────…"
45 "❯"
46 "──────────────────────────────────────────────────────────…"
47 "  agent | builder/… | LC: 4m ago | Opus 4.8 | ctx 312k …"
```

The render gate classifies this **CLEAN** — marker row 45, region end row 46, zero user cells.
The composer is empty and the recipient is safe to write to. The mail was held anyway.

### Root cause — the gate holds on the whole screen, not on the composer

`packages/codev/src/agent-farm/servers/mailbox-delivery.ts`, two mechanisms, both keyed to
output *anywhere* on the screen:

1. `settled()` (L542) / its use at L850 — requires `now - lastDataAt >= 250ms`, i.e. **no
   output byte anywhere** for a quarter second.
2. `ringToken()` (L686) folds `bytesWritten`, so any repaint trips the post-classify
   re-validation (L842) and the in-lock precheck (L912).

Both return `hold('busy')` with a **null detail** — the one verdict invisible to #1482's
diagnostic axis, so no surface says "waiting on the agent, not a human".

### Measured, not asserted (probes in `packages/codev/tmp/`, gitignored)

Replaying the capture split at real repaint boundaries (`ESC[?2026l`, end-of-synchronized-update):

| Signal | Result |
|---|---|
| Repaints while streaming | median **8/sec**, mean interval **122 ms**; only **3 of 728** seconds had <4 repaints |
| Whole-screen hash changes, last 1500 frames | **1242** |
| Composer-region hash changes, same 1500 frames | **4** |
| Longest region-unchanged run | **716 frames** |
| Region-stable runs, wall clock (from the spinner's own elapsed counter) | 107 s, 60 s, 304 s, 81 s, 149 s |

So the 250 ms whole-screen quiet the delivery path demands is essentially unobtainable during
a turn, while the thing it is a proxy for — the composer — sits byte-identical for minutes.
Including the cursor position in the region fingerprint costs nothing (4 changes either way).

### Field cost, `~/.agent-farm/global.db`, last 24 h (the "before" for acceptance #3)

- delivered ≤2 s: **342** rows
- delivered >2 s: **227** rows, mean **54.3 s**, max **561.0 s**
- every >2 s row has a null detail (delivery nulls `reason`/`detail`, so the detail column
  cannot be the after-metric — the wait distribution is)

### Fix shape (issue-prescribed, and it fits BUGFIX)

Replace whole-screen quiescence with **composer-region stability**: fingerprint the classified
region (marker row → bounding rule, plus its row indices, cursor and geometry), deliver when
the region is classified empty *and* its fingerprint is unchanged across two samples
≥ `SETTLE_BEFORE_WRITE_MS` apart, or when the whole screen is quiet (today's proof — keeps the
idle fast path first-pass). Keep the `inputSeq` half of the change token exactly as it is, swap
its output half for the region fingerprint, same in the in-lock precheck, and give the residual
output-side hold the detail `composer-redraw` so it is visible everywhere `recent-input` is.
`#1521`'s hazard survives: a turn-end composer redraw *does* move the region fingerprint.

~150 LOC of production change across mailbox-delivery / render-gate / mailbox-wiring /
session-screen plus the shared detail vocabulary. Well inside BUGFIX.

## FIX (2026-09-09)

### The change

`SETTLE_BEFORE_WRITE_MS` no longer asks the WHOLE SCREEN to go quiet; it asks the **composer
region** to hold still.

- `render-gate.ts` — `locateComposerRegion` extracted (one source of truth for which rows are
  the composer) and `composerRegionFingerprint()` added: the region's rendered text, its row
  span, the cursor, and the geometry. `null` when no region can be located.
- `session-screen.ts` — `peek()`, the sync counterpart of `read()`, because the in-lock
  precheck cannot await.
- `mailbox-delivery.ts` — a required `composerFingerprint` port; a per-session `WeakMap` of the
  last observed region + when it was first seen; deliver when the region has been unchanged for
  ≥ `SETTLE_BEFORE_WRITE_MS` **or** the whole screen is quiet (kept, so an idle recipient still
  delivers on the first pass). The `bytesWritten` half of the TOCTOU token is gone; the
  `inputSeq` half is untouched. Same rule in the in-lock precheck.
- New self-clearing detail `composer-redraw` through `MailboxGateDetail`, `api.ts`, `sse.ts`,
  `hold-verdict.ts`, `inbox.ts describeDetail`, the dashboard badge and the VS Code toast. It
  carries a `retryAfterMs`, so the drainer's one-shot re-drain (shared with #1473's input
  settle) fires ~275 ms later instead of waiting for the 1.5 s backstop — the input-hold streak
  diagnostic is gated to `recent-input` so a repainting composer is never called a typist.

117 non-comment lines of production change. `pnpm build` clean; 6029 tests pass.

### Regression test

`bugfix-1664-composer-stability-gate.test.ts`, 18 cases. Verified it FAILS without the fix: the
old gating restored temporarily, 4 cases fail including "THE REGRESSION: delivers to an agent
that is streaming".

### Acceptance harness

`scripts/bugfix-1664-streaming-delivery-harness.mts` drives a real claude TUI through the
PRODUCTION `deliverAgentMail` (real sqlite mailbox, live gate bindings, `submitMessagePaced`) —
it re-implements no gate. Three scenarios (`streaming`, `draft`, `turn-end`) plus
`--legacy-gate`, which models the retired whole-screen settle so the same trials can be measured
both ways on the same TUI.

Note for the record: **claude 2.1.266 no longer renders `esc to interrupt`**, so the #1567
harness's `WORKING_RE` is stale and reports a streaming agent as idle. This harness detects
streaming by output activity instead — which is also literally the condition in the owner's
ruling.

### Acceptance (measured, `codev/evidence/1664-streaming-delivery/`)

Real `claude 2.1.266` under node-pty, 20 trials each, all through the production
`deliverAgentMail`:

| run | gate | delivered | head-loss | median | max | waits >2 s |
|---|---|---|---|---|---|---|
| streaming | current | 20/20 intact | 0/20 | 397 ms | 400 ms | **0/20** |
| streaming | **retired** whole-screen settle | 20/20 intact | 0/20 | 2505 ms | 6432 ms | **11/20** |
| draft | current | 0/20 — **20/20 held `busy:user-text`** | 0/20 | — | — | — |
| turn-end (#1521's window) | current | 20/20 intact | **0/20** | 393 ms | 404 ms | 0/20 |

- 18 of the 20 streaming deliveries were written at an instant where `now - lastDataAt < 250 ms`
  — writes the retired gate could not have made.
- The draft run had a turn concurrently running in all 20 trials: **streaming does not hold mail;
  a person does.**
- The legacy comparison understates the field cost — `--model haiku` turns are short, where the
  production data behind the issue shows mean 54 s / max 561 s.

Acceptance criterion 3 (a before/after over a comparable window of the maintainer's own
`global.db`) needs the fix actually running in Tower, so it belongs to the post-merge VERIFY
phase, not here. The controlled same-TUI comparison above is what can be measured pre-merge, and
the "before" field numbers are recorded in INVESTIGATE.

### Harness findings worth keeping

- **claude 2.1.266 no longer renders `esc to interrupt`.** The #1567 harness matches exactly
  that, so on this version it reports a working agent as idle — which makes a harness stack every
  prompt into the TUI's queue and measure nothing. This harness reads the live working line's
  parenthesised elapsed counter instead, and refuses to call the TUI idle while messages are
  queued.
- Two acceptance oracles were tried and discarded: counting copies of the body on screen does not
  measure submissions (a composer repaints its own contents every frame, and those states scroll
  into history), and asking the model to echo a token back does not either — claude correctly
  **declines** instructions embedded in a delivered message while acknowledging receipt.

### Soundness gap found and closed mid-flight

The first implementation kept the last composer observation per session with no age bound, so a
sample taken minutes earlier could authorise an immediate write onto a composer that had just
been repainted — #1521's hazard, reopened. Caught because consecutive harness trials delivered on
their very first pass. `MAX_COMPOSER_SAMPLE_GAP_MS` (2 s, above the 1.5 s backstop) now restarts
the stability clock across a gap that long; pinned by a test.

## CMAP round 1 (PR #1666)

gemini **APPROVE** · codex **REQUEST_CHANGES** · claude **REQUEST_CHANGES** — both change requests
correct, and both the same underlying mistake: **evidence that the composer moved was being
discarded instead of resetting the stability clock.**

1. **codex** — the delivery's OWN write moves the composer (body → Enter → fresh prompt), but the
   pre-write sample survived it. A second delivery arriving 250–2000 ms later, finding the same
   empty-composer fingerprint, was authorised to write immediately into the redraw following our
   own submit. Inside `MAX_COMPOSER_SAMPLE_GAP_MS`, so the gap bound could not catch it. #1521's
   window, reopened by our own hand. Fixed by clearing the sample in the same `finally` that
   already invalidates the verdict memo, for exactly the reason that block documents.
2. **claude** — a `!verdict.clean` pass is *evidence* the composer moved or cannot be read, but the
   early return skipped the sample update, so a later clean pass with a coincidentally identical
   fingerprint claimed the region held still across the interval we watched it change.
3. **claude, minor** — the stability decision read `ports.now()` twice; now once, so the recorded
   sample and the retry delay cannot describe different instants.

Both fixes verified bisecting: with each revert applied, exactly its own test fails.
22 cases in the regression file; 6033 tests pass overall.

## CMAP round 2

gemini **APPROVE** · claude **APPROVE** · codex **REQUEST_CHANGES** — codex right again, and on
the residual I had *documented* rather than closed.

**codex:** `peek()` returned the grid without flushing, and `SessionScreen.feed()` queues an
asynchronous xterm parse. So output arriving after the stable sample and immediately before the
in-lock precheck sat in the parse queue, absent from the buffer — the fingerprint compared EQUAL
and permitted the write, straight into the redraw. The retired `bytesWritten` comparison used to
catch exactly that. Closed: `feed()` numbers each chunk and its parse callback records the number,
so `hasUnparsedOutput` answers "is this grid current?" synchronously, and `peek()` returns null
while it is not. A synchronous caller cannot flush, so the only honest answers are a coherent
frame or none. Re-measured rather than assumed — the refusal can only add holds — and it costs
nothing: median 394 ms against 395 ms (`fixed-r3-streaming-*`).

**claude, non-blocking**, two acted on:
- the `ringToken` docblock still claimed a gate→write TOCTOU consumer this PR retired (corrected);
- live acceptance was claude-only, so codex's and agy's composer shapes were untested against the
  new fingerprint — added fixture coverage over their real captures (render-gate suite 70 → 76).

Two recorded as follow-ups rather than changed here:
- a `null` fingerprint reports the self-clearing `composer-redraw` rather than the
  classifier-stuck family, so a *systematic* classify/peek divergence would hold without
  classifier-stuck telemetry (age-based escalation still fires). Distinguishing them means a
  richer port return type for a case that needs classify and peek to disagree persistently.
- `MAX_COMPOSER_SAMPLE_GAP_MS` (2 s) sits only 500 ms above the 1.5 s backstop — latency-only and
  self-correcting via the retry timer.

## CMAP round 3

gemini **APPROVE** · codex **REQUEST_CHANGES** — and codex's third finding is the one that would
have reached a human with destructive advice.

`formatOwnerNoticeBody` routed on `if (info.detail || info.reason === 'no-profile')`, so EVERY
detail except `user-text` landed in the defect arm: *"the render gate CANNOT VERIFY that
composer… the mail will never deliver on its own… `afx interrupt <agent>`"*. For
`composer-redraw` that kills the turn of an agent that is merely working.

Checking it, the same branch **already misfires for `recent-input` on main today** — it tells an
owner to interrupt someone who is simply typing, which is exactly the mistake that function's own
comment says aggravated #1583. Pre-existing, one detail wide, and on the line this issue was
touching; fixed rather than left, and called out as a deliberate widening.

Routing now asks `isUnverifiableVerdict`, the predicate every other surface already uses, so a
detail added later cannot silently default into the destructive arm. Both self-clearing details
get accurate wording that names no terminal-touching command. Tests bisect: 5 fail with the old
conditional restored. 6048 tests pass.

## CMAP round 4

gemini **APPROVE** · claude **APPROVE** · codex **COMMENT** — no blockers. Both round-3 blockers
confirmed closed.

Acted on the remaining notes:
- **codex**: the draft run's summary reported "body left the composer… 20/20" for trials where
  *nothing was delivered* — it was measuring the harness tidying up after itself, and read as a
  success line for a run whose entire point is zero deliveries. Now computed over delivered
  trials only, `n/a` when there are none; draft scenario re-run to regenerate it.
- **codex**: pruned the superseded intermediate evidence runs. Four are kept, one per acceptance
  claim; the re-measurement progression is recorded as prose in the README instead.
- **claude**: a loop-inside-`it` test would have passed vacuously if the fixture naming drifted —
  it now asserts the filter matched all three profiles first.
- **claude**: `classifyAgentScreen`'s docstring still named the retired whole-screen TOCTOU.

Recorded, not changed: the `composer-redraw` re-drain at ~275 ms is slightly more idle work per
starving agent than the 1.5 s backstop (claude, non-blocking), and the post-merge verify should
include a **codex** recipient — the live acceptance drove claude only, though codex's and agy's
composer shapes now have fixture-level fingerprint coverage.

6048 tests pass. Build clean.

## Architect integration review (2026-09-09)

Three blocking items, all done.

**(1) `GateProfile.queuesInputMidTurn` — per-app capability, measured not inherited.** Composer
stability is now a licence granted per app; without it the delivery path keeps the #1573
whole-screen settle end to end, pre-lock and in-lock alike. An app that DROPS input arriving
mid-turn would lose messages silently, which is worse than waiting, so the default is
conservative and agy is explicitly *not claimed*.

Measuring codex needed a flag: with the conservative default in force the gate never delivers to
a streaming agent, so the very experiment that decides the value cannot run. `--assume-queues-input`
grants the licence for the measurement only, and the result decides the profile — a run that
quietly assumed it would be evidence for nothing. **codex-cli 0.153.4: 20/20 delivered intact,
0 head-loss, 20/20 submitted, all 20 at instants the retired settle would have refused.** Flag set,
then confirmed 5/5 with the real profile value rather than the override.

Two findings from that work:
- **codex's composer slides down the screen** (rows 13 → 37 over ~11 s) until the transcript fills
  it and it pins. Its row span is in the fingerprint, so a fresh codex session's first delivery
  holds until the screen fills. Transient, self-correcting, documented rather than special-cased.
- **`esc to interrupt` is a codex-only signal.** codex 0.153.4 renders `• Working (2s • esc to
  interrupt)`; claude 2.1.266 renders no such hint. The harness now matches a union of both.

**(2) SGR attribute digest folded into the fingerprint.** The architect is right and my earlier
"deliberately not covered" reasoning was wrong for the one place it matters: the in-lock precheck
is synchronous and compares fingerprints WITHOUT re-classifying, so a dim placeholder becoming
normal-intensity typed text of the same string — exactly what retyping a suggested command
produces — would have compared equal. `regionAttributeDigest` (dim / inverse / fg-palette, FNV-1a
over non-empty cells) closes it; the placeholder→user-text test is verified bisecting.

**(3) The echo-watch claim was an overclaim of mine.** I wrote that the new mid-write turn-end
race is "detected rather than prevented"; `watchEcho` matches the HEADER (or a paste placard) and
nothing else, so it catches a lost head (#1521's shape) and is blind to a truncated TAIL — header
rendered, delivery reports confirmed, body short. Corrected in place, noted as a follow-up under
**#1578**, with the observation that the harness trials *do* assert a unique trailing token, so
the 0/100 empirical bound covers what the production watch cannot see.

Non-blocking, both done: the measurement figures moved out of the hot bullet into arch.md (1136 →
1059 chars, back near its 1029 baseline), and the claim now reads "For an app MEASURED to queue
input mid-turn … only a HUMAN at the line holds mail".
