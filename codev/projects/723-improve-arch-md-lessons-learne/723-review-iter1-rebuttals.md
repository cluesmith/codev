# Review Iteration 1 — Rebuttal to PR-Type Consultation Feedback

**Date**: 2026-05-05
**Reviewers**: Gemini 3 Pro (APPROVE), GPT-5.4 Codex (REQUEST_CHANGES), Claude (APPROVE)

## Gemini (APPROVE)

No issues raised. Verdict: "The implementation perfectly executes the spec and plan, delivering the governance artifacts with exact parity and complete adherence to all constraints."

## Codex (REQUEST_CHANGES) — addressed

### 1. Spec criterion #103 says `codev init` produces the new templates; reality is that init does not copy resource templates

**Investigation**: Read `packages/codev/src/commands/init.ts:92-93` and `adopt.ts:128`. Both files carry identical explicit comments:

> `// Framework files (protocols, roles, consult-types, templates) are NOT copied. They resolve at runtime from the installed npm package via the unified file resolver.`

This is a **deliberate framework design decision**, not pre-existing init drift. Templates are resolved at runtime from the installed `@cluesmith/codev` npm package via the unified file resolver. Changing this would affect every framework template (protocols, roles, consult-types, cheatsheet, lifecycle), not just arch.md/lessons-learned.md, and is out of scope for this spec.

**Action taken**: 
1. The spec's success criterion #103 was based on an implementer misunderstanding of the framework's propagation model. The honest path is to align the artifacts with reality, not flip a foundational design choice that's out of scope. Updated the review doc's smoke-test section to document this as a "Spec deviation noted" — the spirit of the criterion (template content reaches consumers) is satisfied via runtime resolution and the manual-copy command now documented in the new arch.md template.
2. Updated `codev/templates/arch.md`'s "Note on propagation" section. The previous text incorrectly said templates "propagate to new projects via `codev init`/`adopt`". The new text explicitly states that init/adopt/update do NOT copy templates by design, and provides a manual-copy command for projects that want to opt into the richer template.
3. Mirrored the change to `codev-skeleton/templates/arch.md` (byte-identical).
4. Updated the review doc's spec-acceptance-criteria final check to reference the spec deviation explicitly.

**Rebuttal**: Codex correctly identified the documentation/reality mismatch and the unmet success criterion. The substance is addressed by aligning the artifacts and review with reality. Implementing init.ts copying was considered and rejected as out-of-scope: it would overturn a foundational framework design that affects every template, not just the two this spec touches.

### 2. Shipped documentation overstates propagation behavior

**Action taken**: Same as #1 — the misleading "propagates via `codev init`/`adopt`" line in the new arch.md template has been replaced with an accurate "by design, init/adopt/update do not copy framework templates" statement, plus the explicit manual-copy command. Skeleton mirrored.

**Rebuttal**: Agreed in full. The mismatch between what the template said and what the system did was a real defect. Now corrected.

## Claude (APPROVE) — minor issues addressed

### 1. Duplicate project artifact files

**Observation**: 4 byte-identical duplicates exist in `codev/projects/723-*/` due to porch's naming convention generating both `implement-phase_1` and `phase_1` prefixed files.

**Action taken**: None. These are project-internal porch artifacts (by convention, gitignored in downstream projects but tracked here as part of the SPIR governance trail). The duplication is cosmetic and doesn't affect correctness; it's a porch behavior, not a builder choice. Leaving as-is per Claude's own note that they're "cosmetic rather than correctness-impacting."

**Rebuttal**: Acknowledged as a cosmetic porch quirk; not addressing in this PR.

### 2. Spec still references incorrect Vitest flag

**Observation**: Spec says `--testPathPatterns=scaffold`; this flag isn't valid in Vitest. The plan corrected to positional `scaffold`.

**Action taken**: None — Claude explicitly classified this as "non-blocking" and "no backport needed, just noting for completeness." The spec is approved and committed; the plan and review use the correct positional form. The spec's incorrect form is preserved as an honest record of what was approved and what was discovered during implementation.

**Rebuttal**: Acknowledged as a minor spec-time error caught at plan-review time. Noted in the review's lessons-learned candidate list ("Plan checks should test the actual change surface") for next MAINTAIN run.

## Net assessment

Codex's substantive REQUEST_CHANGES is addressed by aligning the new arch.md template's propagation note with the framework's actual resolve-at-runtime model, and by recording the spec deviation explicitly in the review doc's smoke-test section. Gemini APPROVE and Claude APPROVE stand. The two minor Claude observations are documented but not actioned (cosmetic; spec is approved/committed).
