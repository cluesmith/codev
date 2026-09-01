# Rebuttal — Spec 1470, Phase 7 (docs and parity) iteration 1

**Verdicts**: Codex REQUEST_CHANGES (1) · Claude APPROVE (3 minor).

**All four accepted, no disputes.** One of them is a root-cause finding that makes my own fix look
like the symptom-patch it was.

---

## Claude, minor #1 — the skeleton still emits the bug I just fixed *(accepted; the important one)*

> Skeleton `protocol.json` files still use `../../protocol-schema.json`; `../` would resolve in both
> the skeleton tree and the `codev/protocols/` layout, closing the trap that produced this bug in
> our own tree.

Correct, and understated as a minor. I traced it rather than taking it on faith, and the mechanism
is worse than "inconsistent paths":

`copyProtocols` (`lib/scaffold.ts:480`) copies `codev-skeleton/protocols/*` into a project's
`codev/protocols/`, including the top-level `protocol-schema.json` that sits **inside** `protocols/`.
It does **not** copy the skeleton's *root-level* schema. So `../../protocol-schema.json`:

| Location | Resolves to | Exists? |
|---|---|---|
| `codev-skeleton/protocols/spir/` | `codev-skeleton/protocol-schema.json` | yes |
| a scaffolded `codev/protocols/spir/` | `<project>/protocol-schema.json` | **no** |

That is not an analogous bug — it is *the* bug. Our nine broken files are what the skeleton produces
when scaffolded, and every adopter's project has been getting them the same way.

**This is my own recurring failure one level up.** I have been repeating "fix the class, not the
instance" all project, and I did widen the plan's one-file fix to all nine — then stopped at the
boundary of our tree without asking where the nine came from. The class was never "nine files". It
was "the generator".

**Fixed**: the skeleton's nine now use `../`, which resolves in the skeleton (it carries a schema at
`protocols/` too) *and* in every scaffolded layout.

**The test is the part worth defending.** Asserting `$schema` resolution *inside* the skeleton passes
with either path, because of that second schema copy — so an in-tree assertion cannot see this at all.
The new test drives the real `copyProtocols` into a temp directory and checks resolution in the
scaffolded result. Mutation check: reverting the skeleton to `../../` fails **exactly one** test —
the scaffold one — with in-tree resolution still green. That is the discriminator working.

## Codex — the CLI help omits the one real exception *(accepted)*

> says delayed messages survive Tower restart but does not name the sole exception: the Ctrl+C nudge
> from delayed `--interrupt` is dropped

Right, and it matters more than a wording nit because of how this phase started. I replaced a claim
that was flatly false with one that is true-but-over-broad, in the same help text, for the same flag.
Trading one imprecise claim for another is not a fix — and this phase exists *because* an imprecise
sentence in this exact string propagated into a spec Constraint.

**Fixed**: the help now names the exception.

### And the test I wrote for it was vacuous *(self-reported)*

My first assertion was `expect(read('cli.ts')).toContain('--interrupt')` — which passes on the
unrelated `--interrupt` option defined a few lines above the `--delay` one. Deleting the caveat
entirely changed nothing; the mutation check caught it, not review.

Ninth vacuous test on this project, and the second caught by mutation rather than by a reviewer. Now
scoped to the `--delay` option's own line, and re-verified: removing the caveat fails it.

## Claude, minor #2 — the stale-phrase scan was too broad *(accepted)*

A whole-file blocklist would fail on an unrelated, entirely legitimate "not persisted" elsewhere in
`cli.ts` or `types.ts` — and would report it as a stale delay claim, pointing the next reader at the
wrong thing. **Fixed**: the scan is scoped to each file's delay-describing region, with the anchor
itself asserted so the scoping cannot silently degrade into scanning nothing.

## Claude, minor #3 — spec test 39's coverage is split *(accepted)*

**Fixed** with a header comment recording the division: the Phase 1 boundary-config test owns schema
*content* parity (all three copies describe `context_refresh` identically); this file owns *structural*
parity (protocol directories, `$schema` resolution including through a real scaffold, skill copies,
the delay claim). Neither is complete alone, and a future reader deleting either would silently halve
the criterion.

---

## Net

1 root-cause fix reaching every adopter, 1 over-broad claim corrected, 1 vacuous test of mine
repaired, 2 test-quality corrections. 33 → 35 assertions, all mutation-checked.

**The lesson worth carrying**: I fixed nine files and called it the class-level fix. It was still the
instance — the class was the code that *writes* those nine. When a fix touches N copies of something,
the question is not "did I get all N" but "what produced them, and does it still".
