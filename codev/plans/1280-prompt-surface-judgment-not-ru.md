# Plan: Prompt surface — judgment-not-rules rewrite (principle conformance)

## Metadata
- **ID**: plan-2026-07-31-prompt-surface-judgment-not-rules
- **Status**: draft (CMAP round 1 incorporated)
- **Specification**: [codev/specs/1280-prompt-surface-judgment-not-ru.md](../specs/1280-prompt-surface-judgment-not-ru.md)
- **Created**: 2026-07-31
- **Issue**: #1280 (charter amended 2026-08-01: acceptance = principle conformance, size reporting-only)

## Executive Summary

Approach 1 from the spec: **in-place principle rewrite, surface by surface**, keeping file
layout, the four-tier resolver, and porch untouched. Approach 2 is rejected twice over — it
changes porch behaviour and defeats M11, since the architect cannot inspect old-vs-new diffs of
files that no longer exist as authored artifacts.

**The binding constraint is M11, not the writing.** The architect inspects the old-vs-new diff of
every changed file, in batches of ≤12. Phase boundaries are drawn by *inspection load*.

**Decision count: 67** (the spec says "~66"; **67 is the correct figure** and both CMAP reviewers
independently reproduced it — readers should not have to re-derive it):

| Category | Count | Notes |
|---|---:|---|
| `protocol.md` | 10 | 9 skeleton + `release` (codev-local, no twin) |
| `builder-prompt.md` | 9 | `release` has none |
| `prompts/*.md` | 18 | spir 4 · aspir 4 · pir 3 · bugfix 3 · air 2 · maintain 2 |
| `templates/*.md` | 8 | spir 3 · experiment 1 · maintain 1 · spike 1 + 2 maintain codev-local |
| `consult-types/*.md` | 18 | spir 5 · aspir 5 · pir 2 · bugfix 2 · air 2 · maintain 2 |
| `roles/*.md` | 3 | architect · builder · consultant |
| `CLAUDE.md` + `AGENTS.md` | 1 | one decision, two byte-identical files |
| **Total** | **67** | |

### Review batch — defined, because "one phase = one batch" was false

A **review batch** is *every distinct file the architect reads in one sitting* — prompt
decisions **plus** the supporting test files, registry, retirements entries and manifest that
ride along. A phase may contain **more than one batch**; each batch is ≤12 and is reviewed
before the next begins. Phases below declare their batches explicitly.

### Rollback groups are commit-pure, phases may span groups

Phases are drawn by inspection load, so a phase can touch several rollback groups. The
invariant is at the **commit** level: **every commit belongs to exactly one group**, so any group
reverts cleanly regardless of which phase produced it. Each phase declares its groups; T10
rehearses **every group the project touched**, not a sample. (CMAP round 1 correctly found the
first draft's group mapping was wrong — Phase 1 claimed G2/G6 while also rewriting
`roles/builder.md` (G3) and `roles/consultant.md` (G5).)

**M6's dead-tree deletion is assigned to G4** (phase surfaces), which owns the `prompts/` axis.

### Two mechanisms that must be settled before the work they gate

**1. P6 delivery of `protocol.json` (gates Phase 3).** Verified: `protocol.md` is inlined at
spawn via `{{protocol_reference}}` (`spawn-roles.ts:112-124`), but **`protocol.json` is inlined
nowhere** — `spawn-roles.ts:267` only reads it for validation. In a fresh adopter project
`codev/protocols/<p>/protocol.json` does not exist on disk; it resolves from tier 4. So a prose
instruction "read `protocol.json`" is exactly the fetch-by-path of a framework file that
CLAUDE.md forbids and the spec's own constraint restates.

