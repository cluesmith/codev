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

### 2. Signal Completion

After the PR is created, signal completion. Porch will run consultation automatically via the verify step. If reviewers request changes, you'll be respawned with their feedback.

## Signals

When PR is created and reviews are complete:

```
<signal>PHASE_COMPLETE</signal>
```

If you're blocked:

```
<signal>BLOCKED:reason goes here</signal>
```
