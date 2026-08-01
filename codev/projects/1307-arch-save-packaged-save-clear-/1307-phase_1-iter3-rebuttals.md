# Phase 1 — Rebuttals, iteration 3

Codex `REQUEST_CHANGES`, Claude `APPROVE`. **Codex's finding was accepted and fixed**, and
the work continued through several further review rounds beyond this iteration.

A note on numbering, since it matters for reading this file: porch's iteration counter and
my consultation filenames drifted apart. I ran review rounds named `iter3` … `iter8` while
porch's counter stayed at 3. Everything below covers that whole sequence, so this rebuttal
answers more than just the two `iter3` files. The later review files are on disk under the
same directory and are the record of the rounds after this one.

---

## Codex (iter3): the per-terminal chain did not actually serialise

**Accepted, and it was correct about something my own test had disguised.**

The chain `await`ed `deliverOrBuffer`, but that returns as soon as
`writeMessageToSession` has *scheduled* its paced writes and trailing Enter. Two
same-terminal delayed sends due together therefore still interleaved — short ones
producing `firstsecond\r\r` instead of two messages. My round-2 fix had serialised the
*callback*, not the writes.

Codex also named why the test missed it: the chain test used an artificially async
callback, so it proved the chain waits for the callback rather than for the writes.

**Fixed** in `29abc16c`: `deliverOrBuffer` returns `writeCompletesInMs` (a value
`writeMessageToSession` already computed) and the scheduled callback holds the terminal's
chain open for that long. Added a route-level test whose decisive assertion is that the
first message's trailing Enter lands before the second payload begins. Mutation-verified.

## What the subsequent rounds found (iter4 – iter8)

Recorded here because they are part of the same phase and the same thread of reasoning:

- **iter4 — the spec contradicted the code.** My success criterion said a delayed message
  "never overtakes an earlier message," which reads as request-order FIFO; the
  implementation deliberately lets `--delay 5` overtake `--delay 30`. Codex was right that
  the artifacts disagreed. I revised the **spec** rather than the code: `--delay N` is a
  statement about *when* to deliver, and enforcing request-order would make the flag
  silently not mean what it says. The spec now states the narrow guarantee, the
  no-interleave property, and the deliberate exclusion separately (`e0ff15ad`).
- **iter5 — the mid-flush window.** `flush()` drops a session's queue as soon as it has
  scheduled its writes, so `hasPending()` went false while `/clear` was still
  mid-delivery; a delayed `/arch-init` due in that window wrote *into* it. I had chosen to
  document this window; Codex correctly pushed back, and it was worse than I had assessed
  (the clear never executes at all). Fixed with `SendBuffer.busyUntil` **and** a busy-gate
  in `flush()` — both needed, and I only found the second because the new test failed with
  the first applied (`17db2e9e`).
- **iter6 — shutdown did not cancel due-but-not-started deliveries.** Clearing the `chains`
  map cannot cancel a callback already attached with `.then()`. Fixed with a generation
  guard checked inside the chain callback (`0d8ee648`).
- **iter7 — the guarantee comment had gone stale**, describing a limitation `busyUntil` had
  closed while omitting the residual that remains. Rewritten as COVERED / NOT COVERED /
  NOT GUARANTEED (`0eaf6689`).
- **iter8 — both reviewers APPROVE.** One papercut fixed: the `--delay` error echoed
  `NaN` instead of the user's raw input (`093f6781`).

## Nothing disputed

Every finding across these rounds was accepted. There are no false positives to rebut.

## The pattern, since it recurred

Three findings were the same mistake in different materials: a test asserting against a
copied predicate, a test asserting against a replica helper, a test asserting against a
synthetic callback — and then a *spec* asserting a guarantee the code did not make. Each
artifact described something *adjacent* to the real thing and passed self-review because
the artifact existed.

Three others were the same mistake in the code: correct about the mechanism, incomplete
about its lifetime. Serialising the callback but not its writes; guarding `hasPending` but
not `flush`'s own drain; clearing the registry but not the already-attached continuations.
Each worked for the case I was picturing and left the adjacent case open.

The check that catches both is the same one, and it is cheap: mutate the guard and confirm
the test fails. By the end of the phase I was running it before claiming a fix rather than
after being told — which is how the mid-flush test's vacuous first version got caught by
me instead of by a reviewer.
