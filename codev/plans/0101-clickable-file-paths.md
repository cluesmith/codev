# Plan: Clickable File Paths in Terminal

## Metadata
- **Specification**: `codev/specs/0101-clickable-file-paths.md`
- **Created**: 2026-02-12

## Executive Summary

Wire the existing `FILE_PATH_REGEX` / `parseFilePath` utilities into xterm.js via a custom `ILinkProvider`, add dotted underline decoration, pass `terminalId` through the click→API chain for cwd-relative resolution, and add path containment validation on the server. Most infrastructure already exists — this is a wiring + decoration task.

## Success Metrics
- [ ] All specification success criteria met
- [ ] Unit tests for regex, parsing, path resolution, containment
- [ ] E2E tests for click-to-open flow (including builder worktree scenario)
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
- Return `ILink` objects with decoration and platform-aware Cmd/Ctrl+Click activation
- Extract line/col directly from regex capture groups (not from link text via `parseFilePath`)

#### Deliverables
- [ ] New file `packages/codev/dashboard/src/lib/filePathLinkProvider.ts`
- [ ] `FilePathLinkProvider` class implementing xterm.js `ILinkProvider`
- [ ] Platform-aware modifier key detection (Cmd-only on macOS, Ctrl-only on others)
- [ ] Regex `/g` flag handling (reset `lastIndex` per `provideLinks` call)
- [ ] Line/col extracted from regex groups and passed via closure (not via `parseFilePath` on link text)

#### Implementation Details

**File**: `packages/codev/dashboard/src/lib/filePathLinkProvider.ts`

```typescript
import type { ILink, ILinkProvider, Terminal } from '@xterm/xterm';
import { FILE_PATH_REGEX, looksLikeFilePath } from './filePaths.js';

type FileOpenCallback = (path: string, line?: number, column?: number, terminalId?: string) => void;

const isMac = typeof navigator !== 'undefined' && navigator.platform.toUpperCase().includes('MAC');

export class FilePathLinkProvider implements ILinkProvider {
  constructor(
    private terminal: Terminal,
    private onFileOpen: FileOpenCallback,
    private terminalId?: string,
  ) {}

  provideLinks(lineNumber: number, callback: (links: ILink[] | undefined) => void): void {
    // Get line text from the terminal buffer
    const bufferLine = this.terminal.buffer.active.getLine(lineNumber - 1);
    if (!bufferLine) { callback(undefined); return; }
    const text = bufferLine.translateToString();

    // Create fresh regex to avoid /g lastIndex issues
    const regex = new RegExp(FILE_PATH_REGEX.source, FILE_PATH_REGEX.flags);
    const links: ILink[] = [];
    let match: RegExpExecArray | null;

    while ((match = regex.exec(text)) !== null) {
      const filePath = match[1]; // Group 1: file path (without line/col)
      if (!filePath || !looksLikeFilePath(filePath)) continue;

      // Extract line/col directly from regex groups:
      // Groups 2,3 = colon format (:line:col), Groups 4,5 = paren format (line,col)
      const line = match[2] ? parseInt(match[2], 10)
                 : match[4] ? parseInt(match[4], 10)
                 : undefined;
      const column = match[3] ? parseInt(match[3], 10)
                   : match[5] ? parseInt(match[5], 10)
                   : undefined;

      // Calculate link range: covers the full match (path + line/col suffix)
      // but excludes the leading delimiter character (space, quote, bracket, etc.)
      const fullMatch = match[0];
      const capturedOffset = fullMatch.indexOf(filePath);
      const linkStart = match.index + capturedOffset; // Start at the file path
      const linkEnd = match.index + fullMatch.length; // End includes :line:col

      links.push({
        range: {
          start: { x: linkStart + 1, y: lineNumber },
          end: { x: linkEnd + 1, y: lineNumber },
        },
        text: fullMatch.substring(capturedOffset), // "src/foo.ts:42:15"
        decorations: { pointerCursor: true, underline: true },
        activate: (_event: MouseEvent, _linkText: string) => {
          // Platform-aware modifier key: Cmd on macOS, Ctrl on others
          // isMac → require metaKey; !isMac → require ctrlKey
          if (isMac ? !_event.metaKey : !_event.ctrlKey) return;
          this.onFileOpen(filePath, line, column, this.terminalId);
        },
      });
    }

    callback(links.length > 0 ? links : undefined);
  }
}
```

