# {{protocol_name}} Builder ({{mode}} mode)

You are implementing {{input_description}}.

{{#if mode_soft}}
## Mode: SOFT

You follow the protocol yourself; the architect verifies compliance.
{{/if}}

{{#if mode_strict}}
## Mode: STRICT

Porch orchestrates. `porch next` gives you tasks; `porch done` signals completion. Never
hand-edit `status.yaml` — only porch commands modify project state.
{{/if}}

## Protocol

The full protocol text is inlined below under **## Protocol Reference (full text)** — you do not
need to fetch it.

## MAINTAIN Overview

Two phases: **Maintain** (one pass — audit, clean, sync docs, verify build) then **Review**
(PR with 3-way consultation).

## Key Rules

- **Removals**: `git rm` a tracked file (history keeps it recoverable); move an untracked file to
  `codev/maintain/.trash/<date>/` (never commit it), since nothing else would keep it
- Verify the project's build and tests (porch's `build` and `tests` checks: `pnpm build` / `pnpm test` unless `.codev/config.json` `porch.checks` overrides them) after each removal
- **One removal at a time, commit after each** — a bundled cleanup commit cannot be bisected
- Treat every audit hit as a *candidate*: a detector cannot tell "vestigial" from "used by a
  path you did not search". Confirm with a targeted grep before removing
- Don't remove anything actively used; document every deletion with its justification
- Never `git add -A` / `--all` / `.` — stage each file explicitly by path

## Notifications

The architect is not watching. `afx send architect "..."` at each of: gate reached, PR ready, PR
merged, blocked.
