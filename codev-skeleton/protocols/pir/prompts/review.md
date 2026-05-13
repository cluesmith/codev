# REVIEW Phase Prompt

You are executing the **REVIEW** phase of the PIR protocol.

## Your Goal

Write a retrospective at `codev/reviews/{{artifact_name}}.md` — same shape as SPIR's review file, including **Architecture Updates** and **Lessons Learned Updates** sections. Then push, open a PR using the review file as the PR body, run CMAP-2 (Gemini + Codex), notify the architect, and merge on instruction.

The retrospective ships with the merged PR — it's durable team knowledge, searchable in `codev/reviews/` on `main`.

## Context

- **Project ID**: {{project_id}}
- **Issue Number**: #{{issue.number}}
- **Plan File**: `codev/plans/{{artifact_name}}.md`
- **Review File**: `codev/reviews/{{artifact_name}}.md` (you will write this)

## Prerequisites

- The `code-review` gate has been approved (you're here because `porch next` advanced you)
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
- Manual verification: <what was verified, on what platforms — pulled from the human's review at the code-review gate if known>

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

### 5. Run CMAP-2 Review

Run 2-way parallel consultation on the PR (type=impl — same consult type BUGFIX and AIR use at their PR-creation phase):

```bash
consult -m gemini --protocol pir --type impl &
consult -m codex --protocol pir --type impl &
```

Both should run in the background (`run_in_background: true`). **DO NOT proceed until both return verdicts.**

Wait for each consultation. Use `TaskOutput` to retrieve results. Record each verdict (APPROVE / REQUEST_CHANGES / COMMENT).

> **Why CMAP-2, not CMAP-3?** PIR's design parallels BUGFIX/AIR's consult footprint. The human already approved the *running* implementation at the `code-review` gate; CMAP at PR is a pre-merge hygiene + code-quality pass, not a functional review.

### 6. Address Any REQUEST_CHANGES

If any reviewer requested changes:

1. Read the specific issues
2. Fix them in code
3. Run build + tests
4. Push the updates
5. Re-run CMAP only if substantial changes were made

End with concrete verdicts from both models before continuing.

### 7. Append CMAP Outcome to PR Body

Once you have both verdicts, append them to the PR body:

```markdown
## CMAP Review

- **Gemini**: APPROVE / REQUEST_CHANGES (one-line summary)
- **Codex**: APPROVE / REQUEST_CHANGES (one-line summary)
```

Use `gh pr edit <PR-number> --body-file <updated-body>` to apply.

### 8. Notify the Architect

```bash
afx send architect "PR #<M> ready for review (PIR #{{issue.number}}). CMAP: gemini=<verdict>, codex=<verdict>"
```

This is the only notification you send.

### 9. Wait for Merge Instruction

The architect reviews the PR. They will either:

- Tell you to merge → run the merge command (step 10)
- Request more changes → address them (loop back to step 5)
- Tell you to close without merging → `gh pr close <M>` and stop

### 10. Merge the PR

```bash
gh pr merge <PR-number> --merge
```

**Use `--merge`, not `--squash`.** Project convention: preserve individual commits for development history.

The `Fixes #{{issue.number}}` in the PR body auto-closes the GitHub issue.

### 11. Final Notification + Signal Phase Complete

```bash
afx send architect "PR #<M> merged for PIR #{{issue.number}}. Ready for cleanup."
porch done {{project_id}}
```

## Signals

```
<signal>PHASE_COMPLETE</signal>          # PR merged, project complete
<signal>BLOCKED:reason</signal>          # Cannot proceed
```

## What NOT to Do

- Don't squash-merge (`--squash`) — use `--merge`
- Don't merge without architect instruction
- Don't run `porch approve` for any gate yourself
- Don't push to main — only merge via PR
- Don't skip the Architecture Updates / Lessons Learned sections — porch checks enforce their presence (the section must exist; explaining "no changes needed" in one line is fine)

## Handling Problems

**If the PR cannot be created (e.g., merge conflicts with main):**
- Rebase on main: `git fetch origin main && git rebase origin/main`
- Resolve conflicts (do NOT use destructive shortcuts)
- Force-push with lease: `git push --force-with-lease`
- Re-run `gh pr create`

**If CMAP consults fail (e.g., model unavailable):**
- Retry once
- If still failing, notify the architect and ask whether to proceed without that model's verdict

**If the architect doesn't respond within a reasonable window:**
- Send one follow-up via `afx send architect "..."` after a few hours
- Do not auto-merge