**Decision: deliver it through the existing include resolver.** `resolveCodevIncludes`
(`skeleton.ts:108-119`) is **extension-agnostic** — verified — so `protocol.md` carries a fenced
```` ```json ```` block containing `{{> protocols/<p>/protocol.json}}`. This resolves through all
four tiers, works in fresh installs, requires **no porch change**, and is the literal expression
of P6 ("rich references"). Cost, stated honestly: it adds the JSON back as served words (spir
570, aspir 568, pir 375, others 77–282) — acceptable because size is reporting-only under the
amended charter, and it replaces narration with authoritative structured truth.
**Tested in both strict mode (porch-driven) and soft mode (builder reads `protocol.md` with no
porch)** — the asymmetry matters: strict-mode builders receive checks and gates as porch tasks,
soft-mode builders have only the prompt.

**2. Skill relocation is a FOUR-tree sync (gates Phase 1).** Verified: skills exist in
`.claude/skills` (10), `.codex/skills` (10, **byte-identical** to `.claude`),
`codev-skeleton/.claude/skills` (7) and `codev-skeleton/.codex/skills` (7) — with **existing
drift** (`afx`, `porch` differ repo-vs-skeleton; `forge`, `skill-creator`, `team` are absent from
the skeleton). Consequences if unaddressed: content relocated out of CLAUDE.md into one copy
leaves **Codex agents without it**, leaves **adopters without it** after `codev update`, and is
reported as **deleted** by M0c/T15 — inverting the project's honesty artifact. Phase 0 widens
M0(g)'s basis to all four trees; Phase 1 adds **T17** (skills parity) and treats every relocation
as a four-copy write.

## Success Metrics

- [ ] **MP** — every file marked *rewritten* in the spec's disposition table conforms to
      P1, P2, P3, P4, P6, P7 (P5 N/A with reason), judged per file by the architect
- [ ] **M11** — architect inspected every changed file, in ≤12-file batches, with a complete manifest
- [ ] **M0 / M0b / M0c** — corrected instrument landed early as PR-1; deleted vs relocated reported
- [ ] **M1 / M2** — before/after figures and per-file counts published (no threshold)
- [ ] **M2b** — CLAUDE.md human-readable, architect-confirmed
- [ ] **M3** — every surface enumerated from disk rewritten and inspected
- [ ] **M4** — eight scar canonicals byte-identical; count pinned at 8
- [ ] **M5** — capability inventory over served prompt text; unlisted removals fail
- [ ] **M6** — dead tree deleted, Spec 987 test consumer handled
- [ ] **M7** — A/B SHIP verdict (verify phase)
- [ ] **M8** — behavioural baseline re-run (verify phase)
- [ ] **M9** — rollback rehearsed for every group touched
- [ ] **M10** — every retired prose-pinned assertion named with its originating spec
- [ ] **M12** — no release between merge and SHIP verdict (spans the verify phase)
- [ ] Suite green **at the end of every phase**, not only at the end

## Phases (Machine Readable)

<!-- REQUIRED: porch uses this JSON to track phase progress. Update this when adding/removing phases. -->

```json
{
  "phases": [
    {"id": "phase_0_instrument", "title": "Corrected instrument + frozen capability inventory (PR-1, ships early)"},
    {"id": "phase_1_shared_skills", "title": "CLAUDE.md/AGENTS.md + four-tree skill relocation (G2)"},
    {"id": "phase_2_roles", "title": "Three role files (G6, G3, G5)"},
    {"id": "phase_3_protocol_md", "title": "protocol.md x10 with the P6 include mechanism (G3)"},
    {"id": "phase_4_builder_prompts", "title": "builder-prompt.md x9 + M10 test-retirement burden (G3)"},
    {"id": "phase_5_prompts_heavy", "title": "Phase prompts: spir, aspir, pir (G4)"},
    {"id": "phase_6_prompts_light_spir_templates", "title": "Phase prompts: bugfix, air, maintain + spir templates (G4)"},
    {"id": "phase_7_templates_consult_spir", "title": "Remaining templates + spir consult-types (G4, G5)"},
    {"id": "phase_8_consult_types_a", "title": "Consult-types: aspir, bugfix, air (G5)"},
    {"id": "phase_9_consult_registry_deadtree", "title": "Consult-types pir/maintain + scar registry + dead-tree deletion (G5, G7, G4)"},
    {"id": "phase_10_integration", "title": "Capability verification, measurement report, rollback rehearsal, governance docs"}
  ]
}
```

## Phase Breakdown

### Phase 0: Corrected instrument + frozen capability inventory (PR-1, ships early)
**Groups**: G1 · **Batches**: 1 (script + ~6 test files + 3 artifacts ≈ 10)
**Dependencies**: None. **Ships as its own PR before any prompt rewriting** (M0b).

#### Deliverables
- [ ] `scripts/measure-prompt-surface.sh` corrected — all seven M0 items
- [ ] **M0(g) basis widened to all four skill trees** (`.claude/skills`, `.codex/skills`, and
      both `codev-skeleton/` copies) — otherwise relocation reports as deletion
- [ ] First tests for the script: **T1, T1b, T2, T3, T11, T12, T15**
- [ ] **T16** (manifest completeness) implemented **now** — it is the mechanical guard on M11,
      the project's binding constraint, and must exist before Phase 1 produces the first manifest
- [ ] **`codev/resources/1280-capability-inventory.json` extracted from the PRE-rewrite surface
      and committed** — M5 requires a frozen pre-rewrite baseline, and Phase 3 onward asserts
      against it
- [ ] `codev/resources/1280-word-baseline.md` — corrected, segmented pre-rewrite baseline
- [ ] In-place annotation of `1252-word-baseline.md` / `1252-word-after-phase7.md`
- [ ] **Manifest format defined** at `codev/projects/1280-*/manifests/phase-N.md`: one row per
      changed file — path · old words · new words · principles applied · one-line rationale

#### PR-1 operational mechanics
1. Cut `builder/1280-instrument` from the current branch point
2. Open PR-1, architect review, merge
3. `git fetch origin main && git checkout -b builder/1280-rewrite origin/main` — **never**
   `git checkout main` (a worktree cannot check out a branch checked out elsewhere)
4. Record: `porch done 1280 --pr <N> --branch builder/1280-instrument`, then
   `porch done 1280 --merged <N>`
5. Verify the rewrite branch contains **no duplicate Phase-0 commits** (`git log origin/main..HEAD`)

#### Acceptance Criteria
- [ ] T1, T1b, T2, T3, T11, T12, T15, T16 pass; output deterministic
- [ ] Pre-rewrite capability inventory committed and non-empty
- [ ] Architect reviews the batch; PR-1 merged; suite green

#### Rollback Strategy
Group **G1**. No prompt surface has changed.

---

### Phase 1: CLAUDE.md/AGENTS.md + four-tree skill relocation (G2)
**Groups**: G2 · **Batches**: 1 (CLAUDE+AGENTS, ≤6 skill files across 4 trees, 2 test files ≈ 10)
**Dependencies**: Phase 0 merged.

#### Deliverables
- [ ] `CLAUDE.md` + `AGENTS.md` rewritten (1 decision, 2 byte-identical files)
- [ ] Relocated how-to content written to **all four skill trees**, not one
- [ ] **T17 — skills parity**: `.claude/skills` ≡ `.codex/skills`; every skill present in the
      repo that the skeleton ships is in sync. Pre-existing drift (`afx`, `porch`) and
      skeleton-absent skills (`forge`, `skill-creator`, `team`) are recorded as known state, not
      silently "fixed" — but any skill this project *touches* must be four-way consistent
- [ ] All eight scar canonicals present byte-identically
- [ ] **M10 here, not Phase 4**: `spec-1273-wait-discipline-docs.test.ts:31` asserts on
      `.claude/skills/afx/SKILL.md` + `.codex/skills/afx/SKILL.md` — relocation into `afx` breaks
      it in **this** phase
- [ ] Manifest + architect review; suite green

#### Implementation Details
- Governing principles: **P3**, **P4**, **P1**.
- **Scar verification here is against the ratified source, not T4.** T4 and the registry are
  built in Phase 9, after the surface settles (Baked Decision 2). This phase verifies the eight
  canonicals byte-for-byte against `builder/spir-1252:codev/resources/scar-rules.yaml` directly.
  (CMAP round 1 caught the first draft asserting T4 in Phase 1 while creating it in Phase 8.)
- M2b: architect confirms CLAUDE.md is still navigable by a human.

#### Acceptance Criteria
- [ ] Eight canonicals verified against the ratified YAML; T7, T17 pass
- [ ] Architect judges the decision conformant; M2b confirmed
- [ ] Every touched assertion re-baselined with its originating spec named
- [ ] Suite green

#### Rollback Strategy
Group **G2**, commit-pure.

---

### Phase 2: Three role files (G6, G3, G5)
**Groups**: G6 (`architect`), G3 (`builder`), G5 (`consultant`) — **three commits, one per group**
**Batches**: 1 (3 decisions × 2 trees + 1 test ≈ 7)

#### Deliverables
- [ ] `roles/architect.md` rewritten (G6) — confirm nothing is load-bearing for multi-architect
      coordination (Specs 755/786/823) **before** cutting
- [ ] `roles/builder.md` rewritten (G3)
- [ ] `roles/consultant.md` — *inspected-but-unchanged (expected)*; rewritten only if inspection
      finds non-conformance (G5)
- [ ] **M10**: `spec-1273-wait-discipline-docs.test.ts:26` (`ROLE_DOCS` = `codev/roles/builder.md`
      + skeleton twin) breaks here
- [ ] Manifest + architect review; suite green

#### Rollback Strategy
Three group-pure commits: G6, G3, G5.

---

### Phase 3: protocol.md ×10 with the P6 include mechanism (G3)
**Groups**: G3 · **Batches**: 1 (10 decisions + include-mechanism test ≈ 11)
**Dependencies**: the P6 mechanism decision above.

#### Deliverables
- [ ] Ten `protocol.md` files rewritten (incl. `release`, codev-local, no twin)
- [ ] **P6 include mechanism implemented**: fenced ```` ```json ```` block containing
      `{{> protocols/<p>/protocol.json}}`
