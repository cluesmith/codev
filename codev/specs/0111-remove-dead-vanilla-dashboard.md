---
approved: 2026-02-15
validated: [claude]
---

# Spec 0111: Remove Dead Vanilla Dashboard Code

## Problem

The vanilla JS dashboard (`packages/codev/templates/dashboard/`) has been dead code since Spec 0085 replaced it with a React dashboard (`packages/codev/dashboard/`). The 16 files remain in the repo and npm package, causing confusion — an architect spent 20 minutes editing `templates/dashboard/js/projects.js` thinking it was the live code, when the actual code was in the React `StatusPanel.tsx`.

## Solution

Delete `packages/codev/templates/dashboard/` and update the two test files that reference it.

### Files to Delete

Delete the entire `packages/codev/templates/dashboard/` directory (16 files):

```
packages/codev/templates/dashboard/
├── index.html
├── css/
│   ├── dialogs.css
│   ├── files.css
│   ├── layout.css
│   ├── projects.css
│   ├── statusbar.css
│   ├── tabs.css
│   ├── utilities.css
│   └── variables.css
└── js/
    ├── dialogs.js
    ├── files.js
    ├── main.js
    ├── projects.js
    ├── state.js
    ├── tabs.js
    └── utils.js
```

### Files to Update

1. **`packages/codev/src/__tests__/templates.test.ts`** (line ~127): **No change needed.** The assertion `expect(isUpdatableFile('templates/dashboard.html')).toBe(true)` tests that the `isUpdatableFile` function correctly classifies paths starting with `templates/` as updatable — it tests prefix-matching logic, not file existence. This test passes regardless of whether the dashboard directory exists.

2. **`packages/codev/src/agent-farm/__tests__/clipboard.test.ts`**: Delete this file entirely. It contains only one test block that references `templates/dashboard/js/tabs.js`. Removing just the test block would leave an empty test file, which causes test runners to fail with "No test found in suite".

### No Other References

Verified: no build scripts, `.npmignore`, `package.json` `files` field, or runtime source code references `templates/dashboard/` specifically. The `package.json` `files` array includes `"templates"` (the whole directory), so no packaging config changes are needed.

### What to Keep

- `packages/codev/dashboard/` — the active React dashboard (source + dist)
- `packages/codev/templates/tower.html` — Tower homepage (active)
- `packages/codev/templates/open.html` — af open viewer (active)
- `packages/codev/templates/3d-viewer.html` — 3D model viewer (active)
- `packages/codev/templates/vendor/` — PrismJS, marked, DOMPurify (active, added in bugfix #269)

## Scope

- Delete `packages/codev/templates/dashboard/` directory (16 files)
- Delete `packages/codev/src/agent-farm/__tests__/clipboard.test.ts` (only test references dead code)
- Verify build passes, all tests pass

## Acceptance Criteria

1. `packages/codev/templates/dashboard/` no longer exists
2. `npm run build` passes
3. `npm test` passes
4. React dashboard unaffected (served from `packages/codev/dashboard/dist/`)
5. `npm pack --dry-run` confirms no `templates/dashboard/` files in package

## Testing

1. `npm run build` — clean build
2. `npm test` — all tests pass
3. `npm pack --dry-run` — verify no `templates/dashboard/` entries in output
4. `grep -r "templates/dashboard" packages/codev/src/` — no stale source references
