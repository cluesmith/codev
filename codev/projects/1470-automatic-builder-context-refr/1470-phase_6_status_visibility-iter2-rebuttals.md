# Rebuttal — Spec 1470, Phase 6 (stalled-refresh visibility) iteration 2

**Verdicts**: Codex APPROVE (no issues) · Claude APPROVE (3 minor, none blocking).

**All three minors accepted and fixed**, one of them because it is a real defect I introduced and
Claude was too generous in calling minor.

Claude verified the iteration-1 fixes by running its own mutation check rather than trusting my
rebuttal — stubbing `stalledRefreshes()` to `[]` and confirming the warning test failed. That is the
right level of scepticism about a builder's claim that a fix landed, and it is worth noting that it
was the *reviewer* who did it unprompted.

---

## Claude — the acknowledgment can make `porch next` fail *(accepted; the important one)*

> the acknowledgment `writeStateAndCommit` adds commit+push to the previously git-free normal path
> and can throw

Correct, and I think this is understated as a minor. I added the first git IO to the normal
task-emission path, for a **purely informational** record. `writeStateAndCommit` runs `add` +
`commit` + `push` and throws on failure, so after my change a transient push failure meant `porch
next` returned an error and a builder could not get its next task — because a *visibility* record
could not be filed.

The severity is genuinely low in the way Claude describes (the state write precedes git, so a retry
finds nothing outstanding and proceeds). But low-severity-in-practice is not the point. The shape is
wrong: **bookkeeping must never gate the work it is bookkeeping for.** The spec's own posture is
that a refresh never gates the phase's normal work, and I had just violated it in the one place
where the violation would be invisible until a bad network day.

**Fixed**: the acknowledgment write is wrapped in `try`/`catch` — the only deliberately swallowed
error in `next()`, with a comment saying why it is right *here* and nowhere else. Losing the write
is cheap and self-healing; the boundary stays unacknowledged and the next pass retries. The worst
case of a persistent failure is a stall warning for a builder that is fine, which is the safe
direction for this particular signal to fail in.

**Tested**, and this is the part that makes it real: a new test forces `writeStateAndCommit` to
throw and asserts that `next()` still returns tasks *and* that the boundary stays unacknowledged so
the retry is genuine. Without that second assertion the test would pass equally well against a
version that swallowed the failure by marking it acknowledged anyway — which would lose the record
silently, the worse fix.

This is the same class as the previous phases' findings, one layer up: I reached for the existing
helper (`writeStateAndCommit`) because it was what every other write site used, without noticing
that **every other write site was on a path where failing loudly was correct**. The helper was right;
the context was different, and I did not check the context.

## Claude — `--json` docstring not updated *(accepted)*

Fourth instance of prose drift on this project. Fixed: the docstring now describes all three new
fields and records that fields are *added*, nothing removed or retyped — which is the property a
consumer of `--json` actually needs to know.

## Claude — acknowledgment semantics are coarser than the comment implies *(accepted)*

Any normal-path pass acknowledges every outstanding boundary. So a builder that refuses the refresh
and simply runs `porch next` reads as healthy, as does a stall a human recovered by hand.

Claude's own conclusion — "not worth changing; worth saying" — is right, and the reason is that
porch has exactly one piece of evidence available: a builder asked for work. It cannot distinguish
"cleared and came back" from "never cleared" from "was rescued". Inventing a distinction the system
cannot observe would be worse than admitting the limit.

**Fixed** by documenting it, including the narrow honest reading of the signal: *no builder has
asked for work since this boundary was recorded.* That is weaker than "the refresh succeeded" and it
is what the field actually means.

---

## Net

1 real defect fixed with a discriminating test (acknowledgment can no longer gate normal work),
2 doc corrections. Phase file 23 → 24 tests. Full suite green.

**Carrying into Phase 7**: the reusable lesson is not "wrap writes in try/catch" — it is that
*reusing the established helper imports the established failure policy*, and a policy that is
correct for every existing caller can be wrong for a new one. The question to ask at each reuse is
not "is this the right helper" but "is failing the way this helper fails the right behaviour here".
