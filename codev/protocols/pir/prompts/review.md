# REVIEW Phase Prompt

You are executing the **REVIEW** phase of the PIR protocol.

## Your Goal

Write a retrospective at `codev/reviews/{{artifact_name}}.md` including **Summary**, **Architecture Updates**, and **Lessons Learned Updates** sections. Push, open a PR using the review file as the PR body, record the PR with porch, then signal completion. Porch then hands you the consultation commands (three reviewers by default — Gemini, Codex, Claude — unless `.codev/config.json` sets fewer) and you run them. The consultation is a *single advisory pass* (`max_iterations: 1`): its verdicts are surfaced to the human at the `pr` gate, **not** an iterate-until-APPROVE loop. You notify the architect (leading with any REQUEST_CHANGES) and wait at the gate. When the architect relays the human's approval, you record it with `porch approve` and merge the PR yourself.

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

Output of `git diff --stat "$MERGE_BASE"`, formatted as a list (resolve once: `DEFAULT_BRANCH=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||'); DEFAULT_BRANCH=${DEFAULT_BRANCH:-main}; MERGE_BASE=$(git merge-base "$DEFAULT_BRANCH" HEAD)`. Anchoring at the merge-base keeps the file list scoped to *your* changes, not commits the base branch absorbed after you branched.):

- `path/to/file.ts` (+12 / -3)
- `path/to/new-file.ts` (+45 / -0)

## Commits

Output of `git log "$MERGE_BASE"..HEAD --oneline`:

- `<sha>` [PIR #{{issue.number}}] First change
- `<sha>` [PIR #{{issue.number}}] Second change

## Test Results

- `npm run build`: ✓ pass
- `npm test`: ✓ pass (X tests, Y new)
- Manual verification: <what was verified, on what platforms — pulled from the human's review at the dev-approval gate if known>

## Architecture Updates

What you routed where, across the **two tiers** (Spec 987): **HOT** = `codev/resources/arch-critical.md` (tiny, hard-capped, always-injected) for a behavior-changing cross-cutting fact (demote a weaker entry into `arch.md` if the hot file is full); **COLD** = `codev/resources/arch.md` for reference detail. Update the file(s) you routed to in this same commit. If nothing qualifies, write a single line explaining why: "No arch changes — this PR fixes a typo without affecting module boundaries."

Use the `update-arch-docs` skill if available (`.claude/skills/update-arch-docs/SKILL.md`) — it encodes the discipline for what NOT to include in arch docs and how the hot/cold tiers relate.

## Lessons Learned Updates

What durable wisdom emerged, routed by tier: **HOT** `codev/resources/lessons-critical.md` for a behavior-changing cross-cutting rule (cap + displacement); **COLD** `codev/resources/lessons-learned.md` for a spec-narrow recipe/reference tip. Update the file(s) you routed to in this commit. If nothing qualifies: "No lessons captured — change was mechanical."

## Things to Look At During PR Review

Tricky spots the PR reviewer should focus on. Honest — if a section was hard to get right, flag it.

## How to Test Locally

For reviewers pulling the branch:

- **View diff**: VSCode sidebar → right-click builder pir-{{project_id}} → **View Diff** (auto-detects the repo's default branch)
- **Run dev**: VSCode sidebar → **Run Dev**, or `afx dev pir-{{project_id}}`
- **What to verify**: <bullet list mapped to the plan's Test Plan>

## Flaky Tests (if any)

List any tests you skipped due to pre-existing flakiness, with file:line refs and a one-line rationale each. Omit this section if none.
```

### 2. Update Architecture / Lessons Docs (if applicable)

If your "Architecture Updates" or "Lessons Learned Updates" section routed real changes, update the tier you chose — `arch-critical.md` / `lessons-critical.md` (hot, capped) or `arch.md` / `lessons-learned.md` (cold) — accordingly. Use the `update-arch-docs` skill if it's available.

If neither doc needs updating, your review file's sections still need to explain why — the porch `checks` block enforces section presence.

### 3. Commit the Review File (and arch / lessons updates)

```bash
git add codev/reviews/{{artifact_name}}.md
# Add the governance file(s) you routed to, only if changed
git add codev/resources/arch-critical.md      # hot — only if changed
git add codev/resources/lessons-critical.md   # hot — only if changed
git add codev/resources/arch.md               # cold — only if changed
git add codev/resources/lessons-learned.md    # cold — only if changed
git commit -m "[PIR #{{issue.number}}] Review + retrospective"
git push
```

### 4. Open the PR

```bash
PR_TITLE="[PIR #{{issue.number}}] <concise description of the change>"
BRANCH="$(git branch --show-current)"

export CODEV_PR_TITLE="$PR_TITLE"
export CODEV_PR_BODY="$(cat codev/reviews/{{artifact_name}}.md)"
export CODEV_PR_HEAD="$BRANCH"

{{pr_create_command}}
```

The command above is your forge's `pr-create` concept, substituted by porch (`gh pr create` by default). It prints `{"number": <int>, "url": "<url>"}`. The inputs are **exported** so an inline override that spells `--title "$CODEV_PR_TITLE"` sees them too. The body goes in as an environment variable, not `--body-file` — read the created PR back and confirm the body arrived intact before moving on.

**Verify the PR body contains `Fixes #{{issue.number}}`** (it should — the review file has it at the top). If somehow missing, edit and re-apply:

```bash
gh pr edit <PR-number> --body-file codev/reviews/{{artifact_name}}.md
```

**Exception**: if this PR only partially addresses the issue, use `Refs #{{issue.number}}` instead — the issue stays open until a follow-up PR closes it.

### 4a. Record the PR with Porch

Immediately after creating the PR, tell porch about it so `status.yaml` carries the PR number and branch. This is a metadata-only call — it does NOT advance the phase:

```bash
porch done {{project_id}} --pr <PR-number> --branch "$(git branch --show-current)"
```

Porch stores it as `pr_history[].pr_number` in `codev/projects/{{project_id}}-*/status.yaml`. Without it, status views and audit trails can't link the porch project to its PR, and the `--merged` record in step 9 fails.

### 5. Signal Completion, Then Run the Consultation Porch Hands You

```bash
porch done {{project_id}}
porch next {{project_id}}
```

`porch done` runs the `pr_exists` / `review_has_arch_updates` / `review_has_lessons_updates` checks and marks the build complete. Porch does **not** run the consultation itself: `porch next` returns a task with one `consult -m <model> --protocol pir --type pr ... --output <file>` command per reviewer. Run exactly those commands, in parallel in the background, and wait for all of them — the `--output` paths are where porch reads the verdicts (`codev/projects/{{project_id}}-*/{{project_id}}-review-iter1-<model>.txt`). Then:

```bash
porch next {{project_id}}
```

- **Every verdict `APPROVE` or `COMMENT`** → porch requests the `pr` gate and returns `gate_pending`, listing each `model: VERDICT`. Go to step 7.
- **Any `REQUEST_CHANGES`** → porch returns a "Write rebuttal" task naming each review file with its verdict and the rebuttal path. Go to step 6.
- **A reviewer is missing** (the command failed) → porch re-emits the missing commands. Run them again.

Take verdicts from porch's output — it parses each file's `VERDICT:` line. The consultation runs **exactly once** (`max_iterations: 1`).

> **Why consult after the human already approved the running code?** The human approved the *running* implementation at the `dev-approval` gate; the consultation at the PR is a pre-merge hygiene + code-quality pass, not a functional review.

### 6. Handle a REQUEST_CHANGES Verdict (single-pass — no automated re-review)

Porch will not re-run the consultation after you respond: the rebuttal moves you straight to the `pr` gate. The correctness backstop for a consultation-flagged issue is therefore **(a)** your fix + a regression test and **(b)** the human's `pr`-gate review — *not* an independent model re-review. Treat that as load-bearing: a substantive finding you "address and rebut" gets no second AI opinion.

For each `REQUEST_CHANGES` point:

1. Read the finding in full in the review file porch named.
2. **Assess it honestly:**
   - **Real defect** (correctness / cancellation / security / data-loss): fix it in code, add a regression test that fails without the fix, commit + push (the PR updates automatically — no second PR).
   - **False positive / out of scope**: no code change; say why.
3. Write the disposition of every point (what you changed, or why you disagree) to the rebuttal file porch named (`{{project_id}}-review-iter1-rebuttals.md`), and summarize it in the review file's **"Things to Look At During PR Review"** section. Commit and push.
4. Run `porch done {{project_id}}` — this requests the `pr` gate. `porch next {{project_id}}` then returns `gate_pending`.

### 7. Notify the Architect (gate is now pending)

Porch does not notify the architect at a gate — you do. If any verdict is `REQUEST_CHANGES`, **lead with it and state the disposition**, because PIR will not re-review it and the human at the `pr` gate is the only remaining check. Fill in the PR number and each `model=VERDICT` from porch's output:

```bash
# Any REQUEST_CHANGES:
afx send architect "⚠️ PR #<M> (PIR #{{issue.number}}): consultation returned REQUEST_CHANGES (<model>=<VERDICT>, ...). Disposition: <one line — fixed in <sha> + regression test | rebutted, see review 'Things to Look At'>. PIR is single-pass — this was NOT independently re-reviewed; please verify the fix/rebuttal at the pr gate before approving. Reviews in codev/projects/{{project_id}}-*/."

# Otherwise:
afx send architect "PR #<M> ready for review (PIR #{{issue.number}}). Consultation: <model>=<VERDICT>, ... Awaiting pr gate approval. Reviews in codev/projects/{{project_id}}-*/."
```

A `REQUEST_CHANGES` must never reach the human as an undifferentiated status line — it is the one verdict PIR's single-pass design cannot re-check.

### 8. Wait at the `pr` Gate

End your turn and stay in the interactive session. The human reviews the PR on GitHub (or runs the worktree via `afx dev pir-{{project_id}}` again).

- **They request changes**: push fixes to the PR branch, update the review file if what it describes changed, and tell the architect what you changed. The gate stays pending; no porch command is needed. Re-running `porch done` does **not** re-run the consultation — porch keeps returning `gate_pending` until the gate is approved.
- **They close the PR without merging**: `gh pr close <M>` and stop.
- **They approve**: the architect relays the human's approval to you. Only then, record it:

  ```bash
  porch approve {{project_id}} pr --a-human-explicitly-approved-this
  ```

Neither a consultation `APPROVE` nor approving prose that does not relay the human's decision ("looks good", "lgtm") authorizes the merge.

### 9. After Approval — Merge and Record

```bash
porch next {{project_id}}
```

The response must be `status: complete` with a **"Merge the pull request"** task. If it is still `gate_pending`, the approval was not recorded — do not merge. (`porch status {{project_id}} --json` shows `gate_status` for the current gate, before this `porch next` moves the project to `verified`.)

**Check whether the human already merged it before merging** — never blind-merge:

```bash
PR=<PR-number from step 4a>
STATE=$(gh pr view "$PR" --json state --jq .state)

if [ "$STATE" != "MERGED" ]; then
  gh pr merge "$PR" --merge
fi
porch done {{project_id}} --merged "$PR"
```

`gh pr merge --merge` is the default forge's merge command; on another forge, run the command porch's merge task names with `CODEV_PR_NUMBER` exported. **Use `--merge`, not `--squash`** — preserve individual commits for development history. The `Fixes #{{issue.number}}` in the PR body auto-closes the issue.

### 10. Final Notification

```bash
afx send architect "Project {{project_id}} complete. PR #<M> merged. Ready for cleanup."
```

Together with the `--pr` record from step 4a and the `--merged` record from step 9, porch's `status.yaml` carries the complete PR lifecycle (created → merged → done) for analytics, status displays, and audit trails.

## Signals

Signals are informational — `porch done` is what moves porch.

```
<signal>PHASE_COMPLETE</signal>          # PR merged and recorded
<signal>BLOCKED:reason</signal>          # Cannot proceed
```

## What NOT to Do

- **Don't merge before the `pr` gate is approved and recorded** (steps 8–9). Neither a consultation APPROVE verdict nor approving prose that does not relay the human's decision authorizes `gh pr merge` — only the architect's relay, recorded with `porch approve`, does.
- Don't skip porch's PR/merge records (steps 4a, 9). The `--pr` record links the project to its PR; the `--merged` record closes the lifecycle in porch state. Skipping either leaves `pr_history` incomplete and downstream tooling blind.
- Don't run `porch approve` for any gate on your own initiative — only when the architect relays the human's approval
- Don't push to the default branch — only merge via PR
- Don't skip the Architecture Updates / Lessons Learned sections — porch checks enforce their presence (the section must exist; explaining "no changes needed" in one line is fine)
- **Don't improvise `consult` runs** — run the commands porch's task gives you, as given. Their `--output` paths are where porch looks; a review written anywhere else is invisible to it.
- **Don't fix, skip, or quarantine pre-existing failures unrelated to your change.** Porch's `checks` for this phase are narrow *structural* gates (`pr_exists`, review-section presence) — a green gate does **not** certify the wider build/test suite. If the broader suite surfaces failures your diff did not cause, they are out of scope: note them in the review's Lessons Learned / Things to Look At and proceed. Touching another team's tests to make an unrelated red go green is scope creep, not diligence.

## Handling Problems

**If the PR cannot be created (e.g., merge conflicts with the default branch):**
- Rebase on the default branch:
  ```bash
  DEFAULT_BRANCH=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||')
  DEFAULT_BRANCH=${DEFAULT_BRANCH:-main}
  git fetch origin "$DEFAULT_BRANCH" && git rebase "origin/$DEFAULT_BRANCH"
  ```
- Resolve conflicts (do NOT use destructive shortcuts)
- Force-push with lease: `git push --force-with-lease`
- Re-run the PR creation command from step 4

**If a consultation fails (e.g., model unavailable):**
- A failed `consult` writes no review file, so `porch next {{project_id}}` re-emits the missing command. Retry it once. A file with empty or truncated output counts as `REQUEST_CHANGES`.
- If the model is persistently unavailable, notify the architect and ask whether to proceed without it. Dropping a reviewer is a config change (`porch.consultation` in `.codev/config.json`), which is their call.

**If the architect doesn't respond within a reasonable window:**
- Send one follow-up via `afx send architect "..."` after a few hours
- Do not auto-merge
