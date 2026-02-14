# PR Phase Prompt

You are executing the **PR** phase of the BUGFIX protocol.

## Your Goal

Create a pull request, run CMAP review, and address feedback.

## Context

- **Issue**: #{{issue.number}} — {{issue.title}}
- **Current State**: {{current_state}}

## Process

### 1. Create the Pull Request

Create a PR that links to the issue:

```bash
gh pr create --title "Fix #{{issue.number}}: <brief description>" --body "$(cat <<'EOF'
## Summary

<1-2 sentence description of the bug and fix>

Fixes #{{issue.number}}

## Root Cause

<Brief explanation of why the bug occurred>

## Fix

<Brief explanation of what was changed>

## Test Plan

- [ ] Regression test added
- [ ] Build passes
- [ ] All tests pass
EOF
)"
```

### 2. Run CMAP Review

Run 3-way parallel consultation on the PR:

```bash
consult --model gemini pr <PR_NUMBER> &
consult --model codex pr <PR_NUMBER> &
consult --model claude pr <PR_NUMBER> &
```

All three should run in the background (`run_in_background: true`).

### 3. Address Feedback

Review the consultation results:
- Fix any issues identified by reviewers
- Push updates to the PR branch
- Re-run CMAP if substantial changes were made

### 4. Notify Architect

After CMAP review is complete and feedback is addressed, notify the architect:

```bash
af send architect "PR #<number> ready for review (fixes issue #{{issue.number}})"
```

## Signals

When PR is created and reviews are complete:

```
<signal>PHASE_COMPLETE</signal>
```

If you're blocked:

```
<signal>BLOCKED:reason goes here</signal>
```
