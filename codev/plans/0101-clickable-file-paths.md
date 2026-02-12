# Plan: Clickable File Paths in Terminal

## Metadata
- **Specification**: `codev/specs/0101-clickable-file-paths.md`
- **Created**: 2026-02-12

## Executive Summary

Wire the existing `FILE_PATH_REGEX` / `parseFilePath` utilities into xterm.js via a custom `ILinkProvider`, add dotted underline decoration, pass `terminalId` through the click→API chain for cwd-relative resolution, and add path containment validation on the server. Most infrastructure already exists — this is a wiring + decoration task.

## Success Metrics
- [ ] All specification success criteria met
- [ ] Unit tests for regex, parsing, path resolution, containment
- [ ] E2E tests for click-to-open flow
- [ ] No regression on existing URL link behavior
- [ ] File paths in builder terminals resolve to correct worktree

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "phase_1", "title": "File Path Link Provider"},
    {"id": "phase_2", "title": "Server-Side Path Resolution"},
    {"id": "phase_3", "title": "Dashboard Integration & Styling"},
    {"id": "phase_4", "title": "Tests"}
  ]
}
```

## Phase Breakdown

### Phase 1: File Path Link Provider
**Dependencies**: None

#### Objectives
- Create a custom `ILinkProvider` implementation that detects file paths in terminal buffer lines using `FILE_PATH_REGEX`
- Return `ILink` objects with dotted underline decoration and Cmd/Ctrl+Click activation

#### Deliverables
- [ ] New file `packages/codev/dashboard/src/lib/filePathLinkProvider.ts`
- [ ] `FilePathLinkProvider` class implementing xterm.js `ILinkProvider`
- [ ] Modifier key detection (Cmd on macOS, Ctrl on others) in `activate` callback
- [ ] Regex `/g` flag handling (reset `lastIndex` per `provideLinks` call)

#### Implementation Details

**File**: `packages/codev/dashboard/src/lib/filePathLinkProvider.ts`

```typescript
import type { IBufferLine, ILink, ILinkProvider, Terminal } from '@xterm/xterm';
import { FILE_PATH_REGEX, parseFilePath, looksLikeFilePath } from './filePaths.js';

type FileOpenCallback = (path: string, line?: number, column?: number, terminalId?: string) => void;

export class FilePathLinkProvider implements ILinkProvider {
  constructor(
    private onFileOpen: FileOpenCallback,
    private terminalId?: string,
  ) {}

