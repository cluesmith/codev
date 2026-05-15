# REVIEW Phase Prompt

You are executing the **REVIEW** phase of the PIR protocol.

## Your Goal

Write a retrospective at `codev/reviews/{{artifact_name}}.md` including **Summary**, **Architecture Updates**, and **Lessons Learned Updates** sections. Push, open a PR using the review file as the PR body, record the PR with porch, then signal completion — **porch runs CMAP-2 (Gemini + Codex) automatically** via the verify block. After CMAP approves, the `pr` gate fires; you notify the architect and wait at the gate while the human merges on GitHub.

The retrospective ships with the merged PR — it's durable team knowledge, searchable in `codev/reviews/` on `main`.

## Context

- **Project ID**: {{project_id}}
- **Issue Number**: #{{issue.number}}
- **Plan File**: `codev/plans/{{artifact_name}}.md`
- **Review File**: `codev/reviews/{{artifact_name}}.md` (you will write this)

## Prerequisites

- The `dev-approval` gate has been approved (you're here because `porch next` advanced you)
- Your branch contains the implementation commits
- Build and tests pass

## Process

### 1. Write the Review File

Create `codev/reviews/{{artifact_name}}.md` with these sections:

```markdown
# PIR Review: <Short Title>

Fixes #{{issue.number}}

## Summary

2–3 sentence overview of what was implemented and why. The reader is someone scanning `codev/reviews/` six months from now trying to understand what this PR did.

## Files Changed

Output of `git diff --stat main`, formatted as a list:

- `path/to/file.ts` (+12 / -3)
- `path/to/new-file.ts` (+45 / -0)

## Commits

Output of `git log main..HEAD --oneline`:

- `<sha>` [PIR #{{issue.number}}] First change
- `<sha>` [PIR #{{issue.number}}] Second change

## Test Results

- `npm run build`: ✓ pass
- `npm test`: ✓ pass (X tests, Y new)
- Manual verification: <what was verified, on what platforms — pulled from the human's review at the dev-approval gate if known>

## Architecture Updates

What changed in `codev/resources/arch.md` (or why no changes were needed). If this PR introduced or modified an architectural pattern, document it here AND update `arch.md` in this same commit. If no architectural updates are needed (typical for small fixes), write a single line explaining why: "No arch changes — this PR fixes a typo without affecting module boundaries."

Use the `update-arch-docs` skill if available (`.claude/skills/update-arch-docs/SKILL.md`) — it encodes the discipline for what NOT to include in arch docs.

## Lessons Learned Updates

What durable engineering wisdom emerged from this PR (or why no lessons were captured). Same pattern as Architecture Updates: if something is worth recording in `codev/resources/lessons-learned.md`, update both files in this commit. If not, explain why: "No lessons captured — change was mechanical."

## Things to Look At During PR Review

Tricky spots the PR reviewer should focus on. Honest — if a section was hard to get right, flag it.

## How to Test Locally

For reviewers pulling the branch:

- **View diff**: VSCode sidebar → right-click builder pir-{{project_id}} → **Review Diff** (auto-detects the repo's default branch)
- **Run dev server**: VSCode sidebar → **Run Dev Server**, or `afx dev pir-{{project_id}}`
- **What to verify**: <bullet list mapped to the plan's Test Plan>

## Flaky Tests (if any)

List any tests you skipped due to pre-existing flakiness, with file:line refs and a one-line rationale each. Omit this section if none.
```

### 2. Update Architecture / Lessons Docs (if applicable)

If your "Architecture Updates" or "Lessons Learned Updates" section calls out real changes, update `codev/resources/arch.md` and/or `codev/resources/lessons-learned.md` accordingly. Use the `update-arch-docs` skill if it's available.

If neither doc needs updating, your review file's sections still need to explain why — the porch `checks` block enforces section presence.

### 3. Commit the Review File (and arch / lessons updates)

```bash
git add codev/reviews/{{artifact_name}}.md
# Add arch.md / lessons-learned.md only if you changed them
git add codev/resources/arch.md           # only if changed
git add codev/resources/lessons-learned.md  # only if changed
git commit -m "[PIR #{{issue.number}}] Review + retrospective"
git push
```

### 4. Open the PR

```bash
PR_TITLE="<concise description of the change>"
BRANCH="$(git branch --show-current)"

gh pr create \
  --base main \
  --head "$BRANCH" \
  --title "$PR_TITLE" \
  --body-file codev/reviews/{{artifact_name}}.md
```

**Verify the PR body contains `Fixes #{{issue.number}}`** (it should — the review file has it at the top). If somehow missing, edit and re-apply:

```bash
gh pr edit <PR-number> --body-file codev/reviews/{{artifact_name}}.md
```

**Exception**: if this PR only partially addresses the issue, use `Refs #{{issue.number}}` instead — the issue stays open until a follow-up PR closes it.

### 4a. Record the PR with Porch

Immediately after creating the PR, tell porch about it so `status.yaml` carries the PR number and branch. This is a metadata-only call — it does NOT advance the phase or trigger CMAP:

```bash
porch done {{project_id}} --pr <PR-number> --branch "$(git branch --show-current)"
```

Without this, porch's `history:` for the project stays empty and downstream tooling (status views, analytics, audit trails) can't link the porch project to its GitHub PR.

### 5. Signal Completion to Porch (porch runs CMAP-2)

```bash
porch done {{project_id}}
```

Porch will:
1. Run the `pr_exists` / `review_has_arch_updates` / `review_has_lessons_updates` checks.
2. **Execute CMAP-2 (Gemini + Codex) automatically** via the protocol's `verify` block. Outputs land in `codev/projects/{{project_id}}-<slug>/{{project_id}}-gemini.txt` and `<id>-codex.txt`.
3. Evaluate verdicts:
   - **All APPROVE + checks pass** → review phase complete (the protocol is done from porch's perspective).
   - **Any REQUEST_CHANGES** → porch records the feedback in `status.yaml` and stays in the review phase. The output of `porch done` will surface the verdicts.

> **Why CMAP-2, not CMAP-3?** PIR's design parallels BUGFIX/AIR's consult footprint. The human already approved the *running* implementation at the `dev-approval` gate; CMAP at PR is a pre-merge hygiene + code-quality pass, not a functional review.

### 6. Handle Reviewer Feedback (if porch reports REQUEST_CHANGES)

If `porch done` reports any reviewer requested changes, run `porch next {{project_id}}` — it returns `status: tasks` with the reviewer feedback baked into the task description. Then:

1. Read the specific issues from the task output (and from `codev/projects/{{project_id}}-*/{{project_id}}-<model>.txt` for full context).
2. Fix them in code.
3. Run build + tests.
4. Commit + push the updates (the PR updates automatically — no new `gh pr create`).
5. Run `porch done {{project_id}}` again. Porch re-runs CMAP-2 against the updated diff.

Loop until porch reports all reviewers APPROVE.

### 7. Notify the Architect (after porch approves CMAP)

After `porch done` reports all reviewers APPROVE + checks pass, porch fires the **`pr` gate** (pending). Read the verdicts from porch state and notify:

```bash
GEMINI_VERDICT=$(grep -m1 -i '^\(approve\|request_changes\|comment\)' "codev/projects/{{project_id}}-"*/"{{project_id}}-gemini.txt" || echo UNKNOWN)
CODEX_VERDICT=$(grep -m1 -i '^\(approve\|request_changes\|comment\)' "codev/projects/{{project_id}}-"*/"{{project_id}}-codex.txt" || echo UNKNOWN)

afx send architect "PR #<M> ready for review (PIR #{{issue.number}}). CMAP: gemini=$GEMINI_VERDICT, codex=$CODEX_VERDICT. Awaiting human merge + pr gate approval. Full verdicts in codev/projects/{{project_id}}-*/."
```

This is the only notification you send at the gate.

### 8. Wait at the `pr` Gate

Your active work is done. **You do NOT run `gh pr merge`.** Capability is intentionally not in this protocol — the human owns the merge step on GitHub.

The human will:

1. Review the PR on GitHub (or by running the worktree via `afx dev pir-{{project_id}}` again)
2. Merge the PR via `gh pr merge <M> --merge`, the GitHub web UI, or any other tool
3. Approve the `pr` gate via VSCode (Cmd+K G) or `porch approve {{project_id}} pr --a-human-explicitly-approved-this` in a shell

Until the `pr` gate is approved, you sit idle in this pane. Porch will wake you when it fires (same wake-up mechanism as the earlier plan-approval and dev-approval gates).

If the human requests more changes instead of approving, push fixes and re-run `porch done {{project_id}}` (loops back to step 6). If they close the PR without merging, `gh pr close <M>` and stop.

### 9. After `pr` Gate Approval — Record the Merge

When porch wakes you with "Gate pr approved", the human has merged the PR. Record the merge so porch's `status.yaml` reflects the completed lifecycle:

```bash
# Read the PR number that was recorded at step 4a
PR=$(yq '.history[] | select(.event == "pr_recorded") | .pr' codev/projects/{{project_id}}-*/status.yaml | head -1)
# Or just: PR=<the number you used at step 4a>

porch done {{project_id}} --merged "$PR"
porch next {{project_id}}   # confirms protocol is complete (next: null)
```

Together with the `--pr` record from step 4a, this gives porch a complete view of the PR lifecycle (created → merged) for analytics, status displays, and audit trails.

### 10. Final Notification

```bash
afx send architect "PR #<M> merged for PIR #{{issue.number}}. Ready for cleanup."
```

Porch already marked the review phase complete at step 5 (or whichever iteration's `porch done` got all-APPROVE). The merge is a GitHub action, not a porch phase transition — but the `--merged` record in step 9a keeps porch's history complete.

## Signals

```
<signal>PHASE_COMPLETE</signal>          # PR merged, project complete
<signal>BLOCKED:reason</signal>          # Cannot proceed
```

## What NOT to Do

- **Don't run `gh pr merge` ever.** PIR intentionally does not give the builder merge capability — the human merges on GitHub (or via their own `gh pr merge`). If you find yourself reaching for the merge tool, you've misread the protocol. The `pr` gate is the porch-level synchronization point; you wait at it, you don't bypass it.
- Don't skip porch's PR/merge records (steps 4a, 9). The `--pr` record (step 4a) lets the gate-pending state link to the actual PR; the `--merged` record (step 9) closes the lifecycle in porch state. Skipping either leaves `history:` empty and downstream tooling blind.
- Don't run `porch approve` for any gate yourself
- Don't push to main — only merge via PR
- Don't skip the Architecture Updates / Lessons Learned sections — porch checks enforce their presence (the section must exist; explaining "no changes needed" in one line is fine)
- **Don't run `consult` commands yourself** — porch handles consultations via the `verify` block. Manually invoking `consult` causes CMAP to run twice.

## Handling Problems

**If the PR cannot be created (e.g., merge conflicts with main):**
- Rebase on main: `git fetch origin main && git rebase origin/main`
- Resolve conflicts (do NOT use destructive shortcuts)
- Force-push with lease: `git push --force-with-lease`
- Re-run `gh pr create`

**If porch's CMAP consults fail (e.g., model unavailable):**
- `porch done` will report the failure. Inspect `codev/projects/{{project_id}}-*/{{project_id}}-<model>.txt` for the failure details.
- Re-run `porch done {{project_id}}` once — porch will retry the consult.
- If the model is persistently unavailable, notify the architect and ask whether to proceed without that model's verdict. They may direct you to skip via a manual override.

**If the architect doesn't respond within a reasonable window:**
- Send one follow-up via `afx send architect "..."` after a few hours
- Do not auto-merge
