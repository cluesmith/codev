# Phase 4 — `builder-prompt.md` ×9 + the M10 retirement burden (G3)

**Decisions**: 9 · **Rollback group**: G3, commit-pure
**Batches**: 2 — (A) the nine prompt decisions; (B) the M10 test work and retirements register

## Batch A — 9 decisions

| File (both trees) | Old | New | Principles | Rationale |
|---|---:|---:|---|---|
| `{codev,codev-skeleton}/protocols/spir/builder-prompt.md` | 824 | 428 | P1, P4, P7 | Dropped what `roles/builder.md` now owns (flaky tests, multi-PR mechanics, Getting Started, the ALL-CAPS restrictions block). **Kept the Verify Phase** — see below. |
| `{codev,codev-skeleton}/protocols/pir/builder-prompt.md` | 898 | 335 | P1, P7 | Kept "Sitting at Gates" in full (four feedback channels, never self-approve) and "Resumption After Crash" — both PIR-specific and unavailable elsewhere. |
| `{codev,codev-skeleton}/protocols/aspir/builder-prompt.md` | 820 | 385 | P1, P4, P7 | Mirrors SPIR. **Restored `Follow the ASPIR protocol`** after my first draft dropped it — see M10. |
| `{codev,codev-skeleton}/protocols/research/builder-prompt.md` | 556 | 282 | P1, P7 | Kept both `consult` dispatch blocks verbatim (investigate + critique) and added preserve-disagreement to the principles. |
| `{codev,codev-skeleton}/protocols/air/builder-prompt.md` | 537 | 313 | P1, P7 | Kept the mission, the no-artifacts economy, and the escalation message with its exact `afx send` form. |
| `{codev,codev-skeleton}/protocols/experiment/builder-prompt.md` | 472 | 242 | P1, P7 | Kept the `Closes`/`Fixes` vs `Refs`/`Part of` distinction — a partial-implementation PR must not auto-close its issue. |
| `{codev,codev-skeleton}/protocols/bugfix/builder-prompt.md` | 429 | 224 | P1, P7 | Kept the regression-test-must-fail-first rule and the `--delete-branch` worktree warning. |
| `{codev,codev-skeleton}/protocols/spike/builder-prompt.md` | 400 | 244 | P1, P7 | Kept the three-step workflow, the skip-iterate escape, and "not feasible is a valuable finding". |
| `{codev,codev-skeleton}/protocols/maintain/builder-prompt.md` | 374 | 218 | P1, P7 | Kept soft-delete, one-removal-per-commit, and added the candidate-not-verdict audit discipline. |

## Batch B — M10 and the guard fixes

| File | Old | New | Principles | Rationale |
|---|---:|---:|---|---|
| `codev/resources/1280-retirements.md` | 0 | 520 | none | New. Retirements register; **R1 proposed, not applied** — awaiting architect approval. |
| `packages/codev/src/__tests__/spec-1280-phase-manifest.test.ts` | 0 | 0 | none | T16 scoped to this project by commit provenance — see below. |

## Two protections kept rather than retired

**#744 (per-phase PRs)** — all four asserted phrases preserved verbatim. The bug was builders
shipping a PR per plan phase, which the architect then had to close.

**#619 (cross-protocol mixup)** — my first draft replaced `Follow the ASPIR protocol` with a
template variable, which broke it. The original bug had the ASPIR prompt telling builders to
follow **SPIR** — wrong gates entirely. Restored, and I added the symmetric line to SPIR:
#619 was a *cross*-protocol mixup, and symmetry makes it harder to reintroduce in the other
direction.

## Kept despite duplicating the role doc: the Verify Phase

`roles/builder.md` mentions "verify phase" **only inside a notification string** — it does not
carry the mechanics (pull the integration branch, `porch done`, `verify-approval`,
`porch verify --skip`). Deleting it here would have repeated **precisely the bug Spec 1252
found**: the served SPIR builder prompt having silently lost its entire Verify Phase section.

Checked before deleting rather than after.

## M10 — one retirement PROPOSED, nothing retired unilaterally

**R1: `expectPureAdditionDiff` on the three builder-prompts.** Full trace in
`codev/resources/1280-retirements.md`. Summary:

- **Originating spec**: 746. The baseline is the **pre-746** file; the assertion proves 746's
  paragraph was *added* without deleting prior content.
- **Why it cannot survive**: Spec 1280 deliberately deletes prose, so the invariant is false by
  design — and permanently, since it forbids *any* future rewrite of these files.
- **Why re-baselining is not the escape**: 746's own **pollution check** requires the baseline
  to lack `## Baked Decisions`. A re-baselined file would contain it and fail. Silencing that
  check would gut the anti-vacuity property — the more valuable half of 746's protection.
- **Substance survives**: heading, `do not autonomously` carveout, contradiction wording and
  mirror-parity all still assert and pass, verified in all three files.
- **Replacement implemented but inert**: post-1280 baselines with the same machinery plus an
  inverted anti-vacuity check, so future silent deletion is still caught.

**Awaiting approval. Rejection is a legitimate outcome** — it means Phase 4 cannot rewrite those
three files and the phase is rescoped.

## T16 scoped to this project — second cross-project firing of my own guards

T16's original predicate was **repo-global**: *any* prompt-bearing path in `origin/main...HEAD`
had to appear in a **1280** manifest. Because the test lives in the shared suite, it fired on
other projects — **Spec 1307 was blocked by it**, and would have had to file paperwork in this
project's directory to go green.

That is a worse defect than the pinned-literal one it follows: a guard that taxes work it does
not govern, and demands foreign projects write into my ledger.

**Fix: provenance, not paths.** Only files touched by commits tagged `[Spec 1280]` on this
branch are this project's to document. Any other branch skips the assertion entirely. The
uncommitted-changes check is retained, so a pre-commit run still cannot pass vacuously.

Mutation-verified in both directions — a scoping fix that silently disabled the guard would be
the vacuous pass all over again.

## Incidental fix: closes #1293 (blank artifact filename)

**Found by the architect at inspection; independently verified before recording here.**

The PIR builder-prompt carried **2** `{{artifact_name}}` references before this phase and **0**
after. That resolves #1293's blank-filename symptom **by deletion**, and the verification shows
why the bug existed at all:

- `artifact_name` is substituted by **porch**, in `commands/porch/prompts.ts:102`, when it
  builds a **phase prompt**.
- The **spawn path never substitutes it** — `grep artifact_name spawn-roles.ts` returns nothing.

So a `{{artifact_name}}` placeholder in a *builder-prompt* could only ever render empty. Porch's
per-phase prompts were always the real owner of artifact naming; the builder-prompt was
referencing a variable nobody filled in for it.

**#1293 should be closed against this merge** rather than lingering fixed-but-open.

### Constraint this creates for Phase 5

The same placeholder is **legitimate and load-bearing in phase prompts** — 51 references across
the eleven Phase 5 targets. Deleting it there would break artifact naming outright. The rule is
positional, not textual: **remove `{{artifact_name}}` from spawn-time prompts, preserve it in
porch-substituted phase prompts.**
