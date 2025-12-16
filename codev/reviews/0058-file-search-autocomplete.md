# Review 0058: File Search Autocomplete

## Summary

Implemented a VSCode-like file search feature for the dashboard with two entry points:
1. **Search input in Files column** - Always visible, filters file tree inline
2. **Cmd+P modal palette** - Quick access overlay for rapid file navigation

## Implementation Details

### Files Changed

| File | Changes |
|------|---------|
| `packages/codev/templates/dashboard-split.html` | +526 lines (JS, CSS, HTML) |
| `tests/e2e/dashboard.bats` | +120 lines (17 new test cases) |

### Key Features Implemented

1. **Flat File List Cache** (`flattenFilesTree`)
   - Extracts all file paths from tree into searchable array
   - Cached on initial load and after refresh
   - Enables efficient filtering without tree traversal

2. **Search Engine** (`searchFiles`)
   - Case-insensitive substring matching against full path
   - Relevance sorting: exact filename > prefix > substring > alphabetical
   - Results limited to 15 for performance

3. **Files Column Search**
   - Always-visible search input with placeholder text
   - Clear button (x) appears when input has value
   - Results replace file tree when searching
   - Tree restored when search cleared

4. **Cmd+P Palette**
   - Global Cmd/Ctrl+P keyboard shortcut
   - Modal overlay with backdrop
   - Auto-focus input on open
   - Global Escape handler (works even if input loses focus)

5. **Shared Features**
   - Debounced input (100ms)
   - Match highlighting with `escapeHtml` for XSS safety
   - Keyboard navigation (Arrow Up/Down, Enter, Escape)
   - Focus existing tab if file is already open
   - Scroll selected result into view

### Design Decisions

1. **Reuse existing `/api/files` endpoint** - The file tree is already loaded and filtered server-side according to `.gitignore`. No need for a separate search API.

2. **Client-side filtering** - With files cached in `filesTreeFlat`, substring matching is instant even for large codebases. Server round-trips would add latency.

3. **Shared `searchFiles` function** - Both Files column and Cmd+P palette use the same search logic, ensuring consistent behavior.

4. **Two UI entry points** - Files column search is always accessible; Cmd+P is the power-user shortcut familiar from VSCode.

## External Review Summary

### Gemini (APPROVE)

- Confirmed implementation correctness and security
- Verified relevance sorting matches spec
- Noted XSS protection via `escapeHtml`/`escapeJsString`

### Codex (APPROVE)

- Comprehensive review of search behavior, keyboard UX, and security
- Suggested improvement: Add global Escape handler for palette
- Confirmed tests match existing repository testing patterns

**Improvement Applied**: Added global Escape handler per Codex suggestion.

## Acceptance Criteria Verification

| Criterion | Status |
|-----------|--------|
| Cmd+P / Ctrl+P opens palette | PASS |
| Search input in Files tab header | PASS |
| Typing filters files with substring matching | PASS |
| Arrow keys navigate, Enter opens | PASS |
| File opens in annotation viewer | PASS |
| Escape closes palette | PASS |
| Results sorted by relevance | PASS |
| Performance acceptable with 10,000+ files | PASS (cached flat list) |
| Respects same file exclusions | PASS (uses `/api/files`) |

## Lessons Learned

1. **Debounce is essential** - Without the 100ms debounce, rapid typing causes UI jank as search runs on every keystroke.

2. **Global Escape handler adds resilience** - The palette input's Escape handler wasn't sufficient if focus was lost. A global handler ensures consistent behavior.

3. **XSS requires consistent escaping** - The `highlightMatch` function required careful escaping of the non-highlighted portions while allowing the `<span>` highlight tag through.

4. **Shared logic reduces bugs** - Using the same `searchFiles` function for both entry points ensures identical behavior and simpler maintenance.

## Future Enhancements

- **Search history** - Show recent searches or recently opened files
- **Fuzzy matching** - Allow character skipping (e.g., "dsh" matches "dashboard")
- **File type filtering** - Filter by extension (e.g., "*.ts")
