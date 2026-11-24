# Plan 1963 — iteration 1 rebuttals

Both reviews were accepted in full and nothing is disputed. I checked each factual claim against the
code before changing the plan. During the reviews HEAD moved only by porch's build-complete commit
and the thread-log commit, and the working-tree change Claude saw was my own edit for Codex's points.

## Codex (REQUEST_CHANGES)

1. **Decision images can't use `requestPreservingBody`.**
   - **Confirmed:** it calls `response.text()` and parses JSON (`tower-client.ts:1025`).
   - **Change:** Phase 6 adds a private `requestBinary` with the same key, base URL and timeout. It
     returns bytes and a content type on 2xx, keeps the JSON body on a non-2xx, and never rejects.
     Reads and rulings stay on `requestPreservingBody`.
2. **`.builders/` directories alone give zero builders.**
   - **Confirmed:** `/api/overview` filters discovered worktrees against `activeBuilderRoleIds`,
     taken from the rehydrated terminal registry (`tower-routes.ts:1440`, `overview.ts:1098`).
   - **Change:** each fixture builder is a real worktree plus a builder terminal registered through
     the existing `POST /api/terminals` (`type: 'builder'`, `roleId`, `workspacePath`, `cwd`,
     harmless shell command).
   - Each fixture's `shell.architect` and `shell.builder` are a plain shell, so no agent ever
     starts.
   - The harness asserts `/api/overview` before any screenshot and stops without faking data if it
     does not hold.
3. **Path code needs Windows coverage.**
   - **Change:** containment is `realpath` + `path.relative`, with no prefix compare.
   - `path.win32` table tests cover drive-letter case, separators, a different drive, UNC and
     prefix siblings. A junction case runs on the Windows runner.
   - The on-demand `windows.yml` run is dispatched on the branch and linked in the PR.

## Claude (COMMENT)

1. **`removeArchitect` on a Cockpit row.**
   - **Confirmed:** `extension.ts:1209` falls back to the label, `WEB (0)`.
   - **Change:** Phase 4 resolves a `BuilderGroupTreeItem` to its `groupName`, as an explicit
     deliverable with a unit test. The difference between the two architect sources (overview vs
     workspace terminals) is stated as accepted.
2. **Who owns the Decisions poll.**
   - **Confirmed:** `useDecisions` owns a 2 s interval gated on `isActive` and
     `document.visibilityState`.
   - **Change:** the hook stays the one owner. The host relays `onDidChangeViewState` as a
     visibility message, which drives `isActive`. A test asserts that no read happens while the
     panel is hidden.
3. **Build wiring.**
   - Phase 6 adds `src/workspace-views/webview` to `apps/vscode/tsconfig.json`'s `exclude`.
   - The new esbuild entries set `jsx: 'automatic'` with `tsconfig: 'tsconfig.webview.json'`.
   - A jsdom smoke test asserts the built bundle mounts.
4. **The Cockpit's `getParent` chain and ids.**
   - **Change:** Phase 3 gives the Tower root, workspace rows and the Dormant group stable ids.
   - `getParent` bridges each architect and idle container to its workspace, and each workspace to
     the root.
   - Tests cover the chain from file, builder, idle-sibling and architect rows, and a `reveal` that
     walks it. Both are listed as deliverables.
5. **Config listeners.**
   - **Change:** in Phase 3, the file-tree listener refreshes both providers. The accordion
     listener re-gates both views. Tests cover both.

Minor points, all accepted:

- 12 Agents item entries, not 13;
- the theme and live-switch scenario also runs for Decisions, in Phase 6;
- no `playwright install` in the harness (manual Chromium path, ask first);
- *Refresh* is noted as machine-global.
