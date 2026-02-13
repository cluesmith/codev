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

### 2. Notify Architect

After the PR is created, notify the architect and signal completion. The architect handles review, merge, and cleanup from here.

```bash
af send architect "PR #<number> ready for review (fixes issue #{{issue.number}})"
```

## Signals

When PR is created and architect is notified:

```
<signal>PHASE_COMPLETE</signal>
```

If you're blocked:

```
<signal>BLOCKED:reason goes here</signal>
```
