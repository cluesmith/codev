# PIR Review: Render gate — closing the gate→write input race

Fixes #1473

## Summary

`afx send`'s render gate proved a composer was empty using **output** signals only — the ring's
cumulative byte count and the timestamp of the last output byte — so it could see an app
repainting but was blind to a human's keystrokes. Two races stayed open: a keystroke landing
*after* the gate sampled its change token (nothing the token counted moved, so both samples
agreed and the message was written onto a line someone had started typing on), and a keystroke
landing *just before* the sample and not yet echoed (no counter comparison can catch that — both
samples agree, correctly). This PR gives `PtySession.write()` — the single funnel every writer
passes through — a monotone `inputSeq` counter and a `lastInputAt` timestamp, folds `inputSeq`
into the gate's change token, and adds a 300 ms input-settle beside the existing 250 ms output
settle. A race that happens *during* the paced write is reported (`racedByInput` →
`unverifiedCause`), never re-written, because re-writing a message that already landed is the
#1584 re-injection failure.

The precondition was a server-side terminal-reply filter. xterm forwards DA/DSR/CPR/XTWINOPS/
DECRPM/DECRQSS/OSC-colour/focus **replies** upstream through the same path as keystrokes;
counting those as input would hold mail with nobody at the keyboard, and would self-trip —
delivery repaints the TUI, the TUI queries the client, the client answers, and the answer looks
like typing. `terminal-replies.ts` strips them from the *signal* only; the PTY still receives
every byte verbatim, because applications block waiting on their own DA/DSR answers.

## Files Changed

Against merge-base `03bc5213e` — **41 files, +5834 / -88**. Measured after the
final review commit, so this list includes the review and governance files themselves.

- `codev-skeleton/resources/commands/agent-farm.md` (+6 / -1)
- `codev/evidence/1473-dev-approval-transcript.txt` (+154 / -0)
- `codev/evidence/1473-human-runbook.md` (+416 / -0)
- `codev/plans/1473-render-gate-fuller-close-of-th.md` (+598 / -0)
- `codev/projects/1473-render-gate-fuller-close-of-th/status.yaml` (+27 / -0)
- `codev/resources/arch-critical.md` (+1 / -1)
- `codev/resources/arch.md` (+8 / -0)
- `codev/resources/commands/agent-farm.md` (+6 / -1)
- `codev/resources/lessons-critical.md` (+1 / -1)
- `codev/resources/lessons-learned.md` (+4 / -0)
- `codev/reviews/1473-render-gate-fuller-close-of-th.md` (+172 / -0)
- `codev/state/pir-1473_thread.md` (+559 / -0)
- `packages/codev/scripts/pir-1473-dev-approval-evidence.mts` (+917 / -0)
- `packages/codev/scripts/pir-1473-human-harness.mts` (+581 / -0)
- `packages/codev/src/agent-farm/__tests__/bugfix-1573-delivery-verification.test.ts` (+6 / -1)
- `packages/codev/src/agent-farm/__tests__/bugfix-1584-no-rewrite-after-write.test.ts` (+13 / -3)
- `packages/codev/src/agent-farm/__tests__/cron-delivery.test.ts` (+2 / -0)
- `packages/codev/src/agent-farm/__tests__/inbox-cli.test.ts` (+44 / -0)
- `packages/codev/src/agent-farm/__tests__/pir-1473-input-race-gate.test.ts` (+684 / -0)
- `packages/codev/src/agent-farm/__tests__/send-delivery.test.ts` (+18 / -0)
- `packages/codev/src/agent-farm/__tests__/send-integration.e2e.test.ts` (+7 / -0)
- `packages/codev/src/agent-farm/__tests__/send-mailbox-repro.test.ts` (+3 / -0)
- `packages/codev/src/agent-farm/__tests__/send.test.ts` (+72 / -0)
- `packages/codev/src/agent-farm/__tests__/spec-1365-serializer-convergence.test.ts` (+2 / -0)
- `packages/codev/src/agent-farm/__tests__/spec-1470-reentry-delivery.test.ts` (+2 / -0)
- `packages/codev/src/agent-farm/__tests__/tower-routes.test.ts` (+169 / -0)
- `packages/codev/src/agent-farm/commands/inbox.ts` (+11 / -3)
- `packages/codev/src/agent-farm/commands/send.ts` (+18 / -1)
- `packages/codev/src/agent-farm/db/types.ts` (+15 / -5)
- `packages/codev/src/agent-farm/servers/mailbox-delivery.ts` (+413 / -46)
- `packages/codev/src/agent-farm/servers/mailbox-wiring.ts` (+14 / -4)
- `packages/codev/src/agent-farm/servers/message-write.ts` (+60 / -4)
- `packages/codev/src/agent-farm/servers/session-submit.ts` (+7 / -4)
- `packages/codev/src/agent-farm/servers/tower-routes.ts` (+18 / -0)
- `packages/codev/src/terminal/__tests__/pty-session-input-signal.test.ts` (+232 / -0)
- `packages/codev/src/terminal/__tests__/terminal-replies.test.ts` (+208 / -0)
- `packages/codev/src/terminal/pty-session.ts` (+178 / -7)
- `packages/codev/src/terminal/terminal-replies.ts` (+159 / -0)
- `packages/sdk/src/tower-client.ts` (+14 / -0)
- `packages/types/src/api.ts` (+6 / -3)
- `packages/types/src/sse.ts` (+9 / -3)

