# Phase 8 — consult-types: aspir, bugfix, air (G5)

**Decisions**: 9 (aspir ×5, air ×2, bugfix ×2) · **Rollback group**: G5 · **One rewrite commit**, plus the R6 retirement + replacement (two more, mirroring R1–R4).
**Batches**: 2 — (1) aspir, 5 decisions; (2) air + bugfix, 4 decisions.

**Levers**: P1/P2. **Capabilities preserved**: the `VERDICT: [APPROVE | REQUEST_CHANGES | COMMENT]` block in all nine (kept exactly; air/pr keeps `PR_SUMMARY`, bugfix/pr keeps its `PR_SUMMARY`); the Baked Decisions sections (canonical tokens) in aspir spec/plan-review + air impl/pr-review; and the **#742 divergence** — bugfix impl/pr-review stay distinct from the SPIR versions, keep the BUGFIX-only markers (`Fix #`, `regression test`, `## Out of Scope`, `status.yaml`), and introduce none of the forbidden SPIR criteria (`**Spec Adherence**`, `**Plan Alignment**`, `## Scoping (Multi-Phase Plans)`).

## Batch 1 — aspir consult-types (5 decisions)

| File (both trees) | Old | New | Principles | Rationale |
|---|---:|---:|---|---|
| `{codev,codev-skeleton}/protocols/aspir/consult-types/spec-review.md` | 514 | 386 | P1, P2, P6 | ASPIR mirrors SPIR's review criteria — these five were byte-identical to the pre-Phase-7 spir versions, so they take the **same rewrite** (copied from the new spir consult-types). Kept the `## Baked Decisions` section and VERDICT; carries the P6 stale-heading fix. Triggers R6 — see M10. |
| `{codev,codev-skeleton}/protocols/aspir/consult-types/plan-review.md` | 406 | 322 | P1, P2 | Same rewrite as spir plan-review; kept Baked Decisions + VERDICT. Triggers R6. |
| `{codev,codev-skeleton}/protocols/aspir/consult-types/impl-review.md` | 421 | 331 | P1 | Same rewrite as spir impl-review; kept the SPIR-specific Spec-Adherence/Scoping and VERDICT. |
| `{codev,codev-skeleton}/protocols/aspir/consult-types/pr-review.md` | 392 | 316 | P1 | Same rewrite as spir pr-review; kept the completeness criteria, diff-syntax rule, and VERDICT + `PR_SUMMARY`. |
| `{codev,codev-skeleton}/protocols/aspir/consult-types/phase-review.md` | 421 | 331 | P1 | Byte-identical twin of impl-review (as before) — same rewrite. |

## Batch 2 — air + bugfix consult-types (4 decisions)

| File (both trees) | Old | New | Principles | Rationale |
|---|---:|---:|---|---|
| `{codev,codev-skeleton}/protocols/air/consult-types/impl-review.md` | 420 | 369 | P1 | "CRITICAL: Verify Before Flagging" → a verify-before-flagging contract; kept the AIR framing (issue not spec, escalate to ASPIR at >300 LOC), the `## Baked Decisions` section, and VERDICT. Triggers R6 — see M10. |
| `{codev,codev-skeleton}/protocols/air/consult-types/pr-review.md` | 455 | 380 | P1 | AIR framing (PR body is the review, no `codev/reviews/`), Baked Decisions, diff-syntax rule, VERDICT. Triggers R6. |
| `{codev,codev-skeleton}/protocols/bugfix/consult-types/impl-review.md` | 641 | 551 | P1 | Light touch on a #742-fragile file: decapped "CRITICAL", tightened the focus areas, and kept the **`## Out of Scope`** section and every #742 marker verbatim. Not a baked-decisions file — no retirement. |
| `{codev,codev-skeleton}/protocols/bugfix/consult-types/pr-review.md` | 726 | 574 | P1 | Same: tightened focus areas, kept `## Out of Scope`, the BUGFIX-only markers, and VERDICT + `PR_SUMMARY`. No retirement. |

## M10 — one retirement (R6), CLASS PRE-APPROVED, executed

Rewriting aspir spec/plan-review + air impl/pr-review trips Spec 746's **Phase 3** `expectPureAdditionDiff` on those four files. Covered by the class pre-approval (1280-retirements.md); executes without a per-item gate, honouring the three invariants — behaviour grep green (Baked Decisions sections kept), replacement guard in a mirrored commit, this writeup + register entry R6. **After R6, all six PHASE_3 baked-decisions pure-addition guards are retired** (spir under R4, aspir + air under R6); the loop keeps a documenting test so it re-activates for any future PHASE_3 file. bugfix impl/pr-review are not baked-decisions files — no retirement.

## Guards held green (verified)

- **VERDICT** — all nine consult-types carry the parse block.
- **#742** — bugfix impl/pr-review differ from the SPIR versions, keep the BUGFIX markers, and carry none of the forbidden SPIR criteria.
- **baked-decisions** — every assertion green except the four retired under R6 (grep + mirror-parity for the four still pass).
