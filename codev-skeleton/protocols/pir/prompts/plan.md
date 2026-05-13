# PLAN Phase Prompt

You are executing the **PLAN** phase of the PIR protocol.

## Your Goal

Read the GitHub issue, investigate the codebase, and write a plan to `codev/plans/{{artifact_name}}.md`. The plan is reviewed by a human at the `plan-approval` gate before any code is written.

## Context

- **Project ID**: {{project_id}}
- **Issue Number**: #{{issue.number}}
- **Issue Title**: {{issue.title}}
- **Artifact**: `codev/plans/{{artifact_name}}.md`

## Resumption Check (do this FIRST)

Run `porch next {{project_id}}`. If the response is `gate_pending`, you have already drafted the plan and are awaiting review. In that case:

1. Read your current plan file: `cat codev/plans/{{artifact_name}}.md`
2. Check for new feedback that may have arrived while you were idle:
   - `git diff HEAD~1 codev/plans/{{artifact_name}}.md` — the reviewer may have edited the file directly
   - `gh issue view {{issue.number}} --comments` — check for new comments
   - Read any `afx send` queue messages
3. If feedback exists, revise the plan and recommit. If not, end the turn with a short "still awaiting review" message and stay in the interactive session.

Otherwise (`tasks` response — this is your first run), continue with the steps below.

## Process

### 1. Read the Issue

```bash
gh issue view {{issue.number}}
```

Understand what's being asked. For a bug, identify the symptom. For a feature, identify the desired outcome.

### 2. Investigate the Codebase

- Use Glob / Grep / Read to find the relevant code
- For a bug: trace the failure path, identify the root cause
- For a feature: find the existing patterns and integration points
- Note any existing utilities, components, or conventions you should reuse

### 3. Write the Plan

Create `codev/plans/{{artifact_name}}.md` where `<slug>` is a short kebab-case description of the change. Use this structure:

```markdown
# PIR Plan: <Short Title>

## Understanding

What the issue is asking for, in your own words. For a bug, include the root cause you identified — back it up with file:line references.

## Proposed Change

The approach you intend to take. Be specific. If there are multiple valid approaches, pick one and explain why.

## Files to Change

Concrete file paths. Use `file:line` format for specific edits where possible.

- `path/to/file.ts:42-55` — what changes
- `path/to/new-file.ts` — new file, what it does

## Risks & Alternatives Considered

- Risk: what could go wrong; mitigation
- Alternative: <other approach>; why rejected

## Test Plan

How to verify this works once implemented. The reviewer will use this at the `code-review` gate to test the running worktree.

- Unit test: <what to test>
- Manual: <what to click / observe>
- Cross-platform: <if applicable — what to verify on iOS / Android / web>
```

### 4. Commit and Push

```bash
git add codev/plans/{{artifact_name}}.md
git commit -m "[PIR #{{issue.number}}] Plan draft"
git push -u origin "$(git branch --show-current)"
```

**Never use `git add .` or `git add -A`.**

### 5. Signal Phase Complete

```bash
porch done {{project_id}}
porch next {{project_id}}
```

`porch next` will respond with `gate_pending` on the `plan-approval` gate. Porch automatically notifies the architect.

### 6. End Your Turn With a Prose Summary

Output something like:

> Plan written to `codev/plans/{{artifact_name}}.md` and committed. Ready for review — type any feedback here, edit the plan file directly in VSCode, or approve with `porch approve {{project_id}} plan-approval --a-human-explicitly-approved-this` (Cmd+K G in VSCode).

Then **stay in the interactive session**. Do not exit. Wait for the user's next message.

## Signals

```
<signal>PHASE_COMPLETE</signal>          # Plan drafted (informational; the real signal is porch done)
<signal>BLOCKED:reason</signal>          # Cannot proceed
```

## What NOT to Do

- Don't write code — that's the implement phase
- Don't run `porch approve` yourself — only the human can approve the gate
- Don't post the plan content as a GitHub issue comment — the plan lives in the file, not the issue thread. A one-line pointer comment on the issue is fine if you think it helps the discussion.
- Don't use `git add .` or `git add -A`
- Don't exit the interactive session at the gate

## Handling Feedback

When the reviewer provides feedback (typed in pane, file-edit, `afx send`, or issue comment):

1. Re-read the plan file (the user may have edited it)
2. Apply the requested changes to your plan
3. Recommit: `git add codev/plans/{{artifact_name}}.md && git commit -m "[PIR #{{issue.number}}] Plan revised"`
4. Push
5. Output a short "Revised — see commit X" message
6. Wait for next input — the gate remains pending until the human approves