  provideLinks(lineNumber: number, callback: (links: ILink[] | undefined) => void): void {
    // Create fresh regex to avoid /g lastIndex issues
    const regex = new RegExp(FILE_PATH_REGEX.source, FILE_PATH_REGEX.flags);
    // Get line text from the terminal buffer (passed by xterm.js)
    // Note: provideLinks receives the y-coordinate; the Terminal instance
    // is accessed via closure when registering the provider
    // ... match regex against line text, build ILink array
  }
}
```

Key decisions:
- Create a new `RegExp` from `FILE_PATH_REGEX.source` + `.flags` each call to avoid `/g` stateful `lastIndex`
- `looksLikeFilePath()` filters false positives before creating links
- `ILink.decorations` sets `{ pointerCursor: true, underline: true }` — we'll use CSS to make it dotted
- `ILink.activate` checks `event.metaKey || event.ctrlKey` before calling `onFileOpen`

#### Acceptance Criteria
- [ ] `FilePathLinkProvider` detects all pattern types from spec's pattern table
- [ ] Modifier key check prevents activation on plain click
- [ ] No interference with existing `WebLinksAddon` URL detection
- [ ] Regex `/g` flag is handled correctly (no alternating match/miss)

#### Risks
- **Risk**: `ILink.activate` may not receive `MouseEvent` in xterm.js 5.5.0
  - **Mitigation**: Check API signature; if no event, use global keydown/keyup listener to track modifier state

---

### Phase 2: Server-Side Path Resolution
**Dependencies**: None (can be done in parallel with Phase 1)

#### Objectives
- Update `POST /api/tabs/file` to accept `terminalId` for cwd-relative path resolution
- Add `fs.realpathSync` + fallback for symlink-safe containment checking

#### Deliverables
- [ ] Updated `tower-server.ts` file tab endpoint
- [ ] Terminal session cwd lookup via `getTerminalManager().getSession(terminalId)`
- [ ] `realpathSync` with fallback to `path.resolve` for non-existent files
- [ ] Warning log on missing terminal session fallback

#### Implementation Details

**File**: `packages/codev/src/agent-farm/servers/tower-server.ts` (lines ~2492-2556)

Changes to `POST /api/tabs/file` handler:

1. Extract `terminalId` from request body alongside `path` and `line`
2. If `terminalId` is provided and `path` is relative (`!path.isAbsolute(filePath)`):
   - Look up session: `const session = getTerminalManager().getSession(terminalId)`
   - If session found: `fullPath = path.join(session.config.cwd, filePath)`
   - If session NOT found: log warning, fall back to `path.join(projectPath, filePath)`
3. Replace existing containment check with symlink-aware version:
   ```typescript
   let resolvedPath: string;
   try {
     resolvedPath = fs.realpathSync(fullPath);
   } catch {
     resolvedPath = path.resolve(fullPath);
   }
   const normalizedProject = path.resolve(projectPath);
   // Allow paths within project root OR within .builders/ worktrees
   if (!resolvedPath.startsWith(normalizedProject + path.sep) && resolvedPath !== normalizedProject) {
     res.writeHead(403, ...);
     return;
   }
   ```

#### Acceptance Criteria
- [ ] `terminalId` + relative path resolves correctly using terminal's cwd
- [ ] Missing terminal session falls back to project root with warning log
- [ ] Symlink resolution via `realpathSync` works for existing files
- [ ] Non-existent files fall back to `path.resolve` (no crash)
- [ ] Path traversal (`../../.ssh/id_rsa`) returns 403

#### Risks
- **Risk**: `session.config` is private (not on `PtySessionInfo`)
  - **Mitigation**: Tower has direct access to `PtySession` objects (not just `PtySessionInfo`), so `session.config.cwd` is accessible

---

### Phase 3: Dashboard Integration & Styling
**Dependencies**: Phase 1, Phase 2

#### Objectives
- Wire `FilePathLinkProvider` into `Terminal.tsx`
- Pass `terminalId` through `onFileOpen` → `createFileTab` → Tower API
- Add CSS for dotted underline decoration

#### Deliverables
- [ ] Updated `Terminal.tsx` — register `FilePathLinkProvider` alongside `WebLinksAddon`
- [ ] Updated `Terminal.tsx` — extract `terminalId` from `wsPath` prop
- [ ] Updated `TerminalProps` interface — add `terminalId` prop or extract from `wsPath`
- [ ] Updated `App.tsx` — pass `terminalId` to `handleFileOpen`
- [ ] Updated `api.ts` — `createFileTab` accepts and sends `terminalId`
- [ ] CSS for `.xterm-file-link` dotted underline decoration

#### Implementation Details

**File**: `packages/codev/dashboard/src/components/Terminal.tsx`

1. Import `FilePathLinkProvider`
2. Extract `terminalId` from `wsPath` (e.g., `/ws/terminal/<id>` → `<id>`)
3. After creating the xterm instance, register the link provider:
   ```typescript
   const filePathProvider = new FilePathLinkProvider(
     (filePath, line, column, terminalId) => {
       onFileOpen?.(filePath, line, column, terminalId);
     },
     terminalId,
   );
   term.registerLinkProvider(filePathProvider);
   ```
4. The existing `WebLinksAddon` stays unchanged for URL handling

**File**: `packages/codev/dashboard/src/components/App.tsx`

1. Update `handleFileOpen` to accept and forward `terminalId`:
   ```typescript
   const handleFileOpen = useCallback(async (
     path: string, line?: number, _column?: number, terminalId?: string
   ) => {
     const result = await createFileTab(path, line, terminalId);
     ...
   }, [refresh]);
   ```

**File**: `packages/codev/dashboard/src/lib/api.ts`

1. Update `createFileTab` signature:
   ```typescript
   export async function createFileTab(
     filePath: string, line?: number, terminalId?: string
   ): Promise<{ id: string; existing: boolean; line?: number }>
   ```
2. Include `terminalId` in request body: `JSON.stringify({ path: filePath, line, terminalId })`

**File**: `packages/codev/dashboard/src/index.css` (or equivalent)

Add xterm link provider CSS:
```css
/* File path links in terminal - dotted underline distinct from URL solid underline */
.xterm .xterm-screen .xterm-decoration-overview-ruler {
  /* No changes needed - decoration handled by ILink.decorations */
}
```

Note: xterm.js `ILink.decorations` controls underline and pointer cursor natively. The "dotted" distinction may need to be achieved via the `ILinkDecorations` API if supported, or via CSS targeting the xterm decoration elements.

#### Acceptance Criteria
- [ ] File paths in terminal output show dotted underline
- [ ] Cmd+Click opens file in viewer
- [ ] Plain click does not trigger file open
- [ ] URLs still open in new browser tab (WebLinksAddon unchanged)
- [ ] `terminalId` is passed through the full chain to the Tower API
- [ ] Builder terminal paths resolve relative to builder's worktree cwd

#### Risks
- **Risk**: xterm.js `ILink.decorations` may not support dotted vs solid distinction
  - **Mitigation**: If not, use CSS override on the xterm decoration container elements. The link provider adds a CSS class that can be targeted.

---

### Phase 4: Tests
**Dependencies**: Phase 1, Phase 2, Phase 3

#### Objectives
- Write comprehensive unit tests for all new and modified code
- Write E2E tests for the click-to-open flow

#### Deliverables
- [ ] Unit tests: `packages/codev/tests/unit/file-path-link-provider.test.ts`
- [ ] Unit tests: `packages/codev/tests/unit/file-tab-resolution.test.ts`
- [ ] E2E tests: `packages/codev/tests/e2e/clickable-file-paths.spec.ts`

#### Implementation Details

**Unit Tests**: `file-path-link-provider.test.ts`
- Test `FILE_PATH_REGEX` against all pattern types from spec (match and reject)
- Test `parseFilePath` extraction (colon format, parenthesis format, bare path)
- Test `looksLikeFilePath` filtering (URLs, domains → reject; valid paths → accept)
- Test multiple paths in one line produce multiple links
- Test regex `/g` flag doesn't cause alternating matches

**Unit Tests**: `file-tab-resolution.test.ts`
- Test path containment: within project → allowed; escaping → 403
- Test `terminalId` resolution: relative path + terminal cwd → correct absolute path
- Test `terminalId` fallback: missing session → project root resolution
- Test `realpathSync` failure: non-existent file → `path.resolve` fallback

**E2E Tests**: `clickable-file-paths.spec.ts`
- Test basic file path Cmd+Click opens file viewer
- Test path with line number scrolls to line
- Test URL still works (opens in new tab)
- Test plain click does not open file

#### Acceptance Criteria
- [ ] All unit tests pass
- [ ] All E2E tests pass
- [ ] Existing tests not broken
- [ ] Coverage for all spec test scenarios 1-19

#### Risks
- **Risk**: E2E tests need a running Tower + terminal to test click behavior
  - **Mitigation**: Use existing Playwright test infrastructure that starts a dev server

---

## Dependency Map
```
Phase 1 (Link Provider) ──┐
                           ├──→ Phase 3 (Integration) ──→ Phase 4 (Tests)
