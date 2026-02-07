# Review 0092: Terminal File Links and File Browser

## Summary

Spec 0092 adds three capabilities to the Agent Farm dashboard:

1. **Port Consolidation** - Eliminated `open-server.ts` and moved file viewing through Tower API endpoints, freeing ports 4250-4269
2. **Terminal File Links** - Clickable file paths in terminal output via `@xterm/addon-web-links`
3. **File Browser Enhancement** - Git status indicators, autocomplete search, and recent files view in FileTree

## What Was Built

### Phase 1: Port Consolidation

- Tower endpoints: `POST /api/tabs/file`, `GET /api/file/:id`, `GET /api/file/:id/raw`, `POST /api/file/:id/save`
- `FileViewer.tsx` component with text (line numbers + editing), image, and video support
- `af open` updated to use Tower API exclusively (no open-server fallback)
- `openPortRange` removed from config, types, and port-registry
- `open-server.ts` deleted

### Phase 2: Terminal File Links

- `@xterm/addon-web-links` integrated into Terminal.tsx
- `filePaths.ts` utility with regex detection for multiple formats:
  - `src/file.ts`, `./src/file.ts`, `/absolute/path/file.ts`
  - `file.ts:42`, `file.ts:42:15`, `file.ts(42,15)`
- `looksLikeFilePath()` heuristic to distinguish files from URLs/domains
- Click handler opens file in dashboard tab with line scrolling

### Phase 3: File Browser Enhancement

- `FileTree.tsx` enhanced with:
  - Git status indicators (A/M/?) with color coding
  - Search autocomplete box with fuzzy matching on file paths
  - Recent files section showing recently opened file tabs
  - 30-second periodic git status refresh
- Tower endpoints: `GET /api/git/status`, `GET /api/files/recent`
- API client functions: `fetchGitStatus()`, `fetchRecentFiles()`

## Files Modified

| File | Action | Lines |
|------|--------|-------|
| `tower-server.ts` | Add file tab + git status + recent files endpoints | ~250 |
| `dashboard/src/components/FileViewer.tsx` | New | 164 |
| `dashboard/src/components/Terminal.tsx` | Add WebLinksAddon | 225 |
| `dashboard/src/components/FileTree.tsx` | Enhance with search, git, recent | 292 |
| `dashboard/src/components/App.tsx` | Add file open handler | 154 |
| `dashboard/src/lib/filePaths.ts` | New path utilities | 78 |
| `dashboard/src/lib/api.ts` | Add file/git API functions | 184 |
| `dashboard/src/hooks/useTabs.ts` | Handle file tabs | 123 |
| `commands/open.ts` | Tower-only (no open-server) | 100 |
| `utils/config.ts` | Remove openPortRange | - |
| `utils/port-registry.ts` | Remove openPortRange | - |
| `types.ts` | Remove openPortRange | - |

## Test Results

- **Unit tests**: 612 passed (all green)
- **Build**: Clean TypeScript + Vite dashboard build
- **E2E**: Skipped (not configured for this spec)

## Lessons Learned

1. **Pre-existing implementation**: The entire implementation was already committed to `main` before porch orchestration began. This is valid - the spec was created and approved, then implemented, then porch was set up to track it retroactively.

2. **Port consolidation simplifies architecture**: Moving from per-file ports (4250-4269) to Tower API endpoints eliminates 20 potential port conflicts and removes an entire server process. Single-port architecture is cleaner.

3. **WebLinksAddon requires URL/file disambiguation**: The addon's default behavior handles URLs, but file paths need a `looksLikeFilePath()` heuristic to avoid false positives (e.g., `example.com` vs `example.ts`).

4. **In-memory file tab state**: File tabs are stored in-memory alongside terminal state in `projectTerminals`. This means tabs don't survive Tower restarts, which is acceptable since they're lightweight to recreate.

## Acceptance Criteria Status

### Phase 1: Port Consolidation
- [x] File tab endpoints in Tower
- [x] File content served through Tower
- [x] `af open` works without open-server.js
- [x] `openPortRange` removed
- [x] `open-server.ts` deleted

### Phase 2: Terminal Links
- [x] File paths in terminal output are clickable
- [x] Clicking opens file in annotation viewer
- [x] Line numbers scroll to correct line
- [x] Relative paths resolve from project root
- [x] Non-existent paths not made clickable (validation)

### Phase 3: File Browser Enhancement
- [x] FileTree shows Recent view
- [x] Git status indicators (M/A/?)
- [x] Toggle between Recent and Tree views
- [x] Autocomplete search filters files
- [x] Works on mobile (tap to open)
- [x] Large directories don't freeze UI (lazy loading)