- [ ] **T18 — P6 delivery, both modes**: strict (porch-driven spawn resolves the include) **and**
      soft (a builder reading `protocol.md` with no porch still receives the structured source);
      asserted against a simulated fresh-install resolution where `codev/protocols/` is absent
- [ ] Manifest + architect review; suite green

#### Implementation Details
- `release/protocol.md` has no `protocol.json`; P6 does not apply — rewritten on P1/P3 alone.
- **P7**: delete worst-case padding except scar rules.
- Largest single cut in the project (`spir/protocol.md`, 3,703w); M5's contract-presence
  assertions against the Phase-0 frozen inventory are the primary defence.

#### Acceptance Criteria
- [ ] T5 passes against the **frozen pre-rewrite inventory** — every gate, check, signal and
      artifact contract still represented by name or resolvable reference
- [ ] T18 passes in both modes
- [ ] Architect judges all 10 conformant; suite green

---

### Phase 4: builder-prompt.md ×9 + M10 test-retirement burden (G3)
**Groups**: G3 · **Batches**: **2** — (A) 9 prompt decisions; (B) 4 test suites + retirements file
**Dependencies**: Phase 3 reviewed.

#### Deliverables
- [ ] Nine `builder-prompt.md` files rewritten *(batch A)*
- [ ] **M10 executed and enumerated** *(batch B)*: `baked-decisions.test.ts:139-148`
      (pure-addition diff on `protocols/{spir,aspir,air}/builder-prompt.md` — structurally
      incompatible with rewriting them), `bugfix-744-spir-pr-strategy.test.ts`,
      `bugfix-619-aspir-prompt.test.ts`, plus any `governance-sweep` / `framework-ref-audit`
      assertions touched
