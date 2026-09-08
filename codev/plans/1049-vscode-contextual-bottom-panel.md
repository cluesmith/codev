---
approved: 2026-08-24
validated: [gemini, codex, claude]
---

# Plan: VSCode Contextual Bottom Panel (mode resolver + Attention fallback)

**Specification**: [codev/specs/1049-vscode-contextual-bottom-panel.md](../specs/1049-vscode-contextual-bottom-panel.md)

> **v3 (final — post-dev-approval simplification).** The shipped panel is **purely contextual**: no pills, no summary ⇄ detail, no drill-in, no transient navigation, no cross-builder lists (sidebar owns those). The resolver is `(SurfaceContext) → { kind, context }`; Attention is the **fallback view** when no artifact/diff/terminal is active, not a selectable mode. The `#921` Codev Dev **panel view was removed** (status-bar chip stays). Phase 4 (pills / summary stubs / navigation) and the pill-gesture / summary / applicability material below are **SUPERSEDED**; see issue #1049.

## Executive Summary

The spec's recommended substrate is a **webview-view panel** (Approach 1): a `WebviewViewProvider` registered in the `codevPanel` container, with a pure host-side `ModeResolver` feeding a React webview. This plan follows that, refined to the **React** variant (the `MarkdownPreviewProvider` lineage: an esbuild IIFE bundle mounting React via `React.createElement` — **no JSX**, matching `src/markdown-preview/webview/main.ts`), so Document Review's future content can host `<ArtifactCanvas>` without a rewrite. It is the first `WebviewViewProvider` in the extension.

Four dependency-ordered phases mirror the spec's umbrella boundary — skeleton + resolver + switching + minimal navigation stubs, *no* real mode content:

1. **Mode resolver + contract types** — the pure, VSCode-free decision core (load-bearing; fully unit-testable in isolation).
2. **Panel surface + placeholder retirement** — the webview tab exists and renders a static shell; the vestigial `codev.placeholder` and its dead context-key flip are retired; manifest-invariant tests updated.
3. **Context adapter + contextual mode switching** — tab-based `SurfaceContext` derivation, the trigger set (including the terminal-exit last-focus proxy), and resolver→webview wiring so the panel follows the active surface.
4. **Transient navigation + minimum summary stubs** — clickable pills and summary-list drill-in as transient (never-persisted) navigation, cleared only on an actual surface transition.

