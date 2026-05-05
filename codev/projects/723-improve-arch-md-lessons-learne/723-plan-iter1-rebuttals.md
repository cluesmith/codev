# Plan Iteration 1 — Rebuttal to Review Feedback

**Date**: 2026-05-05
**Reviewers**: Gemini 3 Pro (APPROVE), GPT-5.4 Codex (REQUEST_CHANGES), Claude (APPROVE)

## Codex feedback (REQUEST_CHANGES) — addressed

### 1. "Lives where" matrix rows still left open

**Action taken**: Locked the matrix in Phase 2 with 8 explicit rows. Removed the "Final exact rows are locked at plan-approval time per the spec's open question" deferral. Added one row beyond the issue's starter list — the "retired component" row — to address the graveyard pattern visible in the live `arch.md`. The plan now states explicitly: "no further refinement during implementation."

**Rebuttal**: Agreed. The deferral was a nicety left over from the spec-phase open question; this is the right time to lock it.

### 2. `codev init` smoke test underspecified — `dist/cli.js` not present

**Action taken**: Verified `ls packages/codev/dist/cli.js` returns "No such file or directory" in this worktree. Updated the smoke test in Phase 2 with an explicit command sequence:

```bash
pnpm --filter @cluesmith/codev build
mkdir -p /tmp/codev-723-smoke
node packages/codev/dist/cli.js init /tmp/codev-723-smoke
```

Added a documented fallback ("verify the skeleton template content directly: `cat codev-skeleton/templates/arch.md`") that exercises the same correctness property without going through the propagation pipeline. Same pattern applied to the skill-propagation-via-`codev update` test.

**Rebuttal**: Agreed. The brittleness was real — Codex caught a concrete error before it became a Phase 2 blocker.

### 3. Phase 1 wording incorrectly implies self-hosted skill lives under `codev/`

**Action taken**: Updated Phase 1 Objectives to spell out artifact locations explicitly:
- The skill lives at **repo-root** `.claude/skills/update-arch-docs/SKILL.md` (not under `codev/`) and at `codev-skeleton/.claude/skills/update-arch-docs/SKILL.md`.
- Templates live at `codev/templates/<file>.md` and `codev-skeleton/templates/<file>.md`.

**Rebuttal**: Agreed. The phrasing was ambiguous and the deliverables list was already correct, so this is just tightening the prose.

## Gemini feedback (APPROVE) — addressed

### 1. Vitest does not accept `--testPathPatterns`

**Action taken**: Replaced `--testPathPatterns=scaffold` with `scaffold` (positional argument) in all four occurrences across the plan. Verified by recalling Vitest's CLI — positional args are matched against test file paths.

**Rebuttal**: Agreed. Quick fix.

### 2 & 3. Non-blocking confirmations on test architecture and skill discovery

No action needed — these are confirmations that the plan's assumptions hold.

## Claude feedback (APPROVE) — addressed

### 1. Skill propagation test setup needs a one-liner

**Action taken**: Spelled out the test as a concrete bash sequence (init scratch project → delete `update-arch-docs` to simulate "missing the new skill" → `codev update` → verify the skill returned). Same structure as the `codev init` smoke test for consistency.

**Rebuttal**: Agreed. Concrete command sequences make the verification battery reproducible.

### 2. MAINTAIN cross-references skill — first time the protocol references a skill; phrase carefully

**Action taken**: Noted the observation. The actual phrasing happens during Phase 2 implementation, not in the plan itself. Marking this as a "be deliberate when authoring" note carried into Phase 2 rather than a plan edit.

**Rebuttal**: Agreed in principle; deferred to implementation. The plan correctly identifies the cross-reference as a deliverable; precise wording is an authoring task.

### 3. Audit-mode prose should echo "when in doubt, KEEP"

**Action taken**: Added explicit instruction inside the Phase 1 spec for the `## Mode: audit-mode` section: "Echo the existing MAINTAIN 'when in doubt, KEEP' rule explicitly so audit-mode does not over-prune; bias toward fewer, higher-confidence cuts with rationale, not maximal aggression."

**Rebuttal**: Agreed in full. This is exactly the kind of nuance that distinguishes a useful audit pass from a paralysis-inducing one.

## Net assessment

All three Codex REQUEST_CHANGES items addressed. All three Gemini notes addressed (one substantive: Vitest CLI; two confirmations). All three Claude observations addressed (one substantive: audit-mode "when in doubt, KEEP"; one as deferred-to-implementation; one as explicit command sequence). No reviewer point rejected. The plan moves from "REQUEST_CHANGES" to ready for plan-approval.
