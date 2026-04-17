# MAINTAIN Protocol

## Overview

MAINTAIN is a single-pass maintenance protocol for keeping codebases healthy. The builder does all maintenance work in one phase, then creates a PR with a 3-way review.

**Core Principle**: Do the work in one pass. Don't over-ceremonialize housekeeping.

**Key Documents** MAINTAIN keeps current:
- `codev/resources/arch.md` - Architecture documentation
- `codev/resources/lessons-learned.md` - Extracted wisdom from reviews

## When to Use

- Before a release (clean slate for shipping)
- After completing a major feature
- Quarterly maintenance window
- When the codebase feels "crusty"

## Execution Model

```
afx spawn --protocol maintain
    ↓
1. MAINTAIN: Audit → Clean → Sync docs (single pass)
    ↓ (build + test checks, 3-way review)
2. REVIEW: Create PR
    ↓ (3-way review)
Architect reviews → Merge
```

Two phases total. One consultation during the maintain phase, one before PR.

## Prerequisites

Before starting:
1. Check `codev/maintain/` for the last run number
2. Note the base commit: `git log --oneline -1` on the last run file
3. Focus on changes since then: `git log --oneline <base-commit>..HEAD`

---

## The Maintain Phase (Single Pass)

The builder works through these tasks in order, committing as they go.

### Step 1: Audit

Identify what needs fixing. Don't fix yet — just catalog.

**Dead code**:
```bash
# Find unused exports (TypeScript)
npx ts-prune 2>/dev/null || echo "ts-prune not available"

# Find unused dependencies
npx depcheck 2>/dev/null || echo "depcheck not available"
```

**Stale documentation**:
```bash
# What changed since last maintenance?
git log --oneline <base-commit>..HEAD

# Check arch.md references still exist
grep -oE '[a-zA-Z]+/[a-zA-Z/]+\.[a-z]+' codev/resources/arch.md | sort -u | while read f; do
  [ -e "$f" ] || echo "Missing: $f"
done
```

**Stale project tracking**:
- GitHub Issues that should be closed
- Labels that need updating

Record findings in the maintenance run file (`codev/maintain/NNNN.md`).

### Step 2: Clean

For each finding from the audit:
1. Verify it's truly unused (grep the codebase)
2. Remove it (use `git rm` for tracked files)
3. Verify build + tests still pass
4. Commit with `[Maintain] Remove unused X`

**Rules**:
- One removal at a time — don't batch unrelated changes
- Verify after each removal — build must pass
- Use soft deletion for untracked files: `mv file codev/maintain/.trash/$(date +%Y-%m-%d)/`
- Never use `git add -A` or `git add .`

### Step 3: Sync Documentation

**arch.md**: Compare documented structure with actual codebase. Update:
- Directory structure
- Component descriptions (explain HOW things work, not just WHAT)
- Key files and their purposes
- Remove references to deleted code
- Add new components/utilities

**lessons-learned.md**: Scan `codev/reviews/` for new reviews since last run. Extract lessons that are actionable, durable, and general.

**CLAUDE.md / AGENTS.md**: Diff the two files. They must be identical. Update the stale one.

**Documentation pruning**:
- Remove obsolete references
- ~400 line guideline for CLAUDE.md/README.md (not a hard limit)
- Document every deletion with justification (OBSOLETE, DUPLICATIVE, MOVED, VERBOSE)
- When in doubt, KEEP the content

### Step 4: Final Checks

```bash
# Build and test from the package directory
cd packages/codev && pnpm build && pnpm test
```

Both must pass before moving to the review phase.

---

## Maintenance Run File

Each run creates `codev/maintain/NNNN.md`:

```markdown
# Maintenance Run NNNN

**Date**: YYYY-MM-DD
**Base Commit**: <hash>
**PR**: #NNN

## Changes Since Last Run

<key commits summary>

## What Was Done

### Dead Code Removed
- `path/to/file.ts`: `unusedFunction()` — not imported anywhere
- Removed `some-package` dependency — zero imports

### Documentation Updated
- arch.md: Added VS Code extension section, removed old dashboard-server refs
- lessons-learned.md: Extracted 3 lessons from reviews 653, 672

### Documentation Changes Log
| Document | Section | Action | Reason |
|----------|---------|--------|--------|
| arch.md | "Dashboard Server" | DELETED | OBSOLETE — replaced by Tower |

## Deferred

- Items found but not worth fixing now

## Summary

<2-3 sentences>
```

Keep it factual and short. The run file documents what happened, not what might happen.

---

## Commit Messages

```
[Maintain] Remove 5 unused exports
[Maintain] Remove http-proxy dependency
[Maintain] Update arch.md — add VS Code extension, remove dashboard-server refs
[Maintain] Generate lessons-learned.md from reviews 653, 672
[Maintain] Sync CLAUDE.md with AGENTS.md
```

---

## Governance

MAINTAIN is an operational protocol, not a feature protocol:

| Document | Required? |
|----------|-----------|
| Spec | No |
| Plan | No |
| Review | No (maintenance run file serves this purpose) |
| Consultation | Yes — 3-way review before PR |

If maintenance reveals need for architectural changes, those should follow SPIR.

---

## Rules

1. **Don't be aggressive** — when in doubt, KEEP the content
2. **Check git blame** — understand why code/docs exist before removing
3. **Run full test suite** — not just affected tests
4. **Group related changes** — one commit per logical change
5. **Document every deletion** — what, why, and where (if moved)
6. **Prefer moving over deleting** — extract to another file rather than removing
7. **Size targets are guidelines** — never sacrifice clarity to hit a line count

## Anti-Patterns

1. Aggressive rewriting without explanation
2. Deleting without documenting why
3. Hitting line count targets at all costs
4. Removing "patterns" or "best practices" sections without explicit approval
5. Deleting everything the audit finds — review each item individually
6. Skipping validation — "it looked dead" is not validation
7. Using `rm` instead of `git rm`
