# Specification: Memory Command

## Metadata
- **ID**: 0062
- **Status**: specified
- **Created**: 2025-12-27
- **Specified**: 2025-12-27

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

| Generator | Canonical Output Path | Source Data |
|-----------|----------------------|-------------|
| arch | `codev/resources/arch.md` | Structure, Package, Git, Docs |
| claude | `CLAUDE.md` (or `.ruler/codev.md` if Ruler detected) | Package, Structure, Docs |
| projectlist | `codev/projectlist.md` | **Codev collector**, GitHub, code TODOs |
| lessons | `codev/resources/lessons-learned.md` | Reviews (extract patterns) |

**Path Resolution**:
- All paths are relative to project root
- `arch` and `lessons` always in `codev/resources/`
- `claude` checks for `.ruler/` directory; if exists, outputs to `.ruler/codev.md`
- `projectlist` always in `codev/` (never in resources/)

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
- `--dry-run`: Preview changes without writing files (see Dry-Run Output Format below)
- `--github`: Include GitHub issues/PRs in projectlist seeding
- `--only <files>`: Generate specific outputs only (arch, claude, projectlist, lessons). Accepts comma-separated values: `--only arch,projectlist`. Skips collectors not needed for specified outputs.
- `--merge`: Preserve existing content and append generated content with markers (default: backup and overwrite)
- `--depth <n>`: Directory traversal depth for structure analysis (default: 3, max: 10)

## Detailed Behaviors

### Projectlist Schema

Each project entry in `projectlist.md` uses this YAML structure:

```yaml
- id: "0001"                           # Required: 4-digit string, extracted from filename
  title: "Feature Name"                # Required: from spec header or frontmatter
  summary: "Brief description"         # Optional: first paragraph or AI-generated
  status: conceived                    # Required: see Status Inference below
  priority: medium                     # Optional: high/medium/low, default medium
  release: null                        # Optional: release version assignment
  files:
    spec: codev/specs/0001-feature.md  # Required: path to spec file
    plan: codev/plans/0001-feature.md  # Optional: null if not exists
    review: codev/reviews/0001-feature.md  # Optional: null if not exists
  dependencies: []                     # Optional: list of spec IDs
  tags: []                             # Optional: extracted from spec or inferred
  timestamps:
    conceived_at: "2025-01-01T00:00:00Z"  # From git or file mtime
    specified_at: null                 # When spec approved
    planned_at: null                   # When plan created
    implementing_at: null              # When builder spawned
    implemented_at: null               # When PR merged
  notes: ""                            # User-editable field, always preserved
```

### Merge Rules for Projectlist

When syncing an existing projectlist:

| Field | Behavior |
|-------|----------|
| `id`, `title`, `files.*` | **Auto-updated**: Always reflect current file state |
| `status` | **Auto-updated**: Re-inferred from file existence (see below) |
| `summary`, `tags` | **Preserve if set**: Only populate if currently empty |
| `priority`, `release`, `dependencies` | **Preserve always**: Never overwritten by sync |
| `notes` | **Preserve always**: User customization field |
| `timestamps` | **Merge**: Update specific timestamps when status changes |

**Orphan handling**: Entries in projectlist with no corresponding spec file are:
1. Flagged with a warning comment: `# WARNING: No spec file found for 0042`
2. Status set to `orphaned`
3. NOT automatically removed (user must decide)

**Conflict resolution**: If spec ID appears twice in projectlist, warn and keep first entry.

### Status Inference Mapping

Status is inferred from file existence, mapping to SPIDER lifecycle:

| Files Present | Inferred Status | SPIDER Phase |
|---------------|-----------------|--------------|
| spec only | `conceived` | Specify (draft) |
| spec + explicit "Status: specified" | `specified` | Specify (approved) |
| spec + plan | `planned` | Plan |
| spec + plan + builder worktree exists | `implementing` | Implement/Defend/Evaluate |
| spec + plan + review (no "Status: integrated") | `implemented` | Review (pending merge) |
| spec + plan + review + "Status: integrated" | `integrated` | Complete |
| projectlist entry but no spec | `orphaned` | N/A |
| spec with "Status: abandoned" | `abandoned` | N/A |

**Partial phase handling**:
- If spec has explicit `Status:` field, that takes precedence over file inference
- User-set status in projectlist is **not** overwritten during sync (treated as manual override)

