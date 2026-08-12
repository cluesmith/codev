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

## PLAN phase — hold lifted, plan committed+pushed, then BLOCKED on porch check (2026-08-12)

Hold lifted (human accepted public-branch tolerance). Locked the three named design
calls in the plan (WS transport = Sec-WebSocket-Protocol; CORS = fixed origin
allowlist; constant-time compare = crypto.timingSafeEqual length-guarded), committed
+ pushed the plan (commit aabb5bc25, builder/task-NHnJ).

**BLOCKED:** `porch done` fails the `plan_exists` check ("Plan not found") even though
`codev/plans/builder-task-nhnj-task-NHnJ.md` exists and is committed. Root cause is a
porch defect, NOT the plan: `matchesProjectId` (packages/codev/src/commands/porch/
artifacts.ts:63) only recognizes project ids that are numeric ("42") or prefix-N
ending in digits ("bugfix-237"). This project's id `builder-task-nhnj` ends in letters,
matching neither shape, so the artifact resolver returns false for the plan file AND
the project dir. `plan_exists` (and all downstream artifact checks) can never pass for
this id, and no plan filename/location can satisfy it. Verified empirically with a
node repro of matchesProjectId. Did NOT hand-edit status.yaml or bypass the check.
Escalated to architect with options (re-init under a porch-compatible numeric/prefix-N
id, vs. a separate area/porch fix to the id matcher). Likely affects ALL ad-hoc
`builder-*` PIR spawns. Awaiting decision.

## PLAN phase — re-init under porch-native id `secfix-1`, unblocked (2026-08-12)

Architect confirmed root cause = the `--task` spawn minted a porch-incompatible id
(not a matcher bug to patch). Main verified re-init is session-safe (Tower keys on
builder id + workspace path; no project_id column). Executed the architect's steps in
this worktree:
- `porch init pir secfix-1 tower-auth-hardening` → new project `secfix-1-tower-auth-hardening`
  (prefix-N id, matcher-compatible). porch committed its scaffolding (e1a6c9ba4).
- `git mv codev/plans/builder-task-nhnj-task-NHnJ.md codev/plans/secfix-1-tower-auth-hardening.md`
  — 100% rename, plan CONTENT unchanged (mechanics-free as-is; it had zero self-references
  to the old id, so nothing else to touch).
- Re-driving porch from `secfix-1` to raise the plan-approval gate.

Builder id stays `task-NHnJ` (worktree basename), so this thread file keeps its name.
The stale `codev/projects/builder-task-nhnj-task-NHnJ/` dir is harmless scaffolding
(left as-is; not hand-editing any status.yaml).

