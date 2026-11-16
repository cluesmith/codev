# bugfix-1903 thread — PIR prompt repair + `{{issue.number}}` substitution

## 2026-11-15 — investigate

Reproduced #8 live: this builder's own BUGFIX investigate task from porch renders
`**Issue**: #{{issue.number}} — {{issue.title}}` literally. Same tag in PIR plan/implement/review,
AIR implement/pr, BUGFIX investigate/fix/pr.

Checked every finding against porch source before editing. What porch actually does:

- **Substitution** (`porch/prompts.ts:139`): `/\{\{(\w+)\}\}/` — dotted names never match; only
  `project_id, title, artifact_name, current_state, protocol, pr_create_command, summary, goal,
  plan_phase_*` exist. Fix in porch, not in prompts: derive the issue id from the porch id
  (`1234` for PIR/AIR/SPIR, `bugfix-1234` for BUGFIX, tracker keys) with the existing
  `issueNumberFromPorchId` (moved from `agent-farm/commands/reset/context.ts` to
  `lib/issue-id.ts`), fetch the issue once, feed `issue.number` / `issue.title` and the Goal
  header. Bonus: BUGFIX's Goal header shows the slug today because `fetchIssue("bugfix-N")` fails.
- **Consult** (`next.ts:584-592`): porch emits `consult -m <m> --protocol pir --type <type>
  --project-id <id> --output <projectDir>/<id>-review-iter1-<m>.txt` as a TASK the builder runs.
  Not automatic.
- **Verify type**: `protocol.json` `"type": "impl"` → consult loads `pir/consult-types/impl-review.md`
  (pre-dev-approval review). `"type": "pr"` loads `pr-review.md`; `consult --type pr` finds the PR
  for the current branch, which exists by then. impl-review.md has no other consumer.
- **Models**: `["gemini","codex"]` in JSON; resolved config > protocol via
  `resolveConsultationModels`. Owner ruling: 3 by default.
- **REQUEST_CHANGES** (`next.ts:653-745`): porch emits "write rebuttal to
  `<id>-review-iter1-rebuttals.md`, then `porch done`". `porch done` with build_complete already
  true auto-requests the `pr` gate (`index.ts:533-553`); or `porch next` sees the rebuttal,
  iteration 1 ≥ max_iterations 1 → force-advance → gate. Either way no second consult.
  The prompt's "no rebuttal, don't re-run porch done" is wrong.
- **Re-running `porch done` at the gate** (`review.md:194`): does NOT re-consult — `next()` checks
  the pending gate before build/verify, so it keeps returning `gate_pending`.
- **Verdicts**: reviewers write `VERDICT: APPROVE`; porch's `parseVerdict` scans for it and prints
  `model: VERDICT` in the gate-pending / rebuttal task. The prompt's `grep '^approve'` always
  yields UNKNOWN.
- **Gate notification**: `notify.ts` — architect-bound notifications removed deliberately; porch
  only wakes the builder after `porch approve` run from OUTSIDE the worktree. So the builder must
  `afx send architect` at each gate; `next.ts:354` "architect has already been notified" is false.
- **After pr approval**: `porch next` → gate approved, no next phase → `verified` → `complete` +
  "Merge the pull request" task (forge `pr-merge`). `gate_status` exists only in
  `porch status --json`. PR numbers live in `pr_history[].pr_number`.

Scope: porch ~30 LOC + test, `next.ts` one string, PIR files in both trees. Fits BUGFIX (prompt
text is the bulk, mirrored ×2). No AIR/BUGFIX prompt edits needed once porch substitutes.
Deleting `pir/consult-types/impl-review.md` (dead after `type: pr`).

## 2026-11-15 — fix

- porch: `prompts.ts` derives the issue from the porch id, fetches it once, substitutes dotted
  `{{issue.number}}` / `{{issue.title}}` (unknown names still left as written; title left
  unrendered if the fetch fails). `issueNumberFromPorchId` moved to `lib/issue-id.ts`.
  `next.ts` gate-pending text now tells the builder to `afx send architect` and how to record the
  relayed approval. Regression test: 20/21 fail without the fix (the 21st is a no-issue guard).
- PIR (both trees, byte-identical): `verify.type` impl→pr, 3 models; deleted the now-unloaded
  `consult-types/impl-review.md`; review.md steps 4a–10 rewritten to the walked flow; plan/implement
  get the notify step + architect-relays/builder-approves wording; Baked Decisions added to
  protocol.md, builder-prompt, plan, implement, pr-review.
- Walked a real PIR project through every gate in a scratch repo with the worktree's porch
  (consult files simulated). `verify: null` phases are once-phases, so `porch done` → `porch next`
  reaches the gate directly — no stall there. Old verdict grep returned UNKNOWN on a real
  `VERDICT: REQUEST_CHANGES` file, as the issue said.
- Not touched (outside scope, sibling builder): `consult` skill's `--protocol` list omits pir.

## 2026-11-15 — pr

- PR #1904. Installed `consult` couldn't auto-detect the project ("Multiple projects found" —
  the bug bugfix-1898 fixed, not yet in the installed release); re-ran with `--project-id`.
- CMAP: gemini COMMENT (agy exit 3, skipped). codex REQUEST_CHANGES → fixed → APPROVE:
  `fetchIssue` ignored a configured non-GitHub forge (pre-existing in `getProjectSummary` too) →
  pass `cwd: workspaceRoot`, unmocked forge test; plus a guard on PIR `protocol.json` + tree
  identity. claude APPROVE; applied its two nits (porch's own gate-approved wake-up; `porch done`
  not `porch next` after a rebuttal, to avoid a `force_advanced` record).
- Flake: one `porch done` test check failed on the known unhandled `ERR_INTERNAL_ASSERTION` from
  `tunnel-edge-cases.test.ts` teardown (same as bugfix-1898 saw); all tests green, clean on retry.
