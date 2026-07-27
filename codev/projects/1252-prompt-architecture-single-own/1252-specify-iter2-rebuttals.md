# Spec 1252 — Rebuttal to iteration-2 review feedback

Iteration-2 reviewed the spec as amended with architect decisions **D1–D4**.

| Model | Verdict | Confidence | Issues | Accepted | Disputed |
|---|---|---|---|---|---|
| Gemini | **APPROVE** | HIGH | 0 (1 suggestion) | 1 | 0 |
| Codex | **REQUEST_CHANGES** | HIGH | 2 | 2 | 0 |
| Claude | **APPROVE** | HIGH | 0 blocking (3 minor) | 3 | 0 |

**I dispute nothing.** Both of Codex's issues were real holes in criteria I
wrote, and one of them would have let the central deliverable pass its own tests
while being substantially incomplete.

Round-over-round: iteration 1 drew 9 issues; iteration 2 drew 6, of which 2 were
blocking and 4 were presentational. The blocking pair are both *"your enforcement
mechanism has a hole,"* not *"your analysis is wrong"* — the empirical basis was
re-verified independently by both Codex and Claude and held up.

---

## Codex (REQUEST_CHANGES) — both accepted

### CX-1 — "Ownership-map completeness is not testably defined"

> *M1 says the map gives every instruction class a single owner, but the spec
> does not define how the implementation proves the map is exhaustive rather
> than selectively listing a subset. M4 only validates entries that are already
> in the map.*

**Accepted. This is the most valuable finding of the round**, and it exposes a
circularity I built into my own enforcement.

M4/T7 iterate over the map's entries and check each has one owner. That is
trivially satisfiable: a map containing three instruction classes out of forty
passes cleanly. The tests would have been green, the artifact would have looked
rigorous, and the single-owner rule would have covered a fraction of the surface
with nothing anywhere signalling the gap. **The enforcement measured only what I
had already told it about** — precisely the failure mode this whole spec exists
to attack, reproduced inside the fix.

**Changed** — M1 gains a completeness rule with four parts:

- **Declared inventory boundary.** The map names the exact file set scanned for
  candidates. Content outside it is out of scope *by declaration* rather than by
  omission — the distinction that makes exhaustiveness checkable at all.
- **Mechanical candidate extraction** over that boundary, collecting normative
  statements (`MUST`, `NEVER`, `ALWAYS`, `DO NOT`, `don't`, …), each with a
  stable id.
- **Mandatory disposition**: every candidate is exactly one of `mapped`, `scar`,
  or `out-of-scope` **with written justification**. There is no fourth state and
  no silent omission.
- **T12** fails on any undispositioned candidate. Adopting Codex's own suggested
  formulation nearly verbatim, since it was the right one.

The durable benefit is that new normative text added anywhere inside the
boundary fails CI until dispositioned — so the map cannot rot as the prompt
surface grows, which is the same drift disease at the level of the fix.

**One addition Codex did not ask for**: T12 must itself be validated against a
*seeded* normative line. A completeness test that runs against an empty
candidate set passes vacuously and looks identical to a healthy one. Having just
been caught by one vacuous-pass hole, adding another would be careless.

### CX-2 — "The final state for escalated `local-unique` shadow files is under-specified"

> *M11 correctly blocks overwrite/delete until architect review, but the spec
> does not clearly state whether this feature can still be considered complete
> if any shadow files remain after escalation. Define the permitted terminal
> states explicitly.*

**Accepted.** I specified the escalation *trigger* and the *prohibition*
(nothing local-unique is destroyed pending a ruling) but never said what
happens afterwards. "Escalate to the architect" is a transition, not a
destination, and a criterion whose end state is undefined cannot be judged
complete or incomplete.

**Changed** — M11 gains four explicit terminal states:

| # | Terminal state | Applies to | Result |
|---|---|---|---|
| **TS1** | Reconciled to skeleton, then deleted | `rot` | Skeleton sole owner |
| **TS2** | Promoted — content moved *into* the skeleton, local copy deleted | `local-unique`, keep **and** share with adopters | Skeleton sole owner; functionality preserved for everyone |
| **TS3** | Retained as a deliberate documented local override | `local-unique`, keep **codev-only** | Stays in `codev/`, in the ownership map *and* the M2 allowlist |
| **TS4** | Dropped | `local-unique` judged obsolete | Deleted, ruling recorded |

Plus three rules Codex's question implies:

- **"Pending escalation" is explicitly NOT terminal.** Naming it as a
  non-state is what makes the completion rule enforceable.
- **Completion rule**: all 76 shadow copies in TS1–TS4, **zero open
  escalations**. So yes — every escalation resolves within this spec.
