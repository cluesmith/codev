# Specification: Memory Command

## Metadata
- **ID**: 0062
- **Status**: draft
- **Created**: 2025-12-27

## Clarifying Questions Asked

1. **Q: Should AI synthesis be required or optional?**
   A: User wants Claude to synthesize collected data into readable documentation.

2. **Q: What should the default output behavior be?**
   A: Direct apply - write directly to codev/ files.

3. **Q: How should this relate to `codev adopt`?**
   A: Separate command - `codev memory` is independent, can run after adopt or standalone.

4. **Q: What should the command be called?**
   A: `codev memory` with subcommands `init` and `sync` - ties directly to the memory architecture concept.

## Problem Statement

There are three related problems with codev's memory architecture:

### Problem 1: Brownfield Adoption
When adopting codev in an existing project, `codev adopt` creates empty L0-L2 memory layers. The project already has rich context that goes unused:
- Source code with established patterns and conventions
- Git history documenting decisions and evolution
- Package manifests (package.json, Cargo.toml, etc.)
- Existing documentation (READMEs, existing CLAUDE.md)
- Potentially open GitHub issues and PRs

This leaves users with blank templates instead of meaningful starting points.

### Problem 2: Legacy Codev Upgrade
Older versions of codev didn't have `projectlist.md` or `arch.md`. Projects installed with earlier versions have:
- Existing specs in `codev/specs/`
- Existing plans in `codev/plans/`
- Existing reviews in `codev/reviews/`
- But NO `projectlist.md` tracking these documents
- And NO `arch.md` documenting the architecture

Running `codev update` brings in the new templates but doesn't populate them with data from existing specs/plans.

### Problem 3: Memory Drift (`codev update` Gap)
`codev update` updates protocol templates but doesn't update the actual memory content:
- New `projectlist.md` template arrives but remains empty
- New `arch.md` template arrives but remains generic
- Existing specs/plans are not incorporated into projectlist
- No synchronization between L2 documents and L1 registry

As noted in the Codev book (ch04-memory.qmd): "Bootstrapping memory for brownfield projects is unsolved."

## Current State

### `codev adopt` behavior:
1. Creates empty directories: `specs/`, `plans/`, `reviews/`
2. Creates empty `projectlist.md` with a placeholder example project
3. Creates blank `lessons-learned.md` and `arch.md` templates
4. Creates generic `CLAUDE.md`/`AGENTS.md` (or `.ruler/codev.md` for Ruler projects)
5. Updates `.gitignore`

### `codev update` behavior:
1. Updates protocol templates (spider, tick, experiment, maintain)
2. Updates role definitions (architect, builder, consultant)
3. Creates new template files if missing (projectlist.md, arch.md)
4. **Does NOT** populate these files with project-specific content
5. **Does NOT** scan existing specs/plans to build projectlist

### Legacy codev projects:
- May have `codev/specs/0001-*.md` through `codev/specs/00XX-*.md`
- May have corresponding plans and reviews
- But no `projectlist.md` or `arch.md` at all
- Running `codev update` creates empty templates that don't reflect reality

## Desired State

A new `codev memory` command with subcommands that handle three use cases:

### Use Case 1: Brownfield Adoption (no prior codev)
- Analyze codebase structure, dependencies, git history
- Generate populated `arch.md` documenting actual architecture
- Customize `CLAUDE.md` with detected conventions
- Seed `projectlist.md` from GitHub issues/PRs

### Use Case 2: Legacy Codev Upgrade (codev exists, missing projectlist/arch)
- Scan existing `codev/specs/*.md` files
- Parse spec metadata (title, status from frontmatter or content)
- Find corresponding plans and reviews
- Generate `projectlist.md` entries for each discovered spec
- Generate `arch.md` from codebase + existing documentation

### Use Case 3: Memory Synchronization (ensure projectlist reflects reality)
- Compare existing `projectlist.md` entries against actual spec files
- Add missing entries for specs not in projectlist
- Flag orphaned entries (in projectlist but no spec file)
- Update status based on existence of plan/review files

The command should work across tech stacks (JS, Python, Rust, Go) and be extensible.

## Stakeholders
- **Primary Users**: Developers adopting codev in existing projects
- **Secondary Users**: AI agents working in bootstrapped projects
- **Technical Team**: Codev maintainers
- **Business Owners**: Cluesmith

