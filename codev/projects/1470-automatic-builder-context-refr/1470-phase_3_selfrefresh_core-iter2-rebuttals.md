# Rebuttal — Spec 1470, Phase 3 (self-refresh core) iteration 2

**Verdicts**: Codex REQUEST_CHANGES (1 issue) · Claude APPROVE (0 blocking, 5 comments).

**All accepted.** Codex found a real bypass of the freshness gate — the single most serious defect
in this project so far, because it defeats the guarantee the whole handshake exists to provide.

---

## Codex — malformed challenge data bypasses the nonce freshness gate *(accepted; a real bypass)*

`runSelfRefresh` trusted `JSON.parse` output cast to `Challenge` and validated `nonce` by
truthiness alone.

**I verified the mechanism in node before changing anything**, rather than accepting the report on
its face:

```
![]                          === false   → an array nonce passes the truthiness check
'any content'.includes([])   === true    → String.includes coerces [] to ''
NaN > maxAge                 === false   → a non-numeric issuedAt defeats expiry
(now - futureTs) > maxAge    === false   → a future issuedAt defeats it too
```

All four confirmed. So a challenge containing `{"nonce": []}` did not *weaken* the freshness gate —
it **inverted** it. `content.includes('')` is true for every string, so any state file over the
size floor would pass as a fresh save and the builder would clear its context on arbitrary content.
Three distinct bypasses through one unvalidated parse.

**The root cause is worth stating precisely**, because it is not a missing `if`: casting
`JSON.parse`'s `any` to `Challenge` buys a **compile-time** guarantee about a **runtime** value
read off disk. TypeScript reported the shape as safe while nothing had checked it. Every gate
downstream then reasoned about a type that was never established.

**Changed**: `parseChallenge` validates the complete runtime shape at the trust boundary — a
non-empty *string* nonce, a *finite, non-future, numeric* `issuedAt`, correctly-typed `boundary`
and `consumedAt` — and returns a named reason rather than throwing. Tests cover each malformed
shape, and the array-nonce test asserts the coercion behaviour first, so it fails loudly if the
underlying JavaScript semantics ever change and the test stops meaning what it says.

**Scope note**: the driven path (`runReset`) needs no equivalent and did not get one. It mints its
nonce in-process and never reads one back from a file, so there is no trust boundary to defend.
Validation belongs exactly where a value crosses from file into logic, not sprayed across both
paths for symmetry.

---

## Claude — APPROVE, five comments, all taken

### 1. `JSON.parse` yielding `null` threw an uncaught TypeError *(closed by the same fix)*

Correct: `JSON.parse('null')` succeeds, and reading `.nonce` off it threw rather than aborting by
name — safe in outcome, but inconsistent with every other malformed-challenge path, and it would
have surfaced as a stack trace instead of a message telling the builder what to do. `parseChallenge`
rejects bare `null` and arrays explicitly, with tests for both.

### 2. Challenge-mark failure mislabelled, and silent about the queued re-entry *(accepted)*

Right on both halves. It reported `reentry-failed` — a different failure entirely — and said "your
context is intact" without mentioning that by that point a re-entry **is already queued**, so a
retry queues a second one.

Now `challenge-burn-failed`, with a message that states the context is intact *and* that a re-entry
is already inbound and can be ignored, *and* that retrying queues another. The test asserts the
disclosure, not just the code.

### 3. The stability window was asserted rather than measured *(accepted — the best of the five)*

I passed `msSincePrevious: stabilityWindowMs` as an article of faith. As Claude says, that means
the gate keeps passing even if the sleep never actually advanced the clock: two reads taken back to
back, claiming to be seconds apart.

Now the orchestrator measures real elapsed time across the sleep, and refuses a non-positive window
outright — a zero or negative window makes `msSincePrevious >= stabilityWindowMs` trivially true,
collapsing two observations into one and letting a file still being written pass as stable. The
test injects a **frozen clock** whose `sleep` advances nothing and asserts the run aborts, which is
the only way to prove the measurement is real rather than decorative.

This is the same failure shape as Codex's iteration-1 finding: a safety check whose evidence was
supplied by the thing it was supposed to check.

### 4. The save request omitted the size floor *(accepted)*

A terse-but-honest save would fail the ≥1000-byte gate, and — because a boundary is refreshed at
most once and never retried — the refresh would simply not happen, for a reason the builder had no
way to anticipate. The request now states the floor, explains it is a stub detector rather than a
word count to pad, and says plainly that a rejected save means no refresh occurs at all.

### 5. Happy-path log is a superset of spec test 30's literal sequence *(recorded, not changed)*

Accurate. Test 30 says "verify → assemble → write → schedule → clear"; the implementation logs
`challenge-read`, `worktree-checked`, `challenge-marked`, `clear-attempted` and
`challenge-consumed` as well. The required subsequence and its ordering **are** asserted; the extra
steps are gates the handshake demands and the `clear-attempted` split that iteration 1 required.
Recorded in the review artifact so a later reader does not score it as a miss.

---

## Net

1 bypass closed, 5 comments taken, 8 tests added (51 → 59). Full suite 5059 green.

Two of the last three reviewer findings share a shape worth naming, because I produced both: **a
safety check whose evidence came from the thing being checked.** Iteration 1's step log recorded
the clear only if the clear reported success. Iteration 2's stability gate was handed the gap it
was meant to verify. In each case the check was present, well-commented, and tested — and would
have agreed with a broken system. Asking "where does this check's evidence come from, and could the
failure I fear also corrupt it?" is the question that catches both, and it is now the one I apply
to Phase 4's real-port bindings.
