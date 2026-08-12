# Builder task-NHnJ thread

## PLAN phase — BLOCKED (2026-08-12)

Spawned in PIR strict mode for an "ad-hoc task", but no task description exists anywhere:

- `.builder-prompt.txt` says only "You are implementing an ad-hoc task."
- porch `## Goal` for the plan task is literally `task-NHnJ` (my builder id).
- No GitHub issue is linked; `status.yaml` has no issue number.
- `afx inbox` is empty (no held messages).

Cannot draft a plan without knowing what to build. Notified the architect via
`afx send architect` (routed to the `security` architect) requesting the task
description or an issue number. Holding at the plan phase — porch not advanced.

## PLAN phase — task received, plan DRAFTED, holding before commit (2026-08-12)

Architect supplied the task: harden the Tower local HTTP+WebSocket API to require
request authentication (private security lane, advisory referenced by id only).
Read the advisory in full for context; all committed artifacts stay strictly
mechanics-free (hardening framing, never exploit mechanics/scenario).

Plan written to `codev/plans/builder-task-nhnj-task-NHnJ.md`. Scope narrowed per
architect to **five core layers** (HTTP key enforcement, WebSocket key enforcement,
CORS allowlist, cross-client rollout, BRIDGE_MODE). Key rotation is a **deferred
follow-up (out of scope)** — noted, not implemented.

Grounded the plan with codebase investigation + a client-transport map. Key facts:
- Single HTTP choke point `isRequestAllowed` (server-utils.ts:80, returns true)
  called in `handleRequest` (tower-routes.ts:233); shared key at
  `~/.agent-farm/local-key` via `@cluesmith/codev-core/auth` (ensure/readLocalKey).
- WS auth surface is only two clients: web dashboard (`apps/web`, sends nothing on
  WS) and VS Code (`apps/vscode`, sends key in-band post-open) → move both to
  `Sec-WebSocket-Protocol`. sdk/tower.html/streamdeck open no terminal WS.
- Header inconsistency: sdk/vscode/streamdeck send `codev-web-key`; browser pages
  (`apps/web`, tower.html) send `Authorization: Bearer` → standardize on `codev-web-key`.

**HOLD:** architect asked me to draft only and NOT commit/push yet (a disclosure-
tolerance question re: the branch being on public origin is with the human).
Awaiting explicit "go" before committing the plan and signalling `porch done`.

