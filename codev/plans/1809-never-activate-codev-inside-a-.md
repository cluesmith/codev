# PIR Plan: Never activate Codev inside a builder worktree; hide the Agents view there

## Understanding

The owner ruled (2026-10-13) that Codev must never activate inside a builder worktree
(`<root>/.builders/<id>`), and that the extension's Agents view must not render in such a
window at all. Today, opening a worktree as the VS Code folder makes it a workspace of its own.
Four places in the source cause this:

1. **Extension detection.** `apps/vscode/src/workspace-detector.ts:32-48`
   (`detectWorkspacePath`) accepts any opened folder that directly contains `codev/`. A builder
   worktree is a full checkout, so it matches; the comment at `:16-18` says so on purpose.
2. **Extension activation.** `connection-manager.ts:61-104` (`initialize`) connects with
   `codev.autoConnect`, auto-starts Tower with `codev.autoStartTower`, and `connect()` calls
   `activateWorkspace()` (`:205-221`), which POSTs `/api/workspaces/<worktree>/activate`.
3. **Tower.** `packages/codev/src/agent-farm/servers/tower-instances.ts:453` (`launchInstance`)
   checks only that the path exists and is a directory. It calls `registerKnownWorkspace`
   (`:491`) and spawns a `main` architect when none exists (`:506`). The only `.builders` check
   in that file is in the listing (`getInstances`, `:277`), which hides the path but does not stop
   activation. Three routes reach `launchInstance`: `POST /api/workspaces/:path/activate`
   (`tower-routes.ts:745`), `POST /api/launch` (`:2632`), and create-workspace (`:2578`).
   `afx workspace start` sends the worktree path when run inside one, because
   `findWorkspaceRoot` (`agent-farm/utils/config.ts:76-91`) deliberately returns a worktree that
   has its own `codev/` (#407).
4. **Agents view.** In `apps/vscode/package.json:1141`, `codev.agents` has no `when` clause.
   Every sibling view is gated on `codev.hasWorkspace`.

There are also two ways stale rows come back after the fact:
- On boot, `reconcileTerminalSessions` (`tower-terminals.ts:621`) reattaches any live shellper.
  For a reattached session it calls `registerKnownWorkspace` again (`:894`). For a stray
  worktree architect, that rewrites the `.builders` known-workspace row on every Tower start.
- `getKnownWorkspacePaths()` (`tower-instances.ts:215`) unions `known_workspaces`,
  `terminal_sessions` and memory. The cron scheduler reads it unfiltered (`tower-cron.ts:91`,
  `:175`), so stale worktree paths also leak into cron.

Nothing in Tower prunes `known_workspaces` or `architect` rows today. `codev doctor` does not
touch global.db.

## Decision: attach a worktree window to its parent workspace, read-only

The issue leaves one decision to the plan: should a worktree window attach to its parent
workspace (`mainCheckoutRoot`) or stay fully disconnected?

**Recommendation: attach, read-only.** In a worktree window, the extension uses the parent root
(`<root>`) as its Tower workspace path. It connects only to a Tower that is already running. It
never auto-starts Tower and never POSTs `activate`, either for the worktree or for the parent.
If the parent is not active in Tower, Tower-backed features find no data and degrade the same
way they do when Tower is offline. The worktree window never creates a workspace, an architect,
or a known-workspace row.

How this affects each worktree-aware feature:

| Feature | Today (phantom workspace) | Fully disconnected | **Attach read-only (recommended)** |
|---|---|---|---|
| Markdown preview and review comments (`markdown-preview/preview-provider.ts`) | Works. Comments are REVIEW markers written into the local file, with no Tower involved. | Works the same way. | Works the same way. |
| Preview canvas-view registration (spec 1401, `canvas-view-registry.ts:87`) | Registers under the phantom worktree workspace, which no controller targets. | Never registers, so a controller cannot drive the preview. | Registers under `<root>`, which a controller targeting the real workspace can find. This is an improvement. |
| Worktree dev controls (`dev-shared.ts`, `views/workspace.ts:131`, `commands/run-workspace-dev.ts`) | The dev PTY registers under the phantom workspace, so the "one dev slot across main + builders" swap cannot see main's dev. Config resolves from the worktree, which lacks the gitignored `.codev/config.local.json`. | Broken: dev needs Tower. | The dev PTY registers under `<root>`, so the single-slot swap works across main and builders. Config resolves from `<root>`, including `config.local.json`. **Required change:** the dev target must come from the window root, not `getWorkspacePath()`, or it would resolve to `main`. |
| `openWorktreeWindow` (`commands/open-worktree-window.ts`) | Runs in the main window and opens the worktree window. In a worktree window it lists the phantom's builders, which is none. | Main window unchanged. Errors in a worktree window. | Main window unchanged. In a worktree window it lists the parent's builders, which is correct. |
| `mainCheckoutRoot` (`terminal-resolve.ts:105`, used by `terminal-manager.ts:303` for recover) | Strips `/.builders/<id>` so `afx workspace recover` runs from main. | Unused: no terminals. | The input is already `<root>`, so the result is the identity, still correct. The function becomes a thin wrapper over the shared sdk predicate, so the regex lives in one place. |
| Review-queue Submit Review (`review-queue/submit.ts`, which opens a builder terminal) | Fails: the phantom overview has no builders. | Fails. | Works when the parent is active: it opens the builder's terminal through the parent's overview. |

Under attach, two surfaces would start showing parent data in a worktree window. Each needs a
ruling, so I state a default for each:

- **Activity hooks** (`fireActivity` for `window-focus` and `builder-active`). Hooks open URLs
  using the `{workspace}` value. Firing `window-focus` for `<root>` whenever a worktree window
  gains focus would tell a companion that the main workspace is focused, which is wrong.
  **Default: suppress activity hooks in worktree windows** (no-op).
- **The Workspace view** (`views/workspace.ts`), which holds Architects, Dashboard, Spawn
  Builder, New Shell, Dev and Open Dev URL. Under attach, its Architects rows would open the
  parent's real architect terminals from a worktree window. **Default: in a worktree window,
  show only the worktree-scoped rows (Dev, Open Dev URL, Dashboard).** Hide Architects, Spawn
  Builder and New Shell, because they act on the parent workspace. Backlog, Pull Requests,
  Recently Closed, Team and Status are read-only views at repo level; they keep their current
  gating and show the parent's data.

**Why not fully disconnected:** it is simpler, but it breaks worktree dev controls and canvas
registration outright, and the owner listed dev controls as a feature to keep. **Why not attach
and activate the parent:** activating `<root>` from a worktree window would spawn main's
architect as a side effect of opening a worktree. That is the same class of surprise this issue
removes.

## Proposed Change

### A. Shared predicate in the sdk (for main: Tower and sdk surface)

New module `packages/sdk/src/builder-worktree.ts`, exported as
`@cluesmith/codev-sdk/builder-worktree`. It is pure string logic: environment-agnostic, zero
dependencies, no `node:*` imports, so it passes the #1189 boundary tests.

```ts
/** Parsed builder-worktree location, or null when the path is not inside one. */
export interface BuilderWorktreeLocation {
  /** The parent workspace root: the prefix before the final `/.builders/` segment. */
  workspaceRoot: string;
  /** The builder id: the segment directly after `.builders/`. */
  builderId: string;
  /** `<workspaceRoot>/.builders/<builderId>` */
  worktreePath: string;
}
export function parseBuilderWorktreePath(p: string): BuilderWorktreeLocation | null;
export function isBuilderWorktreePath(p: string): boolean;
```

- It matches a `.builders/<id>` segment with either `/` or `\` as separator, both for the
  worktree itself and for any path under it, and tolerates a trailing separator.
- It uses the **last** `.builders/` segment, the same rule as `deriveWorkspaceFromWorktree`
  (`agent-farm/state.ts:36-48`).
- It does not match `.builders` alone with no id, or a name such as `x.builders`.
- Tower (`packages/codev`) already depends on `@cluesmith/codev-sdk` and re-exports sdk helpers
  (for example `agent-farm/utils/architect-name.ts`), so both sides consume this one function.
  Per #1189, only codev-core is barred from importing the sdk.

### B. Tower refuses to activate a builder worktree (for main)

- At the top of `launchInstance` (`tower-instances.ts:453`), before the existence check, the
  adopt step and `registerKnownWorkspace`, add:

  ```ts
  const worktree = parseBuilderWorktreePath(workspacePath);
  if (worktree) {
    return { success: false, error:
      `Refusing to activate a builder worktree (${worktree.worktreePath}). ` +
      `Builder worktrees are managed by their parent workspace; activate ${worktree.workspaceRoot} instead.` };
  }
  ```

  The check runs on the raw path and again after `fs.realpathSync`, so a symlinked path cannot
  get around it. All three routes (`/activate`, `/api/launch`, create-workspace) go through
  `launchInstance`, so one guard covers them. The `/activate` route already maps a failure to
  `400 {success:false,error}`. The sdk's `activateWorkspace` surfaces that string, and
  `afx workspace start` prints it via `fatal(...)` (`commands/start.ts:48-49`).
- Defence in depth: `registerKnownWorkspace` (`:199`) becomes a no-op for a worktree path. This
  stops the boot reconcile at `tower-terminals.ts:894` from rewriting the row when it reattaches
  a live stray architect. That session stays live; it just isn't registered as a workspace.
- `addArchitect` (`:993`) already refuses a workspace that isn't active, so it cannot start a
  worktree workspace on its own. No change needed there.
- The listing guard at `:277` and the seven `!p.includes('/.builders/')` filters in
  `tower-routes.ts` stay as they are. I switch the `:277` guard to the predicate so it shares
  the rule. The route filters keep their current semantics, and changing them is out of scope.
- `getKnownWorkspacePaths()` filters out worktree paths, so listing, cron and activation no
  longer see them. The current unfiltered union moves to a new accessor,
  `getAllKnownWorkspacePaths()`, and `getKnownWorkspacePaths()` becomes that list minus
  worktree paths.
- **Stop must still reach a live stray (main's condition on B).** The deactivate route
  (`tower-routes.ts:757-768`) returns 404 "Workspace not found" unless the path is in
  `getKnownWorkspacePaths()`. With that list filtered, `afx workspace stop` run from a live
  stray worktree would hit the 404, leaving section C's remedy hint pointing at a command that
  fails. So the route's `isKnown` check switches to the unfiltered `getAllKnownWorkspacePaths()`.
  That list includes the stray's in-memory terminal entry and its `terminal_sessions` row, so a
  live stray stays reachable. `stopInstance` itself is unchanged. The filtered list stays
  limited to listing, cron and activation; stop/deactivate is the only consumer of the
  unfiltered one.

### C. Stale-row cleanup pass on Tower startup (for main)

New function `pruneBuilderWorktreeWorkspaces()` in `tower-instances.ts`. It runs once per boot
in `tower-server.ts`, right after `reconcileTerminalSessions()` (`:707`), when the in-memory
terminal maps are populated and liveness is known.

**Boot order (main's condition):** reconcile, then prune, then the #341 orphan-shellper kill
(`killOrphanedShellpers`, `tower-server.ts:~723`). Liveness is decided before anything is
killed. The prune itself never kills anything.

- Candidates: every distinct `workspace_path` in `known_workspaces` and `architect` for which
  `isBuilderWorktreePath` is true.
- **Liveness check for each candidate path.** The path counts as live if any of these holds:
  - its in-memory `workspaceTerminals` entry has an architect, builder or shell, which means
    reconcile reattached it;
  - a `terminal_sessions` row for that path has a `shellper_pid` for which
    `processExists(pid)` is true, the same rule reconcile Phase 2 uses (`tower-terminals.ts:944-951`,
    bugfix #1686).
- **Not live:** in one transaction, delete that path's `known_workspaces` row, `architect`
  rows, and leftover `terminal_sessions` rows. Log one INFO line with the counts. Builders,
  mailbox and cron rows are not touched: these phantom workspaces never had builders spawned
  from them, and `builders` rows under worktree paths are not part of this issue.
- **Live:** never killed, never signalled, rows kept. Log one WARN line per live path, naming
  the path and terminal ids, with the hint "stray architect in a builder worktree; stop it with
  `afx workspace stop` from that worktree". That remedy works because the deactivate route
  keeps the unfiltered check (see B), and a test covers it. It is reported again on every boot
  until someone stops it, after which the next boot prunes its rows.
- **Exactly one INFO line per boot** with the counts (paths pruned, rows deleted, live paths
  kept). It is logged even when every count is zero, so a quiet boot is visible.
- **Why a startup pass and not a one-time global.db migration:** migrations run in `db/index.ts`
  before reconcile, so they cannot see liveness. A one-time migration would also leave behind
  the rows of sessions that were live when it ran. The pass is idempotent and costs one indexed
  query per boot.
- `codev doctor` does not touch global.db today, and I don't add that here (scope). The Tower
  log is where these lines are reported.

### D. Extension: detector, connection manager, context key, views

- **`workspace-detector.ts`.** Add `detectWorkspace(): DetectedWorkspace`, which returns one of:
  - `{ kind: 'root', path }`
  - `{ kind: 'builder-worktree', path: <worktree>, workspaceRoot, builderId }`
  - `null`

  It uses `parseBuilderWorktreePath` from the sdk. The `codev.workspacePath` override goes
  through the same classification. `detectWorkspacePath()` stays: it now returns the
  **Tower-facing** path, which is `workspaceRoot` for a worktree, so existing callers
  (`extension.ts:202`, `:222`, `:1743`) keep their meaning. Update the comment at `:16-18`.
- **`connection-manager.ts`.**
  - Store the `DetectedWorkspace`. `getWorkspacePath()` returns the Tower-facing path (the
    parent root in a worktree window).
  - Add `getBuilderWorktree(): { builderId, worktreePath } | null` and
    `getWindowRoot(): string | null`.
  - In a worktree window:
    - `initialize()` connects but skips `autoStartTower`, and logs
      `Builder worktree window: attached read-only to <root>; not activating`;
    - `reconnect()` skips `autoStartTower`;
    - `activateWorkspace()` returns early, with no POST.
- **`extension.ts`.**
  - Set a new context key `codev.isBuilderWorktree` next to `codev.hasWorkspace` (`:217-224`),
    kept in sync on folder changes the same way.
  - The activation tier stays `full`: this is still a codev window, so the preview, commands,
    status bar and read-only views register as they do now.
  - Preflight (`:1743`) is unchanged.
  - `fireActivity` call sites (`:320`, `:358`, `:398`, `:560`, `:725`, and
    `preview-provider.ts:167`) all pass `connectionManager.getWorkspacePath()`. Suppress them
    centrally: `fireActivity` gets the worktree flag through a small setter in
    `activity-hooks.ts`, the same shape as its existing `deliveryDisabled`.
- **`package.json`.** Give `codev.agents` the clause **`"when": "!codev.isBuilderWorktree"`**,
  so in a worktree window the view is absent, not empty. The issue suggested
  `codev.hasWorkspace && !codev.isBuilderWorktree`, but that would also hide the view in empty
  and non-codev windows. There, the view hosts the three viewsWelcome onboarding quadrants
  (`:1155-1170`, which require `!codev.hasWorkspace`). The chosen clause leaves every
  non-worktree window exactly as it is today.
- **Dev target from the window root.** `views/workspace.ts:131-132` and
  `commands/run-workspace-dev.ts:22-40` call `resolveWorkspaceDevTarget(getWindowRoot())`, not
  `getWorkspacePath()`. `resolveWorkspaceDevTarget` is reimplemented on the sdk predicate.
- **Workspace view trim** (the default from the Decision section). When `getBuilderWorktree()`
  is set, the Workspace view omits the Architects, Spawn Builder and New Shell rows.
- **`terminal-resolve.ts:105`.** `mainCheckoutRoot` becomes
  `parseBuilderWorktreePath(p)?.workspaceRoot ?? p`, with its behaviour pinned by the existing
  tests.

## Files to Change

**sdk (main):**
- `packages/sdk/src/builder-worktree.ts`: new; the predicate.
- `packages/sdk/package.json`: add the `./builder-worktree` export.
- `packages/sdk/src/__tests__/builder-worktree.test.ts`: new; unit tests.

**Tower (main):**
- `packages/codev/src/agent-farm/servers/tower-instances.ts`:
  - `:199`: `registerKnownWorkspace` guard;
  - `:215`: `getKnownWorkspacePaths` filter; new unfiltered `getAllKnownWorkspacePaths()`;
  - `:277`: listing guard switched to the predicate;
  - `:453`: the `launchInstance` refusal;
  - new `pruneBuilderWorktreeWorkspaces()`.
- `packages/codev/src/agent-farm/servers/tower-routes.ts:~758`: the deactivate route's
  `isKnown` uses `getAllKnownWorkspacePaths()`.
- `packages/codev/src/agent-farm/servers/tower-server.ts:~707`: call the prune pass after
  reconcile and before the #341 orphan sweep.
- `packages/codev/src/agent-farm/__tests__/`: new tests for the refusal (no row written, no
  architect spawned), the `registerKnownWorkspace` no-op, and the prune pass (dead rows deleted,
  live rows kept and reported, non-worktree rows untouched, one INFO count line per boot), and
  the deactivate condition: a live stray worktree workspace can be stopped through
  `/deactivate` (no 404), and its rows then prune on the next boot.

**Extension (vscode):**
- `apps/vscode/src/workspace-detector.ts`: `detectWorkspace()`, tagged result.
- `apps/vscode/src/connection-manager.ts`: worktree mode (no auto-start, no activate),
  `getBuilderWorktree()`, `getWindowRoot()`.
- `apps/vscode/src/extension.ts:~217-224`: `codev.isBuilderWorktree` context key; activity-hook
  suppression wiring.
- `apps/vscode/src/activity-hooks.ts`: worktree suppression flag.
- `apps/vscode/package.json:1141`: `codev.agents` `when` clause.
- `apps/vscode/src/views/workspace.ts`: dev target from the window root; trim rows in worktree
  windows.
- `apps/vscode/src/commands/run-workspace-dev.ts`: dev target from the window root.
- `apps/vscode/src/commands/dev-shared.ts:45`: `resolveWorkspaceDevTarget` on the predicate.
- `apps/vscode/src/terminal-resolve.ts:105`: `mainCheckoutRoot` on the predicate.
- `apps/vscode/src/__tests__/`:
  - `workspace-detector.test.ts`: extend with the worktree classification;
  - new connection-manager worktree-mode test (no `activateWorkspace` or `autoStartTower`
    call);
  - manifest test asserting the `codev.agents` clause;
  - dev-target test.

No skeleton or doc mirror is needed: this changes code, not framework files. I will grep
`codev/` and `codev-skeleton/` for prose saying worktrees "match directly" or activate, and fix
anything that does.

## Risks & Alternatives Considered

- **Risk: a legitimate workspace whose path contains `/.builders/<x>/`** (someone keeps repos
  under a `.builders` folder). The refusal would block it. The convention is codev-owned, and the
  listing guard and seven route filters already treat such paths as non-workspaces, so this
  makes existing behaviour consistent rather than introducing it. The error message names the
  rule.
- **Risk: the prune pass deletes a row that is still needed.** It deletes only for worktree
  paths, never when a live shellper or in-memory terminal exists, and never touches processes.
  Once B is in place, no worktree path can be a real workspace.
- **Risk: attach mode surfaces parent data where it is unwanted.** This is handled by the two
  defaults above (hooks suppressed, Workspace view trimmed). Both are explicit gate items the
  owner can flip.
- **Risk: existing stray architects keep running.** By the ruling they are not killed. They are
  reported every boot, and the user stops them.
- **Alternative: detect worktrees with `git rev-parse --git-common-dir`.** Rejected, as the
  issue suggests: it adds a process spawn to activation and in Tower, and the `.builders` path
  convention is already the invariant `afx spawn` creates.
- **Alternative: a client-side check in `afx workspace start`.** Not needed. Tower's error
  string is printed verbatim, so one server-side guard covers the CLI, the extension, the web
  launch UI and any other client.
- **Ordering with #1803 (main's cross-link).** #1803 adds a startup pass that re-adopts a
  responsive, unregistered shellper whose WELCOME names a known workspace and role. It lives in
  the same region of `tower-server.ts`. Whichever lands second rebases. Once the re-adopt step
  exists it must run **before** this prune, so a re-adopted worktree architect counts as live
  and is reported instead of pruned. The order becomes reconcile, re-adopt, prune, then the
  orphan kill.
- **Alternative: a one-time global.db migration (v19) for the cleanup.** Rejected; see C. It
  cannot check liveness.

## Test Plan

**Unit:**
- sdk predicate:
  - POSIX and Windows separators;
  - a worktree and a nested file inside it;
  - a trailing slash;
  - a nested `.builders` (last segment wins);
  - non-matches: `.builders` with no id, `x.builders/y`, a plain root.
- Tower:
  - `launchInstance('<tmp>/.builders/x')` returns `success:false` with the message, writes no
    `known_workspaces` row, and calls no terminal-manager spawn;
  - `registerKnownWorkspace` with a worktree path writes nothing;
  - prune: a dead worktree row is deleted, a worktree path with a live shellper pid or
    in-memory entry is kept and logged at WARN, and a normal workspace row is untouched;
  - deactivate: `POST /api/workspaces/<stray worktree>/deactivate` on a live stray returns 200
    and stops it. A later prune pass then deletes its rows. `getKnownWorkspacePaths()` excludes
    the path, while `getAllKnownWorkspacePaths()` includes it.
- Extension:
  - the detector classifies root, worktree and override-pointing-at-worktree correctly;
  - the connection manager in worktree mode never calls `activateWorkspace` or
    `autoStartTower`, and `getWorkspacePath()` is the parent root;
  - the manifest has the `codev.agents` clause;
  - the dev target in a worktree window is the builder id.
- `pnpm build` and the full test suites for `packages/sdk`, `packages/codev` and `apps/vscode`,
  plus `check-types` (vitest does not type-check).

**Manual, at the dev-approval gate.** The extension is built from this worktree
(`pnpm --filter codev-vscode... build`, then `pnpm --filter codev-vscode vsix`), and the VSIX
is installed. Tower runs from this worktree's build.
1. Open a builder worktree folder in VS Code with Tower running. Then confirm:
   - the Tower log has no `activate` for that path;
   - `afx status` shows no new architect;
   - `sqlite3 ~/.agent-farm/global.db "select * from known_workspaces where workspace_path like '%/.builders/%'"`
     has no new row;
   - the **Agents view is absent** from the sidebar;
   - the Output channel logs "attached read-only".
2. In that window, open a plan in the Codev Markdown Preview and add, edit and delete a review
   comment: the markers are written to the file.
3. In that window, use the Workspace view's Dev row: the dev PTY starts for the builder id, and
   in the main window the dev slot shows it, so swap works.
4. In the main window: Agents view present, `openWorktreeWindow` opens the worktree window, dev
   controls work. This is the regression check.
5. In a terminal inside a worktree, run `afx workspace start`. It fails with
   `Failed to activate workspace: Refusing to activate a builder worktree (...); activate <root> instead.`
6. Restart Tower:
   - the log shows the prune counts;
   - the stale `.builders` rows are gone, apart from live ones;
   - live stray architects are listed at WARN and still running (`afx status` / `ps`);
   - for one live stray, run `afx workspace stop` from its worktree. It stops, and is not a 404.
     Restart Tower again: that stray's rows are pruned.
7. An empty window and a non-codev folder: unchanged (the welcome quadrants still show).
