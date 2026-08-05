# Phase 6 — phase prompts: bugfix, air, maintain + spir templates (G4)

**Decisions**: 10 (bugfix ×3, air ×2, maintain ×2, spir templates ×3) · **Rollback group**: G4, commit-pure
**Batches**: 2 — (1) bugfix + air prompts, 5 decisions; (2) maintain prompts + spir templates, 5 decisions.

**Levers**: **P1** (procedure → contract) for the prompts, **P2** (annotated examples with filler →
heading interfaces) for the three templates. **P4** drops the `git add -A` repeats `roles/builder.md`
owns. Old/New are word counts (no `{{> }}` includes in any Phase 6 file, so served == raw).

**Capabilities preserved** (all guard-verified): the close-keyword PR-body heredocs (bugfix/pr, air/pr,
maintain/review), the **BUGFIX/AIR CMAP self-dispatch** (`consult -m … --protocol … --type pr` — these
protocols run their own consultation, unlike SPIR), the spec template's porch-required + delivery-checked
headings, the plan template's **machine-readable phases-JSON capability** (`has_phases_json` /
`min_two_phases`, kept at ≥2 phases), and the review template's hot/cold routing headings + `## Flaky
Tests` / `### Methodology Improvements`.

## Batch 1 — bugfix + air prompts (5 decisions)

| File (both trees) | Old | New | Principles | Rationale |
|---|---:|---:|---|---|
| `{codev,codev-skeleton}/protocols/bugfix/prompts/investigate.md` | 290 | 196 | P1 | "Process" steps → a reproduce / root-cause / scope-assessment contract. Kept the <300 LOC BUGFIX ceiling and all signals (`PHASE_COMPLETE` / `TOO_COMPLEX` / `BLOCKED`). |
| `{codev,codev-skeleton}/protocols/bugfix/prompts/fix.md` | 352 | 227 | P1, P4 | Contract form; kept the **fails-without-fix regression-test** rule and its untestable-change carve-out (a real BUGFIX contract). Dropped the git-add prohibition (builder.md owns). |
| `{codev,codev-skeleton}/protocols/bugfix/prompts/pr.md` | 491 | 391 | P1 | Kept the **close-keyword heredoc** (`Fixes #`/`Refs #`/auto-close, no `{{issue.`), the **CMAP self-dispatch** + wait-for-three-verdicts rule, and the `porch done` → `pr` gate hand-off. Dropped the ALL-CAPS "DO NOT proceed" padding (the substance — three verdicts before notifying — stays). |
| `{codev,codev-skeleton}/protocols/air/prompts/implement.md` | 442 | 316 | P1, P4 | Contract form; **kept the Baked Decisions clause verbatim** in canonical wording (`do not autonomously` / `pause` / `flag`) so Spec 746's grep stays green — see M10 / R3 below. Kept the <300 LOC ceiling and no-artifacts rule. |
| `{codev,codev-skeleton}/protocols/air/prompts/pr.md` | 471 | 337 | P1 | Kept the **close-keyword heredoc** (`Closes #`), the AIR "PR body IS the review — no `codev/reviews/` file" rule, and the optional-CMAP dispatch with its judgement guidance. |

## Batch 2 — maintain prompts + spir templates (5 decisions)

| File (both trees) | Old | New | Principles | Rationale |
|---|---:|---:|---|---|
| `{codev,codev-skeleton}/protocols/maintain/prompts/maintain.md` | 402 | 406 | P4 | Already a lean command runbook (ts-prune/depcheck audit, two-tier arch/lessons routing, CLAUDE↔AGENTS sync) — those commands are capabilities, that routing is contract, so it stays. Only the `Never git add -A` prohibition became a positive explicit-staging line (builder.md owns the rule). Net word count is flat by design. |
| `{codev,codev-skeleton}/protocols/maintain/prompts/review.md` | 310 | 310 | none | **Inspected, conformant, kept unchanged** — a concise operational runbook (build/test, doc-link check, run-file finalize, PR with close-keyword heredoc). Under the acceptance model a conformant file passes unchanged. |
| `{codev,codev-skeleton}/protocols/spir/templates/spec.md` | 632 | 246 | P2 | Filler placeholder prose → a clean heading interface. Kept the porch-required headings (`## Problem Statement`, `## Current State`, `## Desired State`, `## Success Criteria`), the delivery-checked `## Solution Approaches` + `SPEC vs PLAN BOUNDARY`. Dropped enterprise sections (Stakeholders sub-roles, fabricated Performance/Security numbers, Resource/Approval/Change-Log sign-offs). |
| `{codev,codev-skeleton}/protocols/spir/templates/plan.md` | 649 | 201 | P2 | Kept the **machine-readable `## Phases (Machine Readable)` JSON capability** (≥2 phases) and the per-phase interface (objective / files / deliverables / acceptance / test). Dropped Resource Requirements, Monitoring/Alerting, Dependency-Map ASCII, Approval sign-offs, Change Log. |
| `{codev,codev-skeleton}/protocols/spir/templates/review.md` | 641 | 293 | P2 | Kept the hot/cold routing headings (`arch-critical.md` / `lessons-critical.md`, `## Architecture Updates`, `## Lessons Learned Updates`), the delivery-checked `## Flaky Tests` + `### Methodology Improvements`, and the Consultation-Feedback interface. Dropped the Timelog / Autonomous-Operation / Consultation-metrics / Avoidable-Iterations tables. |

## M10 — one retirement PROPOSED (R3), suite left RED (1 assertion)

Rewriting `air/implement.md` to P1 trips Spec 746's **Phase 2** `expectPureAdditionDiff` — the third
and last PHASE_2 file (R1 retired PHASE_1, R2 retired the two specify.md files, R3 is air/implement.md).
Behaviour survives: the Baked Decisions grep + mirror-parity pass because the clause was kept in
canonical wording. Per M10 I do **not** re-baseline or edit the test unilaterally: the one assertion is
**left RED** and R3 is written up in `codev/resources/1280-retirements.md` with the full trace,
behaviour-re-asserted mapping, and a replacement guard (extend `spec-1280-prompt-deletion-guard.test.ts`
with a post-1280 air/implement baseline + inverted anti-vacuity) that ships **only on approval**, mirroring
R1/R2. R3 also raises — without assuming — whether the human wants to **pre-approve the class** so the
remaining PHASE_3 retirements in Phases 7–9 don't each need a per-file gate.

**Current suite state: 1 RED** (`codev AIR implement.md pure-addition diff`), by design, pending the
human R3 decision. All PHASE_3 guards remain in force.

## Guards held green (verified, not assumed)

- **bugfix-685** — bugfix/pr, air/pr, maintain/review carry the close-keyword, partial-fix keyword,
  `auto-close`, and a `{{issue.`-free PR-body heredoc; skeleton == codev.
- **template-delivery** — the SPIR specify/plan/review prompts' `{{> }}` includes still resolve, and the
  resolved content carries `## Problem Statement` / `## Solution Approaches` / `SPEC vs PLAN BOUNDARY`
  (spec) and `## Architecture Updates` / `## Lessons Learned Updates` / `## Flaky Tests` /
  `### Methodology Improvements` (review).
- **review-prompt-routing** — spir/templates/review.md keeps the routing strings and carries no
  `add entries to lessons-learned.md`.
- **baked-decisions (Spec 746)** — every assertion green except the one retired under R3.

Measurement instrument, `spec-1280-p6-delivery`, and `spec-1280-prompt-deletion-guard`: green.
