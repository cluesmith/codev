# Plan: Prompt surface — judgment-not-rules rewrite (principle conformance)

## Metadata
- **ID**: plan-2026-07-31-prompt-surface-judgment-not-rules
- **Status**: draft
- **Specification**: [codev/specs/1280-prompt-surface-judgment-not-ru.md](../specs/1280-prompt-surface-judgment-not-ru.md)
- **Created**: 2026-07-31
- **Issue**: #1280 (charter amended 2026-08-01: acceptance = principle conformance, size reporting-only)

## Executive Summary

Approach 1 from the spec: **in-place principle rewrite, surface by surface**, keeping file
layout, the four-tier resolver, and porch untouched. Approach 2 (generate prompts from
`protocol.json`) is rejected twice over — it changes porch behaviour and it defeats M11, since
the architect cannot inspect old-vs-new diffs of files that no longer exist as authored
artifacts.

**The binding constraint is not the writing — it is M11.** The architect personally inspects
the old-vs-new diff of every changed file. There are **67 distinct content decisions** (enumerated
below), and the spec caps review batches at **≤12**. Phase boundaries are therefore drawn by
*inspection load*, not by subsystem elegance: every phase is a reviewable batch that ends at the
architect's per-file review and does not advance until it passes.

Phase 0 ships separately and early as **PR-1** (M0b): the corrected measurement instrument and
its first-ever tests, before a single prompt word is rewritten. Everything after it is one PR.

### The 67 decisions

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

Each decision is applied to **both trees** where a twin exists; T7 asserts twin parity, which is
what makes the architect's review of 67 decisions sound rather than 131 diffs.

## Success Metrics

From the specification (acceptance = principle conformance; size is reporting-only):

- [ ] **MP** — every file marked *rewritten* in the spec's disposition table conforms to P1, P2,
      P3, P4, P6, P7 (P5 N/A with reason), judged per file by the architect
- [ ] **M11** — architect inspected the old-vs-new diff of every changed file, in ≤12-file
      batches, with a complete manifest per phase
- [ ] **M0 / M0b / M0c** — corrected instrument, landed early as PR-1, reporting deleted vs relocated
- [ ] **M1 / M2** — before/after figures and per-file counts published (no threshold)
- [ ] **M2b** — CLAUDE.md human-readable, architect-confirmed
- [ ] **M3** — every surface enumerated from disk is rewritten and inspected
- [ ] **M4** — eight scar canonicals byte-identical; count pinned at 8
- [ ] **M5** — capability inventory over served prompt text; unlisted removals fail
- [ ] **M6** — dead tree deleted, its Spec 987 test consumer handled
- [ ] **M7** — A/B non-inferiority SHIP verdict (gates `verify-approval`)
- [ ] **M8** — behavioural baseline re-run
- [ ] **M9** — rollback rehearsed by group
- [ ] **M10** — every retired prose-pinned assertion named with its originating spec
- [ ] **M12** — no release between the rewrite merge and the SHIP verdict
- [ ] All tests pass after M10 re-baselining; no coverage reduction

## Phases (Machine Readable)

<!-- REQUIRED: porch uses this JSON to track phase progress. Update this when adding/removing phases. -->

```json
{
  "phases": [
    {"id": "phase_0_instrument", "title": "Corrected measurement instrument (PR-1, ships early)"},
    {"id": "phase_1_shared_roles", "title": "CLAUDE.md/AGENTS.md + three role files (4 decisions)"},
    {"id": "phase_2_protocol_md", "title": "protocol.md across ten protocols (10 decisions)"},
    {"id": "phase_3_builder_prompts", "title": "builder-prompt.md across nine protocols (9 decisions)"},
    {"id": "phase_4_prompts_heavy", "title": "Phase prompts: spir, aspir, pir (11 decisions)"},
    {"id": "phase_5_prompts_light_spir_templates", "title": "Phase prompts: bugfix, air, maintain + spir templates (10 decisions)"},
    {"id": "phase_6_templates_consult_spir", "title": "Remaining templates + spir consult-types (10 decisions)"},
    {"id": "phase_7_consult_types_a", "title": "Consult-types: aspir, bugfix, air (9 decisions)"},
    {"id": "phase_8_consult_registry_deadtree", "title": "Consult-types: pir, maintain + scar registry + dead-tree deletion (4 decisions + M4/M6)"},
    {"id": "phase_9_integration", "title": "Capability inventory, governance docs, measurement report, PR"}
  ]
}
```

