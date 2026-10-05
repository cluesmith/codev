# air-1546 thread

- Implemented `codev.diffNextHunk` / `codev.diffPrevHunk` (apps/vscode/src/commands/diff-hunk-nav.ts): when the modified-side cursor is outside visibleRanges, move it (no reveal) to the top visible line for next / bottom for previous, then delegate to the built-in compareEditor next/previousChange. Relay `diff-next-hunk`/`diff-prev-hunk` now point at the wrappers (only those two lines touched in command-relay.ts).
- Cursor resolution targets the MODIFIED side of the active TabInputTextDiff (the built-in reads that side), so it works with the original side focused too.
- Keyboard path: wrappers bound to alt+f5 / shift+alt+f5 scoped to `codev.activeEditorIsBuilderFile && textCompareEditorVisible`, shadowing the built-in's own keys only in builder diffs. Issue text said the built-in key "cannot be intercepted"; a when-scoped extension binding should take precedence over a core default, but this was NOT verified live (needs the full codev extension active). Flagged in PR.
- diff-nav.ts `diffFirstHunk` left unchanged: it does `cursorTop` first, so its anchor is never stale.
- Verified in real VS Code 1.140 via @vscode/test-electron scratch harness: land on hunk@20, scroll to 216-252 without moving cursor -> built-in next jumps UP to 150 (bug reproduced); wrapper next -> 300; wrapper prev -> 150; unscrolled next -> 150 then 300 (unchanged behavior); original side focused -> 300.
- Gotcha: test-electron with a long --user-data-dir fails (IPC socket path >103 chars); use a short /tmp dir.
