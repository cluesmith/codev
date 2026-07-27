# Plan: Prompt Architecture — Single-Owner Rule for Instruction Content

## Metadata

- **ID**: plan-2026-07-27-prompt-architecture-single-owner
- **Status**: draft
- **Specification**: [`codev/specs/1252-prompt-architecture-single-own.md`](../specs/1252-prompt-architecture-single-own.md)
- **Issue**: #1252
- **Created**: 2026-07-27

---

## Executive Summary

The spec establishes that Codev's instruction surface carries ~76 shadow copies
of skeleton files, 17 of them drifted, and that the drift is already live — this
project's own spawn prompt lost its `Verify Phase` section. It also establishes
that a detector for exactly this (`protocol-drift-audit`, #1210) has been
shipping the finding to `codev doctor` all along, unread, because nothing fails
the build.

The implementation follows the spec's **B → A → C** sequencing: make drift fail
CI, then remove the shadow tree, then deduplicate the remaining single surface.
Eight phases, each independently committable.

**One ordering decision beyond the spec's stated constraints.** The spec fixes
two orderings — `M11 → M3 → M8` (audit before reconcile before delete) and
"M5 green before Approach C." It does not say where the scar-rule work sits
relative to deletion. Compressing eight scar rules across every surface *before*
deleting the shadow tree would mean carefully rewriting ~36 files, roughly half
of which get deleted two phases later — wasted work, and a real chance of
reconciling a compression edit against a skeleton that never received it. So
**scar compression (Phase 5) runs after shadow-tree removal (Phase 4)** and
still lands well before deduplication (Phase 7), satisfying the spec's actual
constraint.

```json
{
  "phases": [
    {"id": "phase_1", "title": "Drift gate + measurement baseline"},
    {"id": "phase_2", "title": "Local-unique content audit (M11)"},
    {"id": "phase_3", "title": "Reconcile the 17 drifted files (M3)"},
    {"id": "phase_4", "title": "Compatibility audit + shadow-tree removal"},
    {"id": "phase_5", "title": "Scar-rule registry with compressed wordings"},
    {"id": "phase_6", "title": "Ownership map + completeness enforcement"},
    {"id": "phase_7", "title": "Deduplication and measurement"},
    {"id": "phase_8", "title": "Governance sync + end-to-end verification"}
  ]
}
```

### Criteria-to-phase map

| Phase | Delivers | Verified by |
|---|---|---|
| 1 | M2 (gate), M6 | T5, T1 |
| 2 | M11 (audit + escalations) | T11 |
| 3 | M3 (D1 reconciliation) | T2, T3, allowlist decay |
| 4 | M7, M8, M9, M10 | T8, T9, T10 |
| 5 | M5 (D3 registry, eight compressed rules) | T6 |
| 6 | M1, M4 | T7, T12 |
| 7 | S1, N1 | T4, T13(a) |
| 8 | C6 retirement, N2, N3, N4 | T10, T13(a)+(b) |

---

## Success Metrics

Carried from the spec:

- [ ] **M1** Ownership map, machine-readable, with completeness rule
- [ ] **M2** Drift fails CI; allowlist decays to empty
- [ ] **M3** All 17 drifted files reconciled per D1
- [ ] **M4** Single-owner enforcement derived from the map
- [ ] **M5** Eight scar rules registered in compressed canonical form
- [ ] **M6** Measurement script committed
- [ ] **M7** Compatibility audit complete
- [ ] **M8** Shadow copies removed, local-only entries preserved
- [ ] **M9** `copyProtocols`/`copyRoles` removed
- [ ] **M10** Post-deletion resolver equivalence
- [ ] **M11** All 76 shadow copies in a terminal state TS1–TS4, zero open escalations
- [ ] **S1** Non-scar duplicated classes reduced to owner + references
- [ ] **N1** Always-on word reduction reported (target ≥ 20% of ~24,600)
- [ ] **N2** Full suite green
- [ ] **N3** CLAUDE.md ≡ AGENTS.md
- [ ] **N4** Spec 987 hot-tier caps respected

---

## Phase Breakdown

### Phase 1: Drift gate + measurement baseline

**Dependencies**: None
**Delivers**: M2, M6

#### Objective

Make shadow drift fail the build, and capture the before-measurement that N1 is
scored against. This is the spec's Approach B — cheap, and the safety net that
makes every later phase auditable.

#### Implementation

- **New** `packages/codev/src/__tests__/shadow-drift-gate.test.ts`:
  - Call the existing `auditProtocolDrift()` from
    `packages/codev/src/lib/protocol-drift-audit.ts`. **Do not reimplement
    detection** — #1210 already classifies each shadow copy `identical | differs`.
  - Fail on any `differs` finding absent from the allowlist.
  - Assert the gate bites: construct a fixture workspace with a seeded
    divergence and confirm the check reports failure. A gate that only ever sees
    a clean tree is indistinguishable from a no-op.
- **New** `packages/codev/src/__tests__/fixtures/shadow-drift-allowlist.ts`:
  - Seeded with the **17 currently-drifted files**, each carrying a
    justification comment `// pending reconciliation — Phase 3 (D1)`.
  - Starting populated is deliberate: the tree is dirty today, and a gate that
    fails on commit is a gate someone disables. Phase 3 empties it.
  - Include the allowlist **lifecycle assertion** (Gemini's iteration-2 point):
    every entry needs a justification string, and entries citing "pending
    reconciliation" must be gone once Phase 3 lands.
- **New** `scripts/measure-prompt-surface.sh`:
  - Emits the spec's inventory table — per-surface word counts, the always-on
    subtotal, and the ~24,600 baseline arithmetic.
  - Committed and re-run in Phase 7; both outputs recorded in the review.

#### Success criteria

- `auditProtocolDrift()` is invoked, not duplicated.
- Seeded-divergence fixture fails; clean tree passes.
- Baseline measurement committed.

#### Test approach

T5 (drift gate, incl. the bites-check), T1 (inventory reproduction).

---

### Phase 2: Local-unique content audit (M11)

**Dependencies**: Phase 1
**Delivers**: M11 audit + escalations

#### Objective

Before anything is overwritten or deleted, determine what in the shadow tree is
**codev-specific functionality** rather than rot. This is the architect's D2
safeguard and the phase that protects against silent capability loss.

#### Implementation

- **New** `codev/resources/1252-shadow-tree-audit.md` — one row per shadow copy,
  all 76:

  | File | Divergence | Classification | Terminal state | Ruling |
  |---|---|---|---|---|

- Classification per D2: **rot** (local lags skeleton) vs **local-unique**
  (content absent from the skeleton that plausibly encodes codev-specific
  functionality).
- **Audit content, not just files.** A local-unique paragraph inside an
  otherwise-rotted file is the loss this phase exists to prevent, and Phase 3
  would destroy it first. Every hunk in each of the 17 diffs is classified, not
  just the file as a whole.
- The 59 `identical` copies are recorded as rot → **TS1** without further
  analysis (nothing to lose).
- The 3 local-only entries (`release/`,
  `maintain/templates/{audit-report.md,lessons-learned.md}`) are recorded and
  **preserved** — they have no skeleton counterpart.
- **Ambiguous → local-unique → escalate.** Per the spec: a needless question is
  cheap; a silently deleted behaviour is not.
- Escalate every local-unique finding to the architect via `afx send` with the
  diff hunk and a short read on what it appears to provide. Record the ruling
  and resulting terminal state (TS1–TS4) in the audit.

#### Success criteria

- 76 rows, each classified and assigned a terminal state.
- Every local-unique finding escalated with a recorded ruling, **or** converted
  to TS3 + a filed follow-up issue (the spec's escape hatch — no indefinite
  block).
- Zero rows left "pending."

#### Test approach

T11 — asserts row count, complete classification, no unresolved escalations, and
that nothing local-unique was touched without a ruling. Guards the *process*.

---

### Phase 3: Reconcile the 17 drifted files (M3)

**Dependencies**: Phase 2 (**hard** — reconciling before auditing destroys the
evidence)
**Delivers**: M3

#### Objective

Apply decision D1: the skeleton is authoritative. Bring the drifted shadow
copies back into agreement so the allowlist empties.

#### Implementation

- For each of the 16 drifted files under `codev/protocols/` and
  `codev/roles/architect.md`:
  - Rows classified **rot** in Phase 2 → take the skeleton version.
  - Rows classified **local-unique** → apply the Phase 2 ruling (TS2 promote /
    TS3 retain / TS4 drop). **Never silently overwrite.**
- Confirm the headline repair: `codev/protocols/spir/builder-prompt.md` regains
  `### Multi-PR Mechanics`, `## Verify Phase`, and the
  `"Entering verify phase."` notification string.
- Remove every `// pending reconciliation` entry from the Phase 1 allowlist. Any
  residue must be an open M11 escalation citing its adjudication.

#### Success criteria

- `diff -rq codev/protocols codev-skeleton/protocols` reports zero differing
  files (excluding TS3 retentions, which are allowlisted with justification).
- Allowlist contains no "pending reconciliation" entries.
- Phase 1's gate passes without exemptions beyond documented TS3 items.

#### Test approach

T2 (drift counts → 0), T3 (builder-prompt sections present), T5 (gate green).

---

### Phase 4: Compatibility audit + shadow-tree removal

**Dependencies**: Phase 3
**Delivers**: M7, M8, M9, M10

#### Objective

Complete the reference audit, then delete the shadow copies so the skeleton
becomes the single owner — the spec's Approach A, approved by D2.

#### Implementation

**Step 4a — complete M7** (must finish before any deletion):

- Extend Appendix B's preliminary audit across **tests** (95 references) and any
  non-TypeScript consumers.
- Classify each reference: resolver-routed (safe), comment/error-string (safe),
  or direct-read (**must fix before deletion**).
- Appendix B found no direct-read consumer among the 26 non-test hits —
  `consult/index.ts:175` uses `readCodevFile`, `porch/protocol.ts` uses
  `resolveCodevFile`/`getSkeletonDir` — but the audit is only preliminary and
  tests are unexamined. Any direct-read found is fixed to route through
  `resolveCodevFile` first.

**Step 4b — delete (M8)**:

- Remove shadow copies under `codev/protocols/` and `codev/roles/`.
- **Preserve**: `codev/protocols/release/`,
  `codev/protocols/maintain/templates/{audit-report.md,lessons-learned.md}`, and
  any TS3 retention from Phase 2.
- `codev/protocols/protocol-schema.json` — verify it is a shadow of
  `codev-skeleton/protocols/protocol-schema.json` and not separately referenced
  by path before removing.

**Step 4c — vestigial cleanup (M9)**:

- Delete `copyProtocols` (`packages/codev/src/lib/scaffold.ts:480`) and
  `copyRoles` (`:425`), plus their `scaffold.test.ts` cases.
- Neither is called by `init`, `adopt`, or `update` — they are dead code that
  would manufacture this problem for every adopter if rewired.

**Step 4d — equivalence (M10)**:

- **New** `packages/codev/src/__tests__/shadow-removal-equivalence.test.ts`:
  for every deleted path, `resolveCodevFile` returns the skeleton counterpart
  with matching content.

#### Success criteria

- M7 audit committed; zero unfixed direct-read consumers.
- Shadow copies gone; all preserved entries intact and resolving.
- `copyProtocols`/`copyRoles` absent.
- `porch`, `consult`, and `codev doctor` all still resolve protocol files.

#### Test approach

T8 (local-only preservation), T9 (resolver equivalence), T10 (full regression —
`skeleton`, `protocol-drift-audit`, `protocol-prompt-audit`,
`framework-ref-audit`, `scaffold`).

---

### Phase 5: Scar-rule registry with compressed wordings

**Dependencies**: Phase 4 (see the Executive Summary ordering note — compressing
before deletion would edit files about to be deleted)
**Delivers**: M5, D3

#### Objective

Register the eight ratified scar rules in compressed canonical form and make
deleting or rewording any of them fail the build — **before** Phase 7 touches a
single line of duplicated text.

#### Implementation

- **New** `codev/resources/scar-rules.yaml`:

  ```yaml
  scar_rules:
    - id: git-add-explicit
      canonical: "Never `git add -A` / `.` / `--all` — stage files explicitly."
      must_appear_on: [claude-md, agents-md, arch-critical, ...]
  ```

- All **eight** rules from D3: the original six plus (7) never kill shellper
  processes without the verified-orphan procedure, and (8) never restart Tower
  without explicit human permission.
- **Compress each to one sentence, two at most** (D3). Today's
  `### 🚨 ABSOLUTE PROHIBITION: NEVER USE git add -A 🚨` block in CLAUDE.md
  collapses to a single line.
- **Meaning preservation is the risk here, not brevity.** Each compressed
  wording is diffed against its longest existing variant and checked to retain:
  the prohibition, its scope, and any named escape hatch (e.g. rule 2's "use
  `--resume`, and ask when in doubt"). Compression that drops the escape hatch
  turns guidance into a dead end.
- Replace all 9 existing `git add -A` variants — and the equivalents for the
  other seven rules — with the byte-identical canonical string on every surface
  in `must_appear_on`.
- **New** `packages/codev/src/__tests__/scar-rules.test.ts`: verbatim presence on
  every required surface; **mutation checks** — deleting a rule fails, rewording
  it fails.

#### Success criteria

- Eight rules registered, each one or two sentences.
- Every surface carries the canonical string byte-identically.
- Mutation tests demonstrably fail on deletion and on rewording.
- No scar rule lost or weakened (manual meaning-preservation review recorded).

#### Test approach

T6, plus the meaning-preservation diff recorded in the phase commit.

---

### Phase 6: Ownership map + completeness enforcement

**Dependencies**: Phase 4 (map a single tree, not a doubled one), Phase 5
(scar rules must already be registered so the map can mark them `scar`)
**Delivers**: M1, M4

#### Objective

Author the machine-readable ownership map and enforce both single-ownership
*and* the map's exhaustiveness — the latter being Codex's iteration-2 catch.

#### Implementation

- **New** `codev/resources/prompt-ownership.yaml` per Appendix A: `surfaces`
  (id, path, load) and `instructions` (id, summary, owner, scar,
  canonical_wording, must_appear_on, pattern, enforcement).
- **New** `codev/resources/prompt-ownership.md` — human-readable companion,
  generated from or validated against the YAML.
- **Declare the inventory boundary** explicitly in the YAML: the exact file set
  scanned. Anything outside is out of scope *by declaration*, not omission.
- **New** `scripts/extract-instruction-candidates.mjs`: mechanically collects
  normative statements (`MUST`, `NEVER`, `ALWAYS`, `DO NOT`, `don't`, …) inside
  the boundary, each with a stable id.
- Every candidate gets exactly one disposition: `mapped`, `scar`, or
  `out-of-scope` **with written justification**.
- **Required**: record why `codev/resources/` is excluded from the drift regime
  (Q7 — `FRAMEWORK_DRIFT_DIRS` already omits `resources`; the map states the
  reason so the next person doesn't read a correct default as an oversight).
- **New** `packages/codev/src/__tests__/prompt-ownership.test.ts`:
  - **T7 / M4** — for each `enforcement: automated` class, the pattern matches
    on exactly the declared owner. Assertions are **derived from the YAML**;
    restating ownership in test code would itself violate the single-owner rule.
  - **T12 / M1** — fails on any undispositioned candidate, and is itself
    validated against a **seeded** normative line so it cannot pass vacuously on
    an empty candidate set.

#### Success criteria

- Map covers the declared boundary with zero undispositioned candidates.
- T7 derives from the map file, not from literals.
- T12 fails on a seeded line and on a removed disposition.

#### Test approach

T7, T12.

---

### Phase 7: Deduplication and measurement

**Dependencies**: Phase 6 (the map says what may be reduced), Phase 5 (**hard** —
M5 green before anything is stripped)
**Delivers**: S1, N1

#### Objective

Reduce non-scar duplicated instruction classes to their single owner plus
references, and report the measured win honestly.

#### Implementation

- For each `scar: false` class with duplicates: keep the owner's full statement;
  replace other occurrences with a one-line reference.
- **Scar rules are not touched** — C3, and Phase 5's tests would fail anyway.
  Their contribution to N1 came from Phase 5's compression, which shortened them
  without reducing their reach.
- Re-run `scripts/measure-prompt-surface.sh`; record before/after and the
  achieved percentage.
- **Report the achieved figure whether or not it hits 20%.** N1 is a target, not
  a gate. If the shortfall is structural — most always-on words being CLAUDE.md
  prose that is already single-owned rather than duplicated rules — say so
  plainly rather than stripping content to hit a number.

#### Success criteria

- No `scar: false` class appears outside its owner except as a reference.
- T13(a) confirms the assembled prompt still carries every rule an agent needs.
- Before/after measurement recorded.

#### Test approach

T4 (duplication probe re-run), T7, T13(a).

---

### Phase 8: Governance sync + end-to-end verification

**Dependencies**: Phase 7
**Delivers**: C6 retirement, N2, N3, N4, T13(b)

#### Objective

Update governance docs to describe the new world, and verify the real user path
rather than trusting green tests.

#### Implementation

- **`codev/resources/arch-critical.md`** — the "mirror every framework change in
  BOTH trees" fact (C6) is now wrong for `protocols/` and `roles/`. Rewrite that
  bullet. **Respect the ≤10-fact / ≤35-line cap** (N4): if the replacement needs
  more room, demote a weaker fact to `arch.md` per the displacement rule. Use
  the `update-arch-docs` skill.
- **`codev/resources/arch.md`** — record the shadow-tree removal and the
  single-owner regime.
- **`codev/resources/lessons-learned.md`** — the durable lesson: *a detector
  that reports without failing the build is a detector nobody reads.* #1210 saw
  this drift for months.
- **`CLAUDE.md` + `AGENTS.md`** — apply Phase 5's compressed scar wordings and
  Phase 7's dedup. **Verify byte-identical** (N3).
- **File the tiering follow-up issue** (D4) now that the ownership map exists —
  the prerequisite that made it specifiable.
- **T13(b) — the manual run.** Spawn a real builder against the changed tree and
  *read the prompt it receives*. Confirm the `Verify Phase` section and all eight
  scar rules are present.

#### Success criteria

- Hot-tier caps respected; maps accurate.
- CLAUDE.md ≡ AGENTS.md byte-for-byte.
- Full suite green.
- **Manual spawn inspected and its outcome recorded in the review.**
- Tiering follow-up issue filed.

#### Test approach

T10 (regression), T13(a) automated + **T13(b) manual**, `hot-tier`,
`governance-sweep`.

---

## Risks and Mitigations

| Risk | Phase | Mitigation |
|---|---|---|
| Codev-specific functionality silently lost | 2, 4 | Phase 2 audits content *inside* drifted files; ambiguous → escalate; nothing local-unique touched without a ruling |
| Reconciliation destroys local-unique content before deletion is reached | 3 | Hard dependency Phase 2 → Phase 3; the spec's `M11 → M3 → M8` order |
| A scar rule dropped or weakened during compression or dedup | 5, 7 | M5 green before Phase 7; mutation tests; explicit meaning-preservation review incl. escape hatches |
| Ownership map under-lists, M4 passes vacuously | 6 | Declared boundary + mandatory disposition; T12 seeded-line validated |
| Deleting the shadow tree breaks a path-based reader | 4 | M7 completed across tests before any deletion; T9 per-file equivalence |
| Allowlist becomes a permanent exemption | 1, 3 | Justification per entry; empties in Phase 3; only open escalations may persist |
| Hot-tier cap breached while fixing C6 | 8 | `update-arch-docs` skill; demote-on-add displacement |
| Green tests, broken real spawn | 8 | T13(b) manual spawn — the exact failure that produced this project |

---

## Rollback

Each phase is one commit on `builder/spir-1252`. Phases 1–3 are additive or
reconciling and revert cleanly.

**Phase 4 is the irreversible-feeling one** — but the deleted content is
byte-identical to `codev-skeleton/` (that is precisely what Phases 1–3
established), so recovery is `git revert` and nothing is unique to the deleted
copies except TS3 retentions, which are preserved by construction.

---

## Open Items for the Architect

1. **Phase 2 escalations** will arrive mid-implementation via `afx send`. Each
   needs a TS2/TS3/TS4 ruling. Unanswered ones convert to TS3 + follow-up issue
   per the spec's escape hatch — flagging so that default is visible rather than
   silent.
2. **Phase 5 compressed wordings** are the one place where a review by you is
   worth more than a test: the tests prove the strings match everywhere, not
   that the compressed sentence still carries the rule's force. I will include
   the eight before/after pairs in the phase commit message.

---

## Change Log

| Date | Change | Reason | Author |
|------|--------|--------|--------|
| 2026-07-27 | Initial plan | Spec approved at `spec-approval` | builder spir-1252 |

---

## Notes

The plan deliberately front-loads *safety* over *savings*: four of eight phases
land before a single duplicated word is removed. That reflects the spec's
finding that drift, not token count, is the urgent problem — and the architect's
D2 condition that nothing codev-specific be lost on the way.
