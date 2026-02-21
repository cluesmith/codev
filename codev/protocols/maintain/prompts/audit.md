# AUDIT Phase Prompt

You are executing the **AUDIT** phase of the MAINTAIN protocol.

## Your Goal

Analyze the codebase to identify dead code, unused dependencies, and stale documentation.

## Context

- **Current State**: {{current_state}}

## Process

### 1. Determine Base Commit

Find the last maintenance run:
```bash
ls codev/maintain/
```

If previous runs exist, note the base commit to focus on changes since then.

### 2. Scan for Dead Code

Run static analysis tools:

```bash
# TypeScript/JavaScript
npx ts-prune 2>/dev/null || echo "ts-prune not available"
npx depcheck 2>/dev/null || echo "depcheck not available"

# Check for unused exports
grep -r "export " --include="*.ts" --include="*.tsx" | head -50
```

### 3. Scan for Unused Dependencies

Check package.json for unused dependencies:
```bash
cat package.json | grep -A100 '"dependencies"' | head -50
```

Cross-reference with actual imports in the codebase.

### 4. Scan for Stale Documentation

Check for references to deleted files/functions:
```bash
# Recent changes
git log --oneline -20

# Check if arch.md references exist
grep -E "src/|packages/" codev/resources/arch.md | head -20
```

### 5. Create Audit Report

Create a maintenance run file: `codev/maintain/NNN.md`

Document:
- Dead code identified (with file paths)
- Unused dependencies
- Stale documentation references
- Recommended actions

Use the template structure:
```markdown
# Maintenance Run NNN

**Date**: YYYY-MM-DD
**Base Commit**: <commit-hash>

## Dead Code Identified

| File | Item | Reason |
|------|------|--------|
| path/to/file.ts | unusedFunction() | Not imported anywhere |

## Unused Dependencies

| Package | Reason |
|---------|--------|
| some-pkg | Not imported |

## Stale Documentation

| Document | Issue |
|----------|-------|
| arch.md | References deleted module |

## Recommended Actions

1. Remove X
2. Update Y
3. ...
```

## Signals

When audit report is complete:

```
<signal>PHASE_COMPLETE</signal>
```

If blocked:

```
<signal>BLOCKED:reason</signal>
```
