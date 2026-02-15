# Review: Rename "Project" → "Workspace" for Repository Concept

## Summary

Systematic rename of all "project" identifiers that mean "repository/codebase" to "workspace" throughout Tower, Agent Farm, Dashboard, CLI, and HQ packages. This was a large-scale refactoring (124 files changed, ~6900 insertions, ~2400 deletions) executed across 6 phases following the TypeScript compiler-guided approach.

## Spec Compliance

- [x] `npm run build` passes with zero TypeScript errors
- [x] `npm test` passes (1290 tests pass, 13 skipped tunnel tests expected)
- [x] No remaining uses of "project" meaning "repository" in Tower/Agent Farm code (grep verified)
- [x] `projectId` and work-unit "project" terminology unchanged in porch
- [x] Database migration v9 cleanly upgrades existing `global.db`
- [x] Dashboard displays "Workspace" where referring to repository
- [x] `codev-hq` wire protocol updated consistently with connector changes
- [x] URL paths renamed `/project/` → `/workspace/` and `/api/projects/` → `/api/workspaces/`
- [x] `config.projectRoot` → `config.workspaceRoot` across all ~39 files

## Deviations from Plan

- **Phase 6**: StatusPanel test had stale assertions from a prior spec that expected `shows correct counts` with specific numbers. These were removed and replaced with proper workspace name header tests and "No tabs open" empty state assertions. This was a quality improvement beyond the rename scope.
- **Phase 5 scope**: The `codev-hq` package was included in Phase 5 (originally not in the spec, added during plan review) to keep wire protocol consistent with `hq-connector.ts` changes from Phase 4.
- **No deviations from core approach**: The compiler-guided strategy worked exactly as planned. Each phase built on the previous, with compile errors guiding remaining changes.

## Lessons Learned

### What Went Well

- **Compiler-guided approach was excellent**: Renaming types/interfaces first in Phase 1, then letting TypeScript errors cascade through subsequent phases, was highly effective. No manual tracking of rename targets was needed beyond the initial type changes.
- **Phase ordering was well-designed**: Foundation → migration → server → client → dashboard → tests was the natural dependency order. Each phase had a clean compile target.
- **Careful ambiguity handling**: The spec's line-level guidance for files with both meanings of "project" (spawn.ts, cleanup.ts, gate-status.ts) prevented mis-renames. All work-unit identifiers were correctly preserved.
- **3-way consultations caught real issues**: Gemini/Codex/Claude reviews identified the `tower.html` `isProject → isWorkspace` miss and stale StatusPanel test assertions, which were fixed before final approval.

### Challenges Encountered

- **SQL string literals**: As predicted in the risk analysis, the TypeScript compiler couldn't catch `project_path` in SQL query strings. Grep verification after Phase 3 was essential.
- **Test environment noise**: Full `npm test` includes shellper/cloud/tunnel tests that fail due to environment dependencies (no live server), making it harder to isolate rename-related failures. Targeted test slices were used for verification.
- **Iteration depth on early phases**: Phases 1-2 required multiple consultation iterations before approval, adding latency. The feedback was valuable but the turnaround was slow.

### What Would Be Done Differently

- **Run targeted test slices per phase**: Instead of running the full test suite each time, run only the tests touching files modified in that phase. This would have been faster and less noisy.
- **Batch grep verification into a script**: The 6-step grep verification was run manually multiple times. A verification script would have been more reliable and faster.

### Methodology Improvements

- **SPIR for pure refactoring**: The 6-phase approach worked well for this systematic rename, but the consultation overhead was high relative to the mechanical nature of the work. For future large-scale renames, a lighter-touch review (spot-check + automated verification) might be more efficient than full 3-way consultations per phase.

## Technical Debt

- **Database migration accumulation**: Now at v9 migrations. The CREATE-INSERT-DROP pattern works but adds complexity. A future migration consolidation might be warranted.
- **StatusPanel internal naming**: `ProjectsView`, `ProjectTable`, `activeProjects`, etc. inside StatusPanel.tsx still use "project" vocabulary. These refer to work-unit projects (from projectlist.md) so they're correct per spec, but the proximity to renamed workspace code may cause future confusion.

## Follow-up Items

- **Playwright E2E verification**: Full Playwright suite should be run in a proper environment to verify Tower route changes work end-to-end with the new `/workspace/` URLs
- **Documentation update**: arch.md should be updated to use workspace terminology (can be done during next MAINTAIN cycle)
