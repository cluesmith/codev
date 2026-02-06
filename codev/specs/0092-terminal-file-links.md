# Spec 0092: Terminal File Links and File Browser

## Summary

Add clickable file path detection in terminal output using `@xterm/addon-web-links`, enhance `FileTree.tsx` with git status and search, and consolidate file annotation into Tower (eliminating per-file ports 4250-4269).

## Problem Statement

Currently, when file paths appear in terminal output (from `git status`, `rg`, compiler errors, etc.), users must manually copy-paste them to view the file. This is especially painful on mobile where copy-paste is cumbersome.

The existing `FileTree.tsx` component provides hierarchical browsing but lacks:
- A "recently modified" view for quick access to active files
- Git status integration (modified/staged/untracked indicators)

**Port Proliferation**: The current `af open` command spawns a separate `open-server.js` process on ports 4250-4269 for each file viewed. This violates the Tower Single Daemon architecture (Spec 0090) and creates complexity. File viewing should be served through the Tower like everything else.

## Requirements

### Terminal File Links

1. **Path Detection**: Use `@xterm/addon-web-links` with custom regex matchers
   - Absolute paths: `/Users/foo/project/src/file.ts`
   - Relative paths: `src/file.ts`, `./src/file.ts`
   - Paths with line numbers: `src/file.ts:42`, `src/file.ts:42:15`
   - Common output formats: `file.ts(42,15)`, `file.ts line 42`

2. **Path Resolution**: All relative paths resolve from project root
   - Absolute paths used as-is
   - Relative paths joined with project root
   - **Validation**: Verify file exists before making clickable; skip non-existent paths

3. **Click Handling**: Custom handler for `@xterm/addon-web-links`
   - Open in annotation viewer tab (same as `af open`)
   - If line number present, scroll to that line
   - If file already open, switch to that tab

4. **Visual Indication**: Handled by addon
   - Underline on hover (default addon behavior)
   - Cursor changes to pointer (default addon behavior)

### File Browser Enhancement

5. **Enhance FileTree.tsx**: Add view mode toggle
   - **Default**: Left sidebar, collapsed by default on mobile
   - **Toggle**: Button or keyboard shortcut (`Ctrl+B` / `Cmd+B`)
   - View modes: "Recent" | "Tree" (tab-style toggle at top)

6. **Recently Modified View** (new):
   - **Data source**: `git status --porcelain` only (not filesystem mtime scan)
   - **Default window**: Files from current git status (modified, staged, untracked)
   - **Sort**: Most recently modified first (by git status order)
   - **Display**: Relative time ("2m ago") if session tracking available, else just filename
   - **Limit**: Max 50 files to prevent UI slowdown

7. **Hierarchical View** (existing, enhance):
   - Existing tree view functionality preserved
   - **Add**: Git status indicators (M = modified, A = staged, ? = untracked)
   - **Default depth**: 3 levels expanded, deeper collapsed
   - **Exclusions**: `node_modules/`, `.git/`, `.builders/`, `dist/` collapsed by default

8. **Autocomplete Search**: Quick file finder
   - Search box at top of file browser
   - Fuzzy matching on file paths (like VS Code's Ctrl+P)
   - Results filtered as user types
   - Enter to open selected file

9. **File Actions**: Clicking a file
   - Opens in annotation viewer (existing behavior)
   - No right-click menu (keep simple, use terminal for path operations)

### Port Consolidation (Prerequisite)

10. **Implement `/api/tabs/file` in Tower**: Serve file content through Tower
    - `POST /project/:enc/api/tabs/file` - Create file tab, returns tab ID
    - `GET /project/:enc/api/file/:tabId` - Get file content
    - `POST /project/:enc/api/file/:tabId/save` - Save file changes
    - File tabs tracked in project state alongside terminal tabs

11. **Remove `open-server.ts`**: Eliminate separate file annotation servers
    - Delete `src/agent-farm/servers/open-server.ts`
    - Remove `openPortRange` from config (4250-4269 no longer needed)
    - Update `af open` to only use Tower API (no fallback)

12. **Dashboard File Viewer**: Render file content in dashboard tab
    - Reuse existing annotation viewer HTML/CSS from `templates/open.html`
    - Support text files, images, videos, 3D models (existing functionality)
    - Line number scrolling for text files

## Non-Requirements

- Full IDE-like file editing (we have the annotation viewer)
- File creation/deletion from browser (use terminal)
- Full-text content search (use terminal grep/rg; autocomplete is filename-only)
- Multi-file selection
- Filesystem mtime scanning (too slow for large projects)
- Per-file annotation servers on separate ports (being removed)

## Technical Approach

### Terminal Link Detection

Use `@xterm/addon-web-links` with custom `handler` callback:

```typescript
import { WebLinksAddon } from '@xterm/addon-web-links';

// Custom regex for file paths with optional line numbers
const filePathRegex = /(?:^|[\s"'`])([.\w/-]+\.[a-z]{1,10})(?::(\d+)(?::(\d+))?)?/gi;

