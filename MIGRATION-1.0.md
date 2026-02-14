# Migration Guide: Upgrading to Codev v1.0.x

This guide covers migrating an existing codev installation to v1.0.x.

## Scenario: Existing Codev Project → v1.0.x

You have a project that previously installed codev (from codev-skeleton) and want to upgrade.

## Prerequisites

### Install the npm package

First, install the new npm package:

```bash
npm install -g @cluesmith/codev
```

This provides three CLI commands:
- `codev` - Main CLI (init, adopt, doctor, update, tower)
- `af` - Agent-farm CLI for parallel development
- `consult` - Multi-agent consultation tool

### Verify dependencies

Before migrating, ensure all dependencies are installed. See **[DEPENDENCIES.md](codev-skeleton/DEPENDENCIES.md)** for complete installation instructions.

**Quick check:**

```bash
# Run the doctor command
codev doctor

# Or check manually
which node && node --version    # Need 18+
which git && git --version      # Need 2.5+
which gh && gh auth status      # Need authenticated
which claude || which gemini || which codex  # Need at least one
```

---

## What Gets Preserved vs Merged vs Deleted

**PRESERVED (your work - never touched):**
```
codev/specs/           # Your specifications
codev/plans/           # Your implementation plans
codev/reviews/         # Your review documents
codev/projectlist.md   # Your project tracking
codev/resources/       # Your architecture docs (arch.md, etc.)
codev/config.json      # Your custom configuration (if exists)
```

**MERGED (AI compares old vs new, preserves local customizations):**
```
codev/bin/             # CLI scripts - usually safe to replace
codev/protocols/       # May have local modifications to protocols
codev/templates/       # May have local UI customizations
codev/roles/           # May have customized role prompts
CLAUDE.md              # May have project-specific instructions
AGENTS.md              # May have project-specific instructions
```

**DELETED (obsolete artifacts from pre-1.0):**
```
codev/builders.md              # Old state file (now .agent-farm/state.json)
.architect.pid                 # Old process tracking
.architect.log                 # Old log file
.builders/                     # Old worktrees (will be recreated)
codev/bin/architect            # Old bash script
```

---

## Migration Process (AI-Assisted)

Migration should be performed by an AI assistant (Claude, etc.) that can:
1. Read both old and new versions of files
2. Identify local customizations worth preserving
3. Merge intelligently rather than blindly overwriting

### Step 1: Stop Running Processes

```bash
pkill -f 'agent-farm' 2>/dev/null
# (session cleanup no longer needed — shellper processes are self-managing)
```

### Step 2: Clean Up Obsolete Files

```bash
cd /path/to/your/project

# Remove old state files
rm -f codev/builders.md
rm -f .architect.pid .architect.log

# Remove old worktrees (they'll be recreated)
rm -rf .builders/
git worktree prune

# Remove old agent-farm state
rm -rf .agent-farm/
```

### Step 3: AI Merges Framework Components

The AI should compare each file/directory and merge appropriately:

**For `codev/bin/`**: Usually safe to replace entirely (scripts are standard).

**For `codev/protocols/`**: Check if user modified any protocol files. If so, merge the changes. If not, replace.

**For `codev/templates/`**: Check for UI customizations (colors, layout, etc.). Merge any customizations into new templates.

**For `codev/roles/`**: Check for customized role prompts. Preserve any project-specific instructions.

**For `CLAUDE.md` and `AGENTS.md`**: These often have project-specific sections. Merge new codev instructions while preserving project-specific content.

### Step 4: Verify npm package installation

After installing `@cluesmith/codev` globally, verify the commands are available:

```bash
# Check all three commands work
codev --help
af --help
consult --help
```

If any commands are not found, ensure npm global bin is in your PATH:
```bash
npm config get prefix
# Should show a directory like /usr/local or ~/.npm-global
# Ensure $(npm config get prefix)/bin is in your $PATH
```

### Step 5: Update .gitignore

Ensure your `.gitignore` includes:

```
# Agent Farm
.agent-farm/
.builders/

# Consultation logs
.consult/
```

### Step 6: Configure AI Commands (Optional)

Create or update `codev/config.json` to customize AI CLI commands:

```json
{
  "shell": {
    "architect": "claude --dangerously-skip-permissions",
    "builder": "claude --dangerously-skip-permissions",
    "shell": "bash"
  }
}
```

