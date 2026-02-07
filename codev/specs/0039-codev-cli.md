# Spec 0039: Codev CLI (First-Class Command)

**Status:** integrated
**Protocol:** SPIR
**Amended:** 2025-12-11 (TICK-005)
**Priority:** High
**Dependencies:** 0005 (TypeScript CLI), 0022 (Consult Tool)
**Blocks:** None
**Consultation:** 4-way review (Gemini, Codex, Claude, Architect) - all decisions resolved
<!-- REVIEW(@architect): That's interesting -->

---

## Problem Statement

Codev currently lacks a unified entry point. Users interact with multiple disconnected tools:

1. **agent-farm** - TypeScript CLI for builder orchestration (npm package)
2. **consult** - Python CLI for AI consultation (loose script)
3. **codev-doctor** - Bash script for dependency checking
4. **codev-skeleton/** - Manual copy for new projects

This creates friction:
- Multiple installation steps
- No unified `codev` command
- agent-farm is tightly coupled to current directory (reads `codev/roles/builder.md` locally)
- No standard way to initialize new codev projects or adopt existing repos

---

## Requirements

### Core CLI Commands

1. **`codev init`** - Create a new codev project
   - Creates new directory with `codev/` structure from embedded skeleton
   - Initializes CLAUDE.md/AGENTS.md
   - Sets up git hooks (optional)
   - Interactive or `--yes` for defaults
   - **Use case**: Starting a fresh project

2. **`codev adopt`** - Add codev to an existing project
   - Adds `codev/` directory to current repo without overwriting existing files
   - Detects and warns about conflicts (e.g., existing CLAUDE.md)
   - Offers to merge or skip conflicting files
   - **Use case**: Adding codev to an existing codebase

3. **`codev doctor`** - Check system dependencies
   - Port existing codev-doctor functionality to TypeScript
   - Check: node, npm, git, gh, tmux, ttyd
   - Suggest installation commands for missing deps
   - Exit 0 if all good, non-zero if missing critical deps

4. **`codev update`** - Update codev templates
   - Updates protocols, templates, agents from embedded skeleton
   - Preserves user's specs/plans/reviews (never touched)
   - **Merge strategy for protocol files**:
     1. Compute hash of user's current file
     2. If unchanged from last update, overwrite safely
     3. If user modified, write new version as `filename.codev-new`
     4. Show diff and prompt user to merge manually
   - `--dry-run` to preview changes
   - `--force` to overwrite all (dangerous)

5. **`codev tower`** - Cross-project dashboard
   - Shows all running agent-farm instances across projects
   - Launch capability for multiple projects
   - Lives in codev (not af) because it's cross-project scope

6. **`codev consult`** - AI consultation
   - Native TypeScript implementation (ported from Python)
   - `codev consult --model gemini spec 39`
   - `codev consult --model codex pr 33`
   - Shells out to gemini-cli, codex, claude CLIs
   - Unified with rest of codev codebase

### Package Structure

**Single merged package** (`@cluesmith/codev`):
- One npm package containing all functionality
- agent-farm source merged into codev
- consult ported to TypeScript
- Simpler for users: `npm install -g @cluesmith/codev`

### Installation

```bash
# Global install
npm install -g @cluesmith/codev

# Or via npx for one-off use
npx @cluesmith/codev init my-project
npx @cluesmith/codev doctor
```

### Command Routing

After installation, users get two commands:

```bash
# codev - framework management
codev init my-project    # New project
codev adopt              # Add to existing project
codev doctor             # Check deps
codev update             # Update templates
codev tower              # Cross-project dashboard
codev consult            # AI consultation

# af - agent-farm operations (backwards compatible)
af start                 # Start single-project dashboard
af spawn                 # Spawn builder
af status                # Project status
af cleanup               # Clean up builders
# ... all existing af commands
```

**Design choice**: `af` is NOT aliased as `codev af`. They are separate entry points for different purposes:
- `codev` = framework-level operations
- `af` = project-level builder operations

---

## Technical Approach

### Architecture: Merged Single Package

```
packages/codev/                    # @cluesmith/codev
├── src/
│   ├── cli.ts                    # Main codev entry point
│   ├── af-cli.ts                 # af entry point (thin shim)
│   ├── commands/
│   │   ├── init.ts
│   │   ├── adopt.ts
│   │   ├── doctor.ts
│   │   ├── update.ts
│   │   ├── tower.ts
│   │   └── consult/
│   │       ├── index.ts
│   │       ├── gemini.ts
│   │       ├── codex.ts
│   │       └── claude.ts
│   ├── agent-farm/               # Merged from @cluesmith/agent-farm
│   │   ├── commands/
│   │   │   ├── start.ts
│   │   │   ├── spawn.ts
│   │   │   ├── status.ts
│   │   │   └── ...
│   │   └── lib/
│   │       ├── state.ts
│   │       ├── worktree.ts
│   │       └── ...
│   └── lib/
│       ├── skeleton.ts           # Template copying logic
│       └── config.ts
├── templates/                    # Embedded codev-skeleton
│   ├── protocols/
│   ├── roles/
│   ├── CLAUDE.md.template
│   └── ...
├── bin/
│   ├── codev.js                  # Main entry
│   └── af.js                     # Shim: runs codev agent-farm subcommand
├── package.json
└── tsconfig.json
```

### Binary Entry Points

**package.json:**
```json
{
  "name": "@cluesmith/codev",
  "bin": {
    "codev": "./bin/codev.js",
    "af": "./bin/af.js",
    "consult": "./bin/consult.js"
  }
}
```

**bin/consult.js** (thin shim):
```javascript
#!/usr/bin/env node
// consult is shorthand for codev consult
const { run } = require('../dist/cli.js');
run(['consult', ...process.argv.slice(2)]);
```

**bin/af.js** (thin shim):
```javascript
#!/usr/bin/env node
// af is shorthand for codev agent-farm
const { run } = require('../dist/cli.js');
run(['agent-farm', ...process.argv.slice(2)]);
```

### Consult Implementation (TypeScript)

Port from Python - ~200 lines of glue code:

```typescript
// src/commands/consult/index.ts
const MODEL_CONFIG = {
  gemini: { cli: 'gemini', args: ['--yolo'], envVar: 'GEMINI_SYSTEM_MD' },
  codex: { cli: 'codex', args: ['exec', '--full-auto'], envVar: 'CODEX_SYSTEM_MESSAGE' },
  claude: { cli: 'claude', args: ['--print', '--dangerously-skip-permissions'], envVar: null }
};

export async function consult(model: string, subcommand: string, target: string) {
  const config = MODEL_CONFIG[model];
  const query = await buildQuery(subcommand, target);
  const role = await loadRole();

  const env = config.envVar ? { [config.envVar]: role } : {};
  const args = config.envVar ? [...config.args, query] : [...config.args, role + '\n\n' + query];

  spawn(config.cli, args, { env: { ...process.env, ...env }, stdio: 'inherit' });
}
```

### Skeleton Embedding

The codev-skeleton is embedded in the npm package at build time:
- `templates/` directory contains protocol files, roles, templates
- `codev init` and `codev adopt` copy from this embedded skeleton
- Ensures offline capability and version consistency
- `codev update` compares embedded vs local and offers merge

**Note**: `af` commands still require a local `codev/` directory with roles. The embedded skeleton is only used for init/adopt/update, not runtime.

---

## Migration Path

### For Existing agent-farm Users

1. `npm uninstall -g @cluesmith/agent-farm`
2. `npm install -g @cluesmith/codev`
3. `af` commands continue to work unchanged
4. New `codev` commands available
5. `codev update` to get latest protocol templates

### For New Users

1. `npm install -g @cluesmith/codev`
2. `codev doctor` to verify system dependencies
3. For new project: `codev init my-project`
4. For existing project: `cd my-project && codev adopt`
5. `af start` to begin development

---

## Success Criteria

- [ ] `npm install -g @cluesmith/codev` installs everything needed
- [ ] `codev init` creates working codev project from skeleton
- [ ] `codev adopt` adds codev to existing project without data loss
- [ ] `codev doctor` checks all dependencies (no Python required)
- [ ] `codev update` updates templates with safe merge strategy
- [ ] `codev tower` shows cross-project dashboard
- [ ] `codev consult` works for AI consultation (TypeScript native)
- [ ] Existing `af` commands continue to work unchanged
- [ ] Single version number for entire toolchain

---

## Out of Scope

- GUI installer
- Windows support (Unix-first)
- IDE plugins
- Cloud/hosted version
- Stateful consult sessions (future spec)

---

## Design Decisions

1. **MERGE agent-farm into codev** (4-way unanimous)
   - Single codebase, single package.json
   - No version sync issues with shared dependencies (better-sqlite3, etc.)
   - Native module stability (single compilation)
   - Simplifies publishing and installation

2. **PORT consult to TypeScript** (3:1 majority)
   - Eliminates polyglot toolchain (no Python/uv dependency)
   - Unified test runner and error handling
   - ~4-6 hours to port 200 lines of glue code
   - Single `npm install` for users

3. **SEPARATE binary entry points** (3-way consensus)
   - `bin/codev.js` - main CLI
   - `bin/af.js` - thin shim calling codev agent-farm
   - Clearer mental model than basename detection
   - Easier testing and future flexibility

4. **Skeleton embedded in package**
   - Ship in `templates/` directory
   - Ensures offline capability
   - Version matches CLI version
   - `af` still reads local `codev/roles/` at runtime

5. **Package naming**: `@cluesmith/codev` (scoped npm package)

---

## Risks

1. **Breaking existing agent-farm users**: Mitigated by backwards-compatible `af` command
2. **Package name conflicts**: Check npm for availability before publishing
3. **Large package size**: Monitor bundle size, consider tree-shaking

---

## Testing Strategy

1. **Unit tests**: Command routing, skeleton copying, config parsing
2. **Integration tests**: `codev init` creates valid project, `af` shim works
3. **E2E tests**: Full workflow from install to `af spawn`
4. **Mock strategy**: Mock external CLIs (gemini, codex, claude) in consult tests

---

## TICK Amendment: 2025-12-09

### Problem

The original spec called for porting consult to TypeScript, but the Python implementation (`codev/bin/consult`) was retained in parallel. This causes:

1. **Drift**: Improvements to one version don't reach the other (e.g., Spec 0043's Codex optimizations only updated Python)
2. **Confusion**: Two implementations with different behaviors
3. **Maintenance burden**: Two codebases to maintain

### Amendment Scope

1. **Port Codex improvements to TypeScript**: Apply the changes from Spec 0043:
   - Replace `CODEX_SYSTEM_MESSAGE` env var with `experimental_instructions_file` config flag
   - Add `model_reasoning_effort=low` for faster responses
   - Proper temp file cleanup in finally blocks

2. **Delete Python consult**: Remove `codev/bin/consult` entirely and replace with a shim:
   ```bash
   #!/bin/bash
   exec npx @cluesmith/codev consult "$@"
   ```

   Or better: just delete it and update documentation to use `codev consult` or the `consult` binary from the npm package.

### Success Criteria (TICK-001: Consult Consolidation)

- [x] TypeScript consult has Codex `experimental_instructions_file` approach
- [x] TypeScript consult has `model_reasoning_effort=low` tuning
- [x] Python `codev/bin/consult` deleted (shim remains for backwards compat)
- [x] All existing `consult` invocations work via TypeScript version
- [x] Tests updated/passing

---

## TICK Amendment: 2025-12-09 (TICK-002)

### Problem

Currently `codev init` copies the entire `codev-skeleton/` into each project, including:
- `protocols/` (spir, tick, experiment, maintain)
- `roles/` (architect, builder, consultant)
- `templates/`
- `DEPENDENCIES.md`

This creates problems:
1. **Clutter**: Users see files they never touch (protocols, roles)
2. **Duplication**: Three copies of skeleton (codev-skeleton/, codev/, packages/codev/templates/)
3. **Sync issues**: Updates require manual copying across all locations
4. **Confusion**: Users don't know what they can/should modify

### Amendment Scope

**Embedded skeleton with local overrides**:

1. **Build-time embedding**: `codev-skeleton/` is embedded in the npm package at build time
2. **Minimal init**: `codev init` only creates user-facing directories:
   ```
   codev/
   ├── specs/
   ├── plans/
   ├── reviews/
   └── config.json (optional)
   ```
3. **Runtime resolution**: `af` and `consult` look for files in order:
   - Local `codev/` directory (user overrides)
   - Embedded skeleton in npm package (defaults)
4. **Optional customization**: Users can create local overrides only when needed:
   ```bash
   # To customize spir protocol:
   codev eject protocols/spir
   # Creates codev/protocols/spir/protocol.md from embedded version
   ```

### Benefits

- Clean project directories (only specs/plans/reviews visible)
- Single source of truth (codev-skeleton/)
- Easy updates (npm update, no file copying)
- Customization when needed (eject pattern)

### Success Criteria (TICK-002)

- [ ] `packages/codev/templates/` removed (use codev-skeleton/ directly at build)
- [ ] `codev init` creates minimal directory structure
- [ ] `af` resolves roles from embedded skeleton, local overrides take precedence
- [ ] `consult` resolves consultant.md from embedded skeleton, local overrides take precedence
- [ ] `codev eject <path>` command to copy embedded file locally for customization
- [ ] Existing projects continue to work (local files still take precedence)

---

## TICK Amendment: 2025-12-09 (TICK-003)

### Problem

TICK-002's embedded skeleton approach creates accessibility issues for AI consultants:

1. **AI tools ignore node_modules**: Most AI agents (Gemini, Codex, Claude) and search tools are configured to skip `node_modules/` by default
2. **Windows symlink issues**: Symlinks require admin privileges on Windows
3. **node_modules fragility**: Deleting/reinstalling `node_modules/` would break symlinks or require re-initialization
4. **Project portability**: Historical project checkouts wouldn't have matching protocol versions

### Consultation Summary (Gemini + Codex)

Both consultants unanimously recommended **reverting to copying files**:

> "When you hire a consultant, they bring their playbooks, but they leave them with you so you can operate when they are gone." - Gemini

Key recommendations:
- Copy files during `codev init` (scaffolding pattern)
- Add generated header noting files are managed
- Implement `codev update` to refresh from package
- Optional `framework.lock` to track installed version

### Amendment Scope

**Revert to copy-on-init with managed headers**:

1. **`codev init` copies framework files**:
   ```
   codev/
   ├── protocols/           # Copied from skeleton
   ├── roles/               # Copied from skeleton
   ├── templates/           # Copied from skeleton
   ├── specs/
   ├── plans/
   ├── reviews/
   └── projectlist.md
   ```

2. **Add managed file headers**:
   ```markdown
   <!-- MANAGED BY CODEV - Run 'codev update' to refresh -->
   <!-- Version: 1.2.0 | Do not edit unless customizing -->
   ```

3. **`codev update` command**:
   - Compare local files against embedded skeleton
   - If unchanged (matching hash), overwrite silently
   - If user modified, create `.codev-new` file and prompt for merge
   - Track version in `codev/.framework-version`

4. **Remove runtime resolution**: `af` and `consult` read directly from local `codev/` directory (no fallback to node_modules)

5. **Update E2E tests**: Tests should expect `codev/protocols/` to exist after init

### Benefits

- AI consultants can find and read protocol files at expected paths
- Works on all platforms without symlink issues
- Project is self-contained and portable
- User customizations are possible and preserved
- Clear update path via `codev update`

### Success Criteria (TICK-003)

- [ ] `codev init` copies protocols/, roles/, templates/ to project
- [ ] Managed file headers added to copied files
- [ ] `codev/.framework-version` tracks skeleton version
- [ ] `codev update` refreshes framework files with merge strategy
- [ ] E2E tests updated for new directory structure
- [ ] AI consultants can find `codev/protocols/spir/protocol.md`

---

## TICK Amendment: 2025-12-11 (TICK-004)

### Problem

TICK-003 was never fully implemented. The current code still uses TICK-002's embedded skeleton approach:
- `codev init` creates minimal structure (specs/, plans/, reviews/ only)
- Framework files (protocols/, roles/) resolved from `packages/codev/skeleton/` at runtime
- `codev eject` exists to copy files locally when customization needed

This creates duplication and confusion:
1. `codev-skeleton/` - canonical source in repo
2. `packages/codev/skeleton/` - copy embedded in npm package (build artifact)
3. Runtime resolution adds complexity
4. `eject` command needed but awkward

### Amendment Scope

**Fetch skeleton from GitHub during init** (like `degit` or `create-react-app`):

1. **`codev init` fetches from GitHub**:
   ```typescript
   const version = getPackageVersion(); // e.g., "1.1.1"
   const url = `https://api.github.com/repos/cluesmith/codev-public/contents/codev-skeleton?ref=v${version}`;
   // Or use tarball: https://github.com/cluesmith/codev-public/archive/refs/tags/v${version}.tar.gz
   await downloadAndExtract(url, targetDir + '/codev/');
   ```

2. **Remove embedded skeleton**:
   - Delete `packages/codev/skeleton/` directory
   - Remove `copy-skeleton` build step from package.json
   - Remove runtime skeleton resolution (`src/lib/skeleton.ts`)

3. **Remove `codev eject`**:
   - No longer needed since files are local after init
   - Delete `src/commands/eject.ts`
   - Remove from CLI registration

4. **Simplify `codev update`**:
   - Re-fetch from GitHub at current CLI version tag
   - Same merge strategy as before (hash comparison)

5. **Keep `codev-skeleton/` as single source of truth**:
   - Only location for skeleton files
   - Tagged with releases

### Benefits

- Single source of truth (`codev-skeleton/` only)
- No build-time copying
- Smaller npm package
- Files are local and AI-accessible after init
- Version-aligned fetching (tag matches CLI version)
- Simpler codebase (no runtime resolution, no eject)

### Offline Fallback

For offline scenarios, `codev init --offline` could:
- Fail with helpful message: "Network required for init. Use codev adopt for existing projects."
- Or bundle minimal skeleton (just templates) as fallback

### Success Criteria (TICK-004)

- [ ] `codev init` fetches skeleton from GitHub at matching version tag
- [ ] `packages/codev/skeleton/` removed from repo
- [ ] `copy-skeleton` build step removed
- [ ] `src/lib/skeleton.ts` runtime resolution removed
- [ ] `codev eject` command removed
- [ ] `codev update` fetches from GitHub
- [ ] Tests updated for new behavior
- [ ] Offline behavior documented (or fallback implemented)

---

## TICK Amendment: 2025-12-11 (TICK-005)

### Problem

Two agents exist for keeping codev up-to-date:
- `codev-updater` - Updates from main codev repo (obsolete with TICK-004's GitHub fetch)
- `spider-protocol-updater` - Imports protocol improvements from other repos

These are awkward to use and don't leverage AI for intelligent merging.

### Amendment Scope

**Add `codev import` command** - AI-assisted protocol import from other codev projects:

```bash
# Import from local directory
codev import /path/to/other-project

# Import from GitHub
codev import github:cluesmith/ansari-project
codev import https://github.com/cluesmith/ansari-project
```

**How it works:**

1. **Fetch source**: Download/read the source codev/ directory
   - Local: Read directly from filesystem
   - GitHub: Use GitHub API or clone sparse checkout

2. **Spawn interactive Claude session**: The command launches Claude with context:
   ```
   You are helping import protocol improvements from another codev project.

   SOURCE: [contents of source codev/protocols/, codev/resources/, etc.]
   TARGET: [contents of local codev/protocols/, codev/resources/, etc.]

   Analyze the differences and help the user decide what to import.
   Focus on: protocol improvements, lessons learned, architectural patterns.
   ```

3. **Interactive merge**: Claude discusses with user:
   - "Their SPIR protocol has an additional consultation checkpoint - worth adopting?"
   - "They've added a lesson about test isolation - want to add to lessons-learned.md?"
   - "Their arch.md has a better structure for documenting utilities - merge this pattern?"

4. **Apply changes**: Claude makes approved changes to local files

**Key design choices:**
- NOT a dumb file copy - Claude analyzes and recommends
- Interactive, not autonomous - user approves each change
- Works with local dirs AND GitHub repos
- Replaces both codev-updater and spider-protocol-updater agents

**Delete obsolete agents:**
- Remove `codev/agents/codev-updater.md`
- Remove `codev/agents/spider-protocol-updater.md`
- Remove from `codev-skeleton/agents/` and `.claude/agents/`

### Success Criteria (TICK-005)

- [ ] `codev import <path>` works with local directories
- [ ] `codev import <github-url>` works with GitHub repos
- [ ] Command spawns interactive Claude session with source/target context
- [ ] Claude analyzes differences and recommends imports
- [ ] User can approve/reject each suggested change
- [ ] `codev-updater` agent deleted
- [ ] `spider-protocol-updater` agent deleted
- [ ] Documentation updated