const webLinksAddon = new WebLinksAddon(
  (event, uri, range) => {
    // uri contains the matched path
    // Parse line/column from uri if present
    const match = uri.match(/^(.+?)(?::(\d+)(?::(\d+))?)?$/);
    if (match) {
      const [, filePath, line, col] = match;
      openFileInViewer(filePath, parseInt(line) || 1, parseInt(col) || 1);
    }
  },
  {
    urlRegex: filePathRegex,
    // Validate path exists before making clickable
    validationCallback: async (uri, callback) => {
      const resolved = resolvePath(uri, projectRoot);
      const exists = await checkFileExists(resolved);
      callback(exists);
    }
  }
);

terminal.loadAddon(webLinksAddon);
```

### Path Resolution Strategy

```typescript
function resolvePath(path: string, projectRoot: string): string {
  if (path.startsWith('/')) {
    return path; // Absolute path, use as-is
  }
  return join(projectRoot, path);
}
```

### FileTree Enhancement

Modify existing `dashboard/src/components/FileTree.tsx`:

```typescript
// Add view mode state
const [viewMode, setViewMode] = useState<'recent' | 'tree'>('tree');

// Add git status fetching
const { data: gitStatus } = useQuery(['gitStatus', projectPath],
  () => fetchGitStatus(projectPath),
  { refetchInterval: 5000 } // Refresh every 5s
);

// Render view toggle
<div className="file-browser-header">
  <button onClick={() => setViewMode('recent')}
          className={viewMode === 'recent' ? 'active' : ''}>
    Recent
  </button>
  <button onClick={() => setViewMode('tree')}
          className={viewMode === 'tree' ? 'active' : ''}>
    Tree
  </button>
</div>

{viewMode === 'recent' ? (
  <RecentFilesList files={gitStatus?.files || []} onOpen={handleFileOpen} />
) : (
  <FileTreeView ... gitStatus={gitStatus} />
)}
```

### Tower API Endpoints

**New endpoint for git status**:
```
GET /project/:enc/api/git/status
Response: {
  files: [
    { path: "src/server.ts", status: "M" },
    { path: "src/new-file.ts", status: "?" },
    { path: "src/staged.ts", status: "A" }
  ]
}
```

**Existing tree endpoint** (already exists via file annotation): Reuse or extend as needed.

### Error Handling

| Scenario | Behavior |
|----------|----------|
| Path doesn't exist | Don't make clickable (validation callback returns false) |
| Line number past EOF | Open file, scroll to last line |
| Git status fails | Fall back to tree view only, log warning |
| Large directory | Lazy-load children on expand, limit to 1000 entries per directory |
| Permission denied | Show toast error, log details |

### Security Considerations

1. **Path traversal**: Sanitize paths, reject `../` sequences that escape project root
2. **Symlink following**: Resolve symlinks, reject if target outside project
3. **File size limits**: Don't open files > 10MB in annotation viewer
4. **Rate limiting**: Git status endpoint uses existing Tower rate limits

## User Experience

### Terminal Interaction
```
$ git status
On branch main
Changes not staged for commit:
  modified:   src/server.ts      <- underlined, clickable, opens file
  modified:   src/utils/auth.ts  <- underlined, clickable, opens file

$ rg "TODO"
src/server.ts:42:  // TODO: add error handling  <- click opens at line 42
src/utils.ts:15:   // TODO: refactor            <- click opens at line 15
```

### File Browser (Enhanced FileTree)
```
[🔍 Search files...]               <- autocomplete search box
[Recent] [Tree]                    <- tab-style view toggle

