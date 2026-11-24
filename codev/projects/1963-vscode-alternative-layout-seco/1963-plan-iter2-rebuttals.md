# Plan 1963 — iteration 2 rebuttals

Both reviewers returned COMMENT. Every point was checked against the code and accepted; nothing is
disputed. The working-tree change Claude saw was my edit for Codex's CSP point.

## Codex (COMMENT)

1. **`BuilderCard`'s inline `style` vs `style-src`.**
   - **Confirmed:** `BuilderCard.tsx:135` uses `style={{ width }}`.
   - **Change:** the panels' CSP is `style-src ${cspSource} 'unsafe-inline'`, the same as both
     existing webviews (`panel-template.ts:25`, `preview-template.ts:50`). Scripts stay nonce-only.
   - Phase 7's rendered check asserts the progress bar's width under the real webview CSP, since
     jsdom does not enforce CSP.

## Claude (COMMENT)

1. **The harness can't produce `spawnedByArchitect`.**
   - **Confirmed:** the attribution is read only from `global.db`'s `builders` table
     (`overview.ts:698`). `discoverBuilders` emits `null`, and `spawn.ts` records
     `CODEV_ARCHITECT_NAME`.
   - **Change:** fixture builders are real `afx spawn --task` runs by the branch's CLI.
     - They run with `cwd` in a fixture repo, against the isolated Tower, with
       `CODEV_ARCHITECT_NAME` set per spawn. The plain-shell `shell.builder` means no agent runs.
     - The pre-screenshot gate asserts the `spawnedByArchitect` values as well as builder
       presence.
     - The null fold, which no spawn can produce, is unit-tested.
     - There are no hand-written database rows and no faked data. If spawning fails, verification
       stops and the architect is told.
2. **Workspace-row data sources.**
   - **Confirmed:** `WorkspaceProvider` re-renders on `onDidChangeDevTerminals` and on the
     `codev-config-updated` and `architects-updated` envelopes (`workspace.ts:27–53`), and the
     worktree config is async.
   - **Change:** the Cockpit resolves the config in its async root `getChildren`, uncached, and
     subscribes to the same three signals. Tests cover each signal, and the *Stop Dev* swap after a
     dev starts from a builder menu.
3. **Main vs sibling architect `contextValue`.**
   - **Confirmed:** `AreaGroupTreeItem` sets a flat `group-builder`.
   - **Change:** a scoped (Cockpit) builder gives `cockpit-architect-main` / `-sibling`, while the
     Agents view keeps `group-builder`. *Remove Architect* targets the sibling value only, and the
     parity test fails if its `when` matches main.
4. **Re-exports.**
   - **Change:** `builders.ts` keeps exporting every moved symbol, so the existing tests'
     imports need no edit.

Minor points, both accepted:

- **Image abort.** The adapter takes `image(path, signal?)`. The VS Code adapter ignores a reply
  whose request was aborted, and a test covers it.
- **Request count.** Phase 4 measures it on the isolated Tower's request log, comparing the Cockpit
  alone with the source views alone. The `getWorktreeConfig` per workspace-row render, the same call
  the Workspace view makes, is accounted for.