- **Escape hatch**: if a ruling genuinely cannot be obtained, the item converts
  to **TS3** and a follow-up issue is filed. This is deliberate. Requiring
  resolution with no escape would let one unanswered question block the whole
  project indefinitely; TS3 is the conservative outcome (nothing is lost) and
  guarantees a defined end state either way.

I also flagged **TS2 as preferred** over TS3 for genuine codev-specific
functionality. TS3 knowingly re-creates a shadow copy — single, documented,
allowlisted, but still a shadow copy — and should stay exceptional, or the spec
quietly rebuilds the thing it removed.

---

## Gemini (APPROVE) — suggestion adopted

### G-1 — Adjudication allowlist lifecycle

> *Ensuring the allowlist requires line-item justification comments and
> enforcing that it decays to empty after M3 completion (except for open M11
> escalations) will prevent allowlist rot over time.*

**Adopted.** I had logged allowlist accretion as a risk and written "empty at M3
completion" as an *expectation*. Gemini is right that an expectation is not a
mechanism — the allowlist is the obvious way to re-hide drift, so its decay must
be enforced.

**Changed** — M2 gains an explicit lifecycle: line-item justification comments
required; the test asserts the allowlist is **empty once M3 completes**; the
sole permitted residue is files with an open M11 escalation, each citing its
pending adjudication. An entry outliving its escalation fails the build. This
also ties M2 and M11 together, so an abandoned escalation cannot quietly become
a permanent exemption.

Gemini also specifically endorsed the **M11 → M3 → M8** sequencing and the
scar-integrity chain (M5/T6 green before Approach C begins). Both were
builder-originated additions, so independent validation is worth recording.

---

## Claude (APPROVE) — three minor points, all accepted

### CL-1 — T11/T12 ordering non-sequential

**Accepted.** I inserted T12 above T11 when adding the local-unique test.
Renumbered: **T11** local-unique audit, **T12** ownership-map completeness,
**T13** end-to-end. All cross-references corrected — the risk table (two rows)
and Approach C's mitigation line, which still pointed at T9 from an earlier
revision.

### CL-2 — T11 should clarify automated-vs-manual expectation

**Accepted**, and worth more than its "minor" label.

**Changed** — now **T13**, split explicitly:

- **(a) Automated, in CI**: assemble the spawn prompt in-process; assert the
  verify-phase instructions and all eight compressed scar rules are present.
- **(b) Manual, once**: actually spawn a builder and read what it receives.

The reason for keeping (b) despite (a): **part (a) can pass while the real spawn
path diverges** — an in-process assembly test and the live spawn can read
different files. That is exactly the failure that produced this project, where
the served builder prompt lost its Verify Phase section while everything else
looked fine. An ambiguous "inspect the prompt" instruction would likely have
collapsed into (a) alone.

### CL-3 — Q7 should be required M1 coverage, not a trailing nice-to-know

**Accepted.** Q7 asked whether `codev/resources/` joins the drift regime. The
answer is no — user-evolved files where divergence is legitimate, and
`FRAMEWORK_DRIFT_DIRS` already excludes `resources`. But Claude's point is that
an unrecorded correct default is indistinguishable from an oversight, and the
next person to touch `FRAMEWORK_DRIFT_DIRS` has nothing telling them the
exclusion is deliberate.

**Changed** — Q7 moved out of nice-to-know and resolved into **M1**: recording
*why* `resources/` is excluded is now required map coverage, and M2's allowlist
must not accidentally cover those files.

---

## Summary of changes

| Change | Driver |
|---|---|
| M1 completeness rule — boundary, extraction, mandatory disposition | CX-1 |
| T12 ownership-map completeness, validated against a seeded line | CX-1 (+ builder) |
| M11 terminal states TS1–TS4; "pending" non-terminal; completion rule | CX-2 |
| M11 escape hatch — stalled escalation → TS3 + follow-up issue | CX-2 |
| M2 allowlist lifecycle enforced (justifications, decay, escalation-only residue) | G-1 |
| Tests renumbered T11/T12/T13; all cross-refs fixed | CL-1 |
| T13 split into automated (a) and manual (b), with rationale | CL-2 |
| Q7 resolved into required M1 coverage | CL-3 |
| Two risk rows: vacuous-map, stalled-escalation | CX-1, CX-2 |

## Status

No open questions remain. D1–D4 answered everything architect-owned; iteration-2
feedback is fully absorbed. Returning to the `spec-approval` gate.

The one judgement call worth the architect's eye is **M11's escape hatch**: I
chose "unresolved escalation → TS3 + follow-up issue" over "block until
answered." That trades a small amount of residual shadow tree for a guarantee
that the project cannot stall on an unanswered question. If you would rather it
hard-block, that is a one-line change.
