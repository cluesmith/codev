# air-1546 thread

- Implemented `codev.diffNextHunk` / `codev.diffPrevHunk` (apps/vscode/src/commands/diff-hunk-nav.ts): when the modified-side cursor is outside visibleRanges, move it (no reveal) to the top visible line for next / bottom for previous, then delegate to the built-in compareEditor next/previousChange. Relay `diff-next-hunk`/`diff-prev-hunk` now point at the wrappers (only those two lines touched in command-relay.ts).
- Cursor resolution targets the MODIFIED side of the active TabInputTextDiff (the built-in reads that side), so it works with the original side focused too.
- Keyboard path: wrappers bound to alt+f5 / shift+alt+f5 scoped to `codev.activeEditorIsBuilderFile && textCompareEditorVisible`, shadowing the built-in's own keys only in builder diffs. Issue text said the built-in key "cannot be intercepted"; a when-scoped extension binding should take precedence over a core default, but this was NOT verified live (needs the full codev extension active). Flagged in PR.
- diff-nav.ts `diffFirstHunk` left unchanged: it does `cursorTop` first, so its anchor is never stale.
- Verified in real VS Code 1.140 via @vscode/test-electron scratch harness: land on hunk@20, scroll to 216-252 without moving cursor -> built-in next jumps UP to 150 (bug reproduced); wrapper next -> 300; wrapper prev -> 150; unscrolled next -> 150 then 300 (unchanged behavior); original side focused -> 300.
- Gotcha: test-electron with a long --user-data-dir fails (IPC socket path >103 chars); use a short /tmp dir.

## Review iteration 1 (3-way REQUEST_CHANGES via architect:vscode)
- Item 1: moved diffStepHunk into commands/diff-nav.ts; trackedDiffEditor() is the guard shared with diffFirstHunk (registry-based). Re-anchoring happens only in a tracked per-file diff; anything else delegates to the built-in unchanged (a plain editor's caret is never moved).
- Item 2: first tried `resourceScheme == 'codev-diff'` for the original side. A live keypress probe showed that inside a diff editor `resourceScheme` follows the MODIFIED side whichever side has focus, so that clause never matched. Replaced it with a new diff-level key `codev.activeTabIsBuilderDiff` (diff-inject-codelens.ts syncContextKey). The probe confirmed an extension-set key + Alt+F5 fires on both sides and beats the built-in.
- Item 3: the architect asked for F7; the bundle shows F7 is the Accessible Diff Viewer and Alt+F5 is compareEditor.nextChange. Architect withdrew it; keys stay Alt+F5 / Shift+Alt+F5.
- goToDiff picks start > caret (strictly), so the anchor now sits one line outside the viewport; a hunk starting on the edge line is not skipped. A partially visible hunk that starts above the top is still stepped past (no hunk-aware logic, by design).
- Item 4: multi-file View Diff is scoped out; it delegates unchanged.
- Dev-host gotchas: test-electron focus commands need the window frontmost (osascript System Events can activate it and send keys). A full-extension dev host connected to Tower but `codev.openBuilderDiffFirstFile` resolved no builder (unexplained; I stopped after 2 hypotheses), so the end-to-end runs used the real modules plus a registry entry instead.
