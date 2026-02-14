# Plan: Rename Shepherd to Shellper

## Metadata
- **ID**: plan-2026-02-14-rename-shepherd-to-shellper
- **Status**: draft
- **Specification**: codev/specs/0106-rename-shepherd-to-shellper.md
- **Created**: 2026-02-14

## Executive Summary

Pure mechanical rename refactoring. Two phases: (1) rename all source files, update code references, update schema, and write SQLite migration — all atomically so the build never breaks, (2) update living documentation. Code and schema changes must be in the same phase because `tower-server.ts` and test files reference DB column names directly.

## Success Metrics
- [ ] `grep -ri shepherd packages/codev/` returns zero hits (excluding old migration code in `db/index.ts`, `dist/`, and dashboard build artifacts)
- [ ] All existing tests pass with new names
- [ ] `npm run build` succeeds
- [ ] SQLite migration (v8) handles column rename and value update
- [ ] Living documentation updated

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "phase_1", "title": "Rename All Source, Tests, Schema, and Migration"},
    {"id": "phase_2", "title": "Documentation Updates"}
  ]
}
```

## Phase Breakdown

### Phase 1: Rename All Source, Tests, Schema, and Migration
**Dependencies**: None

#### Objectives
- Rename all 5 source files and 4 test files from `shepherd-*` to `shellper-*`
- Update all class, interface, method, and variable names across all source and test files
- Update all import paths
- Update GLOBAL_SCHEMA column names
- Write migration v8 using table-rebuild pattern
- Update all code comments referencing shepherd
- Result: build succeeds and all tests pass

**Why merged**: Code in `tower-server.ts`, `terminal-sessions.test.ts`, and `schema.ts` references DB column names (`shepherd_socket`, etc.). If source is renamed before schema is updated, the build/tests will fail. These must change atomically.

#### Deliverables
- [ ] 5 source files renamed via `git mv`
- [ ] 4 test files renamed via `git mv`
- [ ] All class/interface renames applied (ShepherdProcess → ShellperProcess, etc.)
- [ ] All method renames applied (attachShepherd → attachShellper, etc.)
- [ ] All variable/property renames applied (~15 variables)
- [ ] All import paths updated
- [ ] Socket path pattern updated (`shepherd-*.sock` → `shellper-*.sock`)
- [ ] `schema.ts` GLOBAL_SCHEMA updated with `shellper_*` columns
- [ ] Migration v8 added to `db/index.ts`
- [ ] Dashboard component comments updated (`App.tsx`, `Terminal.tsx`)
- [ ] All other code comments updated
- [ ] Build succeeds (`npm run build`)
- [ ] All tests pass (`npm test` from `packages/codev/`)

#### Implementation Details

**Step 1: File renames** (source, `packages/codev/src/terminal/`):
- `shepherd-protocol.ts` → `shellper-protocol.ts`
- `shepherd-process.ts` → `shellper-process.ts`
- `shepherd-client.ts` → `shellper-client.ts`
- `shepherd-main.ts` → `shellper-main.ts`
- `shepherd-replay-buffer.ts` → `shellper-replay-buffer.ts`

**Step 2: Test file renames** (`packages/codev/src/terminal/__tests__/`):
- `shepherd-protocol.test.ts` → `shellper-protocol.test.ts`
- `shepherd-process.test.ts` → `shellper-process.test.ts`
- `shepherd-client.test.ts` → `shellper-client.test.ts`
- `tower-shepherd-integration.test.ts` → `tower-shellper-integration.test.ts`

**Step 3: Content updates in renamed files** — update all class names, exports, variable names, and comments within the 9 renamed files.

**Step 4: Content updates in non-renamed source files:**
- `terminal/pty-session.ts` (~55 refs) — methods, variables, comments, imports
- `terminal/session-manager.ts` (~41 refs) — variable names, imports, socket path pattern
- `terminal/pty-manager.ts` (~5 refs) — method call, comments
- `agent-farm/servers/tower-server.ts` (~17 refs) — variables, DB column refs, comments
- `agent-farm/servers/tower-terminals.ts` (~55 refs) — terminal session management, shepherd refs
- `agent-farm/servers/tower-routes.ts` (~37 refs) — route handlers with shepherd refs
- `agent-farm/servers/tower-instances.ts` (~34 refs) — instance management with shepherd refs
- `agent-farm/servers/tower-types.ts` (~4 refs) — type definitions with shepherd refs
- `agent-farm/commands/spawn-worktree.ts` (~1 ref) — comment
- `agent-farm/utils/shell.ts` (~1 ref) — comment

**Note on 0105 decomposition**: The original `tower-server.ts` (~114 refs) was decomposed by Spec 0105 into `tower-server.ts` (~17), `tower-terminals.ts` (~55), `tower-routes.ts` (~37), `tower-instances.ts` (~34), and `tower-types.ts` (~4). Similarly, `spawn.ts` shepherd refs moved to `spawn-worktree.ts`.

**Note**: `agent-farm/db/index.ts` is intentionally NOT updated in this step — its shepherd references are all in old migration code (v6, v7) which is historically correct and must remain as-is.

**Step 5: Schema update** (`agent-farm/db/schema.ts`):
- `shepherd_socket TEXT` → `shellper_socket TEXT`
- `shepherd_pid INTEGER` → `shellper_pid INTEGER`
- `shepherd_start_time INTEGER` → `shellper_start_time INTEGER`

**Step 6: Migration v8** (`agent-farm/db/index.ts`):
- Follow v7's table-rebuild pattern:
  1. CREATE `terminal_sessions_new` with `shellper_*` columns
  2. INSERT from old table mapping `shepherd_*` → `shellper_*`
  3. DROP old table, RENAME new table
  4. Recreate indexes
- UPDATE stored socket path values: `REPLACE(shellper_socket, 'shepherd-', 'shellper-')`
- Scan `~/.codev/run/` for `shepherd-*.sock`, rename to `shellper-*.sock` (skip files that can't be renamed)
- Wrap in try-catch consistent with existing migration pattern

**Step 7: Test file content updates:**
- `agent-farm/__tests__/terminal-sessions.test.ts` (~28 refs) — schema refs, test data, assertions
- `agent-farm/__tests__/tower-instances.test.ts` (~19 refs) — instance management test refs
- `agent-farm/__tests__/tower-routes.test.ts` (~2 refs) — route test refs
- `agent-farm/__tests__/tower-terminals.test.ts` (~6 refs) — terminal test refs
- `terminal/__tests__/session-manager.test.ts` (~128 refs) — variables, mock names, assertions
- All 4 renamed test files — update their internal references (including `shepherd-client.test.ts` with ~48 refs)

**Step 8: Dashboard component comments** (`packages/codev/dashboard/src/components/`):
- `App.tsx` — update Spec 0104 shepherd comment
- `Terminal.tsx` — update shepherd process comments

**Approach**: Use `git mv` for file renames. For content updates, use search-and-replace within each file. Process in the order above: renamed files first (they define exports), then consumers, then schema/migration, then tests.

#### Acceptance Criteria
- [ ] `grep -ri shepherd packages/codev/src/` returns zero hits (excluding `db/index.ts` old migration code)
- [ ] `grep -ri shepherd packages/codev/dashboard/src/` returns zero hits
- [ ] GLOBAL_SCHEMA uses `shellper_*` column names
- [ ] Migration v8 exists and follows table-rebuild pattern
- [ ] `npm run build` succeeds
- [ ] `npm test` passes (run from `packages/codev/`)

#### Test Plan
- **Unit Tests**: Existing tests renamed and updated — all must pass (`npm test` from `packages/codev/`)
- **Build**: `npm run build` compiles without errors
- **Grep**: Zero shepherd references in `packages/codev/src/` and `packages/codev/dashboard/src/` (excluding old migration code)

---

### Phase 2: Documentation Updates
**Dependencies**: Phase 1

#### Objectives
- Update all living documentation to use Shellper naming
- Leave historical documents (0104 specs/plans/reviews) unchanged

#### Deliverables
- [ ] `codev/resources/arch.md` updated (~80 lines with references)
- [ ] `codev-skeleton/resources/commands/agent-farm.md` updated (~2 refs)
- [ ] `codev-skeleton/protocols/maintain/protocol.md` updated (~3 refs)
- [ ] `README.md` updated (~1 ref)
- [ ] `INSTALL.md` updated (~1 ref)
- [ ] `MIGRATION-1.0.md` updated (~1 ref)

#### Implementation Details

**Files to update:**
- `codev/resources/arch.md` — glossary entry, architecture sections, debugging commands, terminal system documentation
- `codev-skeleton/resources/commands/agent-farm.md` — command references
- `codev-skeleton/protocols/maintain/protocol.md` — protocol references
- `README.md`, `INSTALL.md`, `MIGRATION-1.0.md` — brief references

**Files NOT updated** (historical records):
- `codev/specs/0104-custom-session-manager.md`
- `codev/plans/0104-custom-session-manager.md`
- `codev/reviews/0104-custom-session-manager.md`
- `codev/projects/0104-*/` artifacts
- `codev/projectlist.md` (0104 entry)
- `codev/specs/0105-tower-server-decomposition.md` (historical reference)
- `codev/plans/0105-tower-server-decomposition.md` (historical reference)
- `codev/reviews/0105-tower-server-decomposition.md` (historical reference)

#### Acceptance Criteria
- [ ] `grep -ri shepherd` in living docs returns zero hits
- [ ] Historical docs unchanged
- [ ] Build still succeeds

#### Test Plan
- **Manual**: Grep living docs for shepherd references
- **Build**: `npm run build` still passes

---

## Dependency Map
```
Phase 1 (Source + Schema + Migration) ──→ Phase 2 (Docs)
```

## Risk Analysis
### Technical Risks
| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Missed shepherd reference in source | Low | Low | grep-based AC catches all |
| Import path typo breaks build | Low | Low | Build check after phase |
| Migration v8 conflicts with existing data | Low | Medium | Table-rebuild pattern proven in v7 |
| Dashboard refs missed | Low | Low | Separate grep AC for dashboard/ |

## Validation Checkpoints
1. **After Phase 1**: grep clean across `packages/codev/src/` and `packages/codev/dashboard/src/`, build passes, tests pass
2. **After Phase 2**: Docs updated, final grep across living docs

## Notes
- This is a mechanical rename with ~705 individual replacements across ~26 files
- The grep-based acceptance criterion is the safety net — if anything is missed, it will be caught
- Old migration code (v6, v7) in `db/index.ts` must retain shepherd references as they are historically correct
- Reference counts in the spec/plan are approximate — the grep AC is authoritative
