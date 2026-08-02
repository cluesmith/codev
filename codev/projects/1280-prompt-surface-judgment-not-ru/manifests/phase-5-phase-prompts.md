# Phase 5 — phase prompts: spir, aspir, pir (G4)

**Decisions**: 11 (spir ×4, aspir ×4, pir ×3) · **Rollback group**: G4, commit-pure
**Batches**: 2 — (1) SPIR + ASPIR, 8 decisions; (2) PIR, 3 decisions. Include wiring untouched
(no `template-delivery` M10), but the `specify.md` rewrite triggers **one M10 retirement, R2,
PROPOSED and left RED** — see the M10 section below. The SPIR/ASPIR pairs are near-identical (ASPIR = the SPIR
body + a one-line header fix), so Batch 1's per-file inspection is effectively four distinct diffs
mirrored, not sixteen.

**Levers**: **P2** (examples → interfaces) and **P1** (procedure → contract), per the spec's
`protocols/*/prompts/*.md` row. **P4** also applies: `roles/builder.md` (rewritten in Phase 2) now
owns the `git add -A` prohibition, flaky-test handling, consult handling and the never-edit-status.yaml
rule, so those repeats leave the phase prompts.

**Old / New are SERVED counts** (`{{> }}` includes expanded), the manifest's basis. The SPIR
specify/plan/review served totals still carry their **unchanged** template words — templates are
Phases 6–7 — so the prose actually rewritten shrank more than the served delta shows (raw prose:
specify 770→433, plan 520→299, review 1316→589). Files with no include (all implement, all pir)
have served == raw.

## Batch 1 — SPIR + ASPIR (8 decisions)

| File (both trees) | Old | New | Principles | Rationale |
|---|---:|---:|---|---|
| `{codev,codev-skeleton}/protocols/spir/prompts/specify.md` | 1400 | 1077 | P1, P2, P4 | Step-by-step "Process" → a "What must be true when you finish" contract. Kept the existing-spec / Baked-Decisions / contradiction-pause rules (a model gets these wrong without them) **in the canonical carveout wording** — `do not autonomously` / `pause` / `flag` (see M10 / R2 below), the `{{> …/spec.md}}` interface, all `<signal>` capabilities, the filename-sync and commit cadence. Deleted the "Include examples" note (**directly anti-P2**), the PISC-style padding and the What-NOT-to-do list already owned elsewhere. |
| `{codev,codev-skeleton}/protocols/aspir/prompts/specify.md` | 1400 | 1077 | P1, P2, P4 | SPIR body verbatim **plus a correctness fix**: the header said "the SPIR protocol" (see note below). Still includes SPIR's `spec.md` template (ASPIR ships no `templates/`). |
| `{codev,codev-skeleton}/protocols/spir/prompts/plan.md` | 1167 | 946 | P1, P2 | Replaced the "Good/Bad phase examples" lists (**P2 examples**) with the phase-quality **interface** — self-contained / independently-testable / valuable / committable — and the per-phase contract fields. Kept the `{{> …/plan.md}}` include, `PLAN_DRAFTED`, commit cadence. |
| `{codev,codev-skeleton}/protocols/aspir/prompts/plan.md` | 1167 | 946 | P1, P2 | SPIR body verbatim + the ASPIR header fix. |
| `{codev,codev-skeleton}/protocols/spir/prompts/implement.md` | 1064 | 386 | P1, P4 | Heaviest cut. Dropped the PISC emoji checklist, the Trust-Hierarchy ASCII, the "Avoiding Fixing Mode" narration and the **flaky-tests block (now owned by `roles/builder.md`)**. **Kept as contract**: the this-phase-only scope restriction (load-bearing — porch drives per phase), spec-as-source-of-truth, build+tests-must-pass, and every signal (`PHASE_COMPLETE` / `BLOCKED` / `AWAITING_INPUT`). |
| `{codev,codev-skeleton}/protocols/aspir/prompts/implement.md` | 1064 | 386 | P1, P4 | SPIR body verbatim + the ASPIR header fix. (No include; no `{{artifact_name}}` — matches the original.) |
| `{codev,codev-skeleton}/protocols/spir/prompts/review.md` | 1955 | 1228 | P1, P2, P4 | Procedure → contract; dropped the "Review Prompts for Reflection" padding and the What-NOT-to-do repeats. **Preserved every capability the guards pin**: the `{{> …/review.md}}` include, the hot/cold routing (`arch-critical.md` / `lessons-critical.md`) with the exact `## Architecture Updates` / `## Lessons Learned Updates` headings porch greps, the `## Consultation Feedback` contract, and the **`gh pr create … --body "$(cat <<'EOF' … EOF"` heredoc** with `Closes #`/`Refs #`/`auto-close` and no `{{issue.` token (bugfix-685). |
| `{codev,codev-skeleton}/protocols/aspir/prompts/review.md` | 1955 | 1228 | P1, P2, P4 | SPIR body verbatim + the ASPIR header fix; byte-identical skeleton twin (bugfix-685 checks this). |

