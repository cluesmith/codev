---
name: porch
description: Protocol orchestrator CLI — drives SPIR, ASPIR, AIR, BUGFIX, PIR, MAINTAIN, RESEARCH and EXPERIMENT via a state machine. ALWAYS check this skill before running any `porch` command. Use when you need to check project status, approve gates, signal phase completion, or manage protocol state. Also use when a builder asks about gate approvals or phase transitions.
---

# porch - Protocol Orchestrator

Porch manages the state machine behind development protocols. It tracks phases, gates, consultations, and transitions. It is a planner: it emits tasks, and the builder executes them.

## Commands

```
porch next [id]                Get the next tasks as JSON (the strict-mode loop)
porch done [id]                Signal the current phase is complete (runs its checks, advances)
porch done [id] --pr N --branch NAME   Record a PR (no phase advancement)
porch done [id] --merged N     Record a merge (no phase advancement)
porch status [id]              Show current project state and phase
porch check [id]               Run checks for the current phase
porch gate [id]                Request human approval at a gate
porch pending [--all]          List gates awaiting approval
porch approve <id> <gate> --a-human-explicitly-approved-this
porch verify <id> --skip "reason"   Skip post-merge verification and mark verified
porch rollback <id> <phase>    Rewind to an earlier phase
porch skip-phase <id> <plan-phase> --reason "..." --a-human-explicitly-approved-this
                               Drop one unbuilt plan phase from an approved plan
porch init <protocol> <id> <name>   Initialize a new project
```

Project ID auto-detects from the worktree path when inside a builder worktree. `porch run` was removed — use `porch next`.

## The strict-mode loop

Run `porch next`, do the tasks it returns, run `porch done` when the phase work is complete, then `porch next` again. After `porch done` on a reviewed phase, `porch next` hands you the `consult` commands to run (three reviewers by default; `.codev/config.json` `porch.consultation` can change the lanes). Run exactly those, each as a background task. Porch commits only `status.yaml` — commit your own work.

## Gate approvals

Gates are human approval checkpoints. Each protocol's `protocol.json` defines its gates:

| Protocol | Gates |
|----------|-------|
| SPIR | `spec-approval`, `plan-approval`, `pr`, `verify-approval` |
| ASPIR | `pr`, `verify-approval` |
| AIR, BUGFIX | `pr` |
| PIR | `plan-approval`, `dev-approval`, `pr` |
| MAINTAIN | `maintain-complete` |
| RESEARCH | `scope-approval`, `research-complete` |
| EXPERIMENT | `experiment-complete` |

**Who runs `porch approve`:** the builder, after the architect relays the human's decision. The `--a-human-explicitly-approved-this` flag is **required** — it records that a human decided. A gate message is a notification to a human, never authorization an agent may act on by itself.

```bash
porch approve 42 spec-approval --a-human-explicitly-approved-this
porch approve bugfix-42 pr --a-human-explicitly-approved-this
```

## Dropping a plan phase

Plan phases are copied into `status.yaml` once, on entering `implement`; editing the plan afterwards changes nothing. When a human drops an unbuilt phase from an approved plan, record it with:

```bash
porch skip-phase 42 phase_3 --reason "dropped by owner: superseded by #57" --a-human-explicitly-approved-this
```

**Who runs `porch skip-phase`:** the builder, in its own worktree, after the architect relays the human's decision — as with `porch approve`. Porch commits and pushes `status.yaml` in whichever checkout it runs from, so run from the main workspace root it can land on `main`.

The phase is marked `skipped` with the reason (keep it to one short line) and drops out of the plan; `porch status` keeps listing it, with the reason, after implement. Skipping the last unsettled phase advances to review. Completed phases cannot be skipped — use `porch rollback <id> implement` to redo implementation. If the skip crosses a context-refresh boundary, porch says so: run `/builder-refresh`, then `porch next`.

## Checking pending gates

```bash
porch pending                  # List all gates waiting for approval
porch pending --all            # Include stale records on finished/advanced projects (hidden by default)
```

## Critical rules

- **Never run `porch approve` without a human's explicit decision**, relayed to you by the architect
- **Never run `porch skip-phase` without a human's explicit decision**, relayed to you by the architect — it changes an approved plan
- **Never edit `status.yaml` directly** — porch manages all state
- Builders signal phase completion with `porch done`; blockers go to the architect with `afx send architect`
- Strict mode only: soft-mode builders follow the protocol document themselves

## Check overrides and timeouts (`porch.checks`)

Override a protocol check per name in `.codev/config.json` under `porch.checks` instead of forking `protocol.json`. Each entry takes `command` (replace), `cwd` (replace), `timeout_ms` (replace), and/or `skip: true`:

```jsonc
{
  "porch": {
    "checks": {
      "tests":     { "command": "uv run pytest", "timeout_ms": 900000 },
      "e2e_tests": { "skip": true }
    }
  }
}
```

A phase check is killed after 5 minutes unless it sets `timeout_ms` — in `protocol.json` or in its `porch.checks` override. On timeout porch kills the check's whole process tree.

## State storage

Project state lives in `codev/projects/<id>-<name>/status.yaml`, managed automatically by porch. The status file tracks current phase, gate states, consultation results, and timestamps.