- [ ] `codev/resources/1280-retirements.md` entries with architect approval *(batch B)*
- [ ] Manifest + architect review of **both** batches; suite green

#### Implementation Details
For each assertion: name the originating spec, state whether the protected behaviour survives in
the rewritten prose, and either write the replacement assertion or record an architect-visible
retirement. Re-baselining a pure-addition baseline requires the originating spec named and the
new baseline committed **in the same commit**.

#### Risks
The highest-risk phase: silently gutting a prior spec's protection to make the suite green.
Mitigated by M10 being an explicit deliverable with architect sign-off per assertion, reviewed as
its own batch rather than buried among prompt diffs.

---

### Phase 5: Phase prompts — spir, aspir, pir (G4)
**Groups**: G4 · **Batches**: 1 (11 decisions)

#### Deliverables
- [ ] spir ×4, aspir ×4, pir ×3
- [ ] **M10**: `template-delivery.test.ts` if the include wiring is touched
- [ ] Manifest + architect review; suite green

#### Implementation Details
- **P2** is the lever; the `{{> …}}` template includes make each prompt ~600 words heavier than
  it reads. Templates themselves are rewritten in Phases 6–7.
- Two separate constraints, not to be conflated: porch's `REQUIRED_SPEC_SECTIONS` needs **4**
  headings (`checks.ts:149-154`); the `spec-review` consult type advisorily expects 20.
