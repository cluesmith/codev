# Implementation Plan: Consolidate Templates into agent-farm

## Metadata
- **ID**: 0032
- **Spec**: codev/specs/0032-consolidate-templates.md
- **Protocol**: TICK
- **Created**: 2025-12-05

## Overview

Move dashboard and annotate templates from `codev/templates/` to `agent-farm/templates/` and update server code to load from the new location.

## Tasks

### Task 1: Move templates to agent-farm

**Files**:
- `codev/templates/dashboard-split.html` → `agent-farm/templates/`
- `codev/templates/dashboard.html` → `agent-farm/templates/`
- `codev/templates/annotate.html` → `agent-farm/templates/`

```bash
mv codev/templates/dashboard-split.html agent-farm/templates/
mv codev/templates/dashboard.html agent-farm/templates/
mv codev/templates/annotate.html agent-farm/templates/
```

### Task 2: Update dashboard-server.ts

**File**: `agent-farm/src/servers/dashboard-server.ts`

Replace hardcoded path with dynamic resolution (following tower-server.ts pattern):

```typescript
/**
 * Find the dashboard template
 * Template is bundled with agent-farm package in templates/ directory
 */
function findTemplatePath(filename: string): string {
  // 1. Try relative to compiled output (dist/servers/ -> templates/)
  const pkgPath = path.resolve(__dirname, '../templates/', filename);
  if (fs.existsSync(pkgPath)) return pkgPath;

  // 2. Try relative to source (src/servers/ -> templates/)
  const devPath = path.resolve(__dirname, '../../templates/', filename);
  if (fs.existsSync(devPath)) return devPath;

  throw new Error(`Template not found: ${filename}`);
}

const templatePath = findTemplatePath('dashboard-split.html');
const legacyTemplatePath = findTemplatePath('dashboard.html');
```

### Task 3: Update annotate-server.ts

**File**: `agent-farm/src/servers/annotate-server.ts`

Same pattern as Task 2:

```typescript
function findTemplatePath(): string {
  const filename = 'annotate.html';

  // 1. Try relative to compiled output (dist/servers/ -> templates/)
  const pkgPath = path.resolve(__dirname, '../templates/', filename);
  if (fs.existsSync(pkgPath)) return pkgPath;

  // 2. Try relative to source (src/servers/ -> templates/)
  const devPath = path.resolve(__dirname, '../../templates/', filename);
  if (fs.existsSync(devPath)) return devPath;

  throw new Error(`Template not found: ${filename}`);
}
```

### Task 4: Remove old template directories

**Directories to remove**:
- `codev/templates/`
- `codev-skeleton/templates/`

```bash
rm -rf codev/templates/
rm -rf codev-skeleton/templates/
```

### Task 5: Build and test

```bash
cd agent-farm && npm run build && cd ..
./codev/bin/agent-farm start
# Test: Open dashboard in browser
# Test: afx annotate codev/specs/0032-consolidate-templates.md
```

## File Summary

### Files Moved
- `codev/templates/dashboard-split.html` → `agent-farm/templates/`
- `codev/templates/dashboard.html` → `agent-farm/templates/`
- `codev/templates/annotate.html` → `agent-farm/templates/`

### Files Modified
- `agent-farm/src/servers/dashboard-server.ts`
- `agent-farm/src/servers/annotate-server.ts`

### Directories Removed
- `codev/templates/`
- `codev-skeleton/templates/`

## Verification Checklist

- [ ] `npm run build` passes in agent-farm
- [ ] Dashboard loads at http://localhost:4200
- [ ] Annotation viewer works (`afx annotate <file>`)
- [ ] No 404 errors in browser console
- [ ] `codev/templates/` no longer exists
- [ ] `codev-skeleton/templates/` no longer exists
