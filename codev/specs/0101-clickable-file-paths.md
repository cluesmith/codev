# Spec 0101: Clickable File Paths in Terminal

## Summary

File paths displayed in xterm.js terminal output (e.g., `src/lib/foo.ts:42:15`) should be visually indicated as clickable (dotted underline) and open in the dashboard's file viewer (`af open`) when clicked. Must work in both architect terminals and builder terminals (which run in worktrees with different cwd).

## Problem

When Claude or build tools output file paths in the terminal (error messages, diffs, test results, linter output), the user must manually copy the path and run `af open <path>` or navigate the Files panel. This breaks flow — especially during iterative debugging where you're constantly jumping between terminal output and source files.

The infrastructure for this already exists but isn't connected:

1. **`filePaths.ts`** exports `FILE_PATH_REGEX`, `parseFilePath()`, and `looksLikeFilePath()` — created in Spec 0092 but never wired into the link detection.
2. **`WebLinksAddon`** is loaded in `Terminal.tsx` with a handler that already routes file paths to `onFileOpen` — but it only matches HTTP/HTTPS URLs by default. File paths are never detected.
3. **`onFileOpen`** in `App.tsx` calls `createFileTab()` which hits `POST /api/tabs/file` — the full pipeline from click to file viewer already works.

The gap is: the terminal never recognizes file paths as clickable links.

## Current State

- `WebLinksAddon` is loaded with `urlRegex: undefined` (default HTTP/HTTPS only)
- `FILE_PATH_REGEX` exists in `filePaths.ts` but is unused
- The handler in `Terminal.tsx` already checks `looksLikeFilePath()` and calls `onFileOpen()` — but the handler is never triggered for file paths because the regex doesn't match them
- URLs (http/https) are clickable and open in a new tab — this works correctly
- File paths in the Files panel are clickable — clicking a file there opens it in the viewer

## Desired State

### Visual Indicator

File paths in terminal output are visually distinct from plain text:
- Dotted underline via CSS `text-decoration: underline dotted` (distinct from the solid underline used for URLs)
- Subtle color change on hover using existing dashboard CSS variables (e.g., `--link-hover-color` or a brightness filter)
- Cursor changes to `pointer` on hover
- The link decoration is applied by the `ILinkProvider` via the `decorations` property on returned `ILink` objects

This is consistent with how IDEs (VS Code, IntelliJ) display clickable file paths in their integrated terminals.

### Click Behavior

Cmd+Click (macOS) or Ctrl+Click (Linux/Windows) on a file path:
1. Extracts the path and line number (column is parsed but not used by the file viewer in v1)
2. Calls `onFileOpen(path, line)` which opens the file in the dashboard viewer
3. Scrolls to the indicated line if present
4. Plain clicks are reserved for text selection — no interference with drag-to-select

**Modifier key detection**: The `ILinkProvider` `activate` callback receives the `MouseEvent`. Check `event.metaKey` (macOS) or `event.ctrlKey` (others). If the modifier is not held, the activate callback returns without action, preserving normal text selection behavior.

### Path Patterns Recognized

Must detect common output formats from build tools, linters, test runners, and compilers:

| Pattern | Example | Source |
|---------|---------|--------|
| Relative path | `src/lib/foo.ts` | General |
| With line | `src/lib/foo.ts:42` | TypeScript, ESLint |
| With line+col | `src/lib/foo.ts:42:15` | TypeScript, ESLint |
| VS Code style | `src/lib/foo.ts(42,15)` | VS Code problem matcher |
| Absolute path | `/Users/mwk/.../foo.ts:42` | Stack traces |
| Dot-relative | `./src/lib/foo.ts` | Relative imports |
| Parent-relative | `../shared/types.ts` | Cross-package refs |

Must NOT match:
- URLs (`https://example.com/path`)
- Domain names (`github.com`, `npmjs.org`)
- Package specifiers (`@xterm/xterm`)
- Version strings (`v2.0.0-rc.62`)

### Builder Worktree Support

Builder terminals run in worktrees (e.g., `.builders/0099/`). When a builder outputs a relative path like `src/lib/foo.ts`, the dashboard must resolve it relative to the builder's working directory, not the parent project root.

The Tower's `POST /api/tabs/file` already handles absolute paths correctly. The challenge is knowing the builder's cwd for relative path resolution. Options:

- **Preferred**: Resolve relative paths on the server side. The Tower knows each terminal's cwd from the pty session metadata. Send the terminal ID alongside the file path so the Tower can resolve relative to the correct cwd.
- **Alternative**: The dashboard could prepend the worktree prefix if it knows the terminal is a builder. But this couples the dashboard to worktree layout details.

### Terminal ID Data Flow

The `terminalId` is already available at every point in the dashboard:

1. **Tower assigns** a `terminalId` (UUID) when creating each pty session (`PtySession.id`)
2. **Dashboard receives** the ID via the `GET /api/state` response — each builder, architect, and shell tab includes a `terminalId` field (see `Builder.terminalId`, `ArchitectState.terminalId` in `api.ts`)
3. **Terminal component** receives `wsPath` which contains the `terminalId` (e.g., `/ws/terminal/<id>`)
4. **On click**: The `Terminal` component passes the `terminalId` to the `onFileOpen` callback
5. **`onFileOpen` → `createFileTab`**: Passes `terminalId` in the API request body
6. **Tower resolves**: Uses `TerminalManager.getSession(terminalId)` to look up `session.config.cwd`

