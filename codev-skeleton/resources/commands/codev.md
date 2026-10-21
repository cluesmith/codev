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

If CLAUDE.md or AGENTS.md conflicts, adopt launches Claude to merge the `.codev-new` versions; interactively it waits for that session to end. Then, on a project with code to document, it asks "Draft the governance docs from this codebase now?" (default No); yes runs `codev bootstrap-docs`. With `-y` nothing is launched and the command is listed under "Next steps" instead. An empty project gets neither the offer nor the hint.

**Examples:**

```bash
# Add to current project
cd existing-project
codev adopt

# Skip prompts for conflicts
codev adopt -y
```

---

### codev bootstrap-docs

Draft the governance docs from the existing codebase.

```bash
codev bootstrap-docs [options]
```

**Options:**
- `-n, --dry-run` - Report which files are eligible and what would launch; launch and write nothing

**Description:**

Writes a first draft of the four governance files (`codev/resources/arch.md`, `lessons-learned.md`, `arch-critical.md`, `lessons-critical.md`) from the code shape, build wiring and git history. Only files that are still the untouched starters are rewritten; a file with real content is read as input and never edited, and a missing file is reported (run `codev update` to restore it). An empty project is left with its placeholders. Re-running on a populated result changes nothing.

**Flow:**

1. Classify the four files and print each one's status.
2. Write the prompt to `.consult/bootstrap-docs/prompt.md`, show the exact agent command, what it may write and that it consumes model quota, and ask before launching (always; there is no `-y`). The agent follows the `update-arch-docs` skill's bootstrap mode: the project's installed copy when it is identical to the package's version, otherwise the packaged text included in the prompt (the launch statement says which). The agent explores the git history itself, read-only.
3. Run the configured architect harness on the terminal. Exit the session when it says the drafts are done.
4. Report what changed: drafts written, hot-tier cap and map violations, and any path outside the four files (change detection covers the git state and every path git does not ignore, except `.consult/`, where consult writes its own output).
5. When `consult` is available, run a three-way review of the drafts; reviews land in `.consult/bootstrap-docs/<model>.md`.

Nothing is committed: review the drafts, edit, then commit them yourself.

**Manual fallback:** when no supported agent CLI is found, or the prompt is too long to pass as an argument, nothing is launched; give `.consult/bootstrap-docs/prompt.md` to your own agent as its first message.

**Exit codes:** `0` when nothing needed doing, the launch was declined, or the drafts are clean; `1` when there is no `codev/` directory, the agent failed, a draft is missing or breaks the hot-tier rules, or anything changed outside the four files (during the session) or anywhere (while the reviewers ran). Reviewer verdicts never change the exit code. Under `codev adopt`, a pass with problems is reported in its summary, and adopt still exits `0`.

**Examples:**

```bash
# See what would happen
codev bootstrap-docs --dry-run

# Draft the docs
codev bootstrap-docs
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
- git (>= 2.5.0)
- gh (GitHub CLI, authenticated)

**AI CLI Dependencies (at least one required):**
- Claude (`@anthropic-ai/claude-code`)
- Gemini (Antigravity CLI, `agy`)
- Codex (`@openai/codex`)

**Migration Backups (report-only):**
- Leftover copies of pre-migration state — whole-directory `~/.agent-farm.bak-*` / `~/agent-farm-db-backup-*` copies and the `*.pre-merge-<timestamp>` renames left by `afx db consolidate` — listed with age and size on disk.
- Nothing reaps these automatically, so doctor surfaces each one together with the exact `rm -rf` command and leaves the decision to you. It never deletes anything.
- Backups younger than 7 days are listed but not counted as warnings; the section is omitted entirely when there are none.

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

Shipped Claude and Codex skills (`.claude/skills/`, `.codex/skills/`) are refreshed too. A missing skill is added. A skill you never edited, one whose content matches a version Codev shipped, is replaced with the package's version. An edited skill is kept, and each of its files that differs gets a `<file>.codev-new` copy of the new version for the merge, on every update while it differs. A file the package adds to an edited skill arrives as `.codev-new` too. `--force` overwrites an edited skill's packaged files as well, keeping any file the package does not ship. A symlinked skill directory, one holding a symlink, or a symlinked `.claude/`, `.codex/` or skills root is left alone. `--dry-run` reports all of this without writing.

When a governance file is still a starter on a project with code, `codev update` prints one line pointing at `codev bootstrap-docs` (in `--agent` mode it is the `instructions.bootstrapDocs` string instead; never on `--dry-run`).

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

## See Also

- [afx](agent-farm.md) - Agent Farm commands
- [consult](consult.md) - AI consultation
- [overview](overview.md) - CLI overview
