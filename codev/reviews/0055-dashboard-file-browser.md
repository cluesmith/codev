# Review: 0055 Dashboard File Browser

## Summary

Added a VSCode-like file browser tab to the Agent Farm dashboard. The Files tab provides a collapsible folder tree view for exploring project files directly from the dashboard.

## Implementation Details

### Backend (`dashboard-server.ts`)
- Added `/api/files` endpoint that returns directory tree as JSON
- Recursive tree building with proper sorting (directories first, then files)
- Excludes heavyweight directories: `node_modules`, `.git`, `dist`, `.builders`, `__pycache__`, `.next`, etc.
- Dotfiles like `.github`, `.gitignore`, `.eslintrc` are visible

### Frontend (`dashboard-split.html`)
- Added Files tab as second permanent/uncloseable tab (after Projects)
- Tree view with visual indicators (▶/▼) for expand/collapse state
- Click folder to toggle expand/collapse
- Click file to open in annotation viewer (new tab)
- Header controls: Collapse All, Expand All, Refresh buttons
- File type icons based on extension

## Acceptance Criteria Met

- [x] Files tab appears next to Projects tab
- [x] Directory tree displays with expand/collapse
- [x] Clicking file opens in annotation viewer
- [x] Collapse All / Expand All buttons work
- [x] Common directories (node_modules, .git) are hidden

## Consultation Feedback

### Gemini - APPROVE
- "Implementation correctly fulfills the requirements of Spec 0055"
- "XSS protection is applied via `escapeHtml` for file paths and names"
- Suggested lazy loading for large projects (non-blocking)

### Codex - REQUEST_CHANGES (addressed)
1. **Dotfiles hidden** - Fixed: Now only heavyweight directories excluded
2. **Path escaping** - Fixed: Added `escapeJsString()` for inline JS handlers

## Lessons Learned

1. **Inline JS escaping requires different approach than HTML escaping**
   - `escapeHtml()` converts `'` to `&#39;` which gets decoded back before JS runs
   - Need `escapeJsString()` that uses backslash escaping for JS strings

2. **Be selective about file exclusions**
   - Initial implementation hid all dotfiles, making `.github`, `.gitignore` inaccessible
   - Better to exclude by specific names rather than patterns

3. **Test with realistic data**
   - Paths with special characters (apostrophes, quotes) are common
   - Test edge cases in file names early

## Files Changed

- `packages/codev/src/agent-farm/servers/dashboard-server.ts` - Added /api/files endpoint
- `packages/codev/templates/dashboard-split.html` - Added Files tab, tree UI, and supporting functions
