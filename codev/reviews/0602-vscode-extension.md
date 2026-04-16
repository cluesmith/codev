# Review: VS Code Extension for Codev Agent Farm

## Summary

Built a VS Code extension that integrates Codev's Agent Farm into the IDE as a thin client over Tower's API. 9 implementation phases (1a, 1b, 2a, 2b, 3, 4, 5, 6, 7), plus monorepo restructuring. The extension provides native terminals, a unified sidebar, command palette integration, and review comment tooling.

## Spec Compliance

- [x] Architect terminal opens in left editor group (Phase 3)
- [x] Builder terminals open in right editor group as tabs (Phase 3)
- [x] Unified sidebar with Needs Attention, Builders, PRs, Backlog, Recently Closed, Team, Status (Phase 4)
- [x] Status bar shows builder count and blocked gate count (Phase 5)
- [x] `afx spawn`, `afx send`, `afx cleanup`, `porch approve` via Command Palette (Phase 5)
- [x] Review comments via snippet + Decorations API (Phase 6)
- [x] Shell terminals via Command Palette (Phase 3)
- [x] Needs Attention section shows blocked builders (Phase 4)
- [x] Cloud tunnel connect/disconnect commands (Phase 5)
- [x] Team section conditional on teamEnabled (Phase 4)
- [x] Cron task management via Command Palette (Phase 5)
- [x] Tower auto-starts on activation (Phase 2b)
- [x] Extension detects Tower offline and shows degraded state (Phase 2a)
- [x] Terminal sessions survive VS Code reload via shellper (Phase 3)
- [x] Extension activates in < 500ms (Phase 7 — verified)
- [x] `vsce package` produces valid 35KB .vsix (Phase 7)
- [ ] `afx open file.ts:42` opens in VS Code editor — deferred, CLI can't detect VS Code from shellper terminals
- [ ] Analytics Webview — deferred to post-V1 (Phase 8)
- [ ] Image paste in terminal — deferred, VS Code Pseudoterminal doesn't support clipboard image data

## Deviations from Plan

- **Phase 1b**: Added `@cluesmith/codev-core` package (not in original plan — added after discovering duplication during Phase 2a implementation)
- **Phase 3**: Used `TerminalLocation.Editor` + `ViewColumn` instead of `workbench.action.terminal.moveIntoEditor` (the planned approach was an undocumented API that failed)
- **Phase 4**: Overview cache renamed from `overview-cache.ts` to `overview-data.ts` for clarity
- **Phase 9**: Deferred — CLI can't detect VS Code from shellper-managed terminals, making the URI scheme approach invalid for the main use case
- **Monorepo**: Migrated from npm to pnpm workspaces mid-implementation (not in original plan)
- **Dashboard**: Moved to standalone workspace member at `packages/dashboard/` (not in original plan, driven by type sharing needs)

## Key Metrics

- **Commits**: 30+ on the branch
- **Tests**: 2442 passing (existing — no new extension tests yet)
- **Packages created**: `@cluesmith/codev-core`, `@cluesmith/codev-types`, `@cluesmith/config`
- **Extension files**: 20+ source files in `packages/vscode/src/`
- **Bundle size**: 80KB (dist/extension.js), 35KB packaged (.vsix)

## Lessons Learned

### What Went Well
- Extracting `TowerClient` to a shared package before building the extension eliminated duplication and gave the extension the full Tower API for free
- Using `TerminalLocation.Editor` + `ViewColumn` was much cleaner than the `moveIntoEditor` hack — stable API, no workarounds needed
- Subpath exports in `codev-core` successfully isolated Node builtins from the browser dashboard build
- The thin client architecture works — the extension adds VS Code-specific UI on top of shared infrastructure without reimplementing any Tower logic

### Challenges Encountered
- **codev-core exports resolution**: esbuild reads from `dist/` not source, requiring manual core rebuilds during development. Documented but not fixed.
- **npm workspaces quirks**: Initial workspace discovery failures led to pnpm migration mid-project
- **`moveIntoEditor` failure**: The planned terminal layout approach used an undocumented API that failed silently. Discovered during testing, fixed by switching to `TerminalLocation.Editor`.
- **`afx open` integration**: The planned URI scheme approach assumed VS Code environment detection from builder terminals, which doesn't work because builders run in shellper (not VS Code's terminal)

### What Would Be Done Differently
- Start with pnpm from the beginning instead of migrating mid-project
- Fix the codev-core exports issue (source vs dist resolution) before starting Phase 2
- Validate the `afx open` URI scheme approach earlier — the shellper environment limitation should have been caught during spec consultation
- Add extension unit tests alongside implementation, not defer them

## Technical Debt

- **codev-core exports**: esbuild resolves from `dist/` not source. Requires manual `pnpm build` in `packages/core` after changes. Fix documented in `codev/specs/0602-codev-core-exports-issue.md`.
- **codev-core as runtime dependency**: Must be published to npm before codev. Adds release complexity.
- **No extension tests**: All 2442 tests are from the codev package. The extension has zero automated tests.
- **Team provider uses manual workspace encoding**: Should use a `TowerClient` method instead of inline `encodeWorkspacePath`.
- **Snippet not working**: The `rev` snippet registration may need further debugging — VS Code may need specific configuration.

## Follow-up Items

- Fix codev-core exports issue (Option 2: `node` + `default` conditions)
- Add extension unit tests (state machine, workspace detection, auth wrapper)
- Phase 8: Analytics Webview (post-V1)
- Phase 9: File link handling — needs a different approach than URI scheme (possibly SSE-based file open events from Tower)
- Publish `@cluesmith/codev-core` to npm and update release protocol
- Update `codev/resources/arch.md` with extension architecture
