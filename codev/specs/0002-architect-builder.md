# Specification: Architect-Builder Pattern

**Spec ID**: 0002
**Title**: Architect-Builder Pattern for Parallel AI Development
**Status**: Draft
**Protocol**: TICK
**Author**: Claude (with human guidance)
**Date**: 2025-12-02

## Overview

Implement the Architect-Builder pattern within the Codev framework to enable parallel AI-assisted development. This pattern separates concerns between an "Architect" (human + primary AI agent holding overall context) and multiple "Builders" (autonomous AI agents executing discrete specs).

## Problem Statement

Current AI-assisted development is typically single-threaded or uses ad-hoc multi-agent coordination. When projects mature and have parallelizable components, developers need a structured way to:

1. **Delegate discrete work** to multiple AI agents running in parallel
2. **Coordinate via specifications** rather than real-time communication
3. **Track builder progress** without constant manual oversight
4. **Review and integrate** builder output systematically

## Goals

1. Enable running multiple builder agents in parallel on separate specs (no fixed limit)
2. Use git as the coordination backbone (fits existing Codev workflow)
3. Provide simple tooling for spawning and monitoring builders
4. Integrate with existing Codev protocols (SPIR, TICK)

## Non-Goals

1. Full automation of builder spawning (Phase 1 is manual/CLI-assisted)
2. Real-time communication between architect and builders
3. Complex orchestration infrastructure (no separate servers/databases)
4. Replacing the existing spec/plan/review workflow (enhances it)

## Architecture

### Conceptual Model

```
┌─────────────────────────────────────────────────────────────────┐
│                        ARCHITECT                                 │
│  (Human + Claude Code Desktop)                                   │
│                                                                  │
│  Responsibilities:                                               │
│  • Create specs and plans (codev/specs/, codev/plans/)          │
│  • Spawn and monitor builders via web dashboard                  │
│  • Answer blocking questions (poll terminals directly)           │
│  • Review PRs and integrate work                                 │
│  • Update projectlist.md                                         │
└─────────────────────────────────────────────────────────────────┘
              │
              │ Git (specs, plans) + Web Dashboard (terminals)
              ▼
┌──────────────┐  ┌──────────────┐       ┌──────────────┐
│  BUILDER     │  │  BUILDER     │  ...  │  BUILDER     │
│  Port 7681   │  │  Port 7682   │       │  Port 768N   │
│              │  │              │       │              │
│ Spec: 0003   │  │ Spec: 0004   │       │ Spec: XXXX   │
│ Branch:      │  │ Branch:      │       │ Branch:      │
│ builder/0003 │  │ builder/0004 │       │ builder/XXXX │
│              │  │              │       │              │
│ Worktree:    │  │ Worktree:    │       │ Worktree:    │
│ .builders/   │  │ .builders/   │       │ .builders/   │
│  0003/       │  │  0004/       │       │  XXXX/       │
└──────────────┘  └──────────────┘       └──────────────┘
       │                │                       │
       └────────────────┴───────────────────────┘
                              │
                    ┌─────────┴─────────┐
                    │  ttyd instances   │
                    │  (web terminals)  │
                    │  (no fixed limit) │
                    └───────────────────┘
```

### Key Design Decisions

#### 1. Git Worktrees for Isolation

Each builder operates in its own git worktree, providing:
- **Filesystem isolation**: No conflicts between builders modifying files
- **Shared git history**: Instant rebases and merges (same .git database)
- **Clean separation**: Each builder sees only its branch

```bash
# Architect spawns builder with worktree
git worktree add -b builder/0003-auth .builders/0003 main
```

#### 2. Web-Based Terminals via ttyd

