# Protocol Definition Format

This document describes the format for defining protocols in Codev. Protocols define the workflow for development tasks (SPIR, TICK, BUGFIX, etc.).

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
| `name` | string | Yes | Protocol identifier (e.g., "spir", "tick") |
| `version` | string | No | Semantic version |
| `description` | string | No | Human-readable description |
| `phases` | array | Yes | List of phase definitions |
| `signals` | object | No | Signal definitions |
| `phase_completion` | object | No | Checks run at end of each plan phase |
| `defaults` | object | No | Default settings |

### Phase Definition

Each phase in the `phases` array:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Phase identifier (e.g., "specify", "implement") |
| `name` | string | No | Display name |
| `description` | string | No | What this phase does |
| `type` | string | No | "once" or "per_plan_phase" |
| `prompt` | string | No | Filename in prompts/ directory |
| `steps` | array | No | Named steps within the phase |
| `checks` | object | No | Validation checks |
| `gate` | object | No | Human approval gate |
| `transition` | object | No | State transitions |
| `consultation` | object | No | Multi-agent consultation config |

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
| `on_complete.commit` | boolean | No | Commit artifact after successful verify |
| `on_complete.push` | boolean | No | Push after commit |

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


### Signals

Define signals that AI agents can emit:

```json
{
  "signals": {
    "PHASE_COMPLETE": {
      "description": "Signal current phase is complete",
      "transitions_to": "next_phase"
    },
    "BLOCKED": {
      "description": "Signal implementation is blocked",
      "requires": "reason"
    }
  }
}
```

### Phase Completion Checks

Checks run at the end of each plan phase (after evaluate):

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
4. Run consultations
5. Get human approval

## Signals

- When spec is ready: `PHASE_COMPLETE`
- If you need help: `BLOCKED: <reason>`
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

## See Also

- `codev-skeleton/protocols/protocol-schema.json` - JSON Schema for validation
- `codev-skeleton/protocols/spir/protocol.json` - SPIR protocol (full example)
- `codev/protocols/spir/protocol.md` - SPIR human-readable guide
- `codev/protocols/` - All available protocols
