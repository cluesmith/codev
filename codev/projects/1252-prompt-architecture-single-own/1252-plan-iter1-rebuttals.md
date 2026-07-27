# Plan 1252 — Rebuttal to iteration-1 plan review

| Model | Verdict | Confidence | Issues | Accepted | Disputed |
|---|---|---|---|---|---|
| Gemini | **APPROVE** | HIGH | 0 | — | 0 |
| Codex | **REQUEST_CHANGES** | HIGH | 3 | 3 | 0 |
| Claude | **APPROVE** | HIGH | 0 blocking (3 minor) | 3 | 0 |

**I dispute nothing.** Codex's first two are genuine under-deliveries against
criteria I wrote myself; the third is a factual error I should not have made.

Notably, all three reviewers verified the plan's technical claims directly
against the tree, and Codex's third point is the only claim that failed — which
is a useful signal about where my errors cluster: not in analysis, but in
restating details I had verified *earlier* and then paraphrased from memory.

---

## Codex (REQUEST_CHANGES) — all three accepted

### CX-1 — "M10 is not fully covered in Phase 4"

> *The spec requires post-deletion resolver equivalence **and** that the
> assembled spawn prompt is byte-identical to the skeleton-sourced expectation.
> Phase 4 currently plans only per-file `resolveCodevFile` equivalence; Phase 8's
> T13 checks prompt contents/presence, not byte-identical assembled output.*

**Accepted — the sharpest of the three.** M10 as I wrote it in the spec has two
clauses, and the plan implemented one. Worse, the gap was disguised: Phase 8's
T13 *looks* like it covers assembled prompts, so a reader could reasonably
conclude M10 was satisfied across two phases when neither actually asserted
byte-identity.

The distinction matters more than it first appears. **Per-file resolution can be
correct while assembly still differs** — template ordering, `{{project_id}}`
interpolation, or a fragment picked up from a different resolver tier would all
pass the per-file check and still change what a builder receives. The entire
claim of Phase 4 is that deletion is a *no-op for what agents actually see*, and
only byte-identity demonstrates that.

**Changed** — Step 4d now ships both halves:

- **(i)** per-file `resolveCodevFile` equivalence (as before);
- **(ii)** assembled-prompt byte-equivalence: snapshot each protocol's spawn
  prompt on the pre-deletion tree, commit the snapshots as fixtures, assert
  post-deletion assembly is byte-identical.

I also stated why (ii) is not redundant with Phase 8's T13: **T13 asserts
content presence after compression and dedup have deliberately changed the
text; Step 4d(ii) asserts nothing changed at all.** Different phases, opposite
expectations — worth writing down so a later reader doesn't collapse them.

### CX-2 — "Phase 5 vs Phase 8 ownership of CLAUDE.md/AGENTS.md is blurry"

> *Phase 5 says canonical scar strings are replaced on every required surface,
> which should include CLAUDE.md/AGENTS.md if they are in `must_appear_on`;
> Phase 8 then says to apply Phase 5's compressed scar wordings there. Right now
> the phase boundaries imply M5 is delivered before all surfaces are actually
> updated.*

**Accepted.** Both statements were in the plan and they contradict each other.
Read one way, Phase 5 finishes the job and Phase 8 redundantly repeats it; read
the other, Phase 5 skips the two most important surfaces and still claims M5.
The second reading is the dangerous one, because **M5's whole purpose is to be
green before Phase 7 starts stripping text** — if CLAUDE.md and AGENTS.md were
still un-rewritten at that point, the protection would have a hole exactly where
the most-read scar rules live.

**Changed** — the boundary is now explicit in both places:

- **Phase 5 owns every scar-wording edit, on every surface, no exceptions** —
  including CLAUDE.md and AGENTS.md, with the N3 byte-identical pair invariant
  maintained *within* Phase 5.
- **Phase 8 does not re-apply scar wordings.** It parity-checks N3 and lands the
  separate Phase 7 dedup edits.

### CX-3 — "`scaffold.test.ts` has `copyRoles` coverage and no `copyProtocols` cases"

**Accepted — my error, and one I had already disproved.** During the spec phase I
grepped for callers and recorded in the iteration-1 spec rebuttal that
"`copyProtocols` has no references at all outside its definition." Then I wrote
the plan and paraphrased it as "plus their `scaffold.test.ts` cases," implying
both had coverage.

Not consequential on its own — a builder would discover it in seconds — but it
is precisely the failure mode this project exists to fix, in miniature: a fact
verified once, restated from memory later, and drifting in the restatement.

**Changed** — the plan now names the exact scope: the `copyRoles` describe block
(~`scaffold.test.ts:156–195`) is removed; `copyProtocols` has no test cases.

---

## Claude (APPROVE) — three minor points, all accepted

### CL-1 — Phase 2's audit document must be machine-parseable for T11

> *T11 validates row counts and classifications. The plan shows a markdown table
> but doesn't state it must be parseable. A builder who writes free-form prose
> would make T11 unfeasible.*

**Accepted**, and worth more than "minor." I specified a test that parses a
document and then described the document loosely. A builder following the plan
literally could produce something T11 cannot read, and the natural fix under
deadline pressure would be to weaken T11 — quietly removing the guarantee that
no shadow copy was deleted unaudited, which is the single most important
safeguard in this plan.

**Changed** — the table is now specified as a fixed five-column pipe table, one
row per file, with `Classification ∈ {rot, local-unique}` and
`Terminal state ∈ {TS1, TS2, TS3, TS4, pending}`. Narrative commentary goes
below the table, never inside it.

### CL-2 — Phase 7's reference format unspecified

**Accepted.** "Replace with a one-line reference" left the actual shape to the
implementer.

**Changed** — an example is given, plus the reasoning behind the choice: a
**prose** reference (`> Plans contain no time estimates — see
\`spir/protocol.md\` § Plan.`) rather than a machine pointer, because the
consumer is a model reading the assembled prompt and it must be able to act on
the reference *without* resolving it. The per-class string is recorded in the
map's `references` field so T7 can verify placement.

### CL-3 — `.mjs` breaks the TypeScript convention

**Accepted.** → `scripts/extract-instruction-candidates.ts`.

---

## Gemini (APPROVE)

No issues raised. Two things worth recording because they were discretionary
calls of mine rather than spec requirements, and both survived outside scrutiny:

- **Phase 5 placement** (scar compression *after* shadow-tree removal). Gemini
  reviewed the rationale explicitly and confirmed it "satisfies all spec safety
  invariants."
- **`M11 → M3 → M8`** ordering confirmed as respected.

---

## Summary of changes

| Change | Driver |
|---|---|
| Step 4d gains assembled-prompt byte-equivalence with pre-deletion snapshots | CX-1 |
| Stated why 4d(ii) differs from T13 (nothing-changed vs content-present) | CX-1 |
| Phase 5 owns all scar edits incl. CLAUDE.md/AGENTS.md; Phase 8 parity-checks only | CX-2 |
| Scaffold test scope corrected to `copyRoles` only | CX-3 |
| Phase 2 audit table specified as machine-parseable with enumerated values | CL-1 |
| Phase 7 reference format + rationale | CL-2 |
| `.ts` instead of `.mjs` | CL-3 |

## Status

Plan updated and committed. Proceeding to the `plan-approval` gate.

Nothing in this round changed the phase structure, ordering, or scope — all six
points were about specifying existing phases more precisely. The eight phases,
their dependencies, and the B → A → C sequencing stand as approved at spec time.
