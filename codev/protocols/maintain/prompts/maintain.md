# MAINTAIN Phase Prompt

You are executing the **maintain** phase — a single pass covering audit, cleanup, and doc sync.

## Context

- **Current State**: {{current_state}}

## Step 1: Determine Scope

```bash
ls codev/maintain/
```

Find the last run number and its base commit. Then see what changed:

```bash
git log --oneline <base-commit>..HEAD
```

Create your maintenance run file: `codev/maintain/NNNN.md` (next number in sequence).

## Step 2: Audit

Identify dead code, unused dependencies, and stale documentation. Don't fix yet — catalog first.

```bash
# Dead exports
npx ts-prune 2>/dev/null || echo "ts-prune not available"

# Unused dependencies
npx depcheck 2>/dev/null || echo "depcheck not available"

# Stale arch.md references
grep -oE '[a-zA-Z]+/[a-zA-Z/]+\.[a-z]+' codev/resources/arch.md | sort -u | while read f; do
  [ -e "$f" ] || echo "Missing: $f"
done
```

Record all findings in the maintenance run file.

## Step 3: Clean

For each audit finding:
1. Verify it's truly unused (grep the codebase)
2. Remove with `git rm` (tracked) or move to `codev/maintain/.trash/$(date +%Y-%m-%d)/` (untracked)
3. Build and test: `cd packages/codev && pnpm build && pnpm test`
4. Commit: `git add <specific-files> && git commit -m "[Maintain] Remove unused X"`

One removal at a time. Verify after each. Never use `git add -A`.

## Step 4: Sync Documentation

**arch.md**: Read `codev/resources/arch.md`, compare with actual codebase. Update directory structure, component descriptions, key files. Remove references to deleted code. Add new components. Explain HOW things work, not just WHAT.

**lessons-learned.md**: Scan `codev/reviews/` for new reviews since the base commit. Extract actionable, durable, general lessons.

**CLAUDE.md / AGENTS.md**: `diff CLAUDE.md AGENTS.md` — they must be identical. Update the stale one.

**Pruning**: Remove obsolete content. Document every deletion with justification (OBSOLETE, DUPLICATIVE, MOVED, VERBOSE). When in doubt, keep.

Commit documentation changes:
```bash
git add codev/resources/arch.md codev/resources/lessons-learned.md
git commit -m "[Maintain] Update arch.md and lessons-learned.md"
```

## Step 5: Final Checks

```bash
cd packages/codev && pnpm build && pnpm test
```

Both must pass. Update the maintenance run file with a summary of everything done.

## Signals

When all work is complete and build/tests pass:

```
<signal>PHASE_COMPLETE</signal>
```

If blocked:

```
<signal>BLOCKED:reason</signal>
```
