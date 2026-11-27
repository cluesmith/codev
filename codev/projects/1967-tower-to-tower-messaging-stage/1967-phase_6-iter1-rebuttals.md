# Phase 6, iteration 1: response to review

Both reviewers asked for changes (codex and claude, both HIGH confidence). Both points are taken
and fixed. Nothing is disputed.

## codex: the 5-second deadline is not enforced once delivery starts

**Taken.** The approved spec decides it (section 5, after step 16): "R answers within **5
seconds** of receiving the body … R never makes C wait past its own deadline, so C's `no-answer`
means R is unreachable, not slow." The plan's line "Started: the answer is that pass's outcome"
holds only while a started pass is quick. That is true for claude and codex (at most about 0.6 s
of paste, 80 ms to Enter, and 600 ms of echo check). It is not true for agy, which is written
line by line at 10 ms a line. The residual I had recorded for that case broke the spec's
sentence, so it was a defect, not a residual.

Changed (`peer/receiver.ts`, step 16):

- The receiver races the attempt against the time left to `answerBy`.
- If the attempt finishes first, the answer is its outcome, as before.
- If the deadline comes first, whether the attempt is still writing or its turn never came,
  the answer is the message's state at that moment. While the attempt waits or writes, that
  state is `held`, `busy`. The attempt runs on, and a duplicate later reports where it ended.
- A failure after the answer is still logged (ERROR, error class only), and the row stays held.
- The not-started path is unchanged: `runWithin` skips the late turn.

Tests:

- Layer A, fake timers, an 8-second write. At 4,999 ms there is no answer, though the write has
  started. At 5,000 ms the answer is `held`, `busy` and the row is still held. The write then
  finishes, the row is delivered, and a retry is told `delivered`, `duplicate: true`.
- Layer A: a write that fails at 8 s, after the answer, is logged with its class (not its
  message) and leaves the row held.
- Layer B, real Towers: an 800-line body to an agy echo builder on a clean composer is about 8 s
  on the wire. It is answered `held`, `busy` at about 5 s and delivered afterwards, and a retry is
  told `delivered`, `duplicate: true`.
- With the race removed, both layer A tests fail (and so does the existing lock-order test, which
  sets a 50 ms deadline).

The review file no longer lists the agy relay-timeout residual.

## claude: a row the owner releases is held for release again at once

**Taken.** The reviewer is right, and so is the reason given. `remoteMailAllowed` answered "may
this be delivered automatically under the permissions now?" for every caller. After `release()`
under a hold grant, after a revocation, or with the switch off, the drain-time recheck sent the
row straight back to held for release, so a release could never deliver.

What the owner's release means is in spec 1940, Withdrawal: "The owner may still release or
dismiss it: a grant governs what a peer may put into my mailbox, and what I do with a message
already there is my own decision." The switch-off paragraph says such mail becomes held for
release "exactly as when a grant is removed", so the same holds there.

Changed (the reviewer's option 1, a named column):

- `mailbox.released_at` (nullable epoch ms) is set by `release()`. It goes into v21, which is
  this spec's own migration. No shipped build and no real database has run it, because all
  phases land in one PR.
- `remoteMailAllowed` answers yes for a released row. It is the one question that both the
  drain-time recheck and eager withdrawal ask, so neither takes a released row back. That holds
  under the hold grant that held it, after a revocation, and with the switch off, including a
  withdrawal that comes after the release while the row waits for a clean composer.
- To stop a released message, the owner dismisses it. I chose this rule; the architect can
  overrule it. The alternative, where a later withdrawal takes a released row back, needs to know
  which permissions changed after the release, and nothing records that today.

Tests (layer A), each draining after the release, the test the reviewer noted was missing:

- under the hold grant that held it, the released row is delivered to the terminal;
- after a revocation and with the switch still off, the released row is delivered and the
  unreleased one keeps waiting;
- a switch-off and a revocation that come after the release, while the row waits for a clean
  composer, do not take it back, and it is delivered once the composer is clean.

All three fail with the `released_at` line removed. The migration tests cover the new column,
and `release()` is asserted to set it.

## claude's smaller notes

- **1,000 not verified in one minute:** added. They give one row with a count of 1,000.
- **A marker line led by NBSP is not escaped:** faithful to Decision 7, which strips only spaces
  and tabs before the marker. Recorded as a residual in the review, as suggested.
- **Layering** (`withdrawRemoteMail` and `remoteMailAllowed` live in `receiver.ts`): left as
  documented in the file's header.