## Phase Breakdown

### Phase 0: Corrected measurement instrument (PR-1, ships early)
**Dependencies**: None. **Ships as its own PR before any prompt rewriting** (M0b).

#### Objectives
- Make the instrument measure what is actually served, before anything is scored by it
- Correct the public record: 1252's baselines cite dead-tree figures and are read by other work

#### Deliverables
- [ ] `scripts/measure-prompt-surface.sh` corrected — all seven M0 items: served directory ·
      per-file four-tier resolution · inlined `roles/builder.md` · hot-tier `@import`
      transclusion **and the stale comment that caused defect 3** · include expansion ·
      bucket/audience reporting · total-authored-surface reporting
- [ ] First tests for the script: T1, T1b, T2, T11, T12, T15
- [ ] `codev/resources/1280-word-baseline.md` — corrected, segmented pre-rewrite baseline
- [ ] In-place annotation of `1252-word-baseline.md` / `1252-word-after-phase7.md`: originals
      preserved, marked superseded, reason + pointer
- [ ] PR opened, reviewed, merged

#### Implementation Details
- The script's `PORCH_DIR` (line 89) is replaced by resolution through the same path
  `loadPromptFile` uses (`protocols/<p>/prompts/`), asserted against the real resolver in T1.
- Per-file four-tier resolution mirrors `resolveCodevFile` rather than two-tier directory
  selection (T1b fixture: one prompt overridden in `.codev/`, others from the skeleton).
- Two reporting bases, labelled: **always-on** (dedupes twins, expands `@import`/`{{> …}}`) and
  **total authored** (physical files, no dedup, no expansion) — the second is what makes
  relocation visible.
- **No prompt-surface file is touched in this phase.**

#### Acceptance Criteria
- [ ] T1, T1b, T2, T11, T12, T15 pass
- [ ] Script output deterministic at a fixed commit
- [ ] Architect reviews the script diff and both baseline artifacts (M11 applies — small batch)
- [ ] PR-1 merged

#### Test Plan
- **Unit**: the six tests above, including the phantom-savings and relocation fixtures
- **Manual**: run against `main`, confirm the corrected baseline reproduces

#### Rollback Strategy
Group **G1**. Revert the PR; no prompt surface has changed, so nothing else is affected.

#### Risks
A fourth instrument defect. Mitigated by the tests being written *with* the fix and by the
architect reviewing the script before any cut is scored by it.

---

### Phase 1: CLAUDE.md/AGENTS.md + three role files (4 decisions)
**Dependencies**: Phase 0 merged.

#### Objectives
- Establish the conformance pattern on the highest-blast-radius surfaces first, so the
  architect's review calibrates the standard for the seven phases that follow

#### Deliverables
- [ ] `CLAUDE.md` + `AGENTS.md` rewritten (1 decision, 2 byte-identical files)
- [ ] `roles/architect.md`, `roles/builder.md` rewritten; `roles/consultant.md` inspected
      (rewritten only if inspection finds non-conformance — spec disposition table)
- [ ] All eight scar canonicals present byte-identically in CLAUDE.md/AGENTS.md
- [ ] Relocated how-to content landed in the named skills
- [ ] Per-file manifest + architect review

#### Implementation Details
- Governing principles: **P3** (worktree recipes, CLI walkthroughs, protocol-selection prose are
  needed rarely and loaded always) and **P4** (tool how-tos belong with the tool), plus **P1**.
- Relocation destinations are the existing skills: `afx`, `codev`, `porch`, `consult`. Content
  moves *by name*, never by "go read this path" — deliver-don't-fetch still applies.
- `roles/architect.md`: confirm nothing is load-bearing for multi-architect coordination
  (Specs 755/786/823) **before** cutting — spec Open Question.
