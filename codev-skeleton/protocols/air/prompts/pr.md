# PR Phase Prompt

You are executing the **PR** phase of the AIR protocol.

## Your Goal

Create a pull request with the review embedded in the PR body, optionally run CMAP, and notify the architect.

## Context

- **Issue**: #{{issue.number}} — {{issue.title}}
- **Current State**: {{current_state}}

## Process

### 1. Create the Pull Request

Create a PR that links to the issue. The PR body IS the review — include a summary, key decisions, and test plan:

```bash
gh pr create --title "[Air #{{issue.number}}] feat: <brief description>" --body "$(cat <<'EOF'
## Summary

<1-2 sentence description of the feature>

Implements #{{issue.number}}

## What Changed

<Brief explanation of the implementation approach>

## Key Decisions

<Any notable decisions made during implementation, or "None — straightforward implementation">

## Test Plan

- [ ] Unit tests added
- [ ] Build passes
- [ ] All tests pass

## Review Notes

<Anything the reviewer should pay special attention to, or "Standard implementation — no special concerns">
EOF
)"
```

**IMPORTANT**: Do NOT create a review file in `codev/reviews/`. The PR body IS the review for AIR.

### 2. Optional CMAP Review

If the implementation is non-trivial, run 3-way consultation:

```bash
consult -m gemini --protocol air --type pr &
consult -m codex --protocol air --type pr &
consult -m claude --protocol air --type pr &
```

All three should run in the background (`run_in_background: true`).

**This is optional** — use your judgement. For simple features (config changes, small UI additions), you may skip consultation. For features touching core logic or multiple modules, run it.

### 3. Address Feedback (if CMAP was run)

If you ran CMAP:
- Wait for all consultations to complete
- Record each model's verdict
- Fix any issues identified
- Push updates to the PR branch

### 4. Notify Architect

Send notification with PR link:

```bash
af send architect "PR #<number> ready for review (implements issue #{{issue.number}})"
```

If CMAP was run, include verdicts:
```bash
af send architect "PR #<number> ready for review (implements issue #{{issue.number}}). CMAP: gemini=<verdict>, codex=<verdict>, claude=<verdict>"
```

## Signals

When PR is created and ready for review:

```
<signal>PHASE_COMPLETE</signal>
```

If you're blocked:

```
<signal>BLOCKED:reason goes here</signal>
```
