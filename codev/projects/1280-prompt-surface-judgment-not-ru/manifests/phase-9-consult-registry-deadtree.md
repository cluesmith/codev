# Phase 9 — consult-types pir/maintain + scar registry + dead-tree deletion (G5, G7, G4)

**Decisions**: 4 consult-types (G5) + the registry rebuild (G7) + the dead-tree deletion (G4) · **Three group-pure commits**.
**Batches**: 2 — (A) the 4 consult-type decisions; (B) registry + T4 + dead-tree deletion + routing-test update.

## Batch A — pir + maintain consult-types (G5, 4 decisions)

| File (both trees) | Old | New | Principles | Rationale |
|---|---:|---:|---|---|
| `{codev,codev-skeleton}/protocols/pir/consult-types/impl-review.md` | 507 | 413 | P1 | Decapped "CRITICAL", tightened to a contract; kept the PIR-specific focus areas (Plan Adherence, Review File Quality, dev-approval gate, PIR-specific UI/cross-platform concerns) and the VERDICT block. |
| `{codev,codev-skeleton}/protocols/pir/consult-types/pr-review.md` | 475 | 355 | P1 | Kept the PIR context (single-pass `max_iterations:1`, dev-approval already passed), the `Fixes #<N>` linkage, the diff-syntax rule, and VERDICT. |
| `{codev,codev-skeleton}/protocols/maintain/consult-types/impl-review.md` | 421 | 331 | P1 | These mirrored the old spir generic review prompt, so they take the **same rewrite** as the new spir impl-review (copied). VERDICT kept. |
| `{codev,codev-skeleton}/protocols/maintain/consult-types/pr-review.md` | 392 | 316 | P1 | Same — mirrors the new spir pr-review (with its `PR_SUMMARY`). |

Not baked-decisions files — **no retirement**.

## Batch B — scar registry (G7) + dead-tree deletion (G4)

| Item | What | Rationale |
|---|---|---|
| `codev/resources/scar-rules.yaml` (**new**, G7) | The 8 scar canonicals kept **byte-identical** to the Spec 1252 registry; `must_appear_on` **re-derived against the post-1280 surface**. | The P1/P4 rewrites removed the git-add prohibition from most prompts (`roles/builder.md` owns it now) and the dead tree is deleted, so the pre-rewrite lists were stale. Each list is exactly where its canonical appears today; all eight survive on CLAUDE.md + AGENTS.md. |
| `spec-1280-scar-rules.test.ts` (**new**, T4, G7) | Pins count=8 + the ids; enforces byte-identical carriage on every listed surface (rewording fails); checks the primary-surface guarantee. | Created in Phase 9 — the first phase where the surface has settled, so `must_appear_on` is meaningful. Mutation-verified: reword fails, delete fails. |
| `codev-skeleton/porch/prompts/` **deleted** (10 files, M6, G4) | The dead Ralph-SPIR-era prompt tree with no runtime consumer. | M6-verified by an untruncated repo-wide search: the only `porch/prompts` references are the unrelated code module `porch/prompts.ts`, historical project docs, and the measurement DEAD bucket (now 0). |
| `review-prompt-routing.test.ts` **updated** (M10, Spec 987, G4) | Removed the routing check on the deleted `codev-skeleton/porch/prompts/review.md`. | Consequence of the M6 deletion. The live review prompts/templates remain routing-checked; measurement instrument T1 still passes (it asserts on the script text, not the tree's existence). |

## Guards held green (verified)

- **T4** — 8 rules, byte-identical carriage; reword + delete mutations fire.
- **VERDICT** — all four consult-types carry the parse block.
- **review-prompt-routing** + **measurement instrument** — green after the dead-tree deletion.