- M2b: the architect confirms CLAUDE.md is still navigable by a human, not just parity-clean.

#### Acceptance Criteria
- [ ] T4 (scar integrity), T7 (twin parity) pass
- [ ] Architect judges all 4 decisions conformant against P1/P3/P4
- [ ] M2b confirmed
- [ ] M10: any prose-pinned assertion touched is re-baselined with its originating spec named

#### Test Plan
- **Unit**: T4, T7; existing governance-sweep and framework-ref-audit suites
- **Integration**: `codev doctor` clean
- **Manual**: architect reads the rewritten CLAUDE.md end to end

#### Rollback Strategy
Groups **G2** (shared) and **G6** (architect role). Independent of later phases.

#### Risks
Relocating content that turns out to be needed every time. Mitigated by M11 inspection and by
M0c making relocation visible rather than scoring it as deletion.

---

### Phase 2: protocol.md across ten protocols (10 decisions)
**Dependencies**: Phase 1 reviewed.

#### Objectives
- Apply **P6** where it bites hardest: `protocol.md` narrates a state machine that
  `protocol.json` already defines

#### Deliverables
- [ ] Ten `protocol.md` files rewritten (spir, aspir, pir, maintain, research, experiment,
      spike, bugfix, air, **release** — the last is codev-local with no skeleton twin)
- [ ] Per-file manifest + architect review

#### Implementation Details
- **P6 is the lever**: replace narrated gate/check/phase enumerations with an explicit,
  resolvable reference to `protocol.json`. Per M5's representation rule, that reference
  *satisfies* the capability inventory — this is the case M5 was amended to allow.
- **P7**: delete worst-case padding (all-caps prohibition blocks, "⚠️ BLOCKING" banners,
  checklists restating the phase body) — **except** scar rules.
- `release/protocol.md` has no `protocol.json`; it is human-invoked prose, so P6 does not apply
  and it is rewritten on P1/P3 alone.
- Largest single cut in the project (`spir/protocol.md`); M5's contract-presence assertions are
  the primary defence.

#### Acceptance Criteria
- [ ] T5 (capability inventory over served prompt text) passes — every gate, check, signal and
      artifact contract still represented, by name or by resolvable reference
- [ ] T6, T7 pass
- [ ] Architect judges all 10 decisions conformant

#### Test Plan
- **Unit**: T5, T6, T7
- **Integration**: `porch next` on a scratch project returns a well-formed task per phase
- **Manual**: architect diff review, 10 files

#### Rollback Strategy
Group **G3**.

#### Risks
P6 over-applied — a prompt that references `protocol.json` for something an agent needs
*inline*. Mitigated by T9's live spawn probe in Phase 9 and by M11.

---

### Phase 3: builder-prompt.md across nine protocols (9 decisions)
**Dependencies**: Phase 2 reviewed.

#### Objectives
- Remove worst-case padding from the spawn wrappers while preserving every artifact contract

#### Deliverables
- [ ] Nine `builder-prompt.md` files rewritten
- [ ] **M10 re-baselining executed and enumerated** — this is the phase that collides with
      `agent-farm/__tests__/baked-decisions.test.ts:143-148`
- [ ] Per-file manifest + architect review

#### Implementation Details
- Governing principles: **P1**, **P7**.
- **M10 is the load-bearing work here, not the rewriting.** `baked-decisions.test.ts` enforces a
  *pure-addition diff* against committed baselines for `protocols/{spir,aspir,air}/builder-prompt.md`
  — structurally incompatible with rewriting them. Also colliding:
  `bugfix-744-spir-pr-strategy.test.ts` (4 near-verbatim sentences),
  `spec-1273-wait-discipline-docs.test.ts` (16 assertions), `bugfix-619-aspir-prompt.test.ts`.
- For each: name the originating spec, state whether the protected behaviour survives in the
  rewritten prose, and either write the replacement assertion or record an
  architect-visible retirement in `codev/resources/1280-retirements.md`.
- Re-baselining a pure-addition baseline requires the originating spec named and the new
  baseline committed **in the same commit**.

