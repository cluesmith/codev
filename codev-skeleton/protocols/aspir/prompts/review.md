# REVIEW Phase Prompt

You are executing the **REVIEW** phase of the ASPIR protocol.

## Goal

Review the whole implementation, write the retrospective at `codev/reviews/{{artifact_name}}.md`, and open the PR — so porch's consultation and the architect both review a real PR.

## Context

- **Project ID**: {{project_id}}
- **Project Title**: {{title}}
- **Current State**: {{current_state}}
- **Spec File**: `codev/specs/{{artifact_name}}.md`
- **Plan File**: `codev/plans/{{artifact_name}}.md`
- **Review File**: `codev/reviews/{{artifact_name}}.md`

## What must be true when you finish

- **The work is done and green.** All phases committed (`git log --oneline | grep "[Spec {{project_id}}]"`), build and tests passing, no uncommitted changes.
- **The implementation has been reviewed against the spec** — code quality, architecture fit, and security considered; deviations from the spec noted with their reasons; every success criterion accounted for.
- **The review document exists** at `codev/reviews/{{artifact_name}}.md`, following the template below (its headings, its order — do not pattern-match an older review that predates it).
- **Consultation feedback is captured.** The review carries a `## Consultation Feedback` section that, per phase / round / model, records each concern and its disposition — **Addressed** (changed), **Rebutted** (why it does not apply), or **N/A** (out of scope / handled elsewhere). "No concerns raised — all consultations approved" is the right line when that is true; note COMMENT verdicts and any `CONSULT_ERROR`. Read the consult outputs from `codev/projects/{{project_id}}-*/`.
- **Governance facts are routed by tier** (see below).
- **The PR exists before you signal**, with a close-keyword so merging auto-closes the issue (see below).

## Output

Write the review to `codev/reviews/{{artifact_name}}.md` using the template below as its interface. Steps below expand its `## Consultation Feedback`, `## Architecture Updates`, and `## Lessons Learned Updates` sections; porch greps the produced file for the last two by exact heading.

{{> protocols/spir/templates/review.md}}

## Route governance facts by tier (Spec 987)

Each governance doc has two tiers. **Route** each new fact; do not simply append to the cold archive.

- **HOT** — `codev/resources/arch-critical.md` and `lessons-critical.md`: tiny, hard-capped, always injected into every prompt and into CLAUDE.md/AGENTS.md. Add here only a **behavior-changing, cross-cutting** fact a future builder must know up front. The hot files are capped: if one is full, **demote** a weaker entry into its cold counterpart to make room, and keep the hot file's cold-doc map accurate.
- **COLD** — `codev/resources/arch.md` and `lessons-learned.md`: full, on-demand reference for subsystem detail, file locations, one-offs, and spec-narrow recipes.

The review's `## Architecture Updates` and `## Lessons Learned Updates` sections state what you routed where; if nothing qualifies, keep the heading with a one-line reason. Never grow a hot file past its cap by appending — route to cold or displace. The `update-arch-docs` skill encodes this discipline.

## Create the PR (before signaling)

The PR body must carry `Closes #<N>` (feature) or `Fixes #<N>` (bug) for the driving issue — one keyword per issue if several — so GitHub auto-closes on merge. **Exception:** a PR that only partially addresses its issue uses `Refs #<N>` or `Part of #<N>` instead, leaving the issue open for the follow-up.

```bash
export CODEV_PR_TITLE="[Spec {{project_id}}] {{title}}"
export CODEV_PR_BODY="$(cat <<'EOF'
## Summary
[what was implemented]

Closes #<N>  <!-- driving issue; use "Refs #<N>" for a partial fix -->

## Changes
- ...

## Testing
- ...

## Spec
codev/specs/{{artifact_name}}.md

## Review
codev/reviews/{{artifact_name}}.md
EOF
)"

{{pr_create_command}}
```

The command above is your forge's `pr-create` concept, substituted by porch (`gh pr create` by default). It takes `CODEV_PR_TITLE` / `CODEV_PR_BODY` — optionally `CODEV_PR_BASE`, `CODEV_PR_HEAD`, `CODEV_PR_REPO` — from the environment, which is why they are exported rather than prefixed onto the command line: an inline override that spells `--title "$CODEV_PR_TITLE"` needs them set in the calling shell too. It prints `{"number": <int>, "url": "<url>"}`.

## Signals

- Review document complete:
  ```
  <signal>REVIEW_COMPLETE</signal>
  ```
- PR created — signal so porch runs the 3-way consultation:
  ```
  <signal>PR_READY</signal>
  ```

Do not run `consult` (porch handles it) and merge your own PR only after the human approves the `pr` gate — never before.
