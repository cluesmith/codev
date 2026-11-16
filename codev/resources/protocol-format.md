# Protocol Definition Format

This document describes the format for defining protocols in Codev. Protocols define the workflow for development tasks (SPIR, AIR, BUGFIX, etc.). `protocol-schema.json` (shipped with every protocol tree) is the machine-checked description of `protocol.json`; a test validates every shipped protocol against it.

**JSON Schema**: `codev-skeleton/protocols/protocol-schema.json` — use `"$schema": "../../protocol-schema.json"` in your protocol.json for IDE validation.

## Directory Structure

Each protocol lives in its own directory:

```
protocols/
└── spir/
    ├── protocol.json    # Machine-readable protocol definition
    ├── protocol.md      # Human-readable protocol guide
    ├── prompts/         # Phase-specific prompts for AI agents
    │   ├── specify.md
    │   ├── plan.md
    │   ├── implement.md
    │   └── review.md
    └── templates/       # Optional templates for artifacts
        ├── spec.md
        └── plan.md
```

## protocol.json

The main protocol definition file. Porch reads this to orchestrate phases.

### Top-Level Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Protocol identifier (e.g., "spir", "bugfix") |
| `version` | string | No | Semantic version |
| `description` | string | No | Human-readable description |
| `phases` | array | Yes | List of phase definitions |
| `signals` | object | No | Legacy — porch does not read it (see Signals below) |
| `phase_completion` | object | No | Named predicates; their names are valid `porch.checks` override keys, but porch does not run them |
| `defaults` | object | No | Default settings |

### Phase Definition

Each phase in the `phases` array:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Phase identifier (e.g., "specify", "implement") |
| `name` | string | No | Display name |
| `description` | string | No | What this phase does |
| `type` | string | No | "once", "build_verify" or "per_plan_phase" |
| `prompt` | string | No | Filename in prompts/ directory |
| `steps` | array | No | Named steps within the phase |
| `checks` | object | No | Validation checks |
| `gate` | object | No | Human approval gate |
| `transition` | object | No | State transitions |
| `consultation` | object | No | `{type, models}` for a review the builder runs from a `once` phase's prompt (BUGFIX/AIR PR phase); porch renders it into `{{consult_commands}}`, applying `.codev/config.json` `porch.consultation` |

### Phase Types

- **`build_verify`**: Build-verify cycle with automatic 3-way consultation
- **`once`**: Runs once per project (legacy, use build_verify instead)
- **`per_plan_phase`**: Runs for each phase in the plan (e.g., implement)

### Build-Verify Phases (Recommended)

Build-verify phases are the core pattern in SPIR v2. Porch orchestrates:
1. **BUILD**: Spawn Claude to create artifact
2. **VERIFY**: Run 3-way consultation (Gemini, Codex, Claude)
3. **ITERATE**: If any REQUEST_CHANGES, feed feedback back to Claude
4. **COMPLETE**: When all APPROVE (or max iterations), commit + push + gate

**Pre-approved artifact skip**: If a `build_verify` artifact already exists with YAML frontmatter (`approved: <date>`, `validated: [models...]`), porch skips that phase entirely and auto-approves the gate. This allows architects to prepare specs/plans before spawning a builder.

```json
{
  "id": "specify",
  "name": "Specify",
  "type": "build_verify",
  "build": {
    "prompt": "specify.md",
    "artifact": "codev/specs/${PROJECT_ID}-*.md"
  },
  "verify": {
    "type": "spec-review",
    "models": ["gemini", "codex", "claude"],
    "parallel": true
  },
  "max_iterations": 3,
  "on_complete": {
    "commit": true,
    "push": true
  },
  "gate": {
    "name": "spec-approval",
    "next": "plan"
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `build.prompt` | string | Yes | Prompt file in prompts/ directory |
| `build.artifact` | string | Yes | Artifact path pattern (supports ${PROJECT_ID}) |
| `verify.type` | string | Yes | Review type (e.g., "spec-review", "plan-review") |
| `verify.models` | array | Yes | Models to consult ["gemini", "codex", "claude"] |
| `verify.parallel` | boolean | No | Run consultations in parallel (default: true) |
| `max_iterations` | number | No | Max build-verify iterations (default: 3) |
| `on_complete.commit` | boolean | No | Descriptive only — porch commits just `status.yaml`; the builder commits its work |
| `on_complete.push` | boolean | No | Descriptive only |

### Checks

Checks are shell commands that validate work:

```json
{
  "checks": {
    "spec_exists": "test -f codev/specs/${PROJECT_ID}-*.md",
    "build": {
      "command": "npm run build",
      "on_fail": "retry",
      "max_retries": 2
    }
  }
}
```

Check definition formats:
- **String**: Simple shell command
- **Object**: Command with options (`command`, `on_fail`, `max_retries`)

Environment variables available:
- `${PROJECT_ID}` - The project ID (e.g., "0074")
- `${PROJECT_TITLE}` - The project title

### Gates

Gates require human approval before proceeding:

```json
{
  "gate": {
    "name": "spec-approval",
    "description": "Human approves specification before planning",
    "requires": ["spec_final", "consultation"],
    "next": "plan"
  }
}
```

| Field | Description |
|-------|-------------|
| `name` | Gate identifier |
| `description` | What the human is approving |
| `requires` | Steps that must complete before gate |
| `next` | Phase to transition to after approval (null = protocol complete) |

### Transitions

Define how phases connect:

```json
{
  "transition": {
    "on_complete": "defend",
    "on_fail": "implement",
    "on_all_phases_complete": "review"
  }
}
```


### Signals (legacy)

Older protocol files carried a `signals` block of named completion and blocked signals. Porch never
reads it: a builder finishes a phase with `porch done <id>` and reports a blocker with
`afx send architect "…"`. New protocols should omit it.

### Phase Completion Predicates

Named shell predicates. Porch parses them but does not run them; their names are accepted as
`porch.checks` override keys. Put checks porch should run in the phase's `checks`:

```json
{
  "phase_completion": {
    "build_succeeds": "npm run build 2>&1",
    "tests_pass": "npm test 2>&1",
    "commit_has_code": "git log -1 --name-only | grep -qE '\\.(ts|js)$'"
  }
}
```

## Prompt Files

Prompt files in the `prompts/` directory are markdown templates with variable substitution.

### Template Variables

Use `{{variable}}` syntax:

| Variable | Description |
|----------|-------------|
| `{{project_id}}` | Project ID (e.g., "0074") |
| `{{title}}` | Project title |
| `{{current_state}}` | Current phase |
| `{{protocol}}` | Protocol name |
| `{{plan_phase_id}}` | Current plan phase ID (for phased protocols) |
| `{{plan_phase_title}}` | Current plan phase title |
| `{{consult_commands}}` | The `consult` commands for a `once` phase with a `consultation` block, one per configured lane (or a comment when `porch.consultation` is `none`/`parent`) |
| `{{consult_verdicts}}` | The matching `model=<APPROVE\|REQUEST_CHANGES>` list for the architect notification |

### Example Prompt

```markdown
# SPECIFY Phase Prompt