#### Acceptance Criteria
- [ ] Every touched assertion enumerated with its originating spec; none silently deleted
- [ ] Baked-decisions, PR-strategy, wait-discipline and aspir-prompt behaviours either
      re-asserted or explicitly retired with approval
- [ ] T4, T7 pass; full suite green
- [ ] Architect judges all 9 decisions conformant **and** approves each assertion retirement

#### Test Plan
- **Unit**: the four named suites, re-baselined; T4, T7
- **Integration**: `afx spawn --help` path and a live spawn smoke check
- **Manual**: architect reviews 9 diffs + the retirements file

#### Rollback Strategy
Group **G3** (shares the group with Phase 2 — they touch the same spawn-time surface and their
tests are coupled).

#### Risks
The highest-risk phase: silently gutting a prior spec's protection to make the suite green.
Mitigated by M10 being an explicit deliverable with architect sign-off per assertion.

---

### Phase 4: Phase prompts — spir, aspir, pir (11 decisions)
**Dependencies**: Phase 3 reviewed.

#### Objectives
- Apply **P2** (interfaces, not examples) to the heaviest phase prompts in the fleet

#### Deliverables
- [ ] spir: specify, plan, implement, review (4)
- [ ] aspir: specify, plan, implement, review (4)
- [ ] pir: plan, implement, review (3)
- [ ] Per-file manifest + architect review

#### Implementation Details
- These carry the fleet's two fattest prompts (`pir/review` 2,414w, `spir/review` 1,957w).
- **P2**: the `{{> …}}` template includes are what make each prompt ~600 words heavier than it
  reads. Templates themselves are rewritten in Phases 5–6; this phase rewrites the prompt bodies
  and keeps the include mechanism.
- Two separate constraints on template shape, not to be conflated: porch's
  `REQUIRED_SPEC_SECTIONS` needs **4** headings (`checks.ts:149-154`); the `spec-review` consult
  type advisorily expects 20.
- Signal contracts (`<signal>` tags) are capability-inventory items — preserved or retired
  explicitly.

#### Acceptance Criteria
- [ ] T5 passes — every signal, artifact path and check name still represented
- [ ] Porch checks still pass on a scratch project (`spec_has_required_sections`, `has_phases_json`)
- [ ] Architect judges all 11 decisions conformant

#### Test Plan
- **Unit**: T5, T6, T7; `template-delivery.test.ts` re-baselined per M10 if touched
- **Integration**: drive a scratch project through specify→plan with the rewritten prompts
- **Manual**: architect reviews 11 diffs

#### Rollback Strategy
Group **G4**.

#### Risks
Dropping a porch-required heading and breaking a gate check. Mitigated by the integration test
driving real porch checks, not just unit fixtures.

---

### Phase 5: Phase prompts — bugfix, air, maintain + spir templates (10 decisions)
**Dependencies**: Phase 4 reviewed.

#### Deliverables
- [ ] bugfix: investigate, fix, pr (3); air: implement, pr (2); maintain: maintain, review (2)
- [ ] spir templates: `spec.md`, `plan.md`, `review.md` (3) → heading interfaces
- [ ] Per-file manifest + architect review

#### Implementation Details
- The lighter protocols are already closer to conformant (means 356–457w); expect confirmation
  rather than large rewrites — and per the acceptance model, **a file that is already conformant
  passes unchanged**.
- spir templates are the clearest **P2** case in the project: annotated examples with filler
  prose become heading skeletons with one line of intent per heading.
- `plan.md`'s machine-readable phases JSON block is a **capability**, not an example — it is
  required by porch's `has_phases_json` check and must survive.

#### Acceptance Criteria
- [ ] `has_phases_json` and `min_two_phases` still pass against a plan produced from the
      rewritten template
- [ ] T5, T6, T7 pass
- [ ] Architect judges all 10 decisions conformant

#### Test Plan
- **Unit**: T5, T6, T7
- **Integration**: generate a plan from the rewritten template, run porch's plan checks against it
- **Manual**: architect reviews 10 diffs

#### Rollback Strategy
Group **G4**.

#### Risks
Trimming the plan template's JSON block as "an example". Called out explicitly above.

---