Recent (from git status):
  M src/server.ts                  <- M = modified, click to open
  M src/utils/auth.ts
  ? src/new-feature.ts             <- ? = untracked
  A src/staged-file.ts             <- A = staged

Tree:
  v src/
      server.ts    M               <- M indicator from git status
    v utils/
        auth.ts    M
        helpers.ts
  > node_modules/                  <- collapsed by default
  v tests/
      server.test.ts
  package.json     M
```

## Acceptance Criteria

### Phase 1: Port Consolidation (Prerequisite)
1. [ ] `POST /project/:enc/api/tabs/file` creates file tab in Tower
2. [ ] File content served through Tower (no separate ports)
3. [ ] `af open` works without spawning open-server.js
4. [ ] `openPortRange` config removed (4250-4269 freed)
5. [ ] `open-server.ts` deleted

### Phase 2: Terminal Links
6. [ ] File paths in terminal output are clickable (via `@xterm/addon-web-links`)
7. [ ] Clicking path opens file in annotation viewer
8. [ ] Line numbers in paths scroll to correct line
9. [ ] Relative paths resolve from project root
10. [ ] Non-existent paths are not clickable

### Phase 3: File Browser Enhancement
11. [ ] FileTree shows "Recent" view with git status files
12. [ ] FileTree shows git status indicators (M/A/?) in tree view
13. [ ] Can toggle between Recent and Tree views
14. [ ] Autocomplete search box filters files as user types
15. [ ] Works on mobile (tap to open)
16. [ ] Large directories don't freeze UI (lazy loading)

## Testing Strategy

### Phase 1: Port Consolidation Tests
- `af open file.txt` creates tab via Tower API (no new process spawned)
- File tab displays content correctly (text, images, video)
- Multiple file tabs work simultaneously
- No processes listening on 4250-4269 range

### Phase 2: Terminal Link Tests
- Path regex matches expected formats (absolute, relative, with line numbers)
- Path resolution joins relative paths with project root
- Click file path in terminal output → file opens in viewer
- Click path with line number → scrolls to correct line

### Phase 3: File Browser Tests
- Git status parsing handles all status codes (M, A, ?, D, R, C, U)
- Fuzzy search filters file list correctly
- Toggle Recent/Tree view → correct files displayed
- Type in search box → filtered results appear
- Select search result → file opens

### Edge Case Tests
- Path that looks valid but doesn't exist → not clickable
- Line number past EOF → opens at last line
- Very long file list from git status → truncated to 50
- Unicode in file paths → handled correctly
- Empty search query → shows all files
- Large files (>10MB) → show warning, don't crash

## Dependencies

- Spec 0090 (Tower Single Daemon) - Tower API infrastructure
- Spec 0085 (Terminal Dashboard) - React dashboard foundation
- `@xterm/addon-web-links` - npm package (to be added)

## Files to Modify

### Phase 1: Port Consolidation
| File | Change |
|------|--------|
| `tower-server.ts` | Add `/api/tabs/file`, `/api/file/:id`, `/api/file/:id/save` endpoints |
| `dashboard/src/components/FileViewer.tsx` | New: file viewer component (port from open.html) |
| `dashboard/src/components/Dashboard.tsx` | Add file tab type alongside terminal tabs |
| `commands/open.ts` | Remove fallback to open-server.js |
| `servers/open-server.ts` | **DELETE** |
| `utils/config.ts` | Remove `openPortRange` |
| `utils/port-registry.ts` | Remove `openPortRange` |
| `types.ts` | Remove `openPortRange` from AgentFarmConfig |

### Phase 2: Terminal Links
| File | Change |
|------|--------|
| `dashboard/src/components/Terminal.tsx` | Load `@xterm/addon-web-links` with custom handler |
| `dashboard/src/lib/filePaths.ts` | New: path regex and parsing utilities |
| `dashboard/package.json` | Add `@xterm/addon-web-links` dependency |

### Phase 3: File Browser Enhancement
| File | Change |
|------|--------|
| `dashboard/src/components/FileTree.tsx` | Add view mode toggle, Recent view, git status indicators, search box |
| `dashboard/src/components/FileSearch.tsx` | New: autocomplete search component |
| `dashboard/src/hooks/useGitStatus.ts` | New: hook to fetch/cache git status |
| `tower-server.ts` | Add `GET /project/:enc/api/git/status` endpoint |