## Success Criteria

### Brownfield Adoption
- [ ] AI synthesis produces readable, accurate documentation
- [ ] Generated `arch.md` correctly identifies project structure, tech stack, and key components
- [ ] Generated `CLAUDE.md` includes project-specific conventions (detected from config files)
- [ ] `projectlist.md` seeded with actionable items when GitHub integration enabled
- [ ] Works across tech stacks: npm, cargo, go, python (pyproject.toml)
- [ ] Ruler-aware: generates `.ruler/codev.md` when Ruler detected

### Legacy Upgrade
- [ ] Discovers all existing specs in `codev/specs/*.md`
- [ ] Correctly parses spec metadata (id, title, status)
- [ ] Matches specs to corresponding plans and reviews
- [ ] Generates valid `projectlist.md` YAML entries for each spec
- [ ] Infers status from file existence (spec only → conceived, +plan → planned, +review → integrated)

### Memory Sync
- [ ] `--sync` mode updates existing projectlist without regenerating other files
- [ ] Identifies specs not in projectlist (adds them)
- [ ] Flags projectlist entries without corresponding spec files
- [ ] Preserves user customizations in existing projectlist entries

### General
- [ ] Existing files backed up before overwriting
- [ ] `--dry-run` shows changes without writing
- [ ] Documentation updated (CLAUDE.md, README)

## Constraints

### Technical Constraints
- Must not require API keys (uses Claude CLI for AI synthesis)
- Must handle various tech stacks with graceful degradation

### Business Constraints
- Should integrate with existing codev commands naturally
- Should follow established codev patterns (chalk output, options interface)

## Assumptions
- Claude CLI is installed and available for AI synthesis
- Git is available for git history collection
- `gh` CLI is available for GitHub integration (optional)
- Project has at least one package manifest or recognizable structure

## Solution Approach

### Two-Phase Architecture

**Phase 1: Collection** (fast, offline, deterministic)
- Modular collectors gather structured data from various sources
- Each collector returns typed data with confidence levels
- Collectors run in parallel where possible

**Phase 2: Synthesis** (AI-assisted, optional)
- Aggregated collector data passed to Claude
- Claude generates prose documentation
- Output written to target files

### Collectors