### Phase 6: Remaining templates + spir consult-types (10 decisions)
**Dependencies**: Phase 5 reviewed.

#### Deliverables
- [ ] Templates: experiment (1), maintain (1), spike (1), **maintain codev-local ×2**
      (`audit-report.md`, `lessons-learned.md` — no skeleton twin) (5)
- [ ] spir consult-types: spec, plan, impl, phase, pr (5)
- [ ] Per-file manifest + architect review

#### Implementation Details
- The two codev-local maintain templates have **no skeleton twin** — inspected once, excluded
  from T7's twin-parity intersection.
- Consult-types: keep the rubric dimensions and the verdict contract; delete the process prose
  around them (**P1**, **P2**).
- The verdict format (`VERDICT: APPROVE | REQUEST_CHANGES | COMMENT`) is a **capability** —
  `consult` parses it. Preserved exactly.

#### Acceptance Criteria
- [ ] A live `consult -m claude --type spec-review` returns a parseable verdict
- [ ] T5, T6, T7 pass
- [ ] Architect judges all 10 decisions conformant

#### Test Plan
- **Unit**: T5, T6, T7
- **Integration**: one live consult per rewritten type, verdict parsed successfully
- **Manual**: architect reviews 10 diffs

#### Rollback Strategy
Groups **G4** (templates) and **G5** (consult-types).

#### Risks
Breaking verdict parsing, which would silently degrade every future CMAP round. Mitigated by the
live-consult integration check rather than a fixture.

---

### Phase 7: Consult-types — aspir, bugfix, air (9 decisions)
**Dependencies**: Phase 6 reviewed.

#### Deliverables
- [ ] aspir ×5, bugfix ×2, air ×2
- [ ] Per-file manifest + architect review

#### Implementation Details
- Same treatment as Phase 6. bugfix's two are the fleet's largest consult-types (pr 726, impl
  641) and carry the most process prose.
- aspir's five mirror spir's; if the Phase 6 rewrites apply cleanly, these are largely mechanical
  — but each is still a separate decision and a separate diff.

#### Acceptance Criteria
- [ ] Live consult per rewritten type returns a parseable verdict
- [ ] T5, T6, T7 pass
- [ ] Architect judges all 9 decisions conformant

#### Test Plan
As Phase 6.

#### Rollback Strategy
Group **G5**.

#### Risks
Mechanical application without judgment — "same as spir" is a rules-not-judgment failure in a
project about exactly that. Each file is judged on its own diff.

---

### Phase 8: Consult-types pir + maintain, scar registry, dead-tree deletion (4 decisions + M4/M6)
**Dependencies**: Phase 7 reviewed.

#### Objectives
- Finish the per-file rewrite, then rebuild the scar registry **against the settled surface**

#### Deliverables
- [ ] pir ×2, maintain ×2 consult-types (4 decisions)
- [ ] `codev/resources/scar-rules.yaml` rebuilt — eight canonicals verbatim, `must_appear_on`
      re-derived against the **post-rewrite** surface
- [ ] Scar enforcement test (byte-identical presence, count pinned at 8)
- [ ] `codev-skeleton/porch/prompts/` deleted (M6), with `review-prompt-routing.test.ts:29`
      updated under M10 naming **Spec 987**
- [ ] Per-file manifest + architect review

#### Implementation Details
- The registry is rebuilt **now, not earlier** — Baked Decision 2 defers enforcement until the
  surface stops moving, and `must_appear_on` lists derived before the rewrite would be stale.
- M6 verification is **not** a bare grep: an untruncated repo-wide search reconciled against the
  full hit list. (An earlier truncated grep in this project's spec phase produced a false
  "no consumers" claim — the failure this step is written to avoid.)

#### Acceptance Criteria
- [ ] T4 passes with the rebuilt registry; count pinned at 8; reword/deletion fails
- [ ] T8 passes — tree absent, no runtime reference, Spec 987 protection preserved on remaining files
- [ ] Architect judges the 4 decisions conformant **and** ratifies the registry's `must_appear_on`

#### Test Plan
- **Unit**: T4, T8; the updated Spec 987 routing test
- **Manual**: architect reviews 4 diffs + registry + the routing-test change