- `<signal>` tags are capability-inventory items — preserved or retired explicitly.

#### Acceptance Criteria
- [ ] T5 passes; porch checks pass on a scratch project driven specify→plan
- [ ] Architect judges all 11 conformant; suite green

---

### Phase 6: Phase prompts — bugfix, air, maintain + spir templates (G4)
**Groups**: G4 · **Batches**: 1 (10 decisions)

#### Deliverables
- [ ] bugfix ×3, air ×2, maintain ×2; spir templates `spec.md`/`plan.md`/`review.md` ×3
- [ ] Manifest + architect review; suite green

#### Implementation Details
- Lighter protocols are already closer to conformant (means 356–457w); **a file already
  conformant passes unchanged** under the acceptance model.
- **`plan.md`'s machine-readable phases JSON block is a CAPABILITY, not an example** — porch's
  `has_phases_json` and `min_two_phases` checks require it. It survives P2 untouched.

#### Acceptance Criteria
- [ ] A plan generated from the rewritten template passes `has_phases_json` + `min_two_phases`
- [ ] T5, T6, T7 pass; architect judges all 10 conformant; suite green

---

### Phase 7: Remaining templates + spir consult-types (G4, G5)
**Groups**: G4 (templates), G5 (consult-types) — **two commits, one per group**
**Batches**: 1 (10 decisions + `bugfix-742` test ≈ 11)

#### Deliverables
- [ ] Templates: experiment 1, maintain 1, spike 1, **maintain codev-local ×2** (no skeleton twin) = 5
- [ ] spir consult-types ×5
- [ ] **M10**: `bugfix-742-consult-templates.test.ts:27-28` pins prose in
      `spir/consult-types/{pr,impl}-review.md` — breaks here
- [ ] Manifest + architect review; suite green

#### Implementation Details
- The two codev-local maintain templates have no skeleton twin — inspected once, excluded from
  T7's twin-parity intersection.
- **The verdict format (`VERDICT: APPROVE | REQUEST_CHANGES | COMMENT`) is a CAPABILITY** —
  `consult` parses it. Preserved exactly.

#### Acceptance Criteria
- [ ] A live `consult --type spec-review` returns a parseable verdict
- [ ] T5, T6, T7 pass; architect judges all 10 conformant; suite green

---

### Phase 8: Consult-types — aspir, bugfix, air (G5)
**Groups**: G5 · **Batches**: 1 (9 decisions + `bugfix-742` bugfix-side assertions ≈ 10)

#### Deliverables
- [ ] aspir ×5, bugfix ×2, air ×2
- [ ] **M10**: `bugfix-742-consult-templates.test.ts:25-26` pins `bugfix/consult-types/{pr,impl}-review.md`
- [ ] Manifest + architect review; suite green

#### Risks
Mechanical application without judgment — "same as spir" is itself a rules-not-judgment failure
in a project about exactly that. Each file is judged on its own diff.

---

### Phase 9: Consult-types pir/maintain + scar registry + dead-tree deletion (G5, G7, G4)
**Groups**: G5 (consult-types), G7 (registry), G4 (dead tree) — **three commits, one per group**
**Batches**: **2** — (A) 4 consult-type decisions; (B) registry + T4 + dead-tree deletion + T8 + routing test

#### Deliverables
- [ ] pir ×2, maintain ×2 consult-types *(batch A)*
- [ ] `codev/resources/scar-rules.yaml` rebuilt — eight canonicals verbatim, `must_appear_on`
      re-derived against the **post-rewrite** surface *(batch B)*
- [ ] **T4** scar enforcement test created here — first phase where it can be meaningful *(batch B)*
- [ ] `codev-skeleton/porch/prompts/` deleted (M6, group G4), with
      `review-prompt-routing.test.ts:29` updated under M10 naming **Spec 987** *(batch B)*
- [ ] Manifest + architect review of both batches; suite green

#### Implementation Details
- The registry is rebuilt **now** — Baked Decision 2 defers enforcement until the surface stops
  moving; `must_appear_on` derived earlier would be stale.
