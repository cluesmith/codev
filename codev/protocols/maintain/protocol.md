# MAINTAIN Protocol

## Overview

MAINTAIN is a periodic maintenance protocol for keeping codebases healthy. Unlike SPIDER/TICK (which have sequential phases), MAINTAIN is a **task list** where tasks can run in parallel and some require human review.

**Core Principle**: Regular maintenance prevents technical debt accumulation.

## When to Use MAINTAIN

- When the user/architect requests it
- Before a release (clean slate for shipping)
- Quarterly maintenance window
- After completing a major feature
- When the codebase feels "crusty"

## Execution Model

MAINTAIN is executed by a Builder, spawned by the Architect:

```
Architect: "Time for maintenance"
    ↓
af spawn --protocol maintain
    ↓
Builder works through task list
    ↓
PR with maintenance changes
    ↓
Architect reviews → Builder merges
```

## Prerequisites

Before starting MAINTAIN:
1. Check `codev/maintain/` for last maintenance run
2. Note the base commit from that run
3. Focus on changes since that commit: `git log --oneline <base-commit>..HEAD`

---

## Maintenance Files

Each maintenance run creates a numbered file in `codev/maintain/`:

```
codev/maintain/
├── 0001.md
├── 0002.md
└── ...
```

**Template**: `codev/protocols/maintain/templates/maintenance-run.md`

The file records:
- Base commit (starting point)
- Tasks completed
- Findings and deferred items
- Summary

---

## Task List

### Code Hygiene Tasks

| Task | Parallelizable | Human Review? | Description |
|------|----------------|---------------|-------------|
| Remove dead code | Yes | No | Delete unused functions, imports, unreachable code |
| Remove unused dependencies | Yes | Yes | Check package.json/requirements.txt for unused packages |
| Clean unused flags | Yes | No | Remove feature flags that are always on/off |
| Fix flaky tests | No | Yes | Investigate and fix intermittently failing tests |
| Update outdated dependencies | Yes | Yes | Bump dependencies with breaking change review |

**Tools**:
```bash
# TypeScript/JavaScript
npx ts-prune          # Find unused exports
npx depcheck          # Find unused dependencies

# Python
ruff check --select F401   # Find unused imports
```

### Documentation Sync Tasks

| Task | Parallelizable | Human Review? | Description |
|------|----------------|---------------|-------------|
| Update arch.md | Yes | No | Sync architecture doc with actual codebase |
| Generate lessons-learned.md | Yes | Yes | Extract wisdom from review documents |
| Sync CLAUDE.md ↔ AGENTS.md | Yes | No | Ensure both files match |
| Check spec/plan/review consistency | Yes | Yes | Find specs without reviews, plans that don't match code |
| Remove stale doc references | Yes | No | Delete references to deleted code/files |

### Project Tracking Tasks

| Task | Parallelizable | Human Review? | Description |
|------|----------------|---------------|-------------|
| Update projectlist.md status | Yes | No | Update project statuses |
| Archive terminal projects | Yes | No | Move completed/abandoned to terminal section |

### Framework Tasks

| Task | Parallelizable | Human Review? | Description |
|------|----------------|---------------|-------------|
| Run codev update | No | Yes | Update codev framework to latest version |

---

## Task Details

### Update arch.md

Scan the actual codebase and update `codev/resources/arch.md`:

**Discovery phase**:
1. `git log --oneline <base-commit>..HEAD` - what changed since last maintenance
2. `ls -R` key directories to find new files/modules
3. `grep` for new exports, classes, key functions

**Update arch.md**:
1. Verify directory structure matches documented structure
2. Update component descriptions for changed modules
3. Add new utilities/helpers discovered
4. Remove references to deleted code
5. Update technology stack if dependencies changed
6. Document new integration points or APIs

**What to include**:
- File locations and their purpose
- Key functions/classes and what they do
- Data flow and dependencies
- Configuration options
- CLI commands and flags

**What NOT to include**:
- Implementation details that change frequently
- Line numbers (they go stale)
- Full API documentation (use JSDoc/docstrings for that)

### Generate lessons-learned.md

Extract actionable wisdom from review documents into `codev/resources/lessons-learned.md`:

1. Read all files in `codev/reviews/`
2. Extract lessons that are:
   - Actionable (not just "we learned X")
   - Durable (still relevant)
   - General (applicable beyond one project)
3. Organize by topic (Testing, Architecture, Process, etc.)
4. Link back to source review
5. Prune outdated lessons

**Template**:
```markdown
# Lessons Learned

## Testing
- [From 0001] Always use XDG sandboxing in tests to avoid touching real $HOME
- [From 0009] Verify dependencies actually export what you expect

## Architecture
- [From 0008] Single source of truth beats distributed state
- [From 0031] SQLite with WAL mode handles concurrency better than JSON files

## Process
- [From 0001] Multi-agent consultation catches issues humans miss
```

### Sync CLAUDE.md ↔ AGENTS.md

Ensure both instruction files contain the same content:

1. Diff the two files
2. Identify divergence
3. Update the stale one to match
4. Both should be identical (per AGENTS.md standard)

### Remove Dead Code

Use static analysis to find and remove unused code:

1. Run analysis tools (ts-prune, depcheck, ruff)
2. Review findings for false positives
3. Use `git rm` to remove confirmed dead code
4. Commit with descriptive message

**Important**: Use `git rm`, not `rm`. Git history preserves deleted files.

### Update Dependencies

Review and update outdated dependencies:

1. Run `npm outdated` or equivalent
2. Categorize updates:
   - Patch: Safe to auto-update
   - Minor: Review changelog
   - Major: Requires human review for breaking changes
3. Update and test
4. Document any migration steps

### Run codev update

Update the codev framework to the latest version:

```bash
codev update
```

This updates protocols, templates, and agents while preserving your specs, plans, and reviews.

---

## Validation

After completing tasks, validate the codebase:

- [ ] All tests pass
- [ ] Build succeeds
- [ ] No import/module errors
- [ ] Documentation links resolve
- [ ] Linter passes

If validation fails, investigate and fix before creating PR.

---

## Rollback Strategy

### For code changes
```bash
# Git history preserves everything
git log --all --full-history -- path/to/file
git checkout <commit>~1 -- path/to/file
```

### For untracked files
Move to `codev/maintain/.trash/YYYY-MM-DD/` before deleting. Retained for 30 days.

---

## Commit Messages

```
[Maintain] Remove 5 unused exports
[Maintain] Update arch.md with new utilities
[Maintain] Generate lessons-learned.md
[Maintain] Sync CLAUDE.md with AGENTS.md
[Maintain] Update dependencies (patch)
```

---

## Governance

MAINTAIN is an **operational protocol**, not a feature development protocol:

| Document | Required? |
|----------|-----------|
| Spec | No |
| Plan | No |
| Review | No |
| Consultation | No (human review of PR is sufficient) |

**Exception**: If MAINTAIN reveals need for architectural changes, those should follow SPIDER.

---

## Best Practices

1. **Don't be aggressive**: When in doubt, keep the code
2. **Check git blame**: Understand why code exists before deleting
3. **Run full test suite**: Not just affected tests
4. **Group related changes**: One commit per logical change
5. **Document decisions**: Note why things were kept or removed

---

## Anti-Patterns

1. **Deleting everything the audit finds**: Review each item
2. **Skipping validation**: "It looked dead" is not validation
3. **Using `rm` instead of `git rm`**: Lose history
4. **Maintaining during active development**: Wait for PRs to merge
5. **Ignoring false positives**: Fix audit logic if it's wrong
