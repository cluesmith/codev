# Review: Per-Project Port Registry Removal

## Summary

Removed the vestigial per-project port allocation system from the Codev codebase. Since Spec 0090 (Tower Single Daemon), the Tower at port 4100 is the only HTTP server — per-project port blocks (4200-4299, 4300-4399, etc.) were allocated in SQLite but nothing listened on them. This implementation deleted the entire port allocation infrastructure across 3 phases: fixing broken consumers, removing infrastructure, and updating tests.

**Net impact**: ~600 lines removed, broken `consult` command fixed, misleading port displays eliminated.

## Spec Compliance

- [x] `af consult` works (routes to Tower at 4100, not dead per-project port)
- [x] Builder role `{PORT}` resolves to 4100 (Tower port)
- [x] `port-registry.ts` deleted (220 lines)
- [x] No code references `dashboardPort`, `architectPort`, `builderPortRange`, or `utilPortRange`
- [x] All existing tests pass (594 tests, 43 test files)
- [x] `af status` no longer shows per-project port numbers

## Deviations from Plan

### Phase 2 absorbed Phase 3 work
Test updates were pulled into Phase 2 during consultation iterations rather than being deferred to Phase 3. This was practical — reviewers flagged test compilation issues (e.g., `types.test.ts` still referencing removed Config fields) that needed fixing alongside the infrastructure removal. Phase 3 became a verification-only pass confirming all test work was already complete.

### Additional fixes not in original plan
The 3-way consultation process surfaced several issues the plan didn't anticipate:

| Fix | Source | Description |
|-----|--------|-------------|
| Tower HTML stop/restart buttons | Codex iter 2 | `tower.html` still passed `basePort` to stop/restart functions; updated to use `projectPath` |
| SSH tunnel port conflict | Codex iter 3 | Remote `af dash start --remote` hardcoded local tunnel port to 4100, conflicting with local Tower; added `isPortAvailable()` auto-detection |
| `types.test.ts` compilation | Claude iter 1 | Config test fixture still had removed port fields; would break TypeScript compilation |
| Schema JSDoc staleness | Claude iter 1 | Global schema JSDoc still said "Stores port allocations"; updated to "Stores terminal sessions and migrations" |

### Project discovery replacement
The plan didn't explicitly call out the `getKnownProjectPaths()` replacement function in `tower-server.ts`. When `loadPortAllocations()` was removed, project discovery needed a new data source. The implementation combines `terminal_sessions` table (persistent) with `projectTerminals` in-memory cache (current session) to cover both sources.

## Lessons Learned

### What Went Well
- **Surgical removal pattern**: Each deletion was isolated — remove one thing, verify build, move on. This kept the blast radius small.
- **3-way consultation was highly effective**: Each reviewer caught different issues. Claude caught type-level compilation bugs, Codex caught UI template and SSH tunnel regressions, Gemini provided consistent overall assessment.
- **Migration chain preservation**: Making migration v2 a no-op (instead of deleting it) preserved the version numbering for existing installations. This was the right call.
- **`DEFAULT_TOWER_PORT` pattern consistency**: Using the same `const DEFAULT_TOWER_PORT = 4100;` pattern already established in `shell.ts`, `stop.ts`, etc. made the change feel natural to the codebase.

### Challenges Encountered
- **Hidden UI template dependency**: The `tower.html` template referenced `basePort` in button onclick handlers, which wasn't in the plan's file list. The template constructs JavaScript inline, making it harder to catch with simple grep for TypeScript imports.
- **SSH tunnel dual-port assumption**: The remote start feature assumed the same port on both ends of the SSH tunnel. After port registry removal, the local side needed to be flexible (any available port) while the remote side is always 4100.
- **Test fixtures with removed fields**: TypeScript compilation errors in test files weren't caught by the initial implementation because the plan separated "remove infrastructure" from "update tests" — but they're inherently coupled.

### What Would Be Done Differently
- **Combine Phase 2 and Phase 3 in the plan**: Splitting infrastructure removal and test updates into separate phases created unnecessary overhead. The test fixes were needed to make Phase 2 compile, so they should have been in the same phase.
- **Include template files in the plan's file list**: HTML templates with inline JavaScript are easy to miss when planning TypeScript-focused changes. A grep for the removed identifiers across all file types (not just `.ts`) during planning would have caught this.

### Methodology Improvements
- **3-way consultation iteration model works well for removal specs**: The "remove, review, fix what reviewers find" loop naturally surfaces cascading dependencies that a single-pass plan can miss.

## Technical Debt

- **`port: 0` in Tower API responses**: Five places in `tower-server.ts` hardcode `port: 0` to preserve the JSON API shape for backward compatibility. A future pass could remove the `port` field from the API response type entirely.
- **`arch.md` still documents old port registry**: The architecture document references the per-project port system. Should be updated in the next MAINTAIN cycle.

## Follow-up Items

- [ ] Update `codev/resources/arch.md` to remove port registry documentation (MAINTAIN task)
- [ ] Consider removing `port: 0` from Tower API response type in a future cleanup
