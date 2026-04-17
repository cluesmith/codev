---
name: porch
description: Protocol orchestrator CLI — drives SPIR, ASPIR, AIR, and BUGFIX protocols via a state machine. ALWAYS check this skill before running any `porch` command. Use when you need to check project status, approve gates, signal phase completion, or manage protocol state. Also use when a builder asks about gate approvals or phase transitions.
---

# porch - Protocol Orchestrator

Porch manages the state machine behind development protocols. It tracks phases, gates, consultations, and transitions.

## Commands

```
porch status [id]              Show current project state and phase
porch run [id]                 Run the protocol loop (strict mode)
porch next [id]                Get next tasks as JSON
porch done [id]                Signal current phase is complete
porch check [id]               Run checks for current phase
porch gate [id]                Request human approval at a gate
porch approve <id> <gate> --a-human-explicitly-approved-this
porch rollback <id> <phase>    Rewind to an earlier phase
porch init <protocol> <id> <name>   Initialize a new project
```

Project ID auto-detects from worktree path when inside a builder worktree.

## Gate approvals

Gates are human-only approval checkpoints. The `--a-human-explicitly-approved-this` flag is **required** — it exists to prevent AI agents from auto-approving.

| Gate | Protocol | When |
|------|----------|------|
| `spec-approval` | SPIR | After spec is written |
| `plan-approval` | SPIR | After plan is written |
| `pr` | SPIR, AIR | After PR is created |

```bash
porch approve 42 spec-approval --a-human-explicitly-approved-this
porch approve 42 plan-approval --a-human-explicitly-approved-this
porch approve 42 pr --a-human-explicitly-approved-this
```

**ASPIR and BUGFIX have no spec/plan gates** — they run autonomously through those phases.

## Checking pending gates

```bash
porch pending                  # List all gates waiting for approval
```

## Critical rules

- **Builders must NEVER call `porch approve`** — only humans approve gates
- **Never edit `status.yaml` directly** — porch manages all state
- Builders signal completion with `porch done`, not `porch approve`
- `porch run` is for strict mode only — soft mode builders follow the protocol document manually
- When running `porch approve` from the architect, use a subshell if you need worktree context: `(cd /path/to/worktree && porch approve ...)`

## State storage

Project state lives in `codev/projects/<id>-<name>/status.yaml`, managed automatically by porch. The status file tracks current phase, gate states, consultation results, and timestamps.