You are executing the **SPECIFY** phase of the SPIR protocol.

## Context

- **Project ID**: {{project_id}}
- **Project Title**: {{title}}
- **Spec File**: `codev/specs/{{project_id}}-{{title}}.md`

## Your Task

1. Ask clarifying questions
2. Analyze the problem
3. Draft the specification
4. Commit the spec

## When you finish

- Spec committed: run `porch done {{project_id}}`; porch hands you the consultation commands.
- Need help: `afx send architect "Blocked on <reason>"`
```

### Prompt File Naming

Prompt files are named after protocol phases:
- `specify.md` - For the specify phase
- `plan.md` - For the plan phase
- `implement.md` - For the implement phase (plan phases handled as units)
- `review.md` - For the review phase

For protocols with plan phases, porch adds plan phase context (id, title, content) to the prompt automatically.

## Complete Example

See `codev-skeleton/protocols/spir/protocol.json` for a complete SPIR protocol definition.

## Creating a New Protocol

1. Create directory: `codev/protocols/<name>/`
2. Create `protocol.json` with phases
3. Create `prompts/` directory with phase prompts
4. Optionally create `templates/` for artifact templates
5. Create `protocol.md` with human-readable guide

Porch will automatically discover and use the new protocol when referenced by name.

## Protocol to Task Conversion

Protocols can be converted into Claude Code tasks (via `TaskCreate`) for execution tracking. This flattens the protocol's phase graph into a linear task chain with inline build-verify loops.

### Conversion Algorithm

**Input**: A `protocol.json` file and its associated `prompts/*.md` files.

**Steps**:

1. **Read `protocol.json`** — extract the `phases` array and follow the `next` chain to determine ordering.

2. **For each phase** (in order), read its prompt file at `prompts/<phase.build.prompt>`.

3. **Create one task per phase** with:
   - **subject**: `{phase.name}: {short description from protocol.json}`
   - **activeForm**: Present-continuous form (e.g., "Auditing codebase")
   - **description**: Merge the prompt's numbered steps with the verify loop:
     ```
     1-N. [Steps from the prompt file — the "build" work]
     N+1. Run 3-way consultation ({verify.models joined}) — focus: {verify.type}
     N+2. If reviewers flag issues: fix, re-commit, re-consult (up to {max_iterations} iterations)
     N+3. If max iterations reached without approval: escalate to user

     Do NOT mark complete until consultation passes or user overrides.
     ```
   - If the phase has `checks`, include the commands as verification steps (e.g., "run `npm run build` after each change")
   - If the phase has a `gate`, note that human approval is required before the task can be marked complete

4. **Wire dependencies** using `TaskUpdate.addBlockedBy`: each task is blocked by the previous task in the `next` chain.

### Design Decisions

- **Consultation is inline, not a separate task.** The build-verify loop is one atomic unit — do the work, consult, iterate, all within a single task. This avoids cyclic dependencies which the task system doesn't support.
- **`max_iterations` controls the retry budget.** The task stays `in_progress` while iterating through the build-verify loop. Only mark complete when reviewers approve or max iterations hit (then escalate).
- **Human gates** translate to "Do NOT mark complete without user approval" in the task description.
- **`checks`** (build/test commands) become inline verification steps within the task, not separate tasks.

### Example

Given this phase from `maintain/protocol.json`:
```json
{
  "id": "audit",
  "name": "Audit",
  "type": "build_verify",
  "build": { "prompt": "audit.md" },
  "verify": { "type": "impl-review", "models": ["gemini", "codex", "claude"], "parallel": true },
  "max_iterations": 3,
  "next": "clean"
}
```

Produces this task:
```
Subject: Audit: Scan for dead code, unused deps, stale docs
Description:
  1. [Steps from audit.md prompt...]
  7. Run 3-way consultation (Gemini, Codex, Claude) — focus: impl-review
  8. If reviewers flag issues: fix, re-commit, re-consult (up to 3 iterations)
  9. If max iterations reached: escalate to user

  Do NOT mark complete until consultation passes or user overrides.
```

## See Also

- `codev-skeleton/protocols/protocol-schema.json` - JSON Schema for validation
- `codev-skeleton/protocols/spir/protocol.json` - SPIR protocol (full example)
- `codev/protocols/spir/protocol.md` - SPIR human-readable guide
- `codev/protocols/` - All available protocols