Phase 2 (Server)  ─────────┘
```

Phases 1 and 2 can be implemented in parallel.

## Risk Analysis

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| `ILink.activate` doesn't receive MouseEvent | Low | Medium | Track modifier key state globally via keydown/keyup |
| `ILink.decorations` doesn't support dotted underline | Medium | Low | Use CSS override on xterm decoration elements |
| `session.config.cwd` not accessible from tower-server | Low | Medium | PtySession is directly accessible (not just PtySessionInfo) |
| Regex false positives in terminal output | Low | Low | `looksLikeFilePath()` filter already handles common cases |

## Validation Checkpoints
1. **After Phase 1**: File paths are detected in terminal buffer lines (verify with console.log in `provideLinks`)
2. **After Phase 2**: `curl` test: POST to `/api/tabs/file` with `terminalId` resolves correctly
3. **After Phase 3**: End-to-end: type a file path in terminal, Cmd+Click opens viewer
4. **After Phase 4**: All tests green, no regressions

## Notes
- The existing `WebLinksAddon` handler in `Terminal.tsx` (lines 82-99) checks `looksLikeFilePath` but is never triggered for file paths. After this implementation, that handler continues to handle URLs only. The new `FilePathLinkProvider` handles file paths separately.
- The `Terminal` component's `onFileOpen` callback signature changes to include `terminalId` — this is a backward-compatible addition (optional parameter).
