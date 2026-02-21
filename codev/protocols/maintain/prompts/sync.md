# SYNC Phase Prompt

You are executing the **SYNC** phase of the MAINTAIN protocol.

## Your Goal

Update documentation to match the current state of the codebase.

## Context

- **Current State**: {{current_state}}

## Process

### 1. Update arch.md

Read the current architecture doc and compare with actual codebase:

```bash
cat codev/resources/arch.md
ls -la packages/ src/ 2>/dev/null
```

Update:
- Directory structure (if changed)
- Component descriptions
- Key files and their purposes
- Remove references to deleted code
- Add new utilities/components

**arch.md must explain HOW things work, not just WHAT they are.**

### 2. Generate/Update lessons-learned.md

Scan review documents for lessons:

```bash
ls codev/reviews/
```

Extract actionable lessons:
- Testing practices
- Architecture decisions
- Process improvements
- Patterns to follow/avoid

Format:
```markdown
## [Topic]
- [From NNN] Lesson description
```

### 3. Sync CLAUDE.md with AGENTS.md

Compare the two files:
```bash
diff CLAUDE.md AGENTS.md | head -50
```

They must be identical. Update the stale one to match.

### 4. Prune Documentation

Check document sizes:
```bash
wc -l CLAUDE.md AGENTS.md README.md
```

Target ~400 lines for CLAUDE.md/README.md (guideline, not mandate).

For any content removed, document:
- WHAT was removed
- WHY it was removed (OBSOLETE, DUPLICATIVE, MOVED, VERBOSE)
- WHERE it moved (if applicable)

### 5. Commit Documentation Changes

```bash
git add codev/resources/arch.md codev/resources/lessons-learned.md
git commit -m "[Maintain] Update arch.md and lessons-learned.md"

git add CLAUDE.md AGENTS.md
git commit -m "[Maintain] Sync CLAUDE.md with AGENTS.md"
```

## Important Rules

1. **Never invent structure** - Only document what exists
2. **Verify file paths** - Check that referenced files exist
3. **Keep it current** - Remove obsolete references
4. **Preserve important content** - Don't delete patterns/best practices
5. **Document deletions** - Every removal needs justification

## Output

Update the maintenance run file with:
- Documents updated
- What was added/removed/changed
- Any issues encountered

## Signals

When documentation is synchronized:

```
<signal>PHASE_COMPLETE</signal>
```

If blocked:

```
<signal>BLOCKED:reason</signal>
```