## Commits

- `820c2072c` chore(porch): 1473 init pir
- `a21856871` [PIR #1473] Plan draft
- `41b073245` [PIR #1473] Plan revised — 3 blockers from 2-way consult + architect verification
- `c4b2e3ae8` [PIR #1473] Plan revision 3 — 3-way CMAP: 6 blockers, 2 decide-items, 2 self-reversals
- `c0d367659` [PIR #1473] Give PtySession an input observation for the delivery gate
- `9c8ead811` [PIR #1473] Gate consumes the input signal; report and retry an input race
- `1b8a0de16` [PIR #1473] Tests for both input residuals, plus the operator-facing detail
- `a65338543` [PIR #1473] Builder thread — implement phase notes
- `eb093bac6` [PIR #1473] Arm the input re-drain from the request path too
- `d5f7bd4f8` [PIR #1473] dev-approval evidence: script + committed transcript
- `739a52dab` [PIR #1473] Human runbook for the four manual steps, plus its tooling
- `f8e045634` [PIR #1473] Runbook rev 2: split step 4, and make the probe visible to VS Code
- `a4eeb1c4f` [PIR #1473] Runbook rev 3: make the VS Code row clickable, and check the click

## Test Results

- `pnpm --filter @cluesmith/codev build`: ✓ pass
- `pnpm --filter @cluesmith/codev test`: ✓ pass — **286 test files, 3 skipped, 5836 tests, 0
  failures**. **133 tests are new** — 116 in three new files, plus 17 added across four existing
  files in response to the review findings below. A baseline run at merge-base `03bc5213e`
  failed only `worktree-write-guard` (environmental in a `/tmp` worktree; it passes here), so
  nothing red is being hidden.
- **Scripted evidence**: `codev/evidence/1473-dev-approval-transcript.txt` — 20/20 checks
  against a real Tower on a private port with its own test DB, with the live Tower on 4100
  verified untouched before and after.

### Manual verification (the human, at the dev-approval gate)

| Step | Result |
|---|---|
| 1a — reply traffic, browser | **PASS.** Zero `[input-signal]` lines across 60 s hands-off. Liveness confirmed by the built-in vacuity check: typing one character produced `survived="a"` `inputSeq` 24→25 and `survived="\x7f"` 25→26. |
| 1b — reply traffic, VS Code integrated terminal | **PASS** (a different xterm build). |
| 2 — 300 ms calibration, real `claude` | min 5.4 / p50 6.8 / p95 10.8 / **p99 18.2** / max 18.2 ms — rollback criterion did **not** fire. |
| 2 — 300 ms calibration, real `codex` | min 20.5 / p50 22.1 / p95 24.3 / **p99 26.1** / max 26.1 ms — rollback criterion did **not** fire. |
| 3 — mouse click mid-send | **PASS**, `busy:recent-input`. |
| 4a — input signal, cursor-only keys | **PASS**, all 10 repetitions, `busy:recent-input`. |
| 4b — draft integrity while typing | **PASS**, all 10 repetitions, `busy:user-text`; drafts never corrupted, fused, or submitted. |

**The real-harness p99s run 4–8× above the scripted shim's 4.2 / 3.3 ms**, exactly as the
evidence script's "this is a LOWER BOUND, the fixture is a shim not a real harness" caveat
predicted. That caveat is the reason the calibration was worth doing on real harnesses at all:
the 300 ms constant now rests on measured evidence from the applications it actually guards,
not on a proxy that happened to agree. Both real numbers still sit an order of magnitude inside
the budget, so the constant stands unchanged.

## Architecture Updates

**HOT** — `codev/resources/arch-critical.md`: extended the existing `afx send` mailbox-first
fact rather than adding an eleventh (the file is at its 10-fact cap). The gate now samples
input as well as output, and terminal replies are filtered server-side, signal-only. Anyone
adding a message writer needs both halves of that sentence; splitting them across tiers would
let someone read the hot file and still get it wrong.

**COLD** — `codev/resources/arch.md`: the mechanism (the `inputSeq` / `lastInputAt` pair on
`PtySession.write()`, the ordering of the classify → token re-validation → output settle →
input settle chain, and why the reply filter is signal-only), plus the `/api/overview` ↔
`/api/state` naming coupling documented under the VS Code Extension section.

## Lessons Learned Updates

**HOT** — `codev/resources/lessons-critical.md`: sharpened the existing "'tests pass' is not
'it works'" lesson rather than adding an eleventh. It said *verify the real user path*; it now
also says **derive the check from the user's action, not from the code you changed**. That is
the failure this PR hit three times, and the original wording did not prevent any of them —
each of those checks did exercise a real path, just not the one the user takes.

**COLD** — `codev/resources/lessons-learned.md`: the three instances in full (Testing), and two
non-obvious mechanics that cost real time (Debugging).

## Things to Look At During PR Review

**1. The ordering in `mailbox-delivery.ts` is load-bearing and easy to break.**
`classify → token re-validation → output settle → input settle`. `!verdict.clean` returns at
`:797`; the input settle is at `:840`. So a non-empty composer can never yield
`busy:recent-input` — it short-circuits to `user-text` first. Any reordering silently changes
which guard fires, and both guards hold the message, so nothing goes red. This ordering is also
why manual step 4 had to be split (see below).

**2. The reply filter is signal-only, deliberately.** `stripTerminalReplies` removes replies
from what counts as *input*; `PtySession` still writes every byte to the PTY. Applications
block waiting on their own DA/DSR answers, so filtering the PTY write would hang them. The
filter is also pinned to the installed `@xterm/xterm` version by a test — a version bump that
adds a newly-answered query (kitty keyboard, XTVERSION) becomes an unrecognised reply, i.e. an
uncounted-reply hold, and must not pass silently.

**3. Over-strip vs under-strip are both silent, in opposite directions.** An under-strip holds
mail with nobody at the keyboard; an over-strip quietly stops counting a real keystroke and
re-opens the race this issue exists to close, while every gate test keeps passing. That is why
`terminal-replies.test.ts` is the densest file here, and why the `AF_LOG_INPUT_SIGNAL` trace
exists: the filter's correctness is otherwise unobservable from outside the system.

**4. A race during the write is reported, never retried.** `racedByInput` → `unverifiedCause`,
and the row stays `delivered`. Re-writing a message that already landed is #1584. The four
reporting quadrants have explicit tests; `cause: 'input-raced'` wins precedence when the
verdict is also unverified.

**5. `noteOutcome()` on `tower-routes.ts`.** `deliverAgentMailSerialized` is called directly on
the `afx send` request path, *outside* the drainer, so `armInputRetry` never saw that pass's
outcome and `retryAfterMs` was dropped — the operator-facing path fell through to quiescence.
All 27 unit tests passed because every one of them drives the drainer. Worth a look as a class
of bug, not just an instance.

### Review findings and their disposition

Two independent review lanes ran on this PR (the architect's integration CMAP and porch's
single-pass consultation). Verdicts: **gemini APPROVE**, **codex COMMENT/REQUEST_CHANGES**,
**claude REQUEST_CHANGES**. Every finding below was verified against the branch before acting;
none was taken on the summary alone — including one that did not survive the check (gemini
reported the governance updates as landing in `codev-skeleton/` too; they must not, since those
are `<placeholder>` starter templates for adopters and there is no skeleton `arch.md` /
`lessons-learned.md` at all).

#### The consultation lane degrades silently on a large PR

porch's `consult -m claude` failed three times on this diff with `Prompt is too long` — a hard
model input limit at roughly this scale (41 files, +5834), not a transient error. Coverage did
not actually suffer: the architect's integration lane obtained a full claude review of the same
branch, and its four findings are the four blocking fixes below. What suffered was the
*second, independent* opinion.

The protocol gap is worth more than the incident. **porch models consultation completeness as
file presence per model** (`commands/porch/next.ts:598` — `reviews.length <
effectiveModels.length`). It has no representation of a model that *could not* run, so it cannot
distinguish "impossible" from "not yet attempted" from "deliberately skipped". The phase blocks
on a missing file and offers exactly two exits: make a file exist, or change the consultation
lane config repo-wide. The honest state — "this model cannot review a diff this size" — has
nowhere to live in porch's state at all.

That shape has a failure mode beyond inconvenience: the pressure it puts on an agent is to
manufacture the missing file, which is precisely the action that would make a consultation look
like it happened when it did not. Here the builder escalated instead and a human authorized a
**failure record** at that path
(`codev/projects/1473-*/1473-review-iter1-claude.txt`) — a file carrying no verdict line, so
porch's own `grep … || echo UNKNOWN` extraction resolves it as `UNKNOWN`, which is the case the
protocol already anticipates for an unavailable model. Anyone opening that file finds an
account of three failed attempts and a pointer to where claude's real opinion lives, not a
review.

Practical consequence for the next large PIR: expect the porch lane to lose a model somewhere
around this diff size, and plan for a second lane or a split review rather than discovering it
at the gate.

**Fixed — the new hold class was "unrecognized" in `afx inbox show`.** `describeDetail()`
(`commands/inbox.ts`) had no `recent-input` case, so the one verdict this PR exists to make
diagnosable printed as `unrecognized gate detail` — in the view an operator opens *because*
they want the explanation, while the list view rendered it correctly through the shared
formatter. Added with `user-text`-style self-clearing wording, plus a table-driven test over
**every** value the gate can persist, so the next added detail cannot repeat this.

**Fixed — the shared contract still enumerated three details.** `packages/types/src/api.ts` and
`sse.ts` documented the pre-#1473 vocabulary. The SSE payload genuinely carries `recent-input`
(escalation is age-based, so a long-held row escalates whatever its detail says), so server and
client disagreed on the contract. Both updated, with a note on the SSE type saying why the
fourth value reaches consumers.

**Fixed — the starvation warning was sized against one cadence and documented against another.**
`CONSECUTIVE_INPUT_HOLD_WARN_THRESHOLD = 60` claimed "~90s at the 300ms re-drain cadence", but
60 × (300 + 25) ≈ **19.5s**.

The arithmetic is the weaker half of the argument. The sharper evidence is that **the manual
verification of this very feature would have tripped it**: step 4a's ten repetitions each drove
15–20 seconds of unbroken cursor-key input, which is precisely the window the old rule called
machine-generated. A constant written to avoid libelling an ordinary typist as a machine would
have fired on the human confirming that the feature respects ordinary typists. When a guard's
own acceptance test is indistinguishable from the abuse it is meant to catch, the guard is
measuring the wrong thing — no amount of tuning the number fixes that.

So it is now a duration, not a count: `CONSECUTIVE_INPUT_HOLD_WARN_MS = 90_000`, measured from
the start of the unbroken run. That is what the comment always meant, and unlike a count it
cannot silently re-scale when the drain cadence changes — the backstop, quiescence and submit
triggers all drive passes too, so the pass rate was never a stable unit in the first place.
Three tests pin it: 200 passes across 20s must **not** warn (this one fails against the old
code), 20 passes across 95s must warn exactly once, and two 60s runs separated by a delivery
must not add up.

**Fixed — `AF_LOG_INPUT_SIGNAL=1` logs keystrokes verbatim.** `survived="a"` is literal typed
input, and the runbook has operators typing into live composers. There is no redaction to add
without destroying the diagnostic — printing the exact bytes *is* the feature — so the control
is the flag, and it now carries a prominent sensitive-data warning at both sites in
`pty-session.ts` and a callout box at the top of the runbook telling the operator to type
nothing real and not to paste raw trace output into an issue or chat.

**Fixed — two operator-facing boundaries had plumbing and no test.** Neither `/api/send`'s
`unverifiedCause` propagation nor `commands/send.ts`'s cause-aware warning was pinned; as codex
put it, removing that plumbing would have left the suite green. Added route tests for both
causes plus the additive-absence case, and CLI tests for both wordings, the older-Tower
`verified: false` fallback, and an explicit assertion that operator text never leaks the
verifier's internals ("needle", "0 chars") — which the plan had called out by name.

**Fixed — the raw write route's input coupling was untested.** `POST /api/terminals/:id/write`
counts as input only because it passes no `origin` and the default is `'external'` — an
invisible coupling one word wide, and "tidying" it to `'delivery'` would reopen the race for
every non-WebSocket client while every gate test kept passing. Now tested against a **real**
`PtySession` (a double could only assert what the double was told to do): a keystroke advances
the signal, a DA reply does not but still reaches the PTY, and a mixed chunk keeps only the
human residue.

**Not changed — `retryAfterMs` asymmetry** (`mailbox-delivery.ts:825`, `:897`). The
token-moved-by-input branches omit it while the settle branches supply it. Deliberate: those
branches fire when the screen moved *during* the classify, so the input may still be arriving
and there is no settle boundary to compute a deadline from — the next pass re-samples and arms
the retry properly once the input is actually the only thing holding. Supplying a made-up
deadline there would arm a timer against a number that describes nothing.

**Flagged, not fixed — the xterm pin test does not guard the emitting client.**
`terminal-replies.test.ts` resolves `@xterm/xterm` from `packages/codev`, but `apps/web`
declares its own and is what actually emits replies through `Terminal.tsx`. Both are `^5.5.0`
today, so the guard works now but would not trip on an `apps/web`-only bump. Left alone
deliberately: pointing the test at the right package is a one-line change with a cross-package
dependency question behind it (which package should own the pin), and doing it inside a
REQUEST_CHANGES turn without a reviewer seeing it is how a small correct change becomes an
unreviewed one. Worth its own issue.

**Flagged, not fixed — `isUserIdle()` now has zero production consumers.** The gate reads
`lastInputAt` directly, leaving Spec 403's typing-awareness API vestigial. A MAINTAIN candidate,
not this PR's business.

### `afx attach` is the largest remaining hole

The gate observes input at `PtySession.write()`. `afx attach` talks to the shellper socket
directly and never passes through it, so **neither its keystrokes nor its terminal's replies are
observed at all** — and it is the surface a human is most likely to be sitting at. The plan
scoped it out and this PR does not change it; the manual runbook is explicitly forbidden from
using it, because a step-1 trace run there would log zero chunks and read as a clean pass.

Two consequences for a reader: the `afx` command documentation's claim that a held delivery
"cannot fuse" with a draft is an absolute that `attach` does not honour, and closing this hole
is a separate piece of work. **It deserves its own issue** — deliberately not filed from here.

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder pir-1473 → **Review Diff**
- **Run dev**: VSCode sidebar → **Run Dev**, or `afx dev pir-1473`
- **Scripted evidence** (isolated Tower, own DB, refuses to touch 4100):
  `node --experimental-strip-types packages/codev/scripts/pir-1473-dev-approval-evidence.mts`
- **The manual steps**: `codev/evidence/1473-human-runbook.md`, driven by
  `packages/codev/scripts/pir-1473-human-harness.mts` (`up` / `send` / `inbox` / `calibrate` /
  `vscode-check` / `down`)
- **What to verify**: that `busy:recent-input` appears when a human is at an *empty* composer
  and `busy:user-text` when there is a draft; that a draft is never fused or submitted; that an
  idle terminal still delivers promptly (measured −1.9 ms against merge-base, i.e. no
  regression on the common path).

## Flaky Tests

None. No test was skipped or quarantined.
