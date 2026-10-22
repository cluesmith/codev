# 1595 review iter1: dispositions

## Gemini
Skipped (agy exit 3), non-blocking.

## Codex (REQUEST_CHANGES)
- **Untracked context/rebuttal files under codev/projects/1595-*/** → **Addressed**: all 14 committed with this iteration (the repo tracks rebuttals and context records; only `*.txt` transcripts are gitignored).
- **Spec and plan lack `approved`/`validated` frontmatter** → **Rebutted**: that frontmatter marks artifacts approved *before* spawn so porch can skip their phase. This spec and plan were approved through porch's own `spec-approval` and `plan-approval` gates (porch state records both), which is the authority here. (Correction from PR round 2: some recent specs do carry `approved:`; the conclusion rests on the porch gate records, not on that claim.)

## Claude (APPROVE)
- **`/api/agent-lifecycle` not on the tunnel block list** → **Addressed**: added to `BLOCKED_PATH_SEGMENT` in `tunnel-client.ts` (bare, workspace-scoped and percent-encoded forms blocked; lookalike not), test added.
- **Hooks-deletion crash loop** → **N/A**: documented limitation; bounded-relaunch guard proposed in the PR description as a follow-up, per the architect ruling.
- **Served `idle` counts as waiting immediately on the status bar/badge** → **N/A**: SC4 as approved at the spec gate (owner default); noted in the review as the intended behavior change.
- **Some rebuttals untracked** → **Addressed**: as Codex point 1.
