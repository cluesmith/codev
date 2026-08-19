# Rebuttal — Spec 1470, Phase 1 (boundary declaration) iteration 1

**Verdicts**: Codex REQUEST_CHANGES (one issue) · Claude APPROVE (no blocking issues, four
non-blocking observations).

**Accepted: all of them.** The one blocking issue is a real inconsistency, and three of the four
non-blocking observations were cheap enough to fix now rather than defer.

---

## Codex — `context_refresh: null` was accepted as "omitted" *(accepted; my error)*

Codex is right, and the reason it matters is that I violated my own stated principle.

The whole justification for this validator — written into its doc comment — is *reject rather
than ignore, because a silent no-op is the failure mode*. `"context_refresh": null` is an
**explicit configuration act** that would have silently declared nothing. It is the exact shape of
mistake the function exists to catch, and I let it through. All three schemas type the key as an
object, so `null` violates them too; runtime and schema disagreed.

Worth noting how this got in: I wrote a test that *codified* the wrong behavior
("yields no boundaries when the key is explicitly null"). The test passed, so nothing pushed
back. A test that asserts the wrong thing is worse than no test, because it converts an
oversight into an apparent decision.

**Changed**: only `undefined` means omitted. `null` now fails with
`context_refresh is null; omit the key entirely to declare no refresh boundaries` — naming the key
and saying what to do instead. The test is inverted to assert rejection.

**On the split verdict**: Claude's review described this same behavior neutrally ("`undefined`/
`null` → `undefined`, so the absent-key default is genuinely 'no refreshes'") without flagging it.
That is a description, not a defense, so there is no disagreement between the reviewers to
resolve — Codex simply looked at it against the schema and the stated principle, and was right.

---

## Claude — non-blocking observations

### 1. Skeleton protocols are never load-tested *(accepted; fixed now, not deferred)*

Correct and worth more than "non-blocking" suggests. The resolver hits `codev/` first, so
`loadProtocol(repoRoot, name)` never parses `codev-skeleton/protocols/*/protocol.json` — **and for
an adopter those skeleton copies *are* the shipped protocols.** A broken skeleton protocol would
ship undetected past a green suite.

Claude suggested deferring to Phase 7. I fixed it here instead: it is a real coverage gap in the
file I am already in, and Phase 7's parity test asserts *equality of blocks*, which is a weaker
guarantee than *parses successfully*.

**Changed**: a second loop copies each skeleton `protocol.json` into a temp root with no `codev/`
tier to shadow it, then loads it through the real `loadProtocol`.

### 2. `context_refresh: {}` is truthy while declaring nothing *(accepted; carried to Phase 2)*

Accurate. An empty object is accepted and produces a truthy value declaring no boundaries. Not
worth rejecting — it is not an unresolvable declaration, just an empty one — but Claude's actual
point is about Phase 2, and it is the right warning: **`isBoundaryDeclared` must inspect the
fields, not the object's presence.** Recorded in the builder thread as a Phase 2 constraint so it
is not rediscovered by a bug.

### 3. No `uniqueItems` on `on_enter` *(accepted; fixed in both layers)*

Taken, and taken one step further than suggested. Claude proposed `uniqueItems: true` in the three
schema copies; I added that **and** runtime rejection of duplicates. Fixing only the schema would
have left the editor and the runtime disagreeing about the same input, which is the precise
failure mode this phase exists to eliminate — the schema validates nothing at run time, so a
schema-only rule is advice, not a rule.

A duplicate resolves fine (Phase 2 uses set membership), so this is not a correctness fix; it is a
"say what you meant" fix. A boundary cannot fire twice on one transition.

### 4. Forward-compat of unknown-key rejection *(noted; no change)*

Claude flagged, explicitly for the record rather than as a request, that an older installed codev
loading a newer `protocol.json` carrying a future `context_refresh` key will hard-fail the whole
protocol. That is the deliberate fail-fast trade the spec requires, and I am leaving it. Recording
it here so the choice is on file rather than discovered later as a surprise.

The alternative — ignore unknown keys for forward compatibility — reintroduces exactly the silent
no-op that this phase's entire design rejects, and it would make a typo'd key indistinguishable
from a future one.

### Not flagged, correctly

Claude noted it did **not** raise the unresolved `$schema: "../../protocol-schema.json"` path,
since the plan assigns it to Phase 7. That is right, and it stays there.

---

## Verification after the changes

Re-ran the porch suite and the full package suite; build green. The `null` test now asserts
rejection instead of acceptance, and two new tests cover duplicate rejection and skeleton protocol
loading.

## Net

2 substantive changes (null rejection, duplicate rejection in both layers), 1 coverage gap closed
(skeleton protocols now actually parsed), 1 constraint carried forward to Phase 2 (`{}` is truthy —
test fields, not presence), 1 trade recorded on purpose (unknown-key fail-fast).

The lesson I am taking from the `null` miss: a test that encodes the behavior I happened to write,
rather than the behavior the design calls for, provides false assurance. Both reviewers read the
code against the *stated principle*; my test only read it against itself.
