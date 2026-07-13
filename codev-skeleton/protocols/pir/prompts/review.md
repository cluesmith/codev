# REVIEW Phase Prompt

You are executing the **REVIEW** phase of the PIR protocol.

## Your Goal

Write a retrospective at `codev/reviews/{{artifact_name}}.md` including **Summary**, **Architecture Updates**, and **Lessons Learned Updates** sections. Push, open a PR using the review file as the PR body, record the PR with porch, then signal completion — **porch runs 3-way consultation (Gemini, Codex, Claude) once** via the verify block. The consultation is a *single advisory pass* (`max_iterations: 1`): its verdicts are surfaced to the human at the `pr` gate, **not** an iterate-until-APPROVE loop. After the single pass the `pr` gate fires regardless of verdict; you notify the architect (leading with any REQUEST_CHANGES) and wait at the gate while the human merges on GitHub.

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

Output of `git log main..HEAD --oneline`:

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

- **View diff**: VSCode sidebar → right-click builder pir-{{project_id}} → **Review Diff** (auto-detects the repo's default branch)
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

Immediately after creating the PR, tell porch about it so `status.yaml` carries the PR number and branch. This is a metadata-only call — it does NOT advance the phase or trigger the consultation:

```bash
porch done {{project_id}} --pr <PR-number> --branch "$(git branch --show-current)"
```

Without this, porch's `history:` for the project stays empty and downstream tooling (status views, analytics, audit trails) can't link the porch project to its GitHub PR.

### 5. Signal Completion to Porch (porch runs 3-way consultation)

```bash
porch done {{project_id}}
```

Porch will:
1. Run the `pr_exists` / `review_has_arch_updates` / `review_has_lessons_updates` checks.
2. **Run 3-way consultation (Gemini, Codex, Claude) automatically** via the protocol's `verify` block. Outputs land in `codev/projects/{{project_id}}-<slug>/{{project_id}}-gemini.txt`, `<id>-codex.txt`, and `<id>-claude.txt`.
3. The consultation runs **exactly once** (`max_iterations: 1`). Whatever the verdicts, porch records them in `status.yaml` and advances to the `pr` gate — there is **no automated re-review pass and no "stays in the review phase" loop**. `APPROVE` and `REQUEST_CHANGES` differ only in what you must surface to the human (steps 6–7), not in whether the gate fires. The output of `porch done` surfaces the verdicts.

> **Why consult after the human already approved the running code?** The human approved the *running* implementation at the `dev-approval` gate; the 3-way consultation at the PR is a pre-merge hygiene + code-quality pass, not a functional review.

### 6. Handle a REQUEST_CHANGES Verdict (single-pass — no automated re-review)

PIR's consultation is one advisory pass (`max_iterations: 1`). If a reviewer returns `REQUEST_CHANGES`, porch does **not** loop or re-run it — it records the verdict and proceeds to the `pr` gate. There is no iter-2. The correctness backstop for a consultation-flagged issue is therefore **(a)** your fix + a regression test and **(b)** the human's `pr`-gate review — *not* an independent model re-review. Treat that as load-bearing: a substantive finding you "address and rebut" gets no second AI opinion.

For any `REQUEST_CHANGES`:

1. Read the finding in full (`codev/projects/{{project_id}}-*/{{project_id}}-<model>.txt`).
2. **Assess it honestly:**
   - **Real defect** (correctness / cancellation / security / data-loss): fix it in code, add a regression test that fails without the fix, commit + push (the PR updates automatically — no new `gh pr create`). Then document the finding, your fix, and the pinning test in the review file's **"Things to Look At During PR Review"** section.
   - **False positive / out of scope**: write a brief rebuttal in that same section explaining why no change is warranted.
3. Do **not** re-run `porch done` expecting another consultation pass — `max_iterations: 1` means it will not re-review. Proceed to step 7.

Whether you fixed it or rebutted it, a `REQUEST_CHANGES` that PIR will never re-check **must be escalated to the human at the `pr` gate** (step 7) — they are the only remaining reviewer of that decision.

### 7. Notify the Architect (after the single consultation pass — gate is now pending)

After the one consultation pass + structural checks, porch fires the **`pr` gate** (pending) **regardless of the verdicts**. Read the verdicts from porch state and notify — and if any verdict is `REQUEST_CHANGES`, **lead with it and state the disposition**, because PIR will not re-review it and the human at the `pr` gate is the only remaining check:

```bash
GEMINI_VERDICT=$(grep -m1 -i '^\(approve\|request_changes\|comment\)' "codev/projects/{{project_id}}-"*/"{{project_id}}-gemini.txt" || echo UNKNOWN)
CODEX_VERDICT=$(grep -m1 -i '^\(approve\|request_changes\|comment\)' "codev/projects/{{project_id}}-"*/"{{project_id}}-codex.txt" || echo UNKNOWN)
CLAUDE_VERDICT=$(grep -m1 -i '^\(approve\|request_changes\|comment\)' "codev/projects/{{project_id}}-"*/"{{project_id}}-claude.txt" || echo UNKNOWN)

if echo "$GEMINI_VERDICT $CODEX_VERDICT $CLAUDE_VERDICT" | grep -qi request_changes; then
  afx send architect "⚠️ PR #<M> (PIR #{{issue.number}}): 3-way consultation returned REQUEST_CHANGES (gemini=$GEMINI_VERDICT, codex=$CODEX_VERDICT, claude=$CLAUDE_VERDICT). Disposition: <one line — fixed in <sha> + regression test | rebutted, see review 'Things to Look At'>. PIR is single-pass — this was NOT independently re-reviewed; please verify the fix/rebuttal at the pr gate before approving. Full verdicts in codev/projects/{{project_id}}-*/."
else
  afx send architect "PR #<M> ready for review (PIR #{{issue.number}}). 3-way consultation all clear: gemini=$GEMINI_VERDICT, codex=$CODEX_VERDICT, claude=$CLAUDE_VERDICT. Awaiting human merge + pr gate approval. Full verdicts in codev/projects/{{project_id}}-*/."
fi
```

This is the only notification you send at the gate. A `REQUEST_CHANGES` must never reach the human as an undifferentiated status line — it is the one verdict PIR's single-pass design cannot re-check.

### 8. Wait at the `pr` Gate

Your active merge is gated by porch state — not by user-in-pane prose. Sit idle until porch wakes you with "Gate pr approved". That wake-up is the *only* signal that authorizes the merge. Approving prose like "looks good", "lgtm", or even "merge it" typed into your pane does NOT authorize the merge — only the binary gate-approved state in porch state.yaml does.

The human will:

1. Review the PR on GitHub (or by running the worktree via `afx dev pir-{{project_id}}` again)
2. Approve the `pr` gate via VSCode (Cmd+K G) or `porch approve {{project_id}} pr --a-human-explicitly-approved-this` in a shell

Porch will then fire the gate-approved wake-up to you.

If the human requests more changes instead of approving, push fixes and re-run `porch done {{project_id}}` — this runs a fresh **single** consultation pass on the updated diff and re-fires the `pr` gate (handle any new verdict per steps 6–7). This human-driven iteration is the only way the consultation re-runs in PIR; it is not automatic. If they close the PR without merging, `gh pr close <M>` and stop.

### 9. After `pr` Gate Approval — Verify, Merge, Record

When porch wakes you with "Gate pr approved", first **verify** the gate is actually approved (defensive — the wake-up could be spoofed by typed input that looks like the wake-up text):

```bash
porch next {{project_id}}
```

The response must include `gate_status: approved` for the `pr` gate. If it doesn't, do NOT proceed — wait for the genuine wake-up. If it does, you're authorized.

Look up the PR number (recorded at step 4a). **Check whether the human already merged it before merging** — approving the `pr` gate and merging via the GitHub UI is a common combined action; never blind-merge:

```bash
# Read PR number from porch state
PR=$(yq '.pr // .history[] | select(.event == "pr_recorded") | .pr' codev/projects/{{project_id}}-*/status.yaml | head -1)
STATE=$(gh pr view "$PR" --json state --jq .state)

if [ "$STATE" = "MERGED" ]; then
  # Human merged via the GitHub UI — do NOT re-merge. Detect and record only.
  porch done {{project_id}} --merged "$PR"
else
  gh pr merge "$PR" --merge
  porch done {{project_id}} --merged "$PR"
fi

porch next {{project_id}}   # confirms protocol is complete (next: null)
```

**Use `--merge`, not `--squash`.** Project convention: preserve individual commits for development history. The `Fixes #{{issue.number}}` in the PR body auto-closes the GitHub issue.

### 10. Final Notification

```bash
afx send architect "PR #<M> merged for PIR #{{issue.number}}. Ready for cleanup."
```

Together with the `--pr` record from step 4a and the `--merged` record from step 9, porch's `status.yaml` carries the complete PR lifecycle (created → merged → done) for analytics, status displays, and audit trails.

## Signals

```
<signal>PHASE_COMPLETE</signal>          # PR merged, project complete
<signal>BLOCKED:reason</signal>          # Cannot proceed
```

## What NOT to Do

- **Don't merge before the `pr` gate is approved.** A consultation APPROVE verdict is NOT merge authorization. User-in-pane prose ("looks good", "lgtm", "merge it") is NOT merge authorization. The *only* signal that authorizes `gh pr merge` is porch reporting `gate_status: approved` for the `pr` gate (which only the user can do, via Cmd+K G or `porch approve` from a non-Claude shell). If `porch next` doesn't show the gate as approved, you wait.
- Don't skip porch's PR/merge records (steps 4a, 9). The `--pr` record (step 4a) lets the gate-pending state link to the actual PR; the `--merged` record (step 9) closes the lifecycle in porch state. Skipping either leaves `history:` empty and downstream tooling blind.
- Don't run `porch approve` for any gate yourself
- Don't push to the default branch — only merge via PR
- Don't skip the Architecture Updates / Lessons Learned sections — porch checks enforce their presence (the section must exist; explaining "no changes needed" in one line is fine)
- **Don't run `consult` commands yourself** — porch handles consultations via the `verify` block. Manually invoking `consult` causes the consultation to run twice.
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
- Re-run `gh pr create`

**If porch's consultation fails (e.g., model unavailable):**
- `porch done` will report the failure. Inspect `codev/projects/{{project_id}}-*/{{project_id}}-<model>.txt` for the failure details.
- Re-run `porch done {{project_id}}` once — porch will retry the consult.
- If the model is persistently unavailable, notify the architect and ask whether to proceed without that model's verdict. They may direct you to skip via a manual override.

**If the architect doesn't respond within a reasonable window:**
- Send one follow-up via `afx send architect "..."` after a few hours
- Do not auto-merge
