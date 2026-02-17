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
consult -m gemini --protocol bugfix --type pr &
consult -m codex --protocol bugfix --type pr &
consult -m claude --protocol bugfix --type pr &
```

All three should run in the background (`run_in_background: true`).

### 3. Wait for Results and Address Feedback

**DO NOT proceed to step 4 until ALL THREE consultations have returned results.**

Wait for each background consultation to complete, then read the results:
- Use `TaskOutput` (with `block: true`) to retrieve each consultation result
- Record each model's verdict (APPROVE or REQUEST_CHANGES)
- Fix any issues identified by reviewers
- Push updates to the PR branch
- Re-run CMAP if substantial changes were made

You must have three concrete verdicts (e.g., "gemini: APPROVE, codex: APPROVE, claude: APPROVE") before continuing.

### 4. Notify Architect

**DO NOT send this notification until you have all three CMAP verdicts from step 3.**

Send a **single** notification that includes the PR link and each model's verdict:

```bash
af send architect "PR #<number> ready for review (fixes issue #{{issue.number}}). CMAP: gemini=<APPROVE|REQUEST_CHANGES>, codex=<APPROVE|REQUEST_CHANGES>, claude=<APPROVE|REQUEST_CHANGES>"
```

**This is the only notification you send.** After this, your work is done — the architect
takes it from here (reviews, merges, cleans up).

## Signals

When PR is created and reviews are complete:

```
<signal>PHASE_COMPLETE</signal>
```

If you're blocked:

```
<signal>BLOCKED:reason goes here</signal>
```
