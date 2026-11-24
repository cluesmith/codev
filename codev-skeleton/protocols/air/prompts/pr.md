# PR Phase Prompt

You are executing the **PR** phase of the AIR protocol.

## Goal

Open the PR with the review embedded in its body, optionally run CMAP, and notify the architect.

## Context

- **Issue**: #{{issue.number}} — {{issue.title}}
- **Current State**: {{current_state}}

## Create the PR

**The PR body IS the review for AIR** — do not create a file in `codev/reviews/`. Include a summary, the key decisions, and a test plan in the body itself.

The body must carry `Closes #<N>` for the driving issue — one per issue if several — so GitHub auto-closes it on merge. **Exception:** a partial fix uses `Refs #<N>` or `Part of #<N>` instead. Substitute the real number for `<N>`; leave no `{{...}}` tag or `<N>` placeholder in the committed body.

```bash
export CODEV_PR_TITLE="[Air #<N>] feat: <brief description>"
export CODEV_PR_BODY="$(cat <<'EOF'
## Summary

<1-2 sentence description of the feature>

Closes #<N>  <!-- Substitute <N>; use "Refs #<N>" for a partial fix -->

## What Changed

<the implementation approach>

## Key Decisions

<notable decisions, or "None — straightforward implementation">

## Test Plan

- [ ] Unit tests added
- [ ] Build passes
- [ ] All tests pass

## Review Notes

<anything the reviewer should focus on, or "Standard implementation — no special concerns">
EOF
)"

{{pr_create_command}}
```

The command above is your forge's `pr-create` concept, substituted by porch (`gh pr create` by default). It takes `CODEV_PR_TITLE` / `CODEV_PR_BODY` — optionally `CODEV_PR_BASE`, `CODEV_PR_HEAD`, `CODEV_PR_REPO` — from the environment, which is why they are exported rather than prefixed onto the command line: an inline override that spells `--title "$CODEV_PR_TITLE"` needs them set in the calling shell too. It prints `{"number": <int>, "url": "<url>"}`.

## Optional CMAP review

CMAP is your judgement call for AIR. Skip it for simple changes (config, small UI); run it for features touching core logic or several modules. Porch wrote these commands from the protocol's default reviewers (gemini, codex, claude) and your project's `.codev/config.json` `porch.consultation`:

```bash
{{consult_commands}}
```

Run each as its own background task (in Claude Code, `run_in_background: true`, not a trailing `&`). If you run CMAP, wait for every result, record each verdict, fix real issues, and push.

## Notify the architect

```bash
afx send architect "PR #<number> ready for review (implements issue #{{issue.number}})"
```

If you ran CMAP, include the verdicts: `CMAP: {{consult_verdicts}}`.

Then run the `porch done` command porch gives you below: it fires the `pr` gate. Stop and wait — a CMAP APPROVE is not merge authorization. When the architect relays the human's approval, run `porch approve {{project_id}} pr --a-human-explicitly-approved-this` yourself, then follow the merge task from `porch next`. If you are blocked, `afx send architect` the specifics and wait instead of running `porch done`.