Use [ttyd](https://github.com/tsl0922/ttyd) to serve terminals in the browser:

- **One ttyd process per builder** on dynamically assigned ports
- **No fixed limit** - spawn as many builders as your machine can handle
- **Simple HTML dashboard** shows all builders in one view
- **No tmux/screen complexity** - browser handles tabs/windows
- **Easy to monitor** - just refresh the page

**Port allocation**: Starting from 7681, assign next available port. The `architect` script tracks which ports are in use.

```bash
# Start a builder terminal (port assigned automatically)
ttyd -p 7681 -W bash -c "cd .builders/0003 && claude"
ttyd -p 7682 -W bash -c "cd .builders/0004 && claude"
# ... as many as needed
```

**Practical limits**:
- Each builder uses ~500MB-1GB RAM (Claude + terminal)
- Human attention typically caps at 6-8 concurrent builders
- No technical limit on ttyd instances

#### 3. Human-Readable Status via builders.md

Track builder status in a git-tracked markdown file (like projectlist.md):

```markdown
# Active Builders

## Builder 0003: User Authentication
- **Branch**: builder/0003-user-auth
- **Port**: 7681
- **Status**: implementing
- **Phase**: 2/4
- **Started**: 2025-12-02 11:30

## Builder 0004: API Routes
- **Branch**: builder/0004-api-routes
- **Port**: 7682
- **Status**: blocked
- **Phase**: 1/3
- **Started**: 2025-12-02 11:35
- **Blocker**: Needs clarification on rate limiting strategy
```

**Why git-tracked?**
- Human readable (no JSON parsing)
- History of builder activity
- Architect can update via normal editing
- Consistent with projectlist.md pattern

#### 4. Simple Blocking Question Handling

**No complex inbox protocol.** When a builder gets stuck:

1. Builder stops and waits (visible in terminal)
2. Architect polls dashboard, sees builder waiting
3. Architect types response directly in the terminal
4. Builder continues

The `builders.md` file can note blockers for visibility, but resolution happens in the terminal.

#### 5. File Review Tool

The architect needs to review builder work without switching directories or interrupting workflow. Simple CLI commands provide quick access to builder file state:

```bash
# List files changed by a builder (vs main)
architect files 0003
# Output: M src/auth/login.ts, A src/auth/types.ts, ...

# Show diff of builder's changes
architect diff 0003
# Output: unified diff of all changes

# View a specific file in builder's worktree
architect cat 0003 src/auth/login.ts
# Output: file contents with line numbers

# Quick review summary (files + stats)
architect review 0003
# Output: file list, lines added/removed, branch info
```

**Why CLI (not web)?**
- Faster for quick checks than navigating dashboard
- Pipe-able output for scripts
- Works in architect's existing terminal
- No context switch from Claude Code session

**Builders can also use these** to review files in main (though they typically just use git directly in their worktree).

#### 6. Annotation Viewer for Design Review

The architect needs to review builder work and leave persistent comments. Rather than a separate comment database, **comments live directly in the files** using standard comment syntax with a `REVIEW:` prefix.

**Comment Format by File Type:**

```typescript
// REVIEW: Should this handle the null case?
// REVIEW(@architect): Consider using a Map for O(1) lookup
```

```python
# REVIEW: This could be simplified with a list comprehension
# REVIEW(@builder): Good catch - fixed in next commit
```

```markdown
<!-- REVIEW: This requirement is ambiguous - needs clarification -->
<!-- REVIEW(@architect): Added detail in section 2.3 -->
```

**Why Inline Comments?**
- **Visible everywhere**: Any editor, GitHub, git log shows them
- **Git history**: Comments become part of commit history (valuable for decisions)
- **No sync issues**: No separate comment file to keep in sync
- **Natural cleanup**: Remove `REVIEW:` comments when merging PR
- **Threaded discussion**: Use `@username` to attribute responses

**Web-Based Annotation Viewer:**

A simple HTML viewer that:
- Renders files with syntax highlighting (Prism.js)
- Supports both **code** and **markdown** highlighting
- Highlights `REVIEW:` lines distinctly (yellow background, margin icons)
- Click any line → insert new `REVIEW:` comment
- Click existing `REVIEW:` comment → edit or resolve (removes from file)
- Saves changes directly to the builder's worktree
- All edits tracked by git

**CLI Commands:**
```bash
# Open annotation viewer for a specific file
architect annotate 0003 src/auth/login.ts

# Open annotation viewer for a markdown spec
architect annotate 0003 codev/specs/0003-feature.md

# List all files with unresolved REVIEW comments
architect annotations 0003
```

**Workflow:**
1. Builder implements feature
2. Architect opens annotation viewer: `architect annotate 0003 src/main.ts`
3. Architect clicks line 42, types "Consider error handling here"
4. File now contains `// REVIEW(@architect): Consider error handling here` at line 42
5. Builder sees comment (in terminal, editor, or viewer)
6. Builder addresses feedback, optionally adds `// REVIEW(@builder): Fixed`
7. Before PR merge, clean up resolved `REVIEW:` comments

#### 7. Builder Prompt Template

Standard instructions given to each builder when spawned:

```markdown
# Builder Instructions

You are implementing spec XXXX. Read:
- codev/specs/XXXX-name.md (what to build)
- codev/plans/XXXX-name.md (how to build it)

## Rules

1. **Follow SPIR protocol** - Implement → Defend → Evaluate for each phase
2. **Proceed autonomously** - Don't ask "should I continue?" Just continue.
3. **Stop only for true blockers** - Missing information, ambiguous requirements, architectural decisions
4. **Self-rebase if needed** - If main has moved, rebase your branch before PR
5. **Create PR when complete** - Use `gh pr create` with summary of changes

## Your Branch
builder/XXXX-name

## When Blocked
State clearly what you need and wait. The architect will respond in this terminal.
```

## Implementation

### Directory Structure

```
project-root/
├── .builders/                 # Builder worktrees (gitignored)
│   ├── 0003/                  # Git worktree for spec 0003
│   ├── 0004/
│   └── ...
├── codev/
│   ├── bin/
│   │   └── architect         # Main CLI tool
│   ├── templates/
│   │   ├── builder-prompt.md # Standard builder instructions
│   │   └── dashboard.html    # Simple web dashboard
│   ├── builders.md           # Active builder status (git-tracked)
│   ├── specs/
│   ├── plans/
│   ├── reviews/
│   └── projectlist.md
└── .gitignore                 # Includes .builders/
```

### 8. Direct CLI Access for Power Users

Power users often prefer terminal-first workflows without the browser overhead. The `af architect` command provides direct access to the architect role via tmux:

```bash
af architect              # Start/attach to architect tmux session
af architect "prompt"     # With initial prompt
af architect --layout     # Multi-pane layout with status and shell
```

**Basic Mode** (`af architect`):
- If `af-architect` tmux session exists → attach to it
- If no session exists → create new session with architect role
- Session persists after detach (Ctrl+B, D)

**Layout Mode** (`af architect --layout`):
Creates a two-pane tmux layout:
```
┌────────────────────────────────┬──────────────────────────────┐
│                                │                              │
│   Architect Session            │   Utility Shell              │
│   (60%)                        │   (40%)                      │
│                                │                              │
└────────────────────────────────┴──────────────────────────────┘
```
- Left pane: Architect Claude session (main workspace)
- Right pane: Utility shell for running `af spawn`, `af status`, etc.
- Navigate panes: Ctrl+B ←/→ | Zoom: Ctrl+B z | Detach: Ctrl+B d

**Why tmux?** Consistency with other agent farm commands which all use tmux internally for session persistence.

### CLI Interface

```bash
# Direct CLI access to architect (power users)
af architect              # Start/attach to architect tmux session
af architect --layout     # Multi-pane layout

# Spawn a new builder for a project (spec)
architect spawn --project 0003

# Spawn a builder for a GitHub issue
architect spawn --issue 42

# Check status of all builders (reads builders.md)
architect status

# Open the web dashboard
architect dashboard
# Opens browser to localhost with all builder terminals

# Review builder work (without switching context)
architect files 0003      # List changed files
architect diff 0003       # Show unified diff vs main
architect cat 0003 FILE   # View specific file
architect review 0003     # Summary: files, stats, branch info

# Annotation viewer for design review
architect annotate 0003 FILE   # Open web viewer to annotate file
architect annotations 0003     # List files with REVIEW comments

# Clean up a completed builder (removes worktree, stops ttyd)
architect cleanup 0003
```

**Who calls these commands?** The human user, from their main terminal. The architect AI may suggest commands but doesn't execute them directly.

### Web Dashboard

Simple HTML file served locally:

```html
<!DOCTYPE html>
<html>
<head>
  <title>Builder Dashboard</title>
  <style>
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .builder { border: 1px solid #ccc; padding: 10px; }
    .builder h3 { margin: 0 0 5px 0; }
    .status { font-size: 12px; color: #666; }
    iframe { width: 100%; height: 400px; border: none; }
  </style>
</head>
<body>
  <h1>Builder Dashboard</h1>
  <div class="grid" id="builders">
    <!-- Populated dynamically from builders.md -->
  </div>
  <script>
    // Simple script to load builders.md and render iframes
  </script>
</body>
</html>
```

### Workflow Integration with SPIR

The Architect-Builder pattern sits on top of SPIR:

| SPIR Phase | Who Does It |
|--------------|-------------|
| **Specify** | Architect (human + AI) |
| **Plan** | Architect (human + AI) |
| **Implement** | Builder (autonomous) |
| **Defend** | Builder (autonomous) |
| **Evaluate** | Builder (autonomous) |
| **Review** | Architect reviews builder's PR |

The builder executes the IDE loop (Implement → Defend → Evaluate) autonomously, producing a PR. The architect handles specification, planning, and final review/integration.

See: `codev-skeleton/protocols/spir/protocol.md`

### Integration with projectlist.md

When spawning a builder, the project status updates:

```yaml
- id: "0003"
  title: "User Authentication"
  status: implementing  # Updated from "planned"
```

When builder completes (PR merged):

```yaml
- id: "0003"
  title: "User Authentication"
  status: committed
```

## Success Criteria

1. **Parallel Execution**: Can run multiple builders simultaneously without conflicts
2. **Status Visibility**: Dashboard shows all builder terminals at a glance
3. **Simple Blocking**: Can respond to stuck builders by typing in terminal
4. **Quick File Review**: Can inspect builder changes without leaving main terminal
5. **Design Annotations**: Can leave inline `REVIEW:` comments on code and markdown files
6. **Clean Integration**: Builder PRs merge cleanly after architect review
7. **Minimal Tooling**: Works with just ttyd + a shell script + HTML files

## Phase 1 Deliverables

- [ ] `.builders/` directory structure with .gitignore entry
- [ ] `architect` shell script with spawn/status/dashboard/cleanup commands
- [ ] File review commands: `files`, `diff`, `cat`, `review`
- [ ] Annotation viewer: `annotate`, `annotations` commands
- [ ] `annotate.html` with Prism.js syntax highlighting (code + markdown)
- [ ] Inline `REVIEW:` comment insertion and resolution
- [ ] Git worktree-based isolation
- [ ] `builders.md` template and status tracking
- [ ] `builder-prompt.md` template
- [ ] `dashboard.html` for viewing all terminals
- [ ] ttyd integration for web-based terminals
- [ ] Documentation in codev-skeleton

## Future Phases (Out of Scope)

### Phase 2: Enhanced Integration
- `/builder` slash command for Claude Code
- Subagent for PR review assistance
- Automatic projectlist.md updates
- Richer dashboard with status parsing

### Phase 3: Full Automation
- Custom Next.js + xterm.js dashboard
- Auto-spawn builders when spec is committed
- Python orchestrator using Claude Agent SDK

## Resolved Questions

| Question | Resolution |
|----------|------------|
| Web vs tmux for terminals? | **Web (ttyd)** - richer interaction, easier monitoring |
| JSON vs markdown for status? | **Markdown (builders.md)** - human readable, git-tracked |
| Complex inbox protocol? | **No** - architect polls terminals directly |
| claude.ai/code support? | **No** - focus on local ttyd terminals |
| Conflict resolution? | **Builders self-rebase** before creating PR |
| Standard builder prompt? | **Yes** - template enforces SPIR + autonomous execution |

## References

- [Architect-Builder Pattern Article](/Users/mwk/Development/writing/articles/medium/architecture-builder/article.md)
- [ttyd - Terminal in browser](https://github.com/tsl0922/ttyd)
- [SPIR Protocol](codev-skeleton/protocols/spir/protocol.md)

## Appendix: Why These Choices?

### Why Git Worktrees (Not Clones)?

Git worktrees provide isolation without the overhead of full clones:
- Same .git database = fast rebases/merges
- Separate working directories = no file conflicts
- Built into git (no external tools needed)
- Easy cleanup with `git worktree remove`

### Why ttyd (Not tmux)?

- **Browser-based** = richer interaction (copy/paste, scrollback)
- **Visual dashboard** = see all builders at once
- **No terminal multiplexer learning curve**
- **Easy to add status/controls** around terminals later

### Why builders.md (Not JSON)?

- **Human readable** without parsing
- **Editable** with any text editor
- **Git history** shows builder activity over time
- **Consistent** with projectlist.md pattern

---

## Amendments

### TICK-001: Direct CLI Access (2025-12-27)

**Summary**: Add `af architect` command for terminal-first access to architect role, with optional multi-pane layout mode.

**Problem Addressed**:
Power users prefer direct terminal access without browser overhead. Currently, accessing the architect requires either starting the full dashboard (`af start`) or knowing tmux internals (`tmux attach -t af-architect-4301`).

**Spec Changes**:
- Added "8. Direct CLI Access for Power Users" section
- Basic mode: `af architect` for simple session
- Layout mode: `af architect --layout` for multi-pane tmux layout
- Updated CLI Interface to include `af architect` command

**Plan Changes**:
- Added Phase 8: Direct CLI Access implementation

**Review**: See `reviews/0002-architect-builder-tick-001.md`

---

### TICK-002: Protocol-Agnostic Spawn System (2026-01-27)

**Summary**: Refactor `af spawn` to decouple input types from protocols, making the system extensible without hardcoding protocol-specific logic.

**Problem Addressed**:
Currently, specific protocols are deeply baked into `af spawn`:
- `spawnBugfix()` hardcodes BUGFIX protocol path and instructions
- `spawnSpec()` defaults to SPIR with protocol-specific prompts
- Adding a new protocol requires modifying spawn.ts

This violates the open-closed principle and makes the system harder to extend.

**Proposed Design**:

Separate three orthogonal concerns:

1. **Input Type** (what the builder starts from):
   - `--project/-p`: Start from a spec file
   - `--issue/-i`: Start from a GitHub issue
   - `--task`: Start from ad-hoc text
   - `--protocol`: Start from protocol name alone
   - `--worktree`: Interactive (no input)

2. **Mode** (who orchestrates):
   - `strict`: Porch drives the protocol (default for `--project`)
   - `soft`: AI reads and follows protocol.md

3. **Protocol** (what workflow to follow):
   - Explicit via `--protocol <name>`
   - From spec metadata if input is spec
   - Default based on input type (spir for specs, bugfix for issues)

**Key Changes**:

1. **Add `--protocol` as universal flag** that works with any input type:
   ```bash
   af spawn -p 0001 --protocol tick     # Spec with TICK protocol
   af spawn -i 42 --protocol spir     # Issue with SPIR protocol (unusual)
   ```

2. **Protocol-defined prompts**: Each protocol provides `protocols/{name}/builder-prompt.md` template with placeholders:
   ```markdown
   # {{PROTOCOL_NAME}} Builder

   You are implementing {{INPUT_DESCRIPTION}}.

   ## Protocol
   Follow: codev/protocols/{{protocol}}/protocol.md

   {{#if spec}}## Spec: {{spec_path}}{{/if}}
   {{#if issue}}## Issue #{{issue.number}}: {{issue.title}}{{/if}}
   ```

3. **Protocol-defined input requirements** in protocol.json:
   ```json
   {
     "name": "bugfix",
     "input": {
       "type": "github-issue",
       "required": false,
       "default_for": ["--issue"]
     },
     "hooks": {
       "pre-spawn": {
         "collision-check": true,
         "comment-on-issue": "On it! Working on a fix now."
       }
     },
     "defaults": {
       "mode": "soft"
     }
   }
   ```

4. **Refactored spawn flow**:
   ```typescript
   async function spawn(options) {
     // 1. Resolve input (fetch issue, find spec, etc.)
     const input = await resolveInput(options);

     // 2. Determine protocol (explicit > spec metadata > input default)
     const protocol = resolveProtocol(options, input);

     // 3. Load protocol definition
     const protocolDef = loadProtocolDefinition(protocol);

     // 4. Run protocol hooks (collision checks, comments, etc.)
     await runPreSpawnHooks(protocolDef, input, options);

     // 5. Determine mode (explicit > protocol default > global default)
     const mode = resolveMode(options, protocolDef);

     // 6. Build prompt from protocol template
     const prompt = buildPrompt(protocolDef, input, mode);

     // 7. Start builder
     await startBuilder(input, prompt, mode, config);
   }
   ```

**Defaults**:

| Input Type | Default Protocol | Default Mode |
|------------|------------------|--------------|
| `--project` | spir (or from spec) | strict |
| `--issue` | bugfix | soft |
| `--protocol X` | X | soft |
| `--task` | none | soft |

**Example Commands After Refactor**:

```bash
# Standard usage (unchanged behavior)
af spawn -p 0001                    # strict, spir
af spawn -i 42                      # soft, bugfix

# New flexibility
af spawn -p 0001 --protocol tick    # strict, tick
af spawn -i 42 --protocol spir    # soft, spir (escalate bug to full feature)
af spawn --protocol maintain        # soft, maintain
af spawn --strict --protocol experiment  # strict, experiment via porch
```

**Benefits**:
- New protocols work automatically (just add protocol.json + builder-prompt.md)
- Clear separation of concerns (input × mode × protocol)
- Existing commands work unchanged
- Protocol-specific behaviors defined in data, not code

**Spec Changes**:
- Updated Architecture section with protocol-agnostic design
- Added protocol.json schema for input requirements and hooks
- Updated CLI Interface with `--protocol` flag

**Plan Changes**:
- Added Phase: Protocol-Agnostic Spawn Refactor

**Review**: See `reviews/0002-architect-builder-tick-002.md`