#### Rollback Strategy
Group **G7** (registry) — note the dependency rule: reverting G7 requires reverting every group
carrying scar text (G2, G3, G4, G6). Group **G5** for the consult-types.

#### Risks
Registry `must_appear_on` drifting from where scar text actually landed. Mitigated by deriving
it from the post-rewrite surface and by T4 failing loudly.

---

### Phase 9: Capability inventory, governance docs, measurement report, PR
**Dependencies**: Phase 8 reviewed.

#### Objectives
- Prove nothing was lost, report honestly what changed, and open the PR

#### Deliverables
- [ ] Post-rewrite capability inventory extracted and compared (M5); any removal listed in
      `codev/resources/1280-retirements.md` with architect approval
- [ ] Measurement re-run: before/after, per-audience, **deleted vs relocated** (M0c, M1, M2)
- [ ] T9 live spawn probe; T10 rollback rehearsal by group (M9)
- [ ] Governance docs routed by tier (`arch.md`/`arch-critical.md`,
      `lessons-learned.md`/`lessons-critical.md`) — including the
      **"trust the authoritative source, not the convenient signal"** lesson (five instances in
      this project's own spec phase)
- [ ] Review document; PR opened
- [ ] **M12 recorded**: no release between merge and the SHIP verdict

#### Implementation Details
- The measurement report is the project's honesty artifact: it must state where relocated words
  went, not merely that always-on fell.
- T10 rehearses a **group** revert on a scratch branch and confirms the suite stays green.
- The A/B (M7) runs **after** merge and gates `verify-approval` — its design, including the
  prompt-only overlay construction and the T14 pre-flight, is in the spec.

#### Acceptance Criteria
- [ ] M5 passes; retirements file complete and approved
- [ ] Measurement artifacts committed
- [ ] T9, T10 pass; full suite green
- [ ] Review document complete; PR opened

#### Test Plan
- **Unit**: full suite
- **Integration**: T9 live spawn probe end-to-end
- **Manual**: T10 rollback rehearsal; architect final review

#### Rollback Strategy
The PR itself is revertible by group; T10 has rehearsed it.

#### Risks
Discovering at the end that a capability was lost several phases ago. Mitigated by T5 running in
every phase, not only here.

## Timeline & Dependencies

Strictly sequential — each phase ends at the architect's per-file review and does not advance
until it passes. Phase 0 ships as PR-1 and merges before Phase 1 begins; Phases 1–9 accumulate as
commits on one branch and ship as a single PR.

```
P0 (PR-1, merged) → P1 → P2 → P3 → P4 → P5 → P6 → P7 → P8 → P9 (PR)
                     4    10    9    11   10   10    9    4   —     = 67 decisions
```

## Rollback Strategy (whole project)

Per the spec's seven groups: G1 instrument · G2 shared · G3 builder-spawn · G4 phase ·
G5 consultant · G6 architect · G7 scar registry. Reverting **G7** requires reverting every group
carrying scar text (G2, G3, G4, G6); all others are mutually independent. `git revert` restores
prior bytes — no migration, state, or schema. Rehearsed under T10 before the PR merges.

## Open Questions Carried Into Implementation

- **Batch size** — ≤12 is the spec's cap; the architect may prefer smaller, which grows the phase
  count rather than the batches.
- **`roles/consultant.md`** — marked *inspected-but-unchanged (expected)*; rewritten only if
  Phase 1 inspection finds non-conformance.
- **Hot tier** — out of scope by the spec's disposition table; a reviewer may argue P3 applies.

## Notes

**Why phases are drawn by inspection load.** A conventional plan would group by subsystem. Here
the architect's per-file review is the throughput constraint, so the phase boundary that matters
is "a batch a human can review in one sitting." Phase 3 is the exception that proves it: it is
only 9 decisions but carries the entire M10 test-retirement burden, which is why it is not merged
with the 4-decision Phase 1.

**Phase 0 is not optional sequencing.** Rewriting before the instrument is corrected would make
every subsequent measurement unfalsifiable — the spec's principle 7.