The `terminalId` is stable for the lifetime of the pty session. It doesn't change on WebSocket reconnect (the session persists server-side). The Terminal component extracts the ID from its `wsPath` prop.

**Note**: `PtySession.config.cwd` is accessible within `tower-server.ts` directly — the public `PtySessionInfo` interface doesn't expose `cwd`, but the Tower has access to the internal session object.

## Success Criteria

- [ ] File paths in terminal output are visually indicated (dotted underline, pointer cursor)
- [ ] Clicking a file path opens it in the dashboard file viewer
- [ ] Line numbers from `file.ts:42` are passed through — viewer scrolls to line
- [ ] Works in architect terminal (paths relative to project root)
- [ ] Works in builder terminals (paths relative to worktree)
- [ ] Absolute paths work regardless of terminal context
- [ ] URLs (http/https) continue to work — open in new browser tab
- [ ] No false positives on domain names, package names, or version strings
- [ ] Visual style is distinct from URL links (dotted vs solid underline)

## Constraints

### Technical Constraints

- xterm.js `WebLinksAddon` accepts a single `urlRegex` — it may not support two different link styles (dotted for files, solid for URLs). May need to use the lower-level `registerLinkProvider` API instead for separate decoration.
- The `ILinkProvider` API gives full control over decoration and activation but requires manual position tracking across terminal buffer lines.
- `FILE_PATH_REGEX` uses lookbehind (`(?<![a-zA-Z]:\/\/)`) which is supported in modern browsers but check Safari compatibility.

### Design Constraints

- Must not interfere with text selection (click-to-open vs click-to-select). Standard pattern: require modifier key (Cmd/Ctrl+click) or distinguish single click from drag.
- Must not cause visual noise — only underline things that are actually file paths, not every word with a dot in it.

## Assumptions

- `@xterm/addon-web-links` supports custom regex OR we use `ILinkProvider` for full control
- The Tower can determine each terminal's cwd from its session metadata
- Builder worktrees use the standard `.builders/<id>/` layout

## Solution Approach

### xterm.js Link Provider

Rather than trying to make `WebLinksAddon` handle both URLs and file paths with one regex, use xterm.js's `registerLinkProvider` API to add a separate file path link provider alongside the existing URL addon. This gives independent control over:

- Detection regex (file paths only)
- Visual decoration (dotted underline for files, solid for URLs)
- Activation handler (open in file viewer vs open in browser)

The existing `WebLinksAddon` stays unchanged for URL handling.

### Path Resolution

When a file path link is clicked:
1. If absolute → use as-is
2. If relative → send to Tower with the terminal's session ID
3. Tower resolves relative to the terminal's cwd (available from pty session metadata)
4. Tower validates the resolved path exists and is within the project tree

### API Contract

`POST /project/:encodedPath/api/tabs/file` — extended payload:

```typescript
interface CreateFileTabRequest {
  path: string;          // File path (absolute or relative)
  line?: number;         // Line to scroll to
  terminalId?: string;   // Terminal session ID for cwd-relative resolution
}
```

When `terminalId` is provided and `path` is relative:
1. Tower looks up the terminal session via `TerminalManager.getSession(terminalId)` — the `terminalId` on the dashboard side is the same string as `PtySession.id` on the server side (both are the session ID assigned at pty creation)
2. Resolves `path` relative to `session.config.cwd`
3. Validates the resolved absolute path is within the project root or a known worktree (`.builders/`)
4. Rejects with 403 if the resolved path escapes the project tree
5. For symlink resolution: uses `fs.realpathSync()` before the containment check. If the file doesn't exist (e.g., path from a compilation error for a deleted file), falls back to `path.resolve()` without symlink resolution — the containment check still applies

**Fallback when `terminalId` is invalid**: If the terminal session cannot be found (e.g., historical session, tab restored after reconnect), the Tower logs a warning (`WARN: Terminal session <id> not found, resolving relative to project root`) and falls back to resolving relative to the project root. This is the same behavior as when `terminalId` is omitted. The warning is server-side only (not surfaced to the user as a toast) because the fallback usually produces the correct result for architect terminals.

When `terminalId` is omitted, existing behavior is unchanged (resolves relative to project root).

### Security

