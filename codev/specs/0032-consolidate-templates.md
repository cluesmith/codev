# Specification: Consolidate Templates into agent-farm

## Metadata
- **ID**: 0032
- **Protocol**: TICK
- **Status**: specified
- **Created**: 2025-12-05
- **Priority**: medium

## Problem Statement

Templates are inconsistently located across the codebase:

| Server | Current Location | Expected Location |
|--------|------------------|-------------------|
| Tower | `agent-farm/templates/tower.html` | `agent-farm/templates/` (correct) |
| Dashboard | `codev/templates/dashboard-split.html` | Should be in agent-farm |
| Annotate | `codev/templates/annotate.html` | Should be in agent-farm |

This causes:
1. **Duplication**: `codev/templates/` and `codev-skeleton/templates/` must stay in sync
2. **Confusion**: Unclear which templates to edit when making changes
3. **Coupling**: agent-farm depends on project directory structure instead of being self-contained

## Current State

```
agent-farm/
  templates/
    tower.html          # Global tower dashboard (correct)
  src/servers/
    tower-server.ts     # Loads from agent-farm/templates/ (correct)
    dashboard-server.ts # Loads from codev/templates/ (wrong)
    annotate-server.ts  # Loads from codev/templates/ (wrong)

codev/templates/        # OUR project's templates
  dashboard-split.html
  dashboard.html
  annotate.html

codev-skeleton/templates/  # Template for OTHER projects (duplicate)
  dashboard-split.html
  dashboard.html
  annotate.html
```

## Desired State

```
agent-farm/
  templates/
    tower.html
    dashboard-split.html  # Moved from codev/
    dashboard.html        # Moved from codev/
    annotate.html         # Moved from codev/
  src/servers/
    tower-server.ts       # Already correct
    dashboard-server.ts   # Updated to load from agent-farm/templates/
    annotate-server.ts    # Updated to load from agent-farm/templates/

codev/templates/           # REMOVED (no longer needed)
codev-skeleton/templates/  # REMOVED (no longer needed)
```

## Success Criteria

- [ ] All templates in `agent-farm/templates/`
- [ ] Dashboard server loads from `agent-farm/templates/`
- [ ] Annotate server loads from `agent-farm/templates/`
- [ ] `codev/templates/` directory removed
- [ ] `codev-skeleton/templates/` directory removed
- [ ] Dashboard still works after change (`afx start`, refresh browser)
- [ ] Annotation viewer still works (`afx annotate <file>`)
- [ ] Build succeeds (`npm run build` in agent-farm)

## Technical Approach

### 1. Move Templates

```bash
# Move templates to agent-farm
mv codev/templates/dashboard-split.html agent-farm/templates/
mv codev/templates/dashboard.html agent-farm/templates/
mv codev/templates/annotate.html agent-farm/templates/

# Remove duplicate directories
rm -rf codev/templates/
rm -rf codev-skeleton/templates/
```

### 2. Update dashboard-server.ts

Change from:
```typescript
const templatePath = path.join(projectRoot, 'codev/templates/dashboard-split.html');
```

To (following tower-server.ts pattern):
```typescript
function findTemplatePath(): string {
  // 1. Try relative to compiled output (dist/servers/ -> templates/)
  const pkgPath = path.resolve(__dirname, '../templates/dashboard-split.html');
  if (fs.existsSync(pkgPath)) return pkgPath;

  // 2. Try relative to source (src/servers/ -> templates/)
  const devPath = path.resolve(__dirname, '../../templates/dashboard-split.html');
  if (fs.existsSync(devPath)) return devPath;

  throw new Error('Dashboard template not found');
}
```

### 3. Update annotate-server.ts

Same pattern as dashboard-server.ts.

## Out of Scope

- Template customization per project (can be added later if needed)
- Moving roles/ or other codev/ directories

## Risks

| Risk | Mitigation |
|------|------------|
| Breaking existing projects | This is the codev source repo; other projects don't have agent-farm locally |
| Template path not found | Use same fallback pattern as tower-server.ts |

## Testing

1. `npm run build` in agent-farm
2. `afx start` - dashboard should load
3. `afx annotate codev/specs/0032-consolidate-templates.md` - should open file
4. Verify no 404 errors in browser console