| Collector | Sources | Data Extracted |
|-----------|---------|----------------|
| Package | package.json, Cargo.toml, go.mod, pyproject.toml | dependencies, scripts, workspaces |
| Structure | Directory tree, file patterns | apps, packages, entry points, test dirs |
| Git | Commit history, branches | patterns, contributors, recent activity |
| Docs | README.md, existing CLAUDE.md | existing documentation |
| GitHub | gh CLI (optional) | open issues, PRs |
| **Codev** | codev/specs/*.md, codev/plans/*.md, codev/reviews/*.md | existing specs, plans, reviews with metadata |
| **Projectlist** | codev/projectlist.md (if exists) | current project entries for sync |

### Generators

| Generator | Output | Source Data |
|-----------|--------|-------------|
| arch | `codev/resources/arch.md` | Structure, Package, Git, Docs |
| claude | `CLAUDE.md` or `.ruler/codev.md` | Package, Structure, Docs |
| projectlist | `codev/projectlist.md` | **Codev collector**, GitHub, code TODOs |
| lessons | `codev/resources/lessons-learned.md` | Reviews (extract patterns) |

### Codev Collector Details

The Codev collector scans existing SPIDER artifacts:

```
codev/specs/0001-feature-name.md     → Extract: id, title, status
codev/plans/0001-feature-name.md     → Confirms: planned status
codev/reviews/0001-feature-name.md   → Confirms: integrated status
```

**Metadata extraction from spec files:**
1. Parse YAML frontmatter if present
2. Fall back to parsing `# Specification: Title` header
3. Detect status from `Status:` line or infer from file existence:
   - Has spec only → `conceived`
   - Has spec + plan → `planned`
   - Has spec + plan + review → `integrated`

### CLI Interface

```bash
# Initialize memory layers from codebase analysis
codev memory init              # Full init: codebase + codev artifacts
codev memory init --dry-run    # Show what would be generated
codev memory init --github     # Also fetch open issues/PRs
codev memory init --only arch  # Generate specific files only

# Sync projectlist with existing specs/plans/reviews
codev memory sync              # Update projectlist from codev/ artifacts
codev memory sync --dry-run    # Show what would change
```

**Subcommands:**
- `init`: Full memory initialization (all collectors, all generators)
- `sync`: Lightweight sync - only Codev collector → projectlist generator

**Options for `init`:**
- `--dry-run`: Preview changes without writing files
- `--github`: Include GitHub issues/PRs in projectlist seeding
- `--only <files>`: Generate specific outputs only (arch, claude, projectlist, lessons)

## Open Questions

### Critical (Blocks Progress)
- [x] Should bootstrap be a separate command or flag on adopt? **Answered: Separate command**

### Important (Affects Design)
- [ ] How deep should code analysis go? (imports/exports or just structure?)
- [ ] Should we detect and include linting/formatting rules in CLAUDE.md?

### Nice-to-Know (Optimization)
- [ ] Could we use `tokei` for more accurate language breakdown?
- [ ] Should we parse TODO/FIXME comments for projectlist seeding?

## Security Considerations
- No API keys required (uses local CLIs)
- No network access except optional GitHub via `gh` CLI
- Does not read file contents beyond manifests/configs (no secrets risk)

## Test Scenarios

### Brownfield Adoption Tests (`memory init`)
1. Init npm monorepo (like codev itself) - verify correct structure detection
2. Init single-package project - verify simplified output
3. Init with --github - verify issue import
4. Init with --dry-run - verify no file writes
5. Init Rust project (Cargo.toml) - verify cross-stack support
6. Init Python project (pyproject.toml) - verify cross-stack support

### Legacy Upgrade Tests (`memory init`)
7. Init project with existing specs but no projectlist - verify spec discovery
8. Parse spec with YAML frontmatter - verify metadata extraction
9. Parse spec with only `# Specification: Title` header - verify fallback parsing
10. Match specs to plans and reviews - verify file correlation
11. Infer status from file existence - verify status logic

### Memory Sync Tests (`memory sync`)
12. `sync` with missing specs in projectlist - verify additions
13. `sync` with orphaned projectlist entries - verify flagging
14. `sync` preserves custom notes in existing entries
15. `sync` updates status based on new plan/review files

### Edge Cases
16. Empty codev/specs/ directory - handle gracefully
17. Malformed spec file (no title) - warn and skip
18. Conflicting projectlist entries - merge strategy

### Non-Functional Tests
1. Performance: `memory init` on codev repo in < 10s without AI
2. Performance: `memory sync` completes in < 2s
3. Memory: Peak memory during collection < 100MB

## Dependencies
- **External Services**: None required (GitHub optional)
- **Internal Systems**: Existing codev lib utilities (templates.ts, ruler.ts)
- **Libraries/Frameworks**: chalk, commander (already in use)

## References
- Book chapter: `codev-private/docs/book/part1/ch04-memory.qmd`
- Existing adopt command: `packages/codev/src/commands/adopt.ts`
- Template utilities: `packages/codev/src/lib/templates.ts`
- Design plan: `/Users/amrmohamed/.claude/plans/zazzy-scribbling-stroustrup.md`

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|---------------------|
| AI synthesis produces inaccurate output | Medium | Medium | Clearly mark as "draft, review recommended" |
| Collection slow on large codebases | Low | Low | Add progress indicator, optimize with parallel collection |
| Package manifest parsing fails | Low | Medium | Graceful degradation, warn and continue |

## Expert Consultation
<!-- To be filled after consultation -->

## Approval
- [ ] Technical Lead Review
- [ ] Product Owner Review
- [ ] Stakeholder Sign-off
- [ ] Expert AI Consultation Complete

## Notes
- This addresses a gap explicitly noted in the Codev book chapter on memory architecture
- The modular collector architecture allows easy extension for new tech stacks
- Consider future integration with `codev adopt` (e.g., `adopt` could call `memory init` automatically)
- The `memory sync` subcommand provides a lightweight way to keep projectlist in sync with specs
- Legacy upgrade path is critical for existing codev users upgrading to newer versions
- Could potentially integrate with `codev update` (e.g., `update` could suggest running `memory init`)
- Command name "memory" directly ties to the memory architecture concept from the book
