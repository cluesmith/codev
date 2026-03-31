# Specification: Porch - Protocol Orchestrator

## Metadata
- **ID**: 0073
- **Status**: conceived
- **Created**: 2026-01-19
- **Protocol**: SPIR
- **Depends on**: 0072 (Ralph-SPIR spike)

## Executive Summary

Porch is a standalone CLI tool that runs development protocols (SPIR, TICK, BUGFIX) as an interactive REPL with human approval gates. It replaces the current markdown-based protocol system with a state machine that enforces phase transitions and persists state to files.

## Three Levels of Codev Usage

Porch exists as the middle layer of a three-level architecture:

| Level | Tool | Description | Use Case |
|-------|------|-------------|----------|
| 1 | Protocols only | Raw Claude + `codev/protocols/*.md` | Manual protocol following |
| 2 | **porch** | Interactive REPL wrapping Claude | Enforced protocol execution |
| 3 | **afx** | UI for managing porch sessions | Multi-project orchestration |

**Level 1: Protocols Only**
Just tell Claude to follow SPIR. No tooling required. Useful for simple tasks or when you want full control.

**Level 2: Porch (this spec)**
Our take on [Ralph](https://www.anthropic.com/engineering/claude-code-best-practices), but as a REPL. Ralph is Anthropic's recommended pattern for long-running agent tasks: fresh context per iteration, state persisted to files. Porch is an interactive state machine that wraps Claude with protocol enforcement. It persists state to YAML files, blocks on human gates, runs defense checks (build/test), and orchestrates multi-agent consultations. You run `porch` directly and interact with it. Each iteration gets fresh context while state persists between iterations.

**Level 3: afx (Agent Farm)**
A UI layer that enables the **Architect-Builder pattern**. The human architect uses the dashboard to kickoff builders (porch sessions in worktrees), monitor their progress, and approve gates. Each porch session IS a builder - it runs the full protocol lifecycle autonomously until it needs human input.

## Key Decisions (from discussion)

| Decision | Choice |
|----------|--------|
| Replaces or coexists with current protocols? | **Replaces** |
| porch is a standalone command? | **Yes** - `porch`, not `codev porch` |
| Integration with `afx kickoff`? | **Yes** - afx kickoffs porch processes |
| Builder owns full lifecycle? | **Yes** - S→P→I→D→E→R |
| Worktree tied to builder or project? | **Project** - worktrees persist independently |
| Protocol definitions location? | `codev-skeleton/protocols/*.json` |
| tmux dependency? | **No** - porch IS the interactive experience |

## Problem Statement

### Current Architecture

```
ARCHITECT (main)                    BUILDER (worktree in .builders/)
════════════════                    ══════════════════════════════
  Specify ──┐
            │ Human reviews
  Plan ─────┤
            │
            └── afx kickoff ───────────► Claude session
                                     ├── Implement
                                     ├── Defend
                                     ├── Evaluate
                                     └── Creates PR

  Review ◄─────────────────────────── (merge)
```

**Problems:**
1. **Context split** - Architect context ≠ Builder context
2. **Transient worktrees** - `.builders/` disappears when builder done
3. **AI-driven flow** - Claude follows markdown protocol from memory
4. **No enforcement** - Phases can be skipped
5. **Manual notification** - Architect must check on builder

### Target Architecture

```
ARCHITECT (main)                    PROJECT WORKTREE (projects/0073/)
════════════════                    ══════════════════════════════════

  afx kickoff 0073 ────────────────────► PORCH REPL:
                                     │
                                     ├─► Specify ───┐
                                     │              │◄── notify architect
                                     │   ◄──────────┘    porch approve
                                     │
                                     ├─► Plan ──────┐
                                     │              │◄── notify architect
                                     │   ◄──────────┘    porch approve
                                     │
                                     ├─► IDE Loop (for each phase in plan):
                                     │     ├─► Implement phase N (checks: build)
                                     │     ├─► Defend phase N (checks: tests)
                                     │     ├─► Evaluate phase N
                                     │     └─► next phase...
                                     │
                                     ├─► Review
                                     └─► PR + Complete

  ◄──── notification ───────────────
```

**Key insight: IDE is a loop.** SPIR's Implement→Defend→Evaluate phases run once per implementation phase defined in the plan. Porch reads the plan, extracts phases, and loops through them. This is the Ralph principle applied within a protocol.

## Desired State

### 1. Protocol Execution Worktrees

Worktrees are tied to **protocol executions**, not just SPIR projects:

```
codev-project/
├── worktrees/                    # Git worktrees for protocol executions
│   ├── spir_0073_user-auth/    # SPIR project 0073
│   ├── spir_0074_billing/      # SPIR project 0074
│   ├── tick_0073_add-feature/    # TICK amendment to spec 0073
│   ├── bugfix_142/               # BUGFIX for GitHub issue #142
│   └── ...
├── codev/
│   ├── projects/                 # SPIR project artifacts
│   │   ├── 0073-user-auth/
│   │   │   ├── spec.md
│   │   │   ├── plan.md
│   │   │   ├── status.yaml
│   │   │   └── review.md
│   │   └── ...
│   ├── executions/               # All protocol execution state (TICK, BUGFIX, etc.)
│   │   ├── tick_0073_add-feature/
│   │   │   └── status.yaml
│   │   ├── bugfix_142/
│   │   │   └── status.yaml
│   │   └── ...
│   ├── protocols/
│   └── resources/
└── ...
```

**Naming scheme for worktrees:**
- SPIR: `spir_<project_id>_<name>`
- TICK: `tick_<spec_id>_<amendment_name>`
- BUGFIX: `bugfix_<issue_number>`

**Project-centric structure**: SPIR projects get their own directory with spec, plan, status, review. TICK/BUGFIX executions get simpler state in `executions/`.

**Key changes:**
- Directory is `projects/` not `.builders/`
- Worktree persists after porch stops
- Can resume work on a project later
- Multiple projects can exist simultaneously

**Worktree lifecycle:**
- `afx kickoff 0073` creates worktree + starts porch (builder)
- `afx stop 0073` stops porch but preserves worktree
- `afx resume 0073` resumes porch in existing worktree
- `afx cleanup 0073` removes worktree (after project complete or abandoned)

### 2. Porch as Builder

When you kickoff a project, porch becomes the builder:

```bash
# Current system
afx kickoff 0073                # Spawns Claude session that follows SPIR protocol

# New system (porch)
afx kickoff 0073                # Creates worktree at worktrees/spir_0073_*/
                              # Runs: porch run spir 0073
                              # Porch orchestrates the entire lifecycle
```

### 3. JSON Protocol Definitions

Protocols defined declaratively in JSON:

```
codev-skeleton/protocols/
├── spir/
│   ├── protocol.json     # Machine-readable protocol definition
│   ├── protocol.md       # Human-readable protocol documentation (kept for reference)
│   └── prompts/          # SPIR-specific prompts
│       ├── specify.md
│       ├── plan.md
│       ├── implement.md
│       ├── defend.md
│       ├── evaluate.md
│       └── review.md
├── tick/
│   ├── protocol.json
│   └── prompts/
│       ├── understand.md
│       ├── implement.md
│       └── verify.md
└── bugfix/
    ├── protocol.json
    └── prompts/
        ├── diagnose.md
        ├── fix.md
        └── test.md
```

**Migration approach:**
- JSON becomes source of truth for protocol structure
- Keep `protocol.md` for human readability (manually maintained, not generated)
- Each protocol gets its own prompts directory

**Keeps:**
- Phase prompts (as `.md` files, per-protocol)

### 4. Architect Notification

Porch notifies the architect when human review is needed:

```
┌─────────────────────────────────────────────────────────────────┐
│  ARCHITECT DASHBOARD                                             │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  🔔 AWAITING REVIEW                                         │ │
│  │                                                             │ │
│  │  0073 user-auth    specify_approval    "Spec ready"        │ │
│  │  0074 billing      plan_approval       "Plan ready"        │ │
│  │                                                             │ │
│  │  [Approve] [Reject] [View]                                 │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  Active Projects:                                                │
│  • 0073 user-auth     specify:review  (blocked)                 │
│  • 0074 billing       implement       (running)                  │
│  • 0075 search        complete                                   │
└─────────────────────────────────────────────────────────────────┘
```

**Notification mechanisms** (architecture TBD - see "Communication Architecture" section):

1. **Polling hook (for Claude)** - Architect Claude gets notifications via hook:
   ```bash
   # .claude/hooks/porch-notify.sh (user-prompt-submit-hook)
   # Scans codev/status/*.md OR queries SQLite (TBD)
   ```
   Extends the signal protocol upward - porch emits state, architect Claude polls.

2. **Dashboard (for humans)** - afx dashboard shows pending approvals
3. **CODEV_HQ (for remote)** - Push notifications via event relay (design TBD)

## Technical Design

### Three Commands

The codev ecosystem splits into three distinct commands:

| Command | Purpose | Layer |
|---------|---------|-------|
| `codev` | Project setup/utilities | Foundation |
| `porch` | Protocol REPL (this spec) | Engine |
| `afx` | Multi-session UI (Agent Farm) | Orchestration |

**codev** - Project initialization and utilities
- `codev init` - Initialize a new project
- `codev adopt` - Adopt codev into existing project
- `codev doctor` - Check project health

**porch** - Protocol execution engine (standalone)
- Interactive REPL that runs protocols
- Persists state to `codev/projects/<id>/status.yaml`
- No dependency on tmux or the orchestration layer

**afx** - Agent Farm (Orchestration UI)
- Dashboard for managing multiple porch sessions (builders)
- Creates worktrees, kickoffs porch processes
- Provides web UI for monitoring
- Enables the Architect-Builder pattern

### Phased Phases (IDE Loop)

SPIR's IDE phases (Implement, Defend, Evaluate) run as a loop over plan phases:

```
Plan file defines:
  Phase 1: Database schema
  Phase 2: API endpoints
  Phase 3: Frontend components

Porch reads plan, runs:
  implement:phase_1 → defend:phase_1 → evaluate:phase_1 →
  implement:phase_2 → defend:phase_2 → evaluate:phase_2 →
  implement:phase_3 → defend:phase_3 → evaluate:phase_3 →
  review
```

**State representation:**
```yaml
current_state: "implement:phase_2"
current_phase: "API endpoints"
phases:
  phase_1: { status: complete }
  phase_2: { status: in_progress }
  phase_3: { status: pending }
```

This is the Ralph principle applied within a protocol: each phase iteration gets fresh context while state persists.

### Protocol JSON Schema

**State notation**: `<phase>:<substate>` — e.g., `specify:review` = Specify phase, review substate

```json
{
  "name": "spir",
  "version": "2.0.0",
  "description": "Specify → Plan → Implement → Defend → Evaluate → Review",

  "phases": [
    {
      "id": "specify",
      "name": "Specify",
      "prompt": "prompts/specify.md",
      "substates": ["draft", "consult", "revise"],
      "signals": { "SPEC_DRAFTED": "specify:consult" },
      "consultation": {
        "on": "consult",
        "models": ["gemini", "codex", "claude"],
        "type": "spec-review",
        "parallel": true,
        "next": "specify:revise"
      },
      "gate": {
        "after": "revise",
        "type": "human",
        "next": "plan:draft"
      }
    },
    {
      "id": "plan",
      "name": "Plan",
      "prompt": "prompts/plan.md",
      "substates": ["draft", "consult", "revise"],
      "signals": { "PLAN_DRAFTED": "plan:consult" },
      "consultation": {
        "on": "consult",
        "models": ["gemini", "codex", "claude"],
        "type": "plan-review",
        "parallel": true,
        "next": "plan:revise"
      },
      "gate": {
        "after": "revise",
        "type": "human",
        "next": "implement:phase_1"
      }
    },
    {
      "id": "implement",
      "name": "Implement",
      "prompt": "prompts/implement.md",
      "phased": true,
      "phases_from": "plan",
      "checks": {
        "build": { "command": "npm run build", "on_fail": "retry" }
      }
    },
    {
      "id": "defend",
      "name": "Defend",
      "prompt": "prompts/defend.md",
      "phased": true,
      "checks": {
        "tests": { "command": "npm test", "on_fail": "retry" }
      }
    },
    {
      "id": "evaluate",
      "name": "Evaluate",
      "prompt": "prompts/evaluate.md",
      "phased": true,
      "signals": { "PHASE_COMPLETE": "next_phase_or_review" }
    },
    {
      "id": "review",
      "name": "Review",
      "prompt": "prompts/review.md",
      "signals": { "REVIEW_COMPLETE": "complete" }
    }
  ],

  "initial": "specify:draft"
}
```

**Key schema features:**
- `gate` integrated into phase definition (not separate)
- `checks` field defines build/test commands per phase
- `phased: true` - Phase runs per-plan-phase
- `phases_from: "plan"` - Read phases from plan file

### State File Format

```yaml
# codev/projects/0073-user-auth/status.yaml
id: "0073"
title: "user-auth"
protocol: "spir"
state: "specify:review"
worktree: ".worktrees/0073-user-auth"

gates:
  specify_approval: { status: pending, requested_at: "..." }
  plan_approval: { status: pending }

phases:
  phase_1: { status: complete }
  phase_2: { status: in_progress }
  phase_3: { status: pending }

iteration: 5
started_at: "2026-01-19T10:00:00Z"
last_updated: "2026-01-19T10:15:00Z"

log:
  - ts: "2026-01-19T10:00:00Z"
    event: "state_change"
    from: null
    to: "specify:draft"
  - ts: "2026-01-19T10:15:00Z"
    event: "signal"
    signal: "SPEC_READY"
    result: "specify:review"
```

**File format**: Pure YAML (not markdown with frontmatter). Structured for both human readability and machine parsing.

### LLM Integration Mechanism

Porch interfaces with Claude via **subprocess control**:

```
┌─────────────────────────────────────────────────────────────┐
│  PORCH REPL                                                  │
│                                                              │
│  ┌────────────────┐                                         │
│  │  State Machine │                                         │
│  │  (TypeScript)  │                                         │
│  └───────┬────────┘                                         │
│          │                                                   │
│          ▼                                                   │
│  ┌────────────────┐     ┌────────────────┐                  │
│  │  Phase Prompt  │────►│  claude CLI    │                  │
│  │  + Status      │     │  (subprocess)  │                  │
│  └────────────────┘     └───────┬────────┘                  │
│                                  │                           │
│                                  ▼                           │
│                         ┌────────────────┐                  │
│                         │  Signal Parser │◄── stdout        │
│                         └───────┬────────┘                  │
│                                  │                           │
│                                  ▼                           │
│                         State transition                     │
└─────────────────────────────────────────────────────────────┘
```

**Integration approach:**
1. Porch spawns `claude` CLI as subprocess with `--print` flag
2. Passes phase prompt + current status as input
3. Claude executes autonomously (with `--dangerously-skip-permissions` or approved permissions)
4. Porch captures stdout, scans for `<signal>...</signal>` tags
5. Signal triggers state transition
6. Repeat until terminal state or gate

**Fresh context per iteration** (Ralph principle): Each Claude invocation is stateless. All context comes from:
- The phase prompt (from protocol definition)
- The status file (current state)
- The project files (spec, plan, code)

### Multi-Agent Consultation

Porch orchestrates 3-way reviews at protocol-defined checkpoints:

```
┌─────────────────────────────────────────────────────────────────┐
│  PORCH - Consultation Flow                                       │
│                                                                  │
│  Claude completes draft ──► Signal: READY_FOR_REVIEW            │
│                                    │                             │
│                    ┌───────────────┼───────────────┐             │
│                    │               │               │             │
│                    ▼               ▼               ▼             │
│              ┌─────────┐    ┌─────────┐    ┌─────────┐          │
│              │ Gemini  │    │  Codex  │    │ Claude  │          │
│              │ consult │    │ consult │    │ consult │          │
│              └────┬────┘    └────┬────┘    └────┬────┘          │
│                   │              │              │                │
│                   └──────────────┼──────────────┘                │
│                                  ▼                               │
│                         ┌───────────────┐                        │
│                         │ Collect       │                        │
│                         │ Feedback      │                        │
│                         └───────┬───────┘                        │
│                                 │                                │
│                                 ▼                                │
│                    ┌────────────────────────┐                    │
│                    │ Claude: Incorporate    │                    │
│                    │ feedback, revise draft │                    │
│                    └────────────┬───────────┘                    │
│                                 │                                │
│                                 ▼                                │
│                    Signal: REVISION_COMPLETE                     │
└─────────────────────────────────────────────────────────────────┘
```

**Protocol schema for consultation:**

```json
{
  "id": "specify",
  "name": "Specify",
  "prompt": "prompts/specify.md",
  "substates": ["draft", "review", "revise"],
  "signals": {
    "SPEC_DRAFTED": "specify:review"
  },
  "consultation": {
    "trigger": "specify:review",
    "models": ["gemini", "codex", "claude"],
    "type": "spec-review",
    "parallel": true,
    "next": "specify:revise"
  },
  "gate": {
    "after": "revise",
    "type": "human",
    "next": "plan:draft"
  }
}
```

**Consultation loop:**

```
┌─────────────────────────────────────────────────────────┐
│  CONSULT-REVISE LOOP                                     │
│                                                          │
│  ┌─────────┐                                            │
│  │  Draft  │                                            │
│  └────┬────┘                                            │
│       │                                                  │
│       ▼                                                  │
│  ┌─────────────────────────────────────────────┐        │
│  │  3-way consultation (parallel)              │◄──┐    │
│  │  gemini, codex, claude                      │   │    │
│  └────────────────────┬────────────────────────┘   │    │
│                       │                            │    │
│                       ▼                            │    │
│              ┌────────────────┐                    │    │
│              │ All APPROVE?   │                    │    │
│              └───────┬────────┘                    │    │
│                      │                             │    │
│           ┌──────────┴──────────┐                  │    │
│           │                     │                  │    │
│        YES│                  NO │                  │    │
│           ▼                     ▼                  │    │
│  ┌─────────────┐      ┌─────────────────┐         │    │
│  │  Complete   │      │  Claude revises │─────────┘    │
│  │  → gate     │      │  (incorporate   │   (re-consult)│
│  └─────────────┘      │   feedback)     │              │
│                       └─────────────────┘              │
└─────────────────────────────────────────────────────────┘
```

**Mechanics:**
1. Claude drafts → signals `SPEC_DRAFTED`
2. Porch runs 3-way consultation in parallel
3. Collect feedback into `consultation-specify-round-N.md`
4. If all APPROVE → proceed to human gate
5. If any REQUEST_CHANGES:
   - Claude incorporates feedback
   - Re-run consultation (round N+1)
   - Repeat until all APPROVE or max rounds reached
6. Human gate → next phase

**Loop limits:**
- `max_consultation_rounds: 3` (configurable in protocol)
- If stuck after max rounds → escalate to human

**Feedback file format:**
```markdown
# Consultation: Specify Phase (Round 2)

## Gemini
**Verdict**: APPROVE
**Summary**: Issues from round 1 addressed

## Codex
**Verdict**: APPROVE
**Summary**: Error handling section looks good now

## Claude
**Verdict**: APPROVE
**Summary**: Ready for human review
```

### Error Recovery

**Atomic state updates:**
```
1. Write new state to status.yaml.tmp
2. fsync() to ensure durability
3. Rename status.yaml.tmp → status.yaml (atomic on POSIX)
```

**Crash recovery on startup:**
```
porch resume 0073:
  1. Read status.yaml
  2. If status.yaml.tmp exists → crash during write → use .tmp if valid
  3. Resume from last recorded state
  4. Re-run current phase (idempotent by design)
```

**Check retry policy:**
```yaml
checks:
  build:
    command: "npm run build"
    on_fail: "retry"
    max_retries: 3
    retry_delay: 5  # seconds
```

**Unrecoverable failures:**
- After max_retries exceeded → state becomes `failed:<phase>`
- Notification sent to architect
- Manual intervention required (`porch retry` or `porch skip`)

### Plan Phase Extraction

Plans must define phases in a parseable format. Porch scans the plan markdown for phase headers:

**Required plan structure:**
```markdown
## Implementation Phases

### Phase 1: Database Schema
- Create users table
- Add indexes

### Phase 2: API Endpoints
- POST /users
- GET /users/:id

### Phase 3: Frontend Components
- UserForm component
- UserList component
```

**Extraction rules:**
1. Look for `## Implementation Phases` or `## Phases` heading
2. Each `### Phase N: <title>` becomes a phase
3. Content under each phase header is the phase description
4. Phases are ordered by number

**Parsed result (stored in status.yaml):**
```yaml
plan_phases:
  - id: "phase_1"
    title: "Database Schema"
    description: "Create users table, Add indexes"
  - id: "phase_2"
    title: "API Endpoints"
    description: "POST /users, GET /users/:id"
  - id: "phase_3"
    title: "Frontend Components"
    description: "UserForm component, UserList component"
```

**Fallback:** If no structured phases found, treat entire implementation as single phase.

### Signal Protocol Details

Signals are the mechanism by which Claude communicates phase completion to Porch.

**Signal format:**
```xml
<signal>SIGNAL_NAME</signal>
```

**Valid signals per phase:**

| Phase | Signal | Effect |
|-------|--------|--------|
| specify:draft | `SPEC_DRAFTED` | → specify:consult |
| specify:revise | `REVISION_COMPLETE` | → human gate |
| plan:draft | `PLAN_DRAFTED` | → plan:consult |
| plan:revise | `REVISION_COMPLETE` | → human gate |
| implement | `PHASE_IMPLEMENTED` | → defend |
| defend | `TESTS_WRITTEN` | → evaluate |
| evaluate | `EVALUATION_COMPLETE` | → next phase or review |
| review | `REVIEW_COMPLETE` | → complete |

**Signal parsing rules:**
1. Scan stdout for `<signal>...</signal>` patterns
2. Only the **last** signal in output is used
3. Signal must match defined signals for current phase
4. Unknown signals are logged but ignored
5. Missing signal uses default transition

**Error handling:**
- If Claude crashes mid-output → re-run phase (idempotent design)
- If signal parsing fails → log error, continue to next iteration
- If no signal after max iterations → escalate to human

### Timeout Configuration

**Default timeouts:**
```yaml
config:
  claude_timeout: 600        # 10 minutes per Claude invocation
  consultation_timeout: 300  # 5 minutes per consult invocation
```

**Timeout behavior:**
- Claude timeout exceeded → terminate process, retry with exponential backoff
- Consultation timeout → mark that model as "timeout", proceed if 2/3 respond

**Gate handling (Interactive REPL):**
- When a gate is pending, porch prompts the user directly in the terminal
- User can type `y/yes/approve` to approve, `n/no` to decline, or `quit` to exit
- No polling or waiting - the REPL blocks until user responds
- For background/remote use, the gate status is persisted in status.yaml for external monitoring

### Concurrent Access Handling

**File locking strategy:**
1. Status file uses `flock()` advisory locking during writes
2. Readers acquire shared lock, writers acquire exclusive lock
3. Lock timeout: 5 seconds (then retry or fail)

**Race condition handling:**
- `afx status` while `porch run` active → reads last committed state (safe)
- Two porch instances on same project → second instance fails with "already running"
- Multiple projects → independent, no conflict (separate status files)

**Worktree isolation:**
- Each project has its own git worktree
- Worktrees share `node_modules` from main (via npm workspace symlinks)
- Build artifacts are worktree-local

### Security Considerations

**Permission model:**
- Development projects: `--dangerously-skip-permissions` acceptable for trusted repos
- Production use: Configure approved permissions per protocol in `protocol.json`:
  ```json
  {
    "permissions": {
      "implement": ["write:src/**", "bash:npm *"],
      "defend": ["write:tests/**", "bash:npm test"],
      "review": ["read:*"]
    }
  }
  ```

**Subprocess sandboxing:**
- Porch runs in user context (no privilege escalation)
- Build/test commands run in worktree directory (isolated from main)
- Environment variables are not passed to Claude by default

**Credential handling:**
- No secrets in status files (human-readable, may be committed)
- Claude credentials via user's `~/.claude/` config
- Consult tool credentials via respective CLI configs

**Notification security:**
- Gate pending notifications contain project ID only, not file contents
- Dashboard requires local access (not exposed remotely by default)

### TICK/BUGFIX Protocol Details

**TICK protocol** (for amendments to existing specs):

```
understand → implement → verify → complete
```

- **No human gates** - fully autonomous for small changes
- **Scope limit**: <300 LOC net diff
- **State storage**: `codev/executions/tick_<spec>_<name>/status.yaml`
- **Worktree**: `worktrees/tick_<spec>_<name>/`
- **Modifies in-place**: Updates existing spec and plan files
- **Review type**: Uses `tick-review` consultation type

**BUGFIX protocol** (for GitHub issue fixes):

```
diagnose → fix → test → pr → complete
```

- **No human gates** - fully autonomous
- **Source of truth**: GitHub issue (not projectlist.md)
- **State storage**: `codev/executions/bugfix_<issue>/status.yaml`
- **Worktree**: `worktrees/bugfix_<issue>/`
- **Auto-PR**: Creates PR on completion

**Protocol selection:**
```bash
afx kickoff 0073                # SPIR (new feature)
afx kickoff --tick 0073 name    # TICK (amend existing spec 0073)
afx kickoff --issue 142         # BUGFIX (GitHub issue)
```

### Notification Mechanism

**Local notification (MVP):**

Porch writes pending gates to status file. Architect discovery via:

1. **Polling hook** (for Claude-as-architect):
   ```bash
   # .claude/hooks/user-prompt-submit-hook
   #!/bin/bash
   # Scan for pending gates
   for f in codev/projects/*/status.yaml codev/executions/*/status.yaml; do
     if grep -q "status: pending" "$f" 2>/dev/null; then
       echo "⚠️ Gate pending: $f"
     fi
   done
   ```

2. **Dashboard polling** (for human):
   ```
   afx status   # Shows all projects with gate status
   ```

3. **File watcher** (optional):
   ```bash
   fswatch -o codev/projects/*/status.yaml | while read; do
     afx status --pending-only
   done
   ```

**Future (CODEV_HQ):** Push notifications via WebSocket, but that's out of scope for this spec.

### CLI Changes

```bash
# Project lifecycle
afx kickoff 0073                       # Create worktree + start porch
afx status                             # Show all projects and states
afx status 0073                        # Show specific project state
afx approve 0073 specify_approval      # Approve a gate
afx stop 0073                          # Stop porch (worktree persists)
afx resume 0073                        # Resume porch on existing worktree

# Direct porch access (standalone command)
porch run spir 0073                 # Run protocol REPL
porch status 0073                     # Show state
porch approve 0073 <gate>             # Approve gate
```

## Success Criteria

### Functional Requirements
- [ ] `porch` is a standalone command (not `codev porch`)
- [ ] Protocols defined in JSON (with human-readable protocol.md maintained alongside)
- [ ] Porch runs as interactive REPL (Ralph-style fresh context per iteration)
- [ ] IDE phases loop over plan phases (phased implementation)
- [ ] Human gates block and notify architect
- [ ] Architect can approve via CLI or dashboard
- [ ] State persists to files, survives porch restart
- [ ] `afx kickoff` creates persistent worktree and runs porch
- [ ] Worktree persists after porch stops
- [ ] Can resume a paused project
- [ ] Multiple porch instances can run simultaneously (different worktrees)
- [ ] TICK and BUGFIX protocols work with simpler flows

### Testing Requirements
- [ ] Unit tests: State machine transitions, signal parsing, plan phase extraction
- [ ] Integration tests: Full SPIR loop with `--no-claude` flag
- [ ] Integration tests: TICK and BUGFIX protocols with `--no-claude`
- [ ] Crash recovery tests: Resume from interrupted state
- [ ] Concurrent access tests: File locking under contention
- [ ] Test coverage >80% for core state machine logic

## Migration

### From Current System

1. Move protocol definitions: Create `protocols/*.json` alongside existing `protocols/*.md`
2. Keep prompts as markdown
3. Change `.builders/` to `worktrees/` and `codev/projects/`
4. Update `afx kickoff` to run porch instead of Claude directly

### Claude Migration Instructions

When Claude encounters an existing project using the old system:

```
If you find:
  - .builders/ directory → These are legacy worktrees
  - codev/specs/NNNN-*.md → These are existing specs

Migration steps:
1. Create codev/projects/NNNN-name/ for each active spec
2. Move spec to codev/projects/NNNN-name/spec.md
3. Move plan to codev/projects/NNNN-name/plan.md
4. Create status.yaml with current state
5. Clean up .builders/ after migration verified
```

### Backward Compatibility

- `afx kickoff --legacy` runs old Claude-based builder (transitional)
- Existing `.builders/` worktrees can be migrated or cleaned up

## Resolved Decisions

1. **Worktree location**: `worktrees/` in repo root (not hidden, separate from `codev/projects/`)
2. **Project structure**: `codev/projects/<id>/` contains spec.md, plan.md, status.yaml, review.md
3. **tmux dependency**: None - porch IS the interactive experience
4. **LLM integration**: Subprocess control via `claude` CLI with signal parsing
5. **Error recovery**: Atomic writes + crash recovery on resume
6. **Plan phase extraction**: Parse `### Phase N: <title>` headers from plan markdown
7. **File format**: Pure YAML for status (not markdown with frontmatter)
8. **Orchestration command**: `afx` (Agent Farm - keeping existing name)
9. **Action verb**: `kickoff` instead of `spawn` (conductor kicks off the performance)
10. **Multi-agent consultation**: `consultation` field in phase definition triggers 3-way parallel reviews
11. **Multiple instances**: Supported - each project runs in its own worktree
12. **protocol.md**: Keep for human readability, maintained alongside protocol.json
13. **Signal protocol**: XML-style `<signal>...</signal>` tags, last signal wins
14. **Timeout strategy**: Configurable per operation type (claude/consultation/gate)
15. **Concurrent access**: flock() advisory locking on status files
16. **Notification mechanism**: File-based polling (MVP), CODEV_HQ push (future)
17. **TICK/BUGFIX protocols**: No human gates, simpler state in `codev/executions/`

## Open Questions

None remaining - all resolved in this spec.

---

## Notes

*Spec drafted collaboratively between Architect and Claude based on spike 0072.*