Key decisions:
- **Constructor accepts `Terminal` instance** for buffer access via `terminal.buffer.active.getLine()`. The Terminal instance is available at registration time in `Terminal.tsx`.
- **Line/col from regex groups, not `parseFilePath`**: `FILE_PATH_REGEX` captures the path in group 1 (without line/col), and line/col in groups 2-5. We extract them directly from the match groups and pass via closure in the `activate` callback. This avoids the bug where `parseFilePath(match[1])` would miss line/col info since `match[1]` is the bare path. The `text` property includes the full visible match (path + line/col suffix) for correct link range display.
- **Platform-aware modifier**: `isMac` checks `navigator.platform` once at module load. On macOS, `activate` requires `metaKey` (Cmd); on other platforms, it requires `ctrlKey` (Ctrl). This prevents Ctrl+Click on macOS from triggering file open (which would interfere with standard macOS Ctrl+Click → context menu behavior).
- Create a new `RegExp` from `FILE_PATH_REGEX.source` + `.flags` each call to avoid `/g` stateful `lastIndex`
- `looksLikeFilePath()` filters false positives before creating links
- `ILink.decorations` sets `{ pointerCursor: true, underline: true }` — CSS overrides make it dotted (see Phase 3)

#### Acceptance Criteria
- [ ] `FilePathLinkProvider` detects all pattern types from spec's pattern table
- [ ] On macOS: only Cmd+Click activates; Ctrl+Click does NOT activate
- [ ] On Linux/Windows: only Ctrl+Click activates; Cmd+Click does NOT activate
- [ ] Line/col info from `src/foo.ts:42:15` is correctly extracted and passed to `onFileOpen`
- [ ] No interference with existing `WebLinksAddon` URL detection
- [ ] Regex `/g` flag is handled correctly (no alternating match/miss)

#### Risks
- **Risk**: `ILink.activate` may not receive `MouseEvent` in xterm.js 5.5.0
  - **Mitigation**: Check API signature; if no event, use global keydown/keyup listener to track modifier state

---

### Phase 2: Server-Side Path Resolution
**Dependencies**: None (can be done in parallel with Phase 1)

#### Objectives
- Add a public `get cwd()` getter to `PtySession` class (config is `private readonly`)
- Update `POST /api/tabs/file` to accept `terminalId` for cwd-relative path resolution
- Add `fs.realpathSync` + fallback for symlink-safe containment checking
- Containment check allows paths within project root AND `.builders/` worktrees

#### Deliverables
- [ ] New `get cwd()` getter on `PtySession` class in `packages/codev/src/terminal/pty-session.ts`
- [ ] Updated `tower-server.ts` file tab endpoint
- [ ] Terminal session cwd lookup via `getTerminalManager().getSession(terminalId).cwd`
- [ ] `realpathSync` with fallback to `path.resolve` for non-existent files
- [ ] Warning log on missing terminal session fallback
- [ ] Containment check validates both project root and `.builders/` worktrees

#### Implementation Details

**File**: `packages/codev/src/terminal/pty-session.ts`

Add public getter for cwd (since `config` is `private readonly`):
```typescript
/** Working directory of the PTY session. */
get cwd(): string {
  return this.config.cwd;
}
```

**File**: `packages/codev/src/agent-farm/servers/tower-server.ts` (lines ~2492-2556)

Changes to `POST /api/tabs/file` handler:

1. Extract `terminalId` from request body alongside `path` and `line`
2. If `terminalId` is provided and `path` is relative (`!path.isAbsolute(filePath)`):
   - Look up session: `const session = getTerminalManager().getSession(terminalId)`
   - If session found: `fullPath = path.join(session.cwd, filePath)`
   - If session NOT found: log warning, fall back to `path.join(projectPath, filePath)`
3. **Soften the file-exists check**: The current endpoint returns 404 if the file doesn't exist (tower-server.ts line ~2522). The spec requires that non-existent files are still clickable — the file viewer should show a "File not found" indicator rather than the API rejecting the request. Change the 404 early return to instead create the file tab with a `notFound: true` flag, allowing the viewer to display the error. The containment check still runs (non-existent paths are still validated for directory traversal).
4. Replace existing containment check with symlink-aware version that allows both project root and `.builders/` worktrees:
   ```typescript
   let resolvedPath: string;
   try {
     resolvedPath = fs.realpathSync(fullPath);
   } catch {
     resolvedPath = path.resolve(fullPath);
   }

   // Containment: allow paths within project root OR within .builders/ worktrees
   // Builder worktrees are git worktrees at <projectRoot>/.builders/<id>/
   // but they can also be at absolute paths that resolve outside the project root
   // (e.g., when the worktree is a symlink). We resolve the project path too.
   let normalizedProject: string;
   try {
     normalizedProject = fs.realpathSync(projectPath);
   } catch {
     normalizedProject = path.resolve(projectPath);
   }

   const isWithinProject = resolvedPath.startsWith(normalizedProject + path.sep)
     || resolvedPath === normalizedProject;

   if (!isWithinProject) {
     res.writeHead(403, { 'Content-Type': 'application/json' });
     res.end(JSON.stringify({ error: 'Path outside project' }));
     return;
   }
   ```