**Builder worktree detection**:
- Pattern: `.builders/<project-id>-*` (e.g., `.builders/0042-feature-name/`)
- Detection: `ls .builders/ | grep "^<id>-"`
- If match found AND worktree is valid git worktree → status = `implementing`
- **Stale worktree handling**: If `.builders/<id>-*/` exists but is not a valid git worktree (no `.git` file), ignore it (don't infer `implementing`)
- Multiple worktrees for same ID: Use most recently modified (by directory mtime)

### File Regeneration Policy

For existing files (`arch.md`, `CLAUDE.md`, `projectlist.md`):

| Scenario | Behavior |
|----------|----------|
| File doesn't exist | Create new file |
| File exists, `--dry-run` | Show diff, no changes |
| File exists, no flag | **Backup** then overwrite |
| File exists, `--merge` flag | Append new content with `<!-- GENERATED -->` markers |

**Backup convention**: `<filename>.backup.<ISO-timestamp>`
- Example: `arch.md.backup.2025-01-15T14-30-00`
- Backups stored in same directory as original
- Only most recent backup kept (older backups overwritten)

**AI-generated content markers**:
```markdown
<!-- BEGIN GENERATED CONTENT - codev memory init -->
[AI-generated content here]
<!-- END GENERATED CONTENT -->

<!-- User customizations below this line are preserved -->
```

**Per-file merge semantics with `--merge`**:

| File | Merge Behavior |
|------|----------------|
| `arch.md` | Replace content inside `<!-- GENERATED -->` markers only. Content before first marker and after last marker preserved. If no markers exist, prepend generated content with markers, preserve all existing content after. |
| `CLAUDE.md` | Append new sections at end with markers. Never modify existing content. User's custom instructions always preserved. |
| `projectlist.md` | Merge entries by ID. New specs added. Existing entries: update `files.*` and `status`, preserve `priority`, `release`, `notes`, `dependencies`. |
| `lessons-learned.md` | Append new lessons at end with date header. Never remove existing lessons. |

**Without `--merge` (default)**: Backup existing file, then overwrite entirely.

### GitHub Seeding Behavior

When `--github` flag is used:

**Fields pulled from GitHub**:
| GitHub Field | Projectlist Field | Notes |
|--------------|-------------------|-------|
| Issue number | `id` | Prefixed with `GH-` (e.g., `GH-0042`) |
| Issue title | `title` | Truncated to 80 chars |
| First 200 chars of body | `summary` | Sanitized, no markdown |
| Labels | `tags` | Direct mapping |
| Milestone | `release` | If milestone matches semver pattern |

**Idempotency rules**:
- Issues already in projectlist (matched by `GH-` prefix) are skipped
- Re-running with `--github` only adds NEW issues
- Closed issues are not imported (only open issues)
- PRs are not imported (issues only)

**Deduplication**: If a spec file already exists for an issue (detected by matching title or `GitHub: #123` in spec), skip import.

**ID Namespace Coexistence**:
- Spec IDs: 4-digit numeric strings (`0001`-`9999`)
- GitHub IDs: Prefixed with `GH-` (`GH-0042`, `GH-0123`)
- These namespaces are **disjoint** - no collision possible
- Sorting: Specs sorted numerically first, then GH items by number
- Dependencies: Can reference either namespace (`dependencies: ["0015", "GH-0042"]`)
- Status inference: GH items are always `conceived` (no spec/plan/review files)
- GH items cannot progress through SPIDER lifecycle until converted to a spec

### AI Synthesis Constraints

**Claude CLI invocation**:
```bash
claude --print -p "<synthesis prompt>" < collected_data.json
```

**Prompt structure**:
1. Role: "You are documenting a software project based on collected metadata."
2. Constraints: "Be factual. Mark uncertain information with [UNCERTAIN]. Max 500 words per section."
3. Collected data: JSON from all collectors
4. Output format: Markdown matching target file structure

**Token management**:
- Collected data truncated to 50KB before sending to Claude
- Large file lists summarized (show first 20, then "... and N more")
- Git history limited to last 100 commits

**Success criteria for "accurate" output**:
- All detected languages listed in arch.md
- Package names match actual manifest
- Directory structure reflects actual layout
- No hallucinated dependencies

**Low-confidence handling**:
- Sections with uncertain data marked: `> ⚠️ This section was auto-generated and may need review`
- `--dry-run` shows confidence scores per section

### Claude CLI Unavailability

If Claude CLI is not installed or fails:
1. Collection phase completes normally
2. Synthesis phase skipped with warning: `Claude CLI not available. Skipping AI synthesis.`
3. Collected data written to `.codev-memory-data.json` for manual processing
4. Projectlist still generated (doesn't require AI)
5. `arch.md` and `CLAUDE.md` not generated (require AI synthesis)

### Dry-Run Output Format

When `--dry-run` is specified, output uses a structured summary format:

```
codev memory init --dry-run

📊 Collection Summary
├── Package: npm monorepo detected (3 workspaces)
├── Structure: 847 files, 12 directories analyzed
├── Git: 234 commits, 5 contributors
├── Docs: README.md, existing CLAUDE.md found
├── Codev: 15 specs, 12 plans, 8 reviews discovered
└── GitHub: skipped (use --github to enable)

📝 Files to Generate
┌─────────────────────────────────┬──────────┬─────────────┐
│ File                            │ Action   │ Confidence  │
├─────────────────────────────────┼──────────┼─────────────┤
│ codev/resources/arch.md         │ CREATE   │ HIGH        │
│ CLAUDE.md                       │ BACKUP   │ MEDIUM      │
│ codev/projectlist.md            │ UPDATE   │ HIGH        │
└─────────────────────────────────┴──────────┴─────────────┘

📋 Projectlist Changes (diff)
+ 0016: "API Rate Limiting" (conceived)
+ 0017: "User Dashboard" (planned)
~ 0015: status conceived → implemented

Run without --dry-run to apply changes.
```

Actions: `CREATE` (new file), `BACKUP` (backup existing, overwrite), `UPDATE` (merge changes), `SKIP` (no changes needed)

### Security and Redaction Policy

Before sending collected data to Claude for synthesis:

**Always excluded paths** (never sent to AI):
- `.env*`, `*.pem`, `*.key`, `*credentials*`, `*secret*`
- `node_modules/`, `vendor/`, `.git/objects/`
- Files > 100KB
- Binary files (detected by extension or null bytes)

**Always excluded from git history**:
- Commit diffs (only messages and file paths)
- Author emails (only names)
- Any line containing: `password`, `token`, `api_key`, `secret`, `credential`

**Collected data sanitization**:
```typescript
interface SanitizedData {
  // Package: dependency names only, no versions or registry URLs
  // Structure: paths only, no file contents
  // Git: messages and filenames only, no diffs
  // Docs: first 1000 chars of README, no other docs content
}
```

**User override**: `--include-path <glob>` to explicitly include paths matching pattern (use with caution).

### GitHub Failure Modes

| Scenario | Behavior |
|----------|----------|
| `gh` CLI not installed | Warn: "GitHub CLI not found, skipping --github", continue offline |
| `gh` not authenticated | Warn: "Not authenticated with GitHub, run 'gh auth login'", continue offline |
| Rate limit exceeded | Warn: "GitHub rate limit hit, imported N of M issues", continue with partial data |
| Private repo (no access) | Warn: "Cannot access repo issues (private?)", continue offline |
| Network timeout | Retry once after 5s, then warn and continue offline |
| API error (5xx) | Warn with error message, continue offline |

All GitHub failures are **fail-soft**: the command continues without GitHub data rather than aborting.

### Edge Case Decisions

| Edge Case | Behavior |
|-----------|----------|
| **Malformed spec (no title)** | Warn: "Skipping 0042: no title found", continue with others |
| **Duplicate spec IDs** | Error: "Duplicate ID 0042 found", list all files, abort sync |
| **Mixed Ruler/standard** | Detect `.ruler/` directory → use `.ruler/codev.md`; otherwise `CLAUDE.md` |
| **Multiple package manifests** | Priority: root `package.json` > root `Cargo.toml` > root others > nested (alphabetically). Override with `--manifest <path>` |
| **No manifest found** | Warn: "No package manifest found", continue with structure-only analysis |
| **Spec ID vs filename mismatch** | **Filename wins** for `id` field; spec content used for `title`. Warn about mismatch. |
| **Spec title vs frontmatter conflict** | **Frontmatter wins** if present; fall back to `# Specification:` header |
| **Very large codebase (>10k files)** | Use `--depth` flag (default 3). Warn if truncated. Use `--depth 10` for full scan. |
| **Multiple active builders** | Check all `.builders/*/` directories; if any matches project ID, status = `implementing` |
| **Existing user sections in arch.md** | With `--merge`: preserve content outside `<!-- GENERATED -->` markers. Without: backup entire file. |

## Open Questions

### Critical (Blocks Progress)
- [x] Should bootstrap be a separate command or flag on adopt? **Answered: Separate command**

### Important (Affects Design) - Resolved for v1
- [x] How deep should code analysis go? **v1 Scope: Structure only** (directory tree, file counts, entry points). Import/export analysis deferred to v2.
- [x] Should we detect and include linting/formatting rules in CLAUDE.md? **v1 Scope: No**. Only detect from config file presence (`.eslintrc`, `.prettierrc`), don't parse rules. Full lint/format detection deferred to v2.

### Nice-to-Know (Deferred to v2)
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

### 3-Way Review Results (2025-12-27)

| Model | Verdict | Confidence | Summary |
|-------|---------|------------|---------|
| Claude | APPROVE | HIGH | Well-designed spec with clear requirements; minor clarifications needed |
| Gemini | APPROVE | HIGH | Exceptionally well-defined, complete, and technically sound |
| Codex | COMMENT | HIGH | Strong spec with clear behaviors; minor gaps around lessons/backup/tests |

**Key feedback incorporated**:
- Added Projectlist Schema and Merge Rules
- Added Status Inference Mapping (SPIDER lifecycle)
- Added File Regeneration Policy with per-file merge semantics
- Added GitHub Seeding Behavior with ID namespace coexistence
- Added AI Synthesis Constraints and Security/Redaction Policy
- Added GitHub Failure Modes (fail-soft behavior)
- Added Edge Case Decisions table
- Resolved open design questions for v1 scope

**Deferred to planning phase** (per Codex COMMENT):
- Lessons generator success criteria details
- Backup retention naming strategy
- Non-AI fallback acceptance criteria
- Additional test coverage for merge/GitHub/depth scenarios

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
