# IMPLEMENT Phase Prompt

You are executing the **IMPLEMENT** phase of the PIR protocol.

## Your Goal

Implement the approved plan, write tests, and pause at the `code-review` gate so the human can verify behavior by running the worktree locally. No file artifact is produced in this phase — the retrospective (review file) is written in the next phase, after the human has approved the running code.

## Context

- **Project ID**: {{project_id}}
- **Issue Number**: #{{issue.number}}
- **Issue Title**: {{issue.title}}
- **Plan File**: `codev/plans/{{artifact_name}}.md` (already approved)

## Resumption Check (do this FIRST)

Run `porch next {{project_id}}`. If the response is `gate_pending` on `code-review`, the code is already written and you're awaiting review. In that case:

1. Check for feedback:
   - `git diff main` — has the reviewer made any direct edits to your code?
   - `gh issue view {{issue.number}} --comments`
   - `afx send` queue messages
2. If feedback requires code changes: make them, re-run build + tests, recommit.
3. If feedback is a discussion question: respond and stay in the session.

Otherwise (`tasks` response — first run), continue below.

## Process

### 1. Re-Read the Plan

```bash
cat codev/plans/{{artifact_name}}.md
```

The plan is your authoritative scope. Stick to it. If you discover the plan is wrong while implementing, stop and signal `BLOCKED` rather than silently deviating.

### 2. Implement the Code

Follow the plan's "Files to Change" section. Apply the changes.

**Code quality standards:**
- Self-documenting code (clear names, obvious structure)
- No commented-out code
- No debug prints
- Explicit error handling
- Follow project style guide

**Commit cadence:** commit each logical unit separately. Use the format:

```
[PIR #{{issue.number}}] <Concise description of this commit's change>
```

**Never use `git add .` or `git add -A`.** Stage files explicitly:

```bash
git add path/to/changed-file.ts
git commit -m "[PIR #{{issue.number}}] ..."
```

### 3. Write Tests

The plan's "Test Plan" section lists what to verify. Write the corresponding tests:

- Unit tests for new functions
- Integration tests for cross-component flows
- Regression tests for any bug fixes

**Test quality:**
- Test behavior, not implementation
- Avoid overmocking — only mock external dependencies (APIs, databases, file systems)
- Use real implementations for internal module boundaries

### 4. Verify Everything Works

```bash
npm run build    # or project equivalent
npm test         # or project equivalent
```

Both MUST pass before signaling phase complete. If a test is flaky (intermittent failure unrelated to your changes), skip it with annotation — you'll document each skipped test in the review file in the next phase.

### 5. Push Your Branch

```bash
git push -u origin "$(git branch --show-current)"
```

So the reviewer can pull / inspect from elsewhere if they want.

### 6. Signal Phase Complete

```bash
porch done {{project_id}}
porch next {{project_id}}
```

PIR's `implement` phase has no AI consult — the `code-review` gate becomes pending immediately, and the human is the sole reviewer of the running code. (CMAP-2 runs later, in the `review` phase, after the human approves the gate and the PR is opened.)

### 7. End Your Turn With a Code-Review Summary (Prose, Not a File)

When the gate goes pending, output a short prose summary in the pane to orient the human reviewer. This is **not** a committed file — it's a transient message to help them inspect the change. Structure:

> **What changed**: 2–3 sentence summary.
>
> **Files**: `git diff --stat main` style list — paths and +/-.
>
> **Test results**: `npm run build` ✓, `npm test` ✓ (X tests, Y new).
>
> **Things to look at**: tricky spots, platform-specific behavior, anything you want the reviewer to focus on.
>
> **How to test locally**: VSCode → right-click builder → **Run Dev Server**, or `afx dev pir-{{project_id}}`. View diff via VSCode → **View Diff** (auto-detects the repo's default branch).
>
> Ready for review — type feedback here, or approve with `porch approve {{project_id}} code-review --a-human-explicitly-approved-this` (Cmd+K G in VSCode).

Then **stay in the interactive session**. Do not exit. Wait for the user's next message.

(Optional: if your team prefers an issue-thread record, you can also post a one-line comment on the GitHub issue pointing reviewers at the worktree branch. The summary itself stays in the pane — don't duplicate it as a committed file. That's the next phase's job, and that file will be a proper retrospective with arch + lessons updates, not a transient code-review note.)

## Signals

```
<signal>PHASE_COMPLETE</signal>          # Implementation + tests done; code-review gate becomes pending
<signal>BLOCKED:reason</signal>          # Cannot proceed
```

## What NOT to Do

- **Don't write `codev/reviews/<id>-<slug>.md` in this phase** — it's the next phase's artifact, with a different shape (retrospective with arch + lessons updates)
- Don't add features not in the plan — scope creep is a `BLOCKED` signal, not a free expansion
- Don't run `porch approve` yourself
- Don't push to main — only to your builder branch
- Don't squash commits — let the merge commit preserve history
- Don't use `git add .` or `git add -A`
- Don't open the PR yet — that's the `review` phase
- Don't exit the interactive session at the gate

## Handling Feedback at the Gate

The reviewer will run your code via `afx dev` and test it. They may:

- Approve immediately → porch advances to the `review` phase
- Type feedback in the pane / send via `afx send` / edit code in the worktree / comment on the issue
- Ask clarifying questions about specific files or behaviors

When they provide feedback:

1. If it's code feedback: make the change, run build + tests, recommit
2. If it's a discussion question: answer it in the pane
3. Don't re-run `porch done` unless porch's `verify` block needs to re-validate — porch will tell you

The gate stays pending until the human approves.