**Note on `.builders/` worktree containment**: Builder worktrees at `.builders/<id>/` are already within the project root directory tree. The containment check `resolvedPath.startsWith(normalizedProject + path.sep)` naturally allows them because `.builders/` is a subdirectory of the project root. No special-case logic is needed — the single `startsWith` check covers both the main project and all worktrees. The key insight is that `terminalId` resolution uses `session.cwd` (the worktree path) to resolve relative paths, and the resulting absolute path is still within the project tree.

#### Acceptance Criteria
- [ ] `PtySession.cwd` getter returns the session's working directory
- [ ] `terminalId` + relative path resolves correctly using terminal's cwd
- [ ] Missing terminal session falls back to project root with warning log
- [ ] Symlink resolution via `realpathSync` works for existing files
- [ ] Non-existent files fall back to `path.resolve` (no crash)
- [ ] Path traversal (`../../.ssh/id_rsa`) returns 403
- [ ] Builder worktree paths (e.g., `.builders/0099/src/foo.ts`) pass containment check
- [ ] Paths escaping project tree (e.g., `../../etc/passwd`) fail containment check
- [ ] Non-existent files pass containment check and create a tab (no 404 early return)

#### Risks
- **Risk**: `session.config` is `private readonly` on `PtySession`
  - **Mitigation**: Add a `get cwd()` public getter — trivial one-line addition

---

### Phase 3: Dashboard Integration & Styling
**Dependencies**: Phase 1, Phase 2

#### Objectives
- Wire `FilePathLinkProvider` into `Terminal.tsx`
- Pass `terminalId` through `onFileOpen` → `createFileTab` → Tower API
- Add CSS for dotted underline decoration with hover color shift (file-path links only, not URL links)
- Remove dead `looksLikeFilePath` code path from WebLinksAddon handler

#### Deliverables
- [ ] Updated `Terminal.tsx` — register `FilePathLinkProvider` alongside `WebLinksAddon`
- [ ] Updated `Terminal.tsx` — extract `terminalId` from `wsPath` prop
- [ ] Updated `Terminal.tsx` — remove dead file-path branch from WebLinksAddon handler (URL-only now)
- [ ] Updated `TerminalProps` — add `terminalId` to `onFileOpen` callback signature
- [ ] Updated `App.tsx` — pass `terminalId` to `handleFileOpen` → `createFileTab`
- [ ] Updated `api.ts` — `createFileTab` accepts and sends `terminalId`
- [ ] CSS for dotted underline + hover color on file path links (distinct from URL links)
- [ ] Lifecycle disposal: `linkProviderDisposable.dispose()` + MutationObserver disconnect in cleanup
- [ ] **DOM discovery task**: Inspect xterm.js rendered DOM to determine correct CSS selectors

#### Implementation Details

**File**: `packages/codev/dashboard/src/components/Terminal.tsx`

1. Import `FilePathLinkProvider`
2. Extract `terminalId` from `wsPath` (e.g., `/ws/terminal/<id>` → `<id>`)
3. After creating the xterm instance, register the link provider:
   ```typescript
   // Extract terminalId from wsPath: "/base/ws/terminal/<id>" → "<id>"
   const terminalId = wsPath.split('/').pop();

   const filePathProvider = new FilePathLinkProvider(
     term,  // Pass Terminal instance for buffer access
     (filePath, line, column, tid) => {
       onFileOpen?.(filePath, line, column, tid);
     },
     terminalId,
   );
   const linkProviderDisposable = term.registerLinkProvider(filePathProvider);
   ```

   **Lifecycle disposal**: `registerLinkProvider` returns an `IDisposable`. Store it and call `linkProviderDisposable.dispose()` in the component cleanup function (the `useEffect` return callback), alongside `term.dispose()`, `ws.close()`, and other cleanup. If a `MutationObserver` is used for CSS tagging, it must also be disconnected in cleanup. This prevents stacking duplicate providers and memory leaks when Terminal components are unmounted/remounted on tab switches.

   ```typescript
   // In the useEffect cleanup:
   return () => {
     linkProviderDisposable.dispose();
     // ... existing cleanup (ws.close(), term.dispose(), etc.)
   };
   ```
