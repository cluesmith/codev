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

Create your maintenance run file: `codev/maintain/NNNN.md` — the next number in sequence, four digits, zero-padded (`0008.md`). Run files are the one place Codev zero-pads; project and issue ids never are.

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
2. Remove with `git rm` (tracked — git history keeps it recoverable) or move to `codev/maintain/.trash/$(date +%Y-%m-%d)/` (untracked — nothing else would keep it)
3. Run the project's build and tests (porch's `build` and `tests` checks: `pnpm build` / `pnpm test` unless `.codev/config.json` `porch.checks` overrides them)
4. Commit: `git add <specific-files> && git commit -m "[Maintain] Remove unused X"`

One removal at a time, verified after each — staging only the specific files that removal touched.

## Step 4: Sync Documentation

**arch.md / arch-critical.md** (Spec 987 two-tier): Read both, compare with actual codebase. Route behavior-changing invariants to the HOT `arch-critical.md` (respect its cap + keep its cold-doc map accurate); reference detail to the COLD `arch.md` (directory structure, component descriptions, key files, removals). Explain HOW things work, not just WHAT.

**lessons-learned.md / lessons-critical.md** (two-tier): Scan `codev/reviews/` for new reviews since the base commit. **Route** each lesson — behavior-changing + cross-cutting → HOT `lessons-critical.md` (cap + displacement); reference recipe → COLD `lessons-learned.md`. Audit the hot caps + maps via the `update-arch-docs` skill.

**CLAUDE.md / AGENTS.md**: `diff CLAUDE.md AGENTS.md` — they must be identical. Update the stale one.

**Pruning**: Remove obsolete content. Document every deletion with justification (OBSOLETE, DUPLICATIVE, MOVED, VERBOSE). When in doubt, keep.

Commit documentation changes:
```bash
git add codev/resources/arch.md codev/resources/arch-critical.md
git add codev/resources/lessons-learned.md codev/resources/lessons-critical.md
git commit -m "[Maintain] Update governance docs (hot + cold tiers)"
```

## Step 5: Final Checks

Run the project's build and tests (porch's `build` and `tests` checks: `pnpm build` / `pnpm test` unless `.codev/config.json` `porch.checks` overrides them). Both must pass. Update the maintenance run file with a summary of everything done.

## When you finish

- **All work committed, build and tests passing:** run `porch done`. Porch runs its checks, then
  `porch next` hands you the consultation commands to run.
- **Blocked:** do not run `porch done`. `afx send architect` the specifics, then stop and wait.
