# PIR Plan: SD+ Automatic diff press opens the builder's first file diff (dial-ready)

## Understanding

#1404 shipped the Builder Action **Automatic** press: it resolves the builder's
current-phase artifact and fires that verb. For an implement/review/verify builder
(or one blocked at `dev-approval` / `pr`), the resolver returns `view-diff`
(`apps/streamdeck/src/actions.ts:229,233`), which relays to `codev.viewDiff` and
opens the **multi-file aggregate** diff editor (`vscode.changes`).

For SD+ dial-driven review (#1410), the Files/Changes dials step **per-file**. The
right landing spot for a diff press is therefore the builder's **first file in
per-file diff mode**, seeded so the dials step forward from there — not the
aggregate editor.

The gap (verified against the code 2026-08-12):

- `diff-first-file` → `codev.diffFirstFile` → `navigateDiffToFirst`
  (`apps/vscode/src/commands/diff-nav.ts:188`) opens the first per-file diff **and**
  seeds dial navigation (via `recordDiffNavPosition` inside `openDiffAt`,
  `diff-nav.ts:158-166`). But it takes **no builder id**: `resolveDiffContext`
  (`diff-nav.ts:118-155`) resolves the builder from the active editor's diff-inject
  entry or the module-level `lastPosition`. Fired cold (no builder file diff open
  yet) it flashes "open a builder file diff first" and no-ops.
- `view-diff` → `codev.viewDiff` (`apps/vscode/src/commands/view-diff.ts:305`) is the
  only relay verb that opens a **specific builder's** diff by id, and it opens the
  aggregate editor.

So **no verb today means "open builder X's first file diff"**. This plan adds one
and points the Automatic diff branch at it. The explicit **View Diff** PI option
keeps opening the aggregate, unchanged.

### The unanswered "verify first" question (folds into the dev-approval hardware session)

The issue asks: after an Automatic `view-diff` press (aggregate open), do the SD+
dials already navigate? i.e. does the aggregate open populate `getDiffInjectEntry`
for the active editor, or `lastPosition`?

From the code: `viewDiff` registers diff-inject entries for the changed files
(`view-diff.ts:371-378`), so `getDiffInjectEntry(activeFsPath)` *could* resolve **if**
the active editor after a `vscode.changes` open happens to be one of the tracked
`file:` panes. But `viewDiff` never calls `recordDiffNavPosition`, so
`lastPosition` stays `undefined` after an aggregate open. Whether the multi-diff
editor leaves a tracked `file:` pane as `activeTextEditor` is exactly the hardware
unknown.

**This does not change the implementation** — the new verb takes an explicit builder
id and never depends on prior editor state, so it is robust either way. The hardware
answer only decides framing (polish vs broken-dial-flow) and whether a **follow-up**
is warranted for the touch-strip zoom-in path (`zoomInVerb`, which also hands off to
the diff dials and currently opens the aggregate the same way). The zoom-in path is
**out of scope** here; I will report the hardware finding and, if it is broken, ask
the architect to file a separate issue rather than expand this one.

## Proposed Change

### vscode side — a builder-id-scoped "open first file diff" path

1. **`apps/vscode/src/commands/diff-nav.ts`** — let `resolveDiffContext` accept an
   optional explicit seed and add a builder-scoped entry point:
   - Change the signature to
     `resolveDiffContext(deps: NavDeps, seed?: { builderId: string; relPath?: string })`.
     When `seed` is provided it replaces **only step 1** (the active-editor /
     `lastPosition` resolution); **steps 2 and 3 still run** — worktree resolution
     and the ordered-file load — so their existing user-visible flashes
     ("no worktree on record for X", "no changed files to navigate") fire on the
     seeded path exactly as on the editor-context path. Nothing about the seed turns
     an empty/absent case into a silent no-op or a throw; the defined outcome is the
     status-bar flash. `relPath` is optional because "first file" does not need a
     current position.
   - Add `export async function navigateBuilderDiffToFirst(builderId: string | undefined, deps: NavDeps)`:
     if `builderId` is falsy, `flash` a message and return (defined user-visible
     outcome, never a silent bail); else `resolveDiffContext(deps, { builderId })`
     and `openDiffAt(deps, ctx, 0)`. `openDiffAt` already calls
     `recordDiffNavPosition`, so `lastPosition` is seeded to file 1 and the dials
     step forward from there.

2. **`apps/vscode/src/extension.ts`** — register the command, mirroring the
   `codev.viewDiff` registration (`extension.ts:1156`) for arg handling:
   ```ts
   reg('codev.openBuilderDiffFirstFile', (arg: vscode.TreeItem | string | undefined) =>
     navigateBuilderDiffToFirst(extractBuilderId(arg),
       { context, overviewCache, diffCache: builderDiffCache })),
   ```
   (import `navigateBuilderDiffToFirst` alongside the existing `navigateDiffToFirst`).

3. **`apps/vscode/src/command-relay.ts`** — add the relay verb to `VERB_COMMANDS`
   (the provider-side allowlist), grouped with the other builder-scoped verbs:
   ```ts
   'open-diff-first': 'codev.openBuilderDiffFirstFile',
   ```

### streamdeck side — point the Automatic diff branch at the new verb

4. **`apps/streamdeck/src/actions.ts`** — in `BuilderAction.resolveVerb`
   (`actions.ts:154-159`), the **Automatic** branch: when the resolved phase artifact
   is `view-diff`, fire `open-diff-first` instead:
   ```ts
   protected override resolveVerb(settings: SlotSettings, b: OverviewBuilder): string {
     const verb = settings.verb;
     if (verb && verb !== 'automatic') return verb;      // explicit PI verb, incl. View Diff → view-diff
     const auto = phaseArtifactVerb(b) ?? 'open-terminal';
     return auto === 'view-diff' ? 'open-diff-first' : auto;
   }
   ```
   Only the Automatic press is remapped. `phaseArtifactVerb`, `zoomInVerb`, and
   `reviewMode` are **not** touched, so `reviewMode`'s `verb === 'view-diff'` check
   (`actions.ts:260`) and the touch-strip zoom-in keep their current behavior. The
   explicit **View Diff** PI option (`settings.verb === 'view-diff'`, from
   `builder-action.html:26`) still fires `view-diff` verbatim → aggregate.

No changes to `packages/types` (the verb is a free-form wire string; `CommandRequest.verb`
is `string`) and no server change (`packages/codev/.../command-relay.ts` is a pure
passthrough — "the verb allowlist + execution live provider-side").

## Files to Change

- `apps/vscode/src/commands/diff-nav.ts` — add optional `seed` param to
  `resolveDiffContext`; add `navigateBuilderDiffToFirst(builderId, deps)`.
- `apps/vscode/src/extension.ts:1264` area + import at `:14` — register
  `codev.openBuilderDiffFirstFile`; import `navigateBuilderDiffToFirst`.
- `apps/vscode/src/command-relay.ts:24-34` — add `'open-diff-first': 'codev.openBuilderDiffFirstFile'`.
- `apps/streamdeck/src/actions.ts:154-159` — remap the Automatic `view-diff` result to `open-diff-first`.
- `apps/vscode/src/__tests__/diff-nav.test.ts` — unit coverage for the seeded resolve / first-file open (see Test Plan).
- `apps/vscode/src/__tests__/command-relay.test.ts` — assert the new verb maps to the command.
- `apps/streamdeck/src/__tests__/actions.test.ts` — assert Automatic → `open-diff-first` for a diff-phase builder; explicit `view-diff` still verbatim; non-diff phases unchanged.

## Risks & Alternatives Considered

- **Risk: over-broad remap.** Changing `phaseArtifactVerb` directly would also flip
  `zoomInVerb` and break `reviewMode`'s `=== 'view-diff'` classification. *Mitigation:*
  remap locally in `BuilderAction.resolveVerb` only; leave the shared resolver intact.
- **Risk: cold-start no-op.** The old `diff-first-file` no-ops when fired cold. *Mitigation:*
  the new verb carries an explicit builder id, so `navigateBuilderDiffToFirst` never
  depends on prior editor state — it resolves the worktree + file list directly.
- **Risk: no changed files / no worktree.** *Mitigation:* reuses `resolveDiffContext`'s
  existing flashes ("no changed files to navigate", "no worktree on record for X").
- **Alternative: teach `codev.diffFirstFile` to accept an optional id** instead of a new
  command. Rejected — a distinct relay verb keeps the wire contract explicit ("open builder
  X's first file diff" vs the editor-context "reset to first"), and the SD+ diff-dial reset
  (`diff.first = 'diff-first-file'`, `actions.ts:657`) legitimately keeps the no-arg,
  context-based behavior.
- **Alternative: also remap the touch-strip zoom-in.** Deferred — out of this issue's scope;
  gated on the hardware finding and routed to the architect as a possible follow-up.

## Test Plan

**Unit (automated — run from the worktree):**
- `diff-nav.test.ts` (mocks `vscode.window.setStatusBarMessage` so the flash is
  observable, plus `openBuilderFileDiff` and the overview + diff cache deps):
  - **Happy path:** a seeded `{ builderId }` on a builder with changed files opens file
    index 0 via `openBuilderFileDiff` and records the nav position (`peekDiffNavPosition`
    → file 1).
  - **Empty diff (defined outcome, per main's review):** a seeded `open-diff-first` on a
    builder with **zero changed files** fires the `"no changed files to navigate"` flash
    (`setStatusBarMessage` called with that text) and does **not** call `openBuilderFileDiff`
    — asserted as a positive flash, not just "no open".
  - **No worktree (seeded path):** a seeded id whose builder has no worktree on record fires
    the `"no worktree on record for <id>"` flash and opens nothing.
  - **Falsy id:** `navigateBuilderDiffToFirst(undefined, …)` fires a flash and opens nothing
    (no throw).
- `command-relay.test.ts`: `open-diff-first` resolves to `codev.openBuilderDiffFirstFile`
  and forwards the builder-id arg; an unknown verb is still ignored.
- `actions.test.ts`: a diff-phase builder's Automatic press sends `open-diff-first`
  (`args: [id]`); an explicit `view-diff` PI verb still sends `view-diff`; a spec/plan-phase
  builder still sends `open-spec` / `open-plan`; an unknown-state builder still falls back
  to `open-terminal`.
- Build both packages: `pnpm --filter @cluesmith/codev-vscode build` and the streamdeck build.

**Manual — hardware SD+ session (this is the dev-approval gate check):**
1. Spawn/point at an implement- or review-phase builder with committed changes; put its
   Builder Action key on **Automatic**.
2. Press it → the **first** changed file opens in **per-file** diff mode (not the aggregate
   multi-file editor).
3. Rotate the Files/Changes dial forward → it steps to file 2, 3, … from that first file
   (dials seeded). Rotate back → steps toward file 1.
4. Switch the same key's PI to explicit **View Diff** → press still opens the **aggregate**
   multi-file editor (unchanged).
5. On a spec/plan-phase builder, Automatic still opens the canvas doc (spec/plan), unchanged.
6. **Answer the verify-first question:** before this change, does an Automatic press (old
   `view-diff`) leave the dials navigable? Record the finding in the review. If the dials
   were broken after the aggregate open, note that the touch-strip **zoom-in** path likely
   shares the defect and propose a follow-up issue to the architect (do not expand scope here).

**Cross-platform:** n/a (VS Code extension + Stream Deck plugin only; no mobile/web surface).