4. **Remove dead file-path branch** from WebLinksAddon handler. The `looksLikeFilePath` check in the WebLinksAddon callback (lines 86-88) is never triggered because WebLinksAddon only matches URLs. After the new `FilePathLinkProvider` handles file paths, this dead code should be removed. The WebLinksAddon handler becomes URL-only:
   ```typescript
   const webLinksAddon = new WebLinksAddon((event, uri) => {
     event.preventDefault();
     window.open(uri, '_blank');
   });
   ```
5. Update `onFileOpen` callback type to include `terminalId`:
   ```typescript
   onFileOpen?: (path: string, line?: number, column?: number, terminalId?: string) => void;
   ```

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

**CSS Styling — DOM Discovery and Approach**:

xterm.js `ILinkDecorations` only supports `underline: boolean` and `pointerCursor: boolean` — it does NOT support underline style. The dotted underline requires CSS targeting xterm's decoration DOM elements.

**Critical discovery task**: Before writing CSS, the builder must:
1. Register the `FilePathLinkProvider` and a `WebLinksAddon` on a test terminal
2. Output both a file path and a URL to the terminal
3. Inspect the rendered DOM (via browser DevTools) to determine:
   - What HTML elements xterm.js creates for `ILinkProvider` links vs `WebLinksAddon` links
   - What CSS classes or attributes distinguish them
   - Whether they share the same selector or have different ones

**Strategy for distinguishing file-path links from URL links**:

In xterm.js 5.x, `ILinkProvider` links and `WebLinksAddon` links may render using different DOM mechanisms:
- `WebLinksAddon` renders links as inline `<a>` tags with the `xterm-link` class
- `ILinkProvider` links render as overlay `<div>` elements with decoration classes

If they use **different DOM structures** (likely), CSS selectors can target each independently. File path links get dotted underline; URL links keep their default solid underline.

If they share the **same DOM structure**, the builder must apply a CSS class to distinguish them. Approach: in `FilePathLinkProvider`, use a `MutationObserver` on the xterm container to detect newly-added link decoration elements and add a `data-link-type="file"` attribute, or use the `ILink.decorations` mechanism with a custom class if the API supports it.

**CSS rules** (selectors to be finalized after DOM discovery):

```css
/* File path links — dotted underline (distinct from URL solid underline) */
/* Selector TBD after DOM inspection; placeholder using overlay div approach */
.xterm .xterm-screen [data-link-type="file"],
.xterm .xterm-link-layer .file-path-link {
  text-decoration: underline dotted !important;
  text-decoration-color: rgba(255, 255, 255, 0.4);
  text-underline-offset: 2px;
}

/* Hover state: subtle brightness shift + pointer cursor */
.xterm .xterm-screen [data-link-type="file"]:hover,
.xterm .xterm-link-layer .file-path-link:hover {
  text-decoration-color: rgba(255, 255, 255, 0.8);
  filter: brightness(1.15);
  cursor: pointer;
}
```

The final selectors will be determined during implementation based on the DOM discovery. The CSS variables used (`rgba(255, 255, 255, 0.4)` / `0.8`) match the terminal's light-on-dark theme.

#### Acceptance Criteria
- [ ] File paths in terminal output show dotted underline
- [ ] URL links show solid underline (different from file path links)
- [ ] Hover over file path shows brightness shift and pointer cursor
- [ ] Cmd+Click (macOS) / Ctrl+Click (others) opens file in viewer
- [ ] Plain click does not trigger file open
- [ ] URLs still open in new browser tab (WebLinksAddon unchanged)
- [ ] `terminalId` is passed through the full chain to the Tower API
- [ ] Builder terminal paths resolve relative to builder's worktree cwd
- [ ] Dead `looksLikeFilePath` branch removed from WebLinksAddon handler

#### Risks
- **Risk**: xterm.js `ILinkProvider` and `WebLinksAddon` share the same DOM structure, making CSS distinction difficult
  - **Mitigation**: Use a deterministic tagging strategy to guarantee distinct styling. Primary: `MutationObserver` on the xterm container that detects newly-added link decoration elements and adds a `data-link-type="file"` attribute to file-path links (identified by matching against the currently-hovered link provider instance). Fallback: if `ILinkProvider` renders links as overlay divs (separate from `WebLinksAddon` inline `<a>` tags), target each with different CSS selectors directly. The spec requires dotted underline for files and solid for URLs — this is a hard requirement, not optional.