**Cross-cutting implementation rules (architect-directed), applied across phases 2–4:**
- **Extension-local types.** `SurfaceContext`, `ManualSelection`, `ModeDescriptor`, and the webview message types are **extension-internal** and live under `apps/vscode/src/contextual-panel/` — deliberately **not** in `@cluesmith/codev-types` (wire contracts only; the only boundary these cross is this extension's own `postMessage`, which is not a published contract). If [#1549] later extracts primitives, presentation types may move into artifact-canvas; they still never enter codev-types unless an out-of-extension consumer appears.
- **Local primitives with extraction seams for [#1549].** Build UI primitives (pill/segmented-header, list, row, empty-state) locally under `src/contextual-panel/webview/components/` with clean seams; do **not** pre-build a shared layer. #1549 extracts from proven code.
- **No mode content.** Every mode body is a placeholder; the only real data touched is Phase 4's minimal builder-id list (cheap enumeration) for the summary stub.

**Render targets — six, mapped to the spec's "seven".** The plan implements six targets: (1) Document Review *detail*; (2) Code Review *summary* + (3) *detail*; (4) Builder Inspector *summary* + (5) *detail*; (6) Attention *summary*. The spec's Success Criteria says "seven in total" but then **enumerates these same six** (`Document Review (detail only) … Code Review (summary + detail), Builder Inspector (summary + detail), Attention (summary only)` = 1 + 2 + 2 + 1 = 6). So "seven" is a **miscount of the spec's own list, not a dropped or merged target** — the divergence is documentation only (no scope change). The frozen spec is left untouched; this line is the reconciliation.

**Contract-surface note (process):** the **[CONTRACT SURFACE]** sections (Phase 1 types; Phase 3 `SurfaceContext` derivation + trigger set + exit proxy; Phase 4 message contract) were routed to the architect, who returned four notes (all folded below). Because cmap forced a shape change to `SurfaceContext` (independent predicate signals, so precedence lives in the resolver), the revised contract surfaces are re-flagged to the architect before the plan gate.

## Phases (Machine Readable)

<!-- REQUIRED: porch parses this JSON to track phase progress. Keep it in sync when you add or remove phases; at least two phases. -->

```json
{
  "phases": [
    {"id": "phase_1", "title": "Mode resolver + contract types"},
    {"id": "phase_2", "title": "Panel surface + placeholder retirement"},
    {"id": "phase_3", "title": "Context adapter + contextual mode switching"},
    {"id": "phase_4", "title": "Transient navigation + minimum summary stubs"}
  ]
}
```

## Phase Breakdown

### Phase 1: Mode resolver + contract types

**Dependencies**: None

#### Objective

Deliver the pure, synchronous, VSCode-free decision core — the load-bearing surface — so it can be exhaustively unit-tested before any UI exists.

#### Files to Create / Modify

- Create `apps/vscode/src/contextual-panel/types.ts` — extension-local contract types (below).
- Create `apps/vscode/src/contextual-panel/resolver.ts` — `resolveMode(surface, selection)`.
- Create `apps/vscode/src/__tests__/contextual-panel-resolver.test.ts` — Vitest suite (**note the path: `src/__tests__/`, the only dir `vitest.config.ts` `include: ['src/__tests__/**/*.test.ts']` picks up**).

#### [CONTRACT SURFACE] Contract definition (extension-local, NOT codev-types)

- `ModeKind = 'document-review' | 'code-review' | 'builder-inspector' | 'attention'`; `ModeLevel = 'summary' | 'detail'`.
- **`SurfaceContext` carries independent predicate signals** (not a single pre-resolved discriminator), so the resolver applies precedence and overlap is genuinely testable:
  ```
  SurfaceContext {
    artifact?:        { resourcePath: string; builderId?: string };  // builderId when housed under .builders/<id>/
    builderDiff?:     { builderId: string };
    builderTerminal?: { builderId: string };  // present only when the terminal is the last-focused surface (Phase 3)
  }
  ```
  `other`/`none` = all three absent.
- `ManualSelection` (transient, never persisted): `{ mode: ModeKind, builderId?: string }`.
- `ModeDescriptor`: `{ kind: ModeKind, level: ModeLevel, context: { builderId?: string; resourcePath?: string }, applicability: Record<ModeKind, boolean> }`.
- **Precedence (locked by spec):** `builderTerminal → builderDiff → artifact → attention`. A `ManualSelection`, when present, overrides contextual resolution.
- **Applicability:** Code Review, Builder Inspector, and Attention are always applicable-for-navigation; Document Review is applicable only when an `artifact` predicate is present. **A worktree artifact whose `builderId` is derivable additionally marks Code Review + Builder Inspector applicable, scoped to that builder** (richer context for free — architect note A2).
- **Never emits `{ kind: 'document-review', level: 'summary' }`** — *rationale: Document Review is inherently file-scoped and has no cross-builder summary level* (architect note A5).
- **Never throws** — unknown/empty input degrades to `attention`.

#### Deliverables

- [ ] `types.ts`, `resolver.ts` per the contract.
- [ ] Unit tests: each predicate → mode+level; **precedence overlap** (`artifact` + `builderDiff` both present → `code-review`); worktree-artifact builderId → Document Review detail *and* builder-scoped applicability; `ManualSelection` overrides; summary vs detail; attention fallback; applicability matrix; never-`{document-review,summary}`; malformed input → attention (no throw).

#### Acceptance Criteria

- [ ] Resolver pure/synchronous; no VSCode/`node:` imports; no I/O.
- [ ] Precedence encoded once, asserted by the overlap test.
- [ ] `pnpm --filter codev-vscode test:unit` runs and passes the new suite (verified non-vacuous — the file is under `src/__tests__/`); `check-types` clean.

#### Test Plan

Vitest only (no VSCode host). One `describe` per resolver branch + applicability matrix + malformed-degradation.

---

### Phase 2: Panel surface + placeholder retirement

**Dependencies**: Phase 1 (for `ModeKind` / the pill set)

#### Objective

Make the contextual `Codev` tab exist and render a static themed shell (header + four pills + empty body), retiring the vestigial placeholder and its dead context-key flip in the same change. `Codev Dev` untouched.

#### Files to Create / Modify

- Modify `apps/vscode/package.json` — in `contributes.views.codevPanel`, **remove** the `codev.placeholder` entry and **add** `{ "id": "codev.contextualPanel", "name": "Codev", "type": "webview" }` (**`"type": "webview"` is required** — a `WebviewViewProvider` on a view lacking it does not render). `codev.dev` unchanged. (View id decision: new `codev.contextualPanel`; `codev.placeholder` removed entirely so the grep-clean criterion is satisfiable.)
- Create `apps/vscode/src/contextual-panel/panel-provider.ts` — the `WebviewViewProvider` (`resolveWebviewView`): builds HTML with nonce/CSP/`localResourceRoots` (modeled on `src/markdown-preview/preview-template.ts`), loads the bundled script; static shell this phase. **(Relocated to Phase 3 after cmap:** the descriptor cache + re-post on `onDidChangeVisibility` is inseparable from descriptor *posting*, which Phase 3 introduces — in Phase 2 there is no descriptor to cache, so the mechanism would be dead, untested scaffolding. It is a Phase 3 deliverable, not dropped.)
- Create `apps/vscode/src/contextual-panel/webview/main.ts` — React entry via `React.createElement` (no JSX), rendering header + pills + empty body.
- Create `apps/vscode/src/contextual-panel/webview/components/` — local primitives (`Pill`, `HeaderStrip`), `createElement` style; extraction seams for [#1549].
- Modify `apps/vscode/esbuild.js` — add a webview bundle entry `src/contextual-panel/webview/main.ts` → `dist/webview/contextual-panel.js`, mirroring `webviewConfig`.
- Modify `apps/vscode/tsconfig.json` — add `src/contextual-panel/webview` to `exclude`; and `apps/vscode/tsconfig.webview.json` — add it to `include` (so browser DOM type-checking is correct and `check-types` — which runs both configs — passes).
- Modify `apps/vscode/src/extension.ts` — register via `registerWebviewViewProvider('codev.contextualPanel', provider, { webviewOptions: { retainContextWhenHidden: true } })`, injecting `extensionUri` only. **DI-when-needed:** `TerminalManager` (Phase 3) and `OverviewCache` / `ReviewQueueStore` (Phase 4) are added to the constructor in the phase whose code uses them — injecting them here, unused, would be dead params tripping `noUnusedLocals`. **Retire the dead `setContext 'codev.panelContainerEmpty' false` flip (~:555) and its stale `#813/#814/#815 "sibling tabs"` comment (~:552).**
- Delete `apps/vscode/src/views/panel-placeholder.ts` + its registration (the stale `#813/#814/#815` body/tooltip text at lines 18/20 goes with it).
- **Delete** `apps/vscode/src/__tests__/panel-placeholder.test.ts` (its subject `PanelPlaceholderProvider` is removed). Modify `contributes-panel.test.ts` (drop the placeholder/`panelContainerEmpty` assertions; **keep** its sidebar-view-list and `PANEL_REVEALED_KEY` assertions) and `contributes-dev.test.ts` (update its placeholder reference).

#### Deliverables

- [ ] `codev.contextualPanel` webview view registered, always present, `"type": "webview"`, rendering a static header + four pills + empty body.
- [ ] `panel-template.ts` CSP/nonce hardening unit-tested (nonce bound into CSP + script tag, no inline/wildcard scripts, resources scoped to `cspSource`). *(Visibility cache + re-post relocated to Phase 3 — see Files above.)*
- [ ] Placeholder provider, registration, the `panelContainerEmpty` flip, and the `#813/#814/#815` text/comment removed.
- [ ] esbuild produces `dist/webview/contextual-panel.js`; both tsconfigs updated.
- [ ] `panel-placeholder.test.ts` deleted; `contributes-panel.test.ts` / `contributes-dev.test.ts` updated (non-placeholder assertions preserved).
- [ ] Webview hardened: nonce CSP, constrained `localResourceRoots`.

#### Acceptance Criteria

- [ ] Panel shows one contextual `Codev` tab + the untouched `Codev Dev` tab.
- [ ] No reference to `codev.panelContainerEmpty` or `codev.placeholder` remains (grep-clean).
- [ ] `test:unit` and `check-types` (both tsconfigs) pass; extension + webview bundles build.

#### Test Plan

Updated manifest text-invariant tests (contextual view contributed with `"type":"webview"`; `codev.dev` remains; placeholder/gate gone; sidebar/reveal assertions intact). Manual: launch the Extension Development Host, open the bottom panel, confirm the `Codev` tab renders the shell, collapse+reopen it (shell persists), `Codev Dev` unaffected.

---

### Phase 3: Context adapter + contextual mode switching

**Dependencies**: Phase 1, Phase 2

#### Objective

Wire the panel to follow the active surface: derive `SurfaceContext` from the active tab (+ last-focus state), re-resolve on real transitions, and render the resolved mode's pill + a per-mode detail placeholder.

#### Files to Create / Modify

- Create `apps/vscode/src/contextual-panel/surface-context.ts` — the adapter (derivation + last-focus tracking + surface-identity comparison).
- Modify `apps/vscode/src/contextual-panel/panel-provider.ts` — trigger wiring; call `resolveMode`; `postMessage` the `ModeDescriptor` (cache for re-post); **HTML-escape** header text derived from paths/builder ids.
- Modify `apps/vscode/src/contextual-panel/webview/main.ts` — render active/greyed pills from `applicability`; Document Review pill disabled (hover hint) when inapplicable; per-mode detail placeholder body.
- Create `apps/vscode/src/__tests__/contextual-panel-surface-context.test.ts` and `contextual-panel-provider.test.ts` (mocked `vscode`).

#### [CONTRACT SURFACE] Surface derivation + trigger set (revised per cmap)

- **Derivation is O(1), no I/O, and reads the active *tab input* — not the write-only context key** (`codev.activeEditorIsBuilderFile` is set via `setContext` and cannot be read back):
  - **artifact**: active tab resource path matches `/\/codev\/(plans|specs|reviews)\//` (covers `TabInputText` and the `TabInputCustom` `codev.markdownPreview` editor, where `activeTextEditor` is `undefined`). If the path contains a `.builders/<id>/` segment, set `artifact.builderId` from `<id>` (the common review case — architect note A2).
  - **builderDiff**: active tab is a diff (`TabInputTextDiff`, or the `vscode.changes` multi-diff input) whose **`input.modified.fsPath`** (the right/worktree side) is registered in the diff-inject registry — builder id from `provider.get(input.modified.fsPath).builderId`. **Key on `modified`, not `input.original`** (the `original` side is the `codev-diff:` URI; the registry `fsPath` is documented as the right/worktree path — keying on `original` silently misses and loses the builder id). The over-broad context key is **not** used as the diff predicate.
  - **builderTerminal**: `getActiveBuilderId()` (**terminal-manager's verified terminal→builder map — `terminal-manager.ts:450`, matched by `entry.terminal === activeTerminal` + the `builder-<id>` map key, never a tab label; this is the #1497-correct path** — architect note A3), **and** only when the last-focused surface is the terminal (see below).
- **Last-focused-surface state** (fixes the exit path): the adapter tracks `lastFocused: 'editor' | 'terminal'`. `onDidChangeActiveTerminal` (to a builder terminal) sets `terminal`; `onDidChangeTextEditorSelection` and tab activation set `editor`. `builderTerminal` is emitted only while `lastFocused === 'terminal'`, so returning focus to an already-active editor demotes the terminal even though `window.activeTerminal` stays set (documented in `vscode.d.ts` as "has focus OR most recently had focus"). **Residual limitation, documented not engineered around:** some focus returns fire no event at all.
- **Trigger set:** `onDidChangeTabGroups`/`onDidChangeTabs`, `onDidChangeActiveTerminal`, `onDidChangeDiffInjectRegistry` (registry populates after diff activation), `onDidChangeTextEditorSelection` (last-focus proxy).
- **Clear-on-transition, not on-every-event:** each trigger recomputes a **stable surface identity** = the tuple `(kind, resourcePath, builderId)`. The transient `ManualSelection` (Phase 4) is cleared **only when that tuple actually changes** — cursor moves, background-tab churn, and registry refreshes that leave the tuple unchanged do **not** clear it. **A change in `builderId` or `resourcePath` is a transition even when `kind` is unchanged:** moving from builder A's terminal to builder B's terminal (same kind `builder-terminal`, different `builderId`) is a transition and clears the selection — a kind-only identity would let a stale selection cross builders, which is the #1497 class of defect.

#### Deliverables

- [ ] `surface-context.ts` (derivation + last-focus + identity comparison) and trigger wiring.
- [ ] **Visibility cache + re-post (relocated from Phase 2):** the provider holds the `WebviewView`, caches the last posted `ModeDescriptor`, and re-posts it on `resolveWebviewView` and `WebviewView.onDidChangeVisibility`. With `retainContextWhenHidden: true` the webview is not re-resolved on re-show, so `onDidChangeVisibility` (not resolve re-fire) is the re-post trigger; a surface change made while the panel is collapsed must not leave it blank/stale on reopen. Inject `TerminalManager` into the provider here (first use).
- [ ] Webview renders the resolved mode (active pill; greyed/disabled inapplicable pills; per-mode detail placeholder).
- [ ] Tests: each predicate (artifact incl. custom editor; worktree-artifact builderId; builderDiff via `TabInputTextDiff.modified` + registry; builderTerminal gated by last-focus; none); registry-not-yet-populated → re-resolve on registry change; terminal→editor exit demotes terminal; identity-unchanged event does **not** clear selection; **cross-builder transition with the same kind (builder A terminal → builder B terminal, `builderId` A→B) IS a transition and clears the transient selection** (#1497 guard); each real transition → one re-resolution.

#### Acceptance Criteria

- [ ] O(1) derivation, no filesystem/network on the switch path (asserted); no reliance on reading back a context key.
- [ ] Custom-editor spec → Document Review; `TabInputTextDiff` builder diff → Code Review (builder from `modified` side); builder terminal (last-focused) → Builder Inspector; return-to-editor exits Builder Inspector; unmatched → Attention.
- [ ] Visibility cache: after a descriptor is posted, hiding then showing the panel re-posts the cached descriptor (tested via a mocked `WebviewView` + `onDidChangeVisibility`), so the reopened panel is never blank/stale.
- [ ] Residual "fires nothing" cases documented in code comments.
- [ ] `test:unit` + `check-types` pass.

#### Test Plan

Vitest with mocked `vscode` (per `review-queue-store.test.ts`): stub `tabGroups`, `activeTerminal`, the diff-inject registry; assert `SurfaceContext` per case, the last-focus exit, and clear-only-on-transition. Manual dev-approval rehearsal: spec (plain + Codev preview), builder diff, builder terminal, and the terminal→editor exit.

---

### Phase 4: Transient navigation + minimum summary stubs

**Dependencies**: Phase 3

#### Objective

Make the pills transient navigation and give the builder-scoped modes a minimal summary ⇄ detail so navigation and drill-in are demonstrable — no persistence, cleared only on a real surface transition.

#### Files to Create / Modify

- Create `apps/vscode/src/contextual-panel/messages.ts` — the host↔webview message contract + validation.
- Modify `apps/vscode/src/contextual-panel/panel-provider.ts` — hold the transient `ManualSelection` in memory; handle validated `mode-navigate` / `drill-in`; clear on a real surface transition (Phase 3 identity); enumerate builder ids for the summary from `ReviewQueueStore.buildersWithPending()` / `OverviewCache`.
- Modify `apps/vscode/src/contextual-panel/webview/main.ts` + `components/` — clickable navigable pills; minimal summary list (builder-id rows) for Code Review / Builder Inspector with drill-in; local `List`/`Row`/`EmptyState` primitives (seams for [#1549]).
- Create `apps/vscode/src/__tests__/contextual-panel-messages.test.ts`; extend the provider test for navigation + clear-on-transition.
- **Changelog:** the entry is NOT committed on this feature branch. Per the repo convention (self-documented in `docs/releases/UNRELEASED.md`), `apps/vscode/CHANGELOG.md` + `docs/releases/UNRELEASED.md` are updated on the separate `docs/vscode-changelog` branch (via `worktrees/changelog`) as the architect's post-merge workflow — the two branches never touch each other's files by design. The entry text is prepared in the phase-4 review/thread for that workflow.

#### [CONTRACT SURFACE] Host↔webview message contract (revised per cmap)

- Host→webview: `{ type: 'render', descriptor: ModeDescriptor, summary?: { builderIds: string[] } }`.
- Webview→host: `{ type: 'mode-navigate', mode: ModeKind } | { type: 'drill-in', mode: ModeKind, builderId: string }`.
- **Validate field *values*, not just the type** (architect note A4): reject unless `mode ∈ ModeKind` **and** (for `drill-in`) `builderId ∈` the known-builders set; unknown type *or* invalid value → **ignore**. Webview→host messages are lower-trust.
- Selection semantics: `mode-navigate` sets a transient `ManualSelection`; `drill-in` sets one with a `builderId`; a real active-surface **transition** (Phase 3 identity change) clears it. Never written to `workspaceState`/`globalState`/configuration.
- **Pill gesture family (designed behavior; architect-accepted A2 refinement).** A2 navigation-scoping lives in the *provider* (`selectionForNavigate`), not the pure resolver:
  - First-navigating to Code Review / Builder Inspector **while viewing a worktree artifact** scopes to that artifact's builder — its *detail* (A2: richer context for free). Otherwise it lands on the cross-builder *summary*.
  - Clicking the mode you are **already in** returns `{ mode }` (no builder): a builder-scoped *detail* zooms out to its *summary*; a *summary* (or the detail-only Document Review) is a **no-op** (post-dedup). A2 is not re-applied once you are in a mode, so click-active-at-summary stays at summary even over a worktree artifact.
  - The zoom-out is an ordinary transient `ManualSelection` — a real surface change clears it and contextual scoping resumes.

#### Deliverables

- [ ] Message module + value-level validation.
- [ ] Clickable navigable pills (Code Review / Builder Inspector / Attention always navigable; Document Review disabled without an artifact).
- [ ] Minimal summary list (builder-id stub) for the two builder-scoped modes; row drill-in → that builder's detail placeholder.
- [ ] Transient selection cleared only on a real surface transition; no persistence key anywhere.
- [ ] Changelog + UNRELEASED entries.
- [ ] Tests: navigate sets selection; drill-in attaches builder; identity-changing surface transition clears; invalid `mode`/`builderId` ignored; no-persistence invariant (no `codev.contextualPanel.*` key; provider adds no store writes).

#### Acceptance Criteria

- [ ] Clicking a navigable pill switches the panel without changing the editor; the selection is discarded on the next real surface transition.
- [ ] Drilling into a summary row shows that builder's detail placeholder.
- [ ] Invalid webview→host field values are ignored.
- [ ] Grep confirms no persistence surface introduced.
- [ ] `test:unit` + `check-types` pass; both bundles build.

#### Test Plan

Vitest (mocked `vscode`) for the message contract, value validation, and clear-on-transition. Full dev-approval walkthrough: spec → Document Review; builder diff → Code Review for that builder; builder terminal → Builder Inspector; Code Review pill with no diff open → summary list; drill into a row → that builder's detail; switch editors → panel follows context again (selection cleared).

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Terminal→editor exit path fires no VSCode event, leaving Builder Inspector stuck | High if unaddressed | High | Phase 3 last-focused-surface state gates `builderTerminal`; `onDidChangeTextEditorSelection` proxy; residual cases documented; exit path tested. |
| New tests silently don't run (wrong dir) → criteria pass vacuously | High if unaddressed | High | Tests under `src/__tests__/` (the only `vitest` include); verify the suite is non-vacuous. |
| `check-types` breaks on the new webview dir | High if unaddressed | Medium | Phase 2 updates both `tsconfig.json` (exclude) and `tsconfig.webview.json` (include); `React.createElement` (no JSX) matches the existing convention. |
| WebviewView hidden/re-show yields a blank/stale panel | Medium | Medium | Cache last `ModeDescriptor`; re-post on `resolveWebviewView` + `onDidChangeVisibility`. |
| Over-broad `activeEditorIsBuilderFile` routes a plain-tab builder spec to Code Review | Medium | High | Derive `builderDiff` from `TabInputTextDiff.modified` + registry, not the context key; overlap test asserts a plain-tab spec → Document Review. |
| Clearing transient nav on every event wipes the user's browse | Medium | Medium | Clear only on a real surface-identity transition; test identity-unchanged events do not clear. |
| Placeholder retirement breaks manifest-invariant tests | High (expected) | Low | Delete `panel-placeholder.test.ts`; update the other two in the same commit, preserving non-placeholder assertions. |
| Types leak into `codev-types` (permanent public surface) | Low | Medium | Types are extension-local under `src/contextual-panel/`; stated explicitly; no `codev-types` edit. |
| Summary stub pulls in real mode content, blurring the umbrella boundary | Medium | Medium | Summary renders builder *ids* only; rich per-row content stays with participating issues (#1037, files-not-yet-reviewed). |

## Documentation Updates

- `apps/vscode/CHANGELOG.md` + `docs/releases/UNRELEASED.md` — user-facing entry for the contextual `Codev` panel tab. **Added via the `docs/vscode-changelog` branch (architect post-merge workflow), not this feature branch** (the branches diverge by design). Entry text prepared in the phase-4 review.
- No arch.md / lessons-learned.md change anticipated (no new system-shape invariant); revisit at review.
- `#813/#814/#815` rescope and [#1549] extraction are tracked in their own issues — no doc change here.
