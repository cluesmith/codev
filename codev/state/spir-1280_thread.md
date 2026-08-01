# spir-1280 — Prompt surface: judgment-not-rules rewrite (>50% always-on reduction)

## Specify phase — opening survey (2026-07-31)

Read the required prior art before drafting: `codev/reviews/1252-prompt-architecture-single-own.md`,
`1252-word-baseline.md`, `1252-word-after-phase7.md`, `1252-behavior-baseline.md`,
`scripts/measure-prompt-surface.sh`, issue #1279, and the ratified scar registry from
`builder/spir-1252:codev/resources/scar-rules.yaml` (all eight rules recovered verbatim).

### Finding that reshapes the spec: the committed measurement script measures a dead directory

`scripts/measure-prompt-surface.sh` computes `PORCH_PROMPT_MEAN` over
`codev-skeleton/porch/prompts/*.md` (10 files, mean 400w). The live code
(`packages/codev/src/commands/porch/prompts.ts:78`, `loadPromptFile`) resolves
`protocols/<protocol>/prompts/<file>.md` — a *different* directory. Repo-wide grep
(excluding node_modules/dist/.git) finds no code reading `porch/prompts`; the only hits
are historical spec/plan prose. That tree is a Ralph-SPIR-era leftover: its `specify.md`
opens "You are the **Spec Writer** hat in a Ralph-SPIR loop."

Consequences:
- The real SPIR phase prompts (expanded with their `{{> templates/...}}` includes) are
  specify 1402, plan 1169, implement 1065, review 1957 → **mean 1398**, not 400.
- The proxy also omits `roles/builder.md` (1837w), which the spawn wrapper inlines
  verbatim (verified against this worktree's own `.builder-role.md`).
- **The metric is blind to this project's single biggest target.** Cutting the phase
  prompts would not move `ALWAYS_ON_WORDS` at all under the current script.

Corrected always-on model (SPIR, I=10 task deliveries): 5,815 + 6,364 + 21,340 = **33,519**
vs the script's reported 21,702. Same methodology (served/expanded words), corrected inputs.
Spec makes fixing this M0 — before/after both measured with the corrected script, so the
>50% target is unaffected in kind, only in denominator.

Notified the architect; not blocking on it (the fix serves the stated intent of the goal
rather than contradicting a Baked Decision).

### Per-surface sizes captured for the cut plan

| Surface | Words | Notes |
|---|---:|---|
| CLAUDE.md / AGENTS.md | 5,815 each | byte-identical twins; hot tier inlined |
| roles/builder.md | 1,837 | inlined into every spawn |
| spir/protocol.md | 3,703 | inlined into every spawn |
| spir/builder-prompt.md | 824 | spawn wrapper |
| spir/prompts (expanded) | 1,398 mean | ×I per project — the dominant term |
| spir/templates | 632/649/641 | pulled in by specify/plan/review prompts |
| hot tier | 736 | capped, judgment-shaped, keep |
| spir/consult-types | 2,154 (5 files) | reviewer-side always-on, unmeasured today |

Cut plan and A/B design go in the spec.

### Architect ruling (2026-08-01) — M0 endorsed, two additions

Architect independently verified both claims against source (script line 89; the live
resolver at `prompts.ts:78`) and endorsed M0 as specced: fix the instrument first,
measure before AND after on it, >50% target unchanged against the corrected 33,519-word
baseline. Two additions folded into the spec:

1. **M0b** — the corrected script + corrected baseline land on `main` in a small early
   standalone PR (precedent #1290), not at the end of the branch, because the 1252
   baseline artifacts cite the wrong figure and are shared knowledge other work reads.
   Recorded as an architect-requested PR under the issue's PR strategy.
2. **Principle 7, "the instrument is part of the deliverable"** — written into the spec's
   Problem Statement with the lineage: this is the SECOND measurement defect in the 1252
   line (the first: 1252 originally shipped with no measurement plan at all, caught at a
   human gate, not by CMAP). Neither was caught by reading the instrument's code; both by
   asking what it claims to measure.

Spec drafted (5,800w) — carries the three architect-mandated designs (per-surface cut
plan with word targets, A/B non-inferiority design with a pre-registered decision rule,
scar-rule carriage plan) plus the rollback story. Headline: 33,519 → ≤15,900 (−52.7%),
with the phase-task term (71% of the post-rewrite budget) dominated by the hot tier,
which is explicitly exempt from cuts. Signalling SPEC_DRAFTED to porch for 3-way review.