---

### Phase 4: Tests
**Dependencies**: Phase 1, Phase 2, Phase 3

#### Objectives
- Write comprehensive unit tests for all new and modified code
- Write E2E tests for the click-to-open flow, including builder worktree scenario
- Write visual regression tests for link styling (spec scenarios 17-19)

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
- Test line/col extraction from regex groups (colon format and paren format)

**Unit Tests**: `file-tab-resolution.test.ts`
- Test path containment: within project → allowed; escaping → 403
- Test `terminalId` resolution: relative path + terminal cwd → correct absolute path
- Test `terminalId` fallback: missing session → project root resolution
- Test `realpathSync` failure: non-existent file → `path.resolve` fallback
- Test builder worktree path (e.g., `.builders/0099/src/foo.ts`) passes containment
- Test path escaping via `../` from builder worktree returns 403

**E2E Tests**: `clickable-file-paths.spec.ts`
- Test basic file path Cmd+Click opens file viewer
- Test path with line number scrolls to line
- Test URL still works (opens in new tab)
- Test plain click does not open file
- **Test builder terminal worktree resolution**: Spawn or simulate a builder terminal session with a worktree cwd. Output a relative file path. Cmd+Click the path and verify the file viewer opens the correct file resolved relative to the worktree, not the project root.

**Visual/Screenshot Tests** (spec scenarios 17-19):
- Test dotted underline: Screenshot comparison showing file paths have dotted underline decoration
- Test hover cursor: Verify pointer cursor on hover over file path (via Playwright `page.mouse.move()` + screenshot)
- Test no visual noise: Screenshot showing that plain text with dots (sentences, config values) is NOT underlined

These use Playwright's `toHaveScreenshot()` for visual regression. Baseline screenshots are committed and compared on subsequent runs.

#### Acceptance Criteria
- [ ] All unit tests pass
- [ ] All E2E tests pass
- [ ] Existing tests not broken
- [ ] Coverage for all spec test scenarios 1-19 (including visual tests 17-19)
- [ ] Builder worktree resolution tested in E2E
- [ ] Visual regression baselines committed

#### Risks
- **Risk**: E2E tests need a running Tower + terminal to test click behavior
  - **Mitigation**: Use existing Playwright test infrastructure that starts a dev server
- **Risk**: Visual regression tests may be flaky due to rendering differences
  - **Mitigation**: Use appropriate `maxDiffPixelRatio` threshold in `toHaveScreenshot()`

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
| File-path and URL links share same DOM structure | Medium | Medium | Deterministic tagging via MutationObserver + data attribute; or target different DOM structures with separate CSS selectors |
| `session.config.cwd` not directly accessible | Confirmed | Low | Add `get cwd()` getter to PtySession (one-line fix) |
| Regex false positives in terminal output | Low | Low | `looksLikeFilePath()` filter already handles common cases |
| Visual regression test flakiness | Low | Low | Appropriate pixel diff threshold |

## Validation Checkpoints
1. **After Phase 1**: File paths are detected in terminal buffer lines (verify with console.log in `provideLinks`); line/col correctly extracted from `src/foo.ts:42:15`
2. **After Phase 2**: `curl` test: POST to `/api/tabs/file` with `terminalId` resolves correctly for both project-root and worktree scenarios
3. **After Phase 3**: End-to-end: type a file path in terminal, Cmd+Click opens viewer; builder terminal paths resolve correctly; file-path links have dotted underline, URL links have solid underline
4. **After Phase 4**: All tests green, no regressions, visual baselines committed

## Notes
- The existing `WebLinksAddon` handler in `Terminal.tsx` (lines 82-99) checks `looksLikeFilePath` but is never triggered for file paths. After this implementation, that dead code branch is **removed** — the WebLinksAddon handler becomes URL-only. The new `FilePathLinkProvider` handles file paths separately.
- The `Terminal` component's `onFileOpen` callback signature changes to include `terminalId` — this is a backward-compatible addition (optional parameter).
- `PtySession.config` is `private readonly` — the plan adds a `get cwd()` public getter rather than making `config` public, preserving encapsulation.
- Line/col extraction uses regex capture groups directly (groups 2-5) rather than `parseFilePath` on the link text. This avoids the bug where `match[1]` (bare path without line/col) would produce a `parseFilePath` result with no line info.
