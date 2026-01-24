# Protocol Definition Format

This document describes the format for defining protocols in Codev. Protocols define the workflow for development tasks (SPIDER, TICK, BUGFIX, etc.).

## Directory Structure

Each protocol lives in its own directory:

```
protocols/
└── spider/
    ├── protocol.json    # Machine-readable protocol definition
    ├── protocol.md      # Human-readable protocol guide
    ├── prompts/         # Phase-specific prompts for AI agents
    │   ├── specify.md
    │   ├── plan.md
    │   ├── implement.md
    │   ├── defend.md
    │   ├── evaluate.md
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
| `name` | string | Yes | Protocol identifier (e.g., "spider", "tick") |
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

- **`once`**: Runs once per project (e.g., specify, plan, review)
- **`per_plan_phase`**: Runs for each phase in the plan (e.g., implement, defend, evaluate)

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

### Consultation

Configure multi-agent review:

```json
{
  "consultation": {
    "on": "review",
    "models": ["gemini", "codex", "claude"],
    "type": "spec-review",
    "parallel": true,
    "max_rounds": 3
  }
}
```

### Verification

Checks run after Claude signals PHASE_COMPLETE. If verification fails, porch respawns Claude (up to max_retries times):

```json
{
  "verification": {
    "checks": {
      "pr_has_3way": "gh pr list --head $(git branch --show-current) --json number -q '.[0].number' | xargs -I{} gh pr view {} --json comments -q '.comments[].body' | grep -qE '(Gemini|gemini).*(Codex|codex)'"
    },
    "max_retries": 5
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `checks` | object | Yes | Name → command pairs to verify phase output |
| `max_retries` | number | No | Max respawn attempts before proceeding to gate (default: 5) |

**Behavior:**
1. Claude signals PHASE_COMPLETE
2. Porch runs verification checks
3. If all pass → proceed to gate (or next phase)
4. If any fail and retries < max_retries → respawn Claude
5. If retries >= max_retries → proceed to gate (human decides)

**Use cases:**
- Review phase: Verify PR has 3-way consultation comment
- Spec phase: Verify spec has required sections
- Any phase needing post-completion validation with retry

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

You are executing the **SPECIFY** phase of the SPIDER protocol.

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

See `skeleton/protocols/spider/protocol.json` for a complete SPIDER protocol definition.

## Creating a New Protocol

1. Create directory: `codev/protocols/<name>/`
2. Create `protocol.json` with phases
3. Create `prompts/` directory with phase prompts
4. Optionally create `templates/` for artifact templates
5. Create `protocol.md` with human-readable guide

Porch will automatically discover and use the new protocol when referenced by name.