- M6 verification is **not** a bare grep: an untruncated repo-wide search reconciled against the
  full hit list. (A truncated grep in this project's own spec phase produced a false
  "no consumers" claim — the failure this step exists to avoid.)

#### Acceptance Criteria
- [ ] T4 passes with the rebuilt registry; count pinned at 8; reword/deletion fails
- [ ] T8 passes; Spec 987 protection preserved on remaining files
- [ ] Architect judges the 4 decisions conformant **and** ratifies `must_appear_on`; suite green

---

### Phase 10: Capability verification, measurement report, rollback rehearsal, governance docs
**Groups**: all (verification only) · **Batches**: 1 (artifacts)

#### Deliverables
- [ ] Post-rewrite capability inventory extracted and compared against the Phase-0 frozen
      baseline (M5); any removal listed in `1280-retirements.md` with architect approval
- [ ] Measurement re-run: before/after, per-audience, **deleted vs relocated** across all four
      skill trees (M0c, M1, M2)
- [ ] **T9** live spawn probe; **T10** rollback rehearsal for **every group touched**
      (G1–G7), not a sample (M9)
- [ ] Governance docs routed by tier — including the **"trust the authoritative source, not the
      convenient signal"** lesson (five instances in this project's spec phase alone)
- [ ] Suite green

#### Note on scope
The **review document and PR belong to porch's `review` phase**, not here — the first draft
folded them into an implement sub-phase where porch's review phase would re-run over them.

---

## Post-merge: the verify phase (M7, M8, M12, T13, T14)

SPIR's `verify` phase is where the A/B lives; it is **not** an implement phase and is listed here
so it has an explicit home rather than being assumed.

- [ ] **M12 release hold** in force from the moment the rewrite PR merges until the SHIP verdict
- [ ] **T14 pre-flight per pair**: every surface under test resolves from tier 2 — no skeleton
      file lacks a `codev/` twin. Failure **voids the pair** rather than producing a comparison
      that looks valid and is not
- [ ] **M7**: ≥6 issue-pairs, prompt-only overlay construction (both arms from source commit `S`;
      control applies one overlay reverting G2–G6), both hashes recorded per run
- [ ] `codev/resources/1280-ab-results.md` — one row per run
- [ ] **M8 / T13**: `measure-prompt-behavior.ts` re-run, B1 compared directionally to 51.88%
- [ ] SHIP / HOLD / ROLLBACK verdict → `verify-approval`

## Timeline & Dependencies

Strictly sequential; each phase ends at the architect's per-file review and a green suite.

```
P0 (PR-1, merged) → P1 → P2 → P3 → P4 → P5 → P6 → P7 → P8 → P9 → P10 → [PR] → verify
                     1    3   10    9   11   10   10    9    4    —
                                                        decisions = 67
```

## Rollback Strategy (whole project)

Seven groups per the spec: G1 instrument · G2 shared · G3 builder-spawn · G4 phase ·
G5 consultant · G6 architect · G7 scar registry. **Every commit is group-pure**, so any group
reverts cleanly. Reverting **G7** requires reverting every group carrying scar text (G2, G3, G4,
G6); all others are mutually independent. T10 rehearses **every** group touched.

## Open Questions Carried Into Implementation

- **Batch size** — ≤12 is the spec's cap; smaller grows the phase count, not the batches.
- **`roles/consultant.md`** — *inspected-but-unchanged (expected)*; rewritten only on finding.
- **Hot tier** — out of scope by the spec's disposition table; a reviewer may argue P3 applies.
- **Pre-existing skills drift** (`afx`, `porch` repo-vs-skeleton; `forge`/`skill-creator`/`team`
  skeleton-absent) — recorded as known state. Fixing it is arguably in scope for P3/P4
  relocation and arguably a separate concern; **architect's call at the plan gate.**

## Notes

**Why phases are drawn by inspection load.** The architect's per-file review is the throughput
constraint, so the boundary that matters is "a batch a human can review in one sitting." Phase 4
is the exception that proves it: only 9 decisions, but it carries the entire M10 burden, so it is
split into two explicit batches.

**Phase 0 is not optional sequencing.** Rewriting before the instrument is corrected — and before
the capability inventory is frozen — would make every subsequent measurement and every M5
assertion unfalsifiable.
