# Rebuttal — Spec 1470, Phase 7 (docs and parity) iteration 2

**Verdicts**: Codex APPROVE (no issues) · Claude APPROVE (3 minor, none blocking).

Two minors fixed, one routed to follow-ups. No disputes.

Claude re-ran the scaffold mutation independently rather than accepting my rebuttal's claim that it
discriminates — the second time this project a reviewer has verified a fix instead of reading about
it, and the reason the iteration-1 root-cause fix can be trusted.

---

## Claude, minor #3 — a missing `protocol.json` would shrink coverage, not fail *(accepted)*

My `$schema` enumeration filtered on existence, so deleting a `protocol.json` would have quietly
removed its own test rather than failing one. Coverage evaporates; the run stays green.

**This is the vacuous-test disease in a new place**, and the detail worth recording is that I had
*already been thinking about exactly this failure* when I wrote the enumeration guard
(`expect(cases.length).toBeGreaterThanOrEqual(18)`). It didn't help. A floor catches "matched
nothing"; it does not catch "matched one fewer". **A bound is not a check** — it fails only in the
catastrophic case, which is the case least likely to happen quietly.

**Fixed**: `release` is excluded by name (it is genuinely `.md`-only) and every remaining protocol
directory is *required* to carry a `protocol.json`. Mutation-checked — removing
`codev-skeleton/protocols/spike/protocol.json` now fails three tests where it previously would have
reduced the count in silence.

## Claude, minor #2 — the region scan didn't cover skills *(accepted)*

`delayRegion` fell back to whole-file scanning for `SKILL.md`, so the false-positive protection I
added *in the same iteration* did not extend to whatever skill is added to `LIVE_DOCS` next.

Same shape as the fs-port consolidation in Phase 4: I fixed the behaviour for the files in front of
me rather than making it a property of the helper. **Fixed** by anchoring skills on their own
paragraph, so every entry gets a scoped region regardless of type. Mutation-checked: a stale claim
reintroduced into a skill's delay paragraph is caught.

## Claude, minor #1 — `codev-skeleton/protocol-schema.json` is now dead *(accepted as a follow-up)*

Correct: with the skeleton's protocols repointed at the `protocols/`-level copy, the root-level
schema is referenced by nothing and copied by nothing, kept alive only by the Phase 1 parity test.

**Not deleting it here.** It is out of this phase's scope, deleting a file on my own judgement is
not a call I should make, and the two schemas differ in content (draft 2020-12 vs draft-07) — so
"delete the unreferenced one" may be exactly backwards if the newer one is the intended direction
and the *protocols*-level copy is the stale one. That question deserves someone deciding it, not a
builder tidying up mid-phase.

Routed to the review's follow-ups as a MAINTAIN candidate, together with the pre-existing
two-divergent-schemas finding it is entangled with.

---

## Net

2 test-quality gaps closed and mutation-checked, 1 follow-up recorded. 35 → 53 assertions.

**The lesson**: both of my defects this iteration were cases where I had the right idea and stopped
one step short — a coverage guard that only catches total collapse, and a scoping helper that only
scopes the files I happened to list. Neither was an oversight about *what* to protect. Both were
about protecting it at the wrong level.