## Batch 2 — PIR (3 decisions)

| File (both trees) | Old | New | Principles | Rationale |
|---|---:|---:|---|---|
| `{codev,codev-skeleton}/protocols/pir/prompts/plan.md` | 741 | 722 | P4 | Already substantially conformant (recent rewrite). Removed only the two `git add -A` prohibition repeats `builder.md` owns; kept the resumption/gate mechanics, the plan-structure heading interface, and the four-channel feedback handling. |
| `{codev,codev-skeleton}/protocols/pir/prompts/implement.md` | 1151 | 1132 | P4 | Same: dropped the two git-add prohibition repeats; preserved the `$MERGE_BASE` diff mechanics, dev-approval gate flow and the flaky-vs-unrelated-failure distinction (PIR-specific, load-bearing). |
| `{codev,codev-skeleton}/protocols/pir/prompts/review.md` | 2413 | 2380 | P4 | Largest file in the project, and the densest with load-bearing PIR mechanics (single-pass `max_iterations:1`, verdict escalation, gate-authorization, `--pr`/`--merged` records) — nearly all of it survives P1 as **contract, not padding**. One P4 win: the gate-not-prose merge rule is stated in full at its action points (steps 8–9), so the trailing restatement in "What NOT to Do" became a back-reference. Routing strings preserved. |

## The one content change beyond trimming: ASPIR header correctness

The four ASPIR phase prompts were **byte-identical to SPIR's and literally read "the SPIR protocol"**
in their headers (0 occurrences of "ASPIR" before this phase). That is the same cross-protocol
mislabel class **#619** ratified fixing in the ASPIR *builder-prompt* during Phase 4. I corrected the
header phrase to "the ASPIR protocol" in all four; the body is otherwise identical to the SPIR rewrite.
No test required spir==aspir identity (bugfix-685 pins only skeleton==codev per file, which holds).
Flagging explicitly because it is a change in content, not just economy.

## Why the PIR files barely moved

PIR's three prompts were rewritten recently to a standard close to P1/P2 already: contracts with
heading interfaces, commands that are capabilities rather than illustrative examples, and mechanics a
frontier model genuinely needs (PIR's consultation is single-pass, so the human at the `pr` gate is
the only re-check — that is not padding). Under the acceptance model (**principle conformance, size
reporting-only; a conformant file passes unchanged**) the honest action was the P4 de-duplication
above, not a rewrite for its own sake.

## M10 — one retirement PROPOSED (R2), suite deliberately left RED

Rewriting `specify.md` to P1/P2 trips Spec 746's **Phase 2** `expectPureAdditionDiff` guard on the
two SPIR/ASPIR `specify.md` files — the identical wall R1 hit, which R1 **explicitly foresaw and
left in force** ("the `PHASE_2_FILES` … guards remain in force"). Two responses, opposite kinds:

- **Behaviour grep — fixed in-phase, not retired.** My first draft reworded the Baked Decisions
  clause and dropped the canonical literals. Restored to `do not autonomously` / `pause` / `flag`
  (the preferred carveout phrasing anyway). All 188 behaviour/mirror/pollution assertions pass.
- **Pure-addition diff — proposed for retirement (R2), NOT applied.** A P1/P2 rewrite that deletes
  prose can never be a line-superset of the pre-746 baseline. Per M10 I do **not** re-baseline or
  edit the test unilaterally: the two assertions are **left RED** and R2 is written up in
  `codev/resources/1280-retirements.md` with the full trace, the behaviour-re-asserted mapping, and
  a replacement guard (extend `spec-1280-prompt-deletion-guard.test.ts` with post-1280 `specify.md`
  baselines + inverted anti-vacuity) that ships **only on approval**, in its own commit, mirroring R1.

**Current suite state: 2 RED** (`codev SPIR/ASPIR specify.md pure-addition diff`), by design,
pending the architect's R2 decision. `air/implement.md`'s Phase 2 guard and all Phase 3 guards stay
in force.

## Guards held green (verified, not assumed)

- **template-delivery** `#1279` WIRINGS — all six `{{> spir/templates/{spec,plan,review}.md}}`
  includes intact in spir+aspir specify/plan/review.
- **review-prompt-routing** — spir/aspir/pir review (both trees) still carry `arch-critical.md`,
  `lessons-critical.md`, `## Architecture Updates`, `## Lessons Learned Updates`, and none carries
  `add entries to lessons-learned.md`.
- **bugfix-685** — spir/aspir review carry the close-keyword, partial-fix keyword, `auto-close`, and a
  `{{issue.`-free PR-body heredoc; skeleton == codev.
- **T16 (phase-manifest)** — this manifest is what makes it pass; all 11 changed files listed.

Measurement instrument, `spec-1280-p6-delivery`, and `spec-1280-prompt-deletion-guard`: green.
