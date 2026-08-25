# Ad-hoc adversarial review of commit `1cad0ec75` — findings and response

**Why this exists.** Porch force-advanced Phase 3 at its iteration ceiling, so the two fixes in
`1cad0ec75` — the nonce-format validator and the Gate 0 parameter matrix — shipped without a CMAP
round. The architect ruled against a porch rollback and ordered an ad-hoc consult outside porch
instead, scoped to that commit alone and framed adversarially: *can the nonce gate still be
satisfied by a degenerate save, and can any safety parameter still be silently disabled?*

Reviewers: Codex and Claude, both with repo access. Their raw outputs are gitignored like every
other consult output in this repo; this document is the committed record, following the same
convention as the per-iteration rebuttals.

**Headline: both reviewers confirmed the two fixes work and that the tests are not vacuous —
Claude mutation-checked each one individually — but the fixes prove weaker properties than they
advertised. Five real defects came out of it, one of which I would otherwise have shipped.**

---

## The one that mattered — echoing the save request back passed every gate

*(Claude F1, HIGH; Codex #4 independently)*

`buildBoundarySaveRequest` is roughly 2KB and **contains the nonce marker**, because it tells the
builder which marker to reproduce. So:

```
cp <the request text> .builder-state.md
```

gave: nonce present ✓, over the 1000-byte floor ✓, size stable across the window ✓ →
`receipt-accepted` → `/clear`.

Two things make this the most serious finding of the project:

1. **It is not an attack.** An agent that mistakes its instructions for a template does this by
   accident, and agents echo instructions routinely. The gate would have destroyed a builder's
   context on a file containing none of its work.
2. **The fix was already written down and simply not enforced.** The request says the file *"MUST
   begin with this exact line"*. The gate accepted the nonce anywhere.

**Fixed** in the shared `verifyReceipt`: the nonce must appear on the **first line**.

Two deliberate choices in that fix:

- **Shared module, not just my path.** The driven path (`afx refresh`) had the identical bypass —
  its `buildSaveRequest` also contains the marker. Fixing mine and leaving theirs would have been
  the fix-the-instance-miss-the-class error I had committed to stopping one iteration earlier.
- **Still matched on the nonce TOKEN, not the exact marker string.** `verifyReceipt` deliberately
  tolerates altered comment spacing, with a comment explaining that discarding a real save over
  whitespace would be a false rejection of work that cost the builder real effort. I verified the
  existing tolerance test keeps its marker on line 1, so the contract survives intact. The full
  suite confirms: no driven-path test regressed.

## The boundary guard was inert in production

*(Codex #10)*

The porch task text said `afx self-refresh --begin` with **no `--boundary`**. So the challenge
carried no boundary, and the guard built in Phase 3 and wired in Phase 4 never engaged in the real
flow.

My tests passed because they supplied `expectedBoundary` directly — they exercised the CLI but not
the **instructed workflow**. That is a category of gap worth naming: a feature can be correct at
every layer I tested and still never run, because the thing that invokes it in production is a
string in a task description that no test reads.

**Fixed**: the task text passes `--boundary` on both commands, and explains why.

## `--delay 0.001` reached Tower

*(Claude F5, HIGH)*

`positiveInt` accepted fractions despite its name, so `deliverAfter: 0.001` went straight through.
The re-entry and the `/clear` then race for the same clean prompt; if the render gate opens first,
the re-entry is delivered and immediately wiped — **a cleared builder with no re-entry and nobody
coming back**, which is precisely the outcome the schedule-before-clear ordering exists to prevent.
Reachable from the CLI in one flag.

**Fixed**: safety flags require whole numbers at or above real floors (`--min-bytes` ≥ 200,
`--stability-window` ≥ 500ms, `--delay` ≥ 5s), validated at the CLI **and** again in the core.

## Validity is not sanity

*(Claude F6, Codex #7)*

Gate 0 checked "finite and positive", which is validity. `--min-bytes 1` reduces the substance gate
to "contains the nonce" (~12 bytes); `--stability-window 1` makes the sleep a single event-loop
tick, which detects nothing. Both pass a positivity check while neutering the gate they configure.

**Fixed** by the floors above. Hard floors rather than warnings: a warning on a safety parameter is
a warning nobody reads in an unattended run.

## An unbounded nonce satisfies the size floor by itself

*(Codex #1)*

`^[0-9a-f]{12,}$` had no ceiling, so a multi-kilobyte nonce would make a state file containing
*only the marker* clear `minBytes`. **Fixed**: ceiling of 128 hex characters.

## A forward clock step could spoof the measured gap

*(Claude F8)*

`Date.now()` is not monotonic. An NTP step forward inside the window makes the measured elapsed
time satisfy the stability check when no real time passed — spoofing the measurement that was
introduced one iteration earlier precisely to stop the gap being *asserted*. Backwards is already
fail-safe.

**Fixed**: `performance.now()` for the measurement, `Date.now()` retained for `issuedAt`, which is
compared across processes.

## Distinct failure code for a configuration error

*(Claude F7)*

Gate 0 reused `receipt-rejected`, so a bad `--min-bytes` told the builder its **save** was the
problem. New `invalid-parameters` code. Claude noted this was the one lapse in an enum that is
carefully differentiated everywhere else, which is a fair reading.

---

## Test gaps closed

- **Anchors were unpinned.** Mutating `^[0-9a-f]{12,}$` to drop its anchors left all six format
  tests green, because `zzzzzzzzzzzz`, `ABC123DEF456` and `abc123def45` contain no valid 12-hex
  run. Added `'abc123def456\n'`, `' abc123def456'`, `'abc123def456 OR ANYTHING'` and a leading
  prefix — these pin the anchors rather than the character class.
- **Gate 0's position was unpinned.** Every parameter test seeded a valid challenge first, so Gate 0
  could have drifted below the challenge read unobserved. Added a test with bad parameters and *no
  challenge*, asserting `invalid-parameters` wins — plus one asserting a parameter error leaves the
  step log empty, writes nothing, schedules nothing, and leaves the challenge intact for a
  corrected retry.
- **Echo and append cases** now covered directly, including the positive case that a differently
  spaced marker on line 1 is still accepted.

Core file: 59 → 92 tests. Command file: 33 → 37. Full suite 5129 passing, build green.

---

## Accepted but deliberately NOT fixed

- **`sizeOf()`/`read()` TOCTOU in `verifyReceipt`** *(Codex #5)*. Real, but the realistic instance
  is a file growing mid-write between the two calls — which the two-observation stability gate
  already catches. Closing it properly means measuring bytes from the content actually read, a
  change to shared behaviour with no demonstrated failure behind it.
- **A predictable-but-well-formed nonce** *(Codex #2)*. `generateNonce()` uses `randomBytes`; a
  predictable nonce requires a hand-written challenge file, which is outside the honest-builder
  threat model this gate serves. The gate exists to catch a builder that wrote a stub or crashed
  mid-write, not one attacking itself.
- **`runReset` logs its clear after sending it** (`index.ts:540`). The same weakness Codex found in
  my path at iteration 1. It belongs to the driven path, which this project does not own; recorded
  as a follow-up rather than fixed silently.

## What I take from this

The two findings that hurt are the ones where **the tests were fine and the thing they tested was
not the thing that runs**. The echoed-request bypass passed every gate I had written *and* every
test I had written, because both were reasoning about a file that contains the nonce rather than a
file that answers the request. The inert boundary guard was correct at three layers and never
invoked, because production calls it through a string in a task description that no test reads.

Coverage measured against my own implementation cannot find either. Only someone asking "what would
a real builder actually do here?" finds the first, and "what does the thing that calls this actually
pass?" finds the second.
