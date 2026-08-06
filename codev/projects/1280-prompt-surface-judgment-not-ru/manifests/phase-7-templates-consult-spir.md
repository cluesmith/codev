# Phase 7 — remaining templates + spir consult-types (G4, G5)

**Decisions**: 10 (5 templates, 5 spir consult-types) · **Rollback groups**: G4 (templates), G5 (consult-types) — **two group-pure commits**, plus the R4 retirement + replacement (two more, mirroring R1–R3).
**Batches**: 2 — (1) templates, 5 decisions; (2) spir consult-types, 5 decisions.

**Levers**: **P2** (annotated-example filler → heading interfaces) for the templates; **P1/P2** for the consult-types, plus **P6** on `spec-review.md` (see below). **Old/New are word counts** (no `{{> }}` includes in these files).

**Capabilities preserved**: the `VERDICT: [APPROVE | REQUEST_CHANGES | COMMENT]` block in all five consult-types (`consult` parses it — kept exactly, `pr-review` keeps its `PR_SUMMARY` extension); the `maintenance-run.md` delivery-checked headings (`# Maintenance Run NNNN`, `## Audit Findings`, `### Dependencies Cleaned`); the experiment/spike `{{> }}` include wiring (untouched in the protocol.md files); and the #742 divergence (spir pr/impl-review stay distinct from the BUGFIX versions).

## Batch 1 — templates (G4, 5 decisions)

| File | Old | New | Principles | Rationale |
|---|---:|---:|---|---|
| `{codev,codev-skeleton}/protocols/experiment/templates/notes.md` | 312 | 167 | P2 | Example-laden placeholders (a literal `python experiment.py …`, fabricated metrics) → a clean heading interface. Kept the include wiring from `experiment/protocol.md`. |
| `{codev,codev-skeleton}/protocols/spike/templates/findings.md` | 265 | 169 | P2 | Light P2 — kept the **Verdict** line and the effort-sizing interface; trimmed placeholder verbosity. |
| `{codev,codev-skeleton}/protocols/maintain/templates/maintenance-run.md` | 184 | 175 | P2 | Already a lean heading interface; kept the three delivery-checked headings verbatim and only dropped the one filler example row from the Documentation Changes Log. |
| `codev/protocols/maintain/templates/audit-report.md` | 625 | 294 | P2 | Codev-local (no skeleton twin). Collapsed ~10 repetitive empty per-category tables into **one findings schema** + a category list; kept pre-audit checks, the summary reconciliation table, recommendation tiers, rollback notes, and approval. |
| `codev/protocols/maintain/templates/lessons-learned.md` | 78 | 78 | none | Codev-local (no skeleton twin). **Inspected, conformant, kept unchanged** — already a minimal category heading interface. |

## Batch 2 — spir consult-types (G5, 5 decisions)

| File (both trees) | Old | New | Principles | Rationale |
|---|---:|---:|---|---|
| `{codev,codev-skeleton}/protocols/spir/consult-types/spec-review.md` | 514 | 386 | P1, P2, P6 | Rubric prose → lean focus-area contract. **Fixed a staleness bug (P6)**: the old Structure section hardcoded the 20-heading spec-template list, which Phase 6's spec.md rewrite made wrong — replaced with a reference to the delivered `protocols/spir/templates/spec.md`. Kept the `## Baked Decisions` section (canonical tokens) and the VERDICT block. Triggers R4 — see M10. |
| `{codev,codev-skeleton}/protocols/spir/consult-types/plan-review.md` | 406 | 322 | P1, P2 | Rubric → focus-area contract; kept the `## Baked Decisions` section and the VERDICT block. Triggers R4 — see M10. |
| `{codev,codev-skeleton}/protocols/spir/consult-types/impl-review.md` | 421 | 331 | P1 | "CRITICAL: Verify Before Flagging" → a verify-before-flagging contract; kept the SPIR-specific **Spec Adherence / Plan Alignment** focus areas and the **Scoping (Multi-Phase Plans)** section (which #742 requires stay absent from BUGFIX, i.e. present here) and the VERDICT block. |
| `{codev,codev-skeleton}/protocols/spir/consult-types/pr-review.md` | 392 | 316 | P1 | Kept the SPIR-specific completeness criteria (spec/plan/review trinity + `[Spec XXXX][Phase]` — the very things #742 keeps out of BUGFIX), the diff-syntax false-positive rule, and the VERDICT block **with its `PR_SUMMARY` extension**. |
| `{codev,codev-skeleton}/protocols/spir/consult-types/phase-review.md` | 421 | 331 | P1 | Byte-identical twin of impl-review.md (as before this phase) — same rewrite. |

## M10 — one retirement (R4), CLASS PRE-APPROVED, executed

Rewriting `spec-review.md` + `plan-review.md` to P1/P2 trips Spec 746's **Phase 3** `expectPureAdditionDiff` on those two spir consult-types (the first two PHASE_3 files; the aspir + air ones follow in Phases 8–9). This is covered by the **class pre-approval** (1280-retirements.md), so it executes without a per-item blocking gate — but honours all three invariants: (1) behaviour grep stays green (the `## Baked Decisions` sections keep `do not autonomously` / `COMMENT` / `REQUEST_CHANGES` / contradiction-handling); (2) the replacement guard ships in a mirrored separate commit (post-1280 baselines + inverted anti-vacuity in `spec-1280-prompt-deletion-guard.test.ts`); (3) this writeup + register entry R4 keep the audit trail. `impl/pr/phase-review` are not baked-decisions files — no retirement. The other PHASE_3 files (aspir spec/plan-review, air impl/pr-review) stay in force until their phase.

## Guards held green (verified)

- **VERDICT capability** — all five consult-types carry `VERDICT: [APPROVE | REQUEST_CHANGES | COMMENT]`.
- **bugfix-742** — spir pr/impl-review still differ from the BUGFIX versions.
- **template-delivery** — maintenance-run resolves with `# Maintenance Run NNNN` / `## Audit Findings` / `### Dependencies Cleaned`; the experiment/spike/maintain include wirings intact; audit-report + lessons-learned stay codev-local (twin-parity exempt).
- **baked-decisions** — every assertion green except the two retired under R4 (grep + mirror-parity for spec/plan-review still pass).
