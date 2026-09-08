# PR Phase Prompt

You are executing the **PR** phase of the BUGFIX protocol.

## Goal

Open the PR, run CMAP review on it, address feedback, and hand off to the architect at the `pr` gate.

## Context

- **Issue**: #{{issue.number}} — {{issue.title}}
- **Current State**: {{current_state}}

## Create the PR

The PR body must carry `Fixes #<N>` for the driving issue — one per issue if several — so GitHub auto-closes it on merge. **Exception:** a PR that only partially addresses the issue uses `Refs #<N>` or `Part of #<N>` instead, leaving it open for the follow-up. Substitute the real number for `<N>`; leave no `{{...}}` tag or `<N>` placeholder in the committed body.

```bash
export CODEV_PR_TITLE="Fix #<N>: <brief description>"
export CODEV_PR_BODY="$(cat <<'EOF'
## Summary

<1-2 sentence description of the bug and fix>

Fixes #<N>  <!-- Substitute <N>; use "Refs #<N>" for a partial fix -->

## Root Cause

<why the bug occurred>

## Fix

<what changed>

## Test Plan

- [ ] Regression test added
- [ ] Build passes
- [ ] All tests pass
EOF
)"

{{pr_create_command}}
```

The command above is your forge's `pr-create` concept, substituted by porch (`gh pr create` by default). It takes `CODEV_PR_TITLE` / `CODEV_PR_BODY` — optionally `CODEV_PR_BASE`, `CODEV_PR_HEAD`, `CODEV_PR_REPO` — from the environment, which is why they are exported rather than prefixed onto the command line: an inline override that spells `--title "$CODEV_PR_TITLE"` needs them set in the calling shell too. It prints `{"number": <int>, "url": "<url>"}`.

## Run CMAP review

BUGFIX runs its own 3-way consultation on the PR (porch does not do it for you). Dispatch all three in the background:

```bash
consult -m gemini --protocol bugfix --type pr &
consult -m codex --protocol bugfix --type pr &
consult -m claude --protocol bugfix --type pr &
```

Do not proceed until **ALL THREE consultations have returned results** — retrieve each with `TaskOutput` (`block: true`), record its verdict (APPROVE / REQUEST_CHANGES), fix real issues, push, and re-run CMAP if the changes were substantial. You must hold three concrete verdicts before you notify.

## Notify and hand off at the gate

**DO NOT send this notification until you have all three CMAP verdicts.** Send a **single** notification with the PR link and all three verdicts, then request the gate:

```bash
afx send architect "PR #<number> ready for review (fixes issue #{{issue.number}}). CMAP: gemini=<APPROVE|REQUEST_CHANGES>, codex=<APPROVE|REQUEST_CHANGES>, claude=<APPROVE|REQUEST_CHANGES>"
porch done <project-id>
```

`porch done` fires the `pr` gate and surfaces the PR in Needs Attention. Wait for the architect to approve it (`porch approve <project-id> pr`) — a CMAP APPROVE is not merge authorization. After gate approval, follow the merge task from `porch next` to merge and advance to `verified`.

## Signals

- PR created and reviews complete:
  ```
  <signal>PHASE_COMPLETE</signal>
  ```
- Blocked:
  ```
  <signal>BLOCKED:reason goes here</signal>
  ```