- **Path containment**: All resolved paths must be within the project root directory or a `.builders/` worktree. Symlinks are resolved before checking containment. Paths that escape (e.g., `../../.ssh/id_rsa`) return 403.
- **Path normalization**: `path.resolve()` + `fs.realpathSync()` to collapse `..`, `.`, and symlinks before validation. If `realpathSync` fails (file doesn't exist), fall back to `path.resolve()` alone.
- **No shell execution**: File opening reads file content directly — no shell commands are invoked from user-provided paths.
- **File size limit**: The existing file tab endpoint already reads file content for the annotator. No additional size limit is needed here — the annotator handles large files by streaming. If a file is extremely large, the browser's rendering is the bottleneck, not the click-to-open pipeline.

## Test Scenarios

### Unit Tests (vitest)

1. **`FILE_PATH_REGEX` matches**: Test all pattern types (relative, absolute, with line, with line+col, VS Code style, dot-relative, parent-relative)
2. **`FILE_PATH_REGEX` rejects**: URLs, domains, package specifiers, version strings
3. **`parseFilePath` extracts correctly**: Colon format, parenthesis format, bare path
4. **`looksLikeFilePath` filters**: Rejects URLs and domains, accepts valid paths
5. **Path containment**: Resolved path within project → allowed; path escaping project → 403
6. **`terminalId` resolution**: Relative path + terminal cwd → correct absolute path
7. **`terminalId` fallback**: Invalid/missing terminal session falls back to project root resolution
8. **`realpathSync` failure**: Non-existent file path still gets containment check via `path.resolve()`
9. **Multiple paths in one line**: `error in src/a.ts:1 and src/b.ts:2` — both detected as separate links

### Playwright E2E Tests

10. **Basic file path clickable**: Terminal outputs `src/foo.ts`, Cmd+Click opens file viewer
11. **Path with line**: `src/foo.ts:42` opens file and scrolls to line 42
12. **Absolute path**: `/path/to/project/foo.ts` works regardless of terminal context
13. **URL still works**: `https://example.com` opens in new tab (not file viewer)
14. **No false positives**: `github.com`, `@xterm/xterm`, `v2.0.0` are NOT clickable
15. **Non-existent file**: Click a path to a missing file, verify error indicator shown in viewer
16. **Plain click ignored**: Clicking a file path without Cmd/Ctrl does NOT open the file (text selection works normally)

### Visual Tests (Playwright screenshot comparison)

17. **Dotted underline**: File paths have dotted underline (distinct from URL solid underline)
18. **Hover cursor**: Pointer cursor on hover over file path
19. **No visual noise**: Plain text with dots (sentences, config values) not underlined

## Error Handling

| Scenario | Behavior |
|----------|----------|
| File doesn't exist | File viewer shows "File not found" indicator |
| `terminalId` not found (expired/reconnected session) | Server logs warning; falls back to project-root-relative resolution |
| Path escapes project tree | Tower returns 403; dashboard shows error toast |
| Tower unreachable | Dashboard shows connection error toast |
| `realpathSync` throws (non-existent file) | Falls back to `path.resolve()` for containment check |

## Design Decisions

- **Cmd/Ctrl+Click required** — Cmd+Click on macOS, Ctrl+Click on Linux/Windows. Plain click is reserved for text selection. This matches VS Code's integrated terminal behavior. The `ILinkProvider.activate` callback checks `event.metaKey || event.ctrlKey` and returns early without action if neither is held.
- **Non-existent files are still clickable** — all file path patterns are marked as links. When clicked, if the file doesn't exist, the file viewer shows a visual error indicator (e.g., a cross icon or "File not found" message) rather than silently failing. This avoids the performance cost of checking file existence for every detected path on every terminal render.
- **Windows drive-letter paths deferred** — The feature works cross-platform (Cmd+Click on macOS, Ctrl+Click on Linux/Windows). Only Windows-specific drive-letter path patterns (`C:\foo\bar.ts`) are out of scope for v1, since Codev currently targets macOS. The regex can be extended later.
- **No quoted/bracketed/space-containing paths in v1** — Paths inside quotes (`"foo/bar.ts"`), brackets (`[foo/bar.ts]`), or containing spaces (`My Tests/foo.ts`) are not matched. Development repositories rarely use spaces in paths. Wrapper character stripping and space-in-path support can be added in a follow-up if false negatives are reported.
- **ANSI escape codes** — xterm.js `ILinkProvider.provideLinks` receives the **text content** of each buffer line (after ANSI parsing), not raw escape sequences. The regex runs against clean text, so ANSI codes don't interfere with matching.
- **Multi-line wrapped paths** — Paths that wrap across terminal lines are not matched in v1. The `ILinkProvider` operates per-line. This is a reasonable limitation since most tool output keeps file paths on a single line. Can be revisited if wrapped paths are a common issue.
- **Column support deferred** — `parseFilePath` extracts column numbers, but the file viewer doesn't support column-level scrolling. Column is parsed and passed through the pipeline but not acted upon in v1. This keeps the data available for future use without adding viewer complexity now.
- **Regex `/g` flag handling** — `FILE_PATH_REGEX` uses the global flag. The link provider must create a new regex instance (or reset `lastIndex` to 0) for each `provideLinks` call to avoid stateful match/miss alternation.

## Notes

Most of the code exists. The main implementation work is:
1. Create a custom `ILinkProvider` for file paths using the existing `FILE_PATH_REGEX` and `parseFilePath`
2. Add dotted underline decoration (use existing dashboard CSS variables for colors)
3. Wire into `onFileOpen` (already connected to `createFileTab`)
4. Add optional `terminalId` to the file tab API for cwd resolution
5. Add path containment validation in the Tower's file tab endpoint