**Configuration options:**
- `shell.architect`: Command for architect terminal (default: `claude`)
- `shell.builder`: Command for builder terminals (default: `claude`)
- `shell.shell`: Command for utility shells (default: `bash`)
- `--dangerously-skip-permissions`: Skip permission prompts (use at your own risk)

You can also override these via CLI flags: `--architect-cmd`, `--builder-cmd`, `--shell-cmd`

### Step 7: Update Templates (projectlist.md, CLAUDE.md, AGENTS.md)

Several templates have been improved in v1.0.x. Update your project's versions while preserving your content:

**projectlist.md improvements:**
- YAML format with structured fields (id, title, summary, status, priority, dependencies, tags)
- Lifecycle stages: conceived → specified → planned → implementing → implemented → committed → integrated
- Terminal states: abandoned, on-hold
- Active projects sorted to the top
- Tags for categorization
- Dependencies tracking

```bash
# Compare your projectlist with the new template
diff codev/projectlist.md /path/to/codev/codev-skeleton/projectlist.md
```

**CLAUDE.md / AGENTS.md improvements:**
- Updated protocol documentation
- Architect-Builder pattern with new CLI commands
- Consult tool documentation for multi-agent consultation
- Git workflow restrictions (explicit file staging, no squash merges)
- Release process guidelines

The AI migration assistant should merge these template improvements while preserving your project-specific content (specs, plans, reviews, project entries).

### Step 8: Verify Installation

```bash
# Check CLI works
af --help

# Run health check
codev doctor

# Test starting the dashboard
af dash start
```

---

## Post-Migration Checklist

- [ ] npm package installed: `npm install -g @cluesmith/codev`
- [ ] Dependencies installed (node 18+, git, AI CLIs)
- [ ] `codev --help` shows available commands
- [ ] `af --help` shows available commands
- [ ] `consult --help` shows available commands
- [ ] `codev doctor` passes all checks (AI CLIs show "working")
- [ ] Dashboard starts with `af dash start`
- [ ] Your specs in `codev/specs/` are intact
- [ ] Your plans in `codev/plans/` are intact
- [ ] Your reviews in `codev/reviews/` are intact
- [ ] `codev/projectlist.md` updated to new YAML format
- [ ] `codev/config.json` created with shell commands configured
- [ ] `CLAUDE.md` / `AGENTS.md` updated with latest protocol docs
- [ ] Any local customizations were preserved during merge

---

## AI Migration Prompt

When asking an AI to perform the migration, use this prompt:

```
I need to migrate my project from an older version of codev to v1.0.x.

Source codev repo: /path/to/codev
My project: /path/to/my/project

Please:
1. Install the npm package: npm install -g @cluesmith/codev
2. Verify the three commands work: codev --help, af --help, consult --help
3. Check prerequisites (node, git, AI CLIs) with: codev doctor
4. Clean up obsolete files (builders.md, .architect.pid, .builders/, etc.)
5. Compare my codev/protocols/, codev/templates/, codev/roles/ with the
   new versions in codev-skeleton/ and merge any local customizations
6. Compare my CLAUDE.md/AGENTS.md with codev-skeleton/ versions and
   merge, preserving my project-specific content
7. Update codev/projectlist.md to the new YAML format:
   - Convert existing projects to new schema (id, title, summary, status, etc.)
   - Add lifecycle stages and tags
   - Sort active projects to the top
8. Create codev/config.json with shell command configuration
9. Run codev doctor to verify all dependencies work
10. Test af dash start/stop

Do NOT blindly overwrite - check for local modifications first.
Preserve all existing project entries when updating projectlist.md.
```

---

## Troubleshooting

### Port already in use

```bash
af ports cleanup
```

### Old state causing issues

```bash
rm -rf .agent-farm/
rm -rf ~/.agent-farm/ports.json
```

### Commands not found (codev, af, consult)

Ensure npm global bin is in your PATH:
```bash
npm config get prefix
# Add $(npm config get prefix)/bin to your $PATH if needed

# Example for bash/zsh:
echo 'export PATH="$(npm config get prefix)/bin:$PATH"' >> ~/.bashrc
# or for zsh:
echo 'export PATH="$(npm config get prefix)/bin:$PATH"' >> ~/.zshrc
```

Then restart your shell or run:
```bash
source ~/.bashrc  # or ~/.zshrc
```
