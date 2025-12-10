# codev - Project Management CLI

The `codev` command manages project setup, maintenance, and framework-level operations.

## Synopsis

```
codev <command> [options]
```

## Commands

### codev init

Create a new codev project.

```bash
codev init [project-name] [options]
```

**Arguments:**
- `project-name` - Name of the project (optional, prompts if not provided)

**Options:**
- `-y, --yes` - Use defaults without prompting

**Description:**

Creates a minimal codev project structure:
- `codev/specs/` - Specification files
- `codev/plans/` - Implementation plans
- `codev/reviews/` - Review documents
- `codev/projectlist.md` - Project tracking
- `CLAUDE.md` / `AGENTS.md` - AI agent instructions
- `.gitignore` - Standard ignores

Framework files (protocols, roles) are provided by the embedded skeleton at runtime, not copied to the project.

**Examples:**

```bash
# Interactive creation
codev init

# Create with name
codev init my-app

# Non-interactive with defaults
codev init my-app -y
```

---

### codev adopt

Add codev to an existing project.

```bash
codev adopt [options]
```

**Options:**
- `-y, --yes` - Skip conflict prompts

**Description:**

Adds codev structure to the current directory. Detects existing files (CLAUDE.md, AGENTS.md) and prompts before overwriting.

Use this when you want to add codev to a project that already has code.

**Examples:**

```bash
# Add to current project
cd existing-project
codev adopt

# Skip prompts for conflicts
codev adopt -y
```

---

### codev doctor

Check system dependencies.

```bash
codev doctor
```

**Description:**

Verifies that all required dependencies are installed and properly configured:

**Core Dependencies (required):**
- Node.js (>= 18.0.0)
- tmux (>= 3.0)
- ttyd (>= 1.7.0)
- git (>= 2.5.0)
- gh (GitHub CLI, authenticated)

**AI CLI Dependencies (at least one required):**
- Claude (`@anthropic-ai/claude-code`)
- Gemini (`gemini-cli`)
- Codex (`@openai/codex`)

**Exit Codes:**
- `0` - All OK or warnings only
- `1` - Required dependencies missing

**Example:**

```bash
codev doctor
```

Output:
```
Codev Doctor - Checking your environment
============================================

Core Dependencies (required for Agent Farm)

  ✓ Node.js      20.10.0
  ✓ tmux         3.4
  ✓ ttyd         1.7.4
  ✓ git          2.42.0
  ✓ gh           authenticated
  ✓ @cluesmith/codev  1.0.0

AI CLI Dependencies (at least one required)

  ✓ Claude       working
  ✓ Gemini       working
  ○ Codex        not installed (npm i -g @openai/codex)

============================================
ALL OK - Your environment is ready for Codev!
```

---

### codev update

Update codev templates and protocols.

```bash
codev update [options]
```

**Options:**
- `-n, --dry-run` - Show changes without applying
- `-f, --force` - Force update, overwrite all files

**Description:**

Updates framework files (protocols, roles, agents) from the installed `@cluesmith/codev` package. User data (specs, plans, reviews) is never modified.

If you've customized a file locally, the update creates a `.codev-new` file with the new version so you can merge changes manually.

**Examples:**

```bash
# Preview changes
codev update --dry-run

# Apply updates
codev update

# Force overwrite (discard local changes)
codev update --force
```

---

### codev eject

Copy embedded skeleton files locally for customization.

```bash
codev eject [path] [options]
```

**Arguments:**
- `path` - File or directory to eject (e.g., `protocols/spider`)

**Options:**
- `-l, --list` - List available files to eject
- `-f, --force` - Overwrite existing files

**Description:**

Copies embedded framework files to your local `codev/` directory so you can customize them. Ejected files become "local overrides" and won't be changed by `codev update`.

Use this when you want to modify protocols, roles, or templates for your specific project.

**Examples:**

```bash
# List available files
codev eject --list

# Eject a single file
codev eject roles/consultant.md

# Eject entire protocol directory
codev eject protocols/spider

# Force overwrite existing
codev eject protocols/spider --force
```

---

### codev tower

Cross-project dashboard showing all agent-farm instances.

```bash
codev tower [options]
```

**Options:**
- `-p, --port <port>` - Port to run on (default: 4100)
- `--stop` - Stop the tower dashboard

**Description:**

Starts a web-based dashboard that shows all running agent-farm instances across different projects. Useful when working on multiple codev projects simultaneously.

The tower aggregates status from the global port registry at `~/.agent-farm/ports.json`.

**Examples:**

```bash
# Start tower dashboard
codev tower

# Start on custom port
codev tower -p 4200

# Stop the dashboard
codev tower --stop
```

---

## See Also

- [af](agent-farm.md) - Agent Farm commands
- [consult](consult.md) - AI consultation
- [overview](overview.md) - CLI overview
