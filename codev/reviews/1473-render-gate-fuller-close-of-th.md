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

- `packages/codev/src/terminal/terminal-replies.ts` (+159 / -0) — new; the reply filter
- `packages/codev/src/terminal/pty-session.ts` (+171 / -0) — input observation + the diagnostic trace
- `packages/codev/src/agent-farm/servers/mailbox-delivery.ts` (+436 / -0) — the gate consumes the input signal
- `packages/codev/src/agent-farm/servers/message-write.ts` (+64 / -0) — race reporting through the paced write
- `packages/codev/src/agent-farm/servers/mailbox-wiring.ts` (+18 / -0)
- `packages/codev/src/agent-farm/servers/session-submit.ts` (+11 / -0)
- `packages/codev/src/agent-farm/servers/tower-routes.ts` (+18 / -0) — arm the re-drain from the request path
- `packages/codev/src/agent-farm/commands/send.ts` (+19 / -0) — operator-facing `unverifiedCause`
- `packages/codev/src/agent-farm/db/types.ts` (+20 / -0)
- `packages/sdk/src/tower-client.ts` (+14 / -0)
- `packages/codev/src/agent-farm/__tests__/pir-1473-input-race-gate.test.ts` (+622 / -0) — new
- `packages/codev/src/terminal/__tests__/pty-session-input-signal.test.ts` (+232 / -0) — new
- `packages/codev/src/terminal/__tests__/terminal-replies.test.ts` (+208 / -0) — new
- eight existing test files touched (+64 / -4) for the new call shapes
- `packages/codev/scripts/pir-1473-dev-approval-evidence.mts` (+917 / -0) — scripted evidence
- `packages/codev/scripts/pir-1473-human-harness.mts` (+581 / -0) — the manual-step harness
- `codev/evidence/1473-dev-approval-transcript.txt` (+154 / -0)
- `codev/evidence/1473-human-runbook.md` (+404 / -0)
- `codev/plans/1473-render-gate-fuller-close-of-th.md` (+598 / -0)
- `codev/state/pir-1473_thread.md` (+559 / -0)
- `codev/resources/commands/agent-farm.md` (+7 / -0) and its skeleton twin (+7 / -0)

31 files, +5228 / -77 against merge-base `03bc5213e`.

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
- `pnpm --filter @cluesmith/codev test`: ✓ pass — **286 test files, 3 skipped, 5819 tests, 0
  failures**. **116 tests are new**, across three new files. A baseline run at merge-base
  `03bc5213e` failed only `worktree-write-guard` (environmental in a `/tmp` worktree; it passes
  here), so nothing red is being hidden.
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
