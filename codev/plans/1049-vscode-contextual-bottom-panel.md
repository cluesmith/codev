# Plan: VSCode Contextual Bottom Panel (mode resolver + Attention fallback)

**Specification**: [codev/specs/1049-vscode-contextual-bottom-panel.md](../specs/1049-vscode-contextual-bottom-panel.md)

## Executive Summary

The spec's recommended substrate is a **webview-view panel** (Approach 1): a `WebviewViewProvider` registered in the `codevPanel` container, with a pure host-side `ModeResolver` feeding a React webview. This plan follows that, refined to the **React** variant of the substrate (the `MarkdownPreviewProvider` lineage: an esbuild IIFE bundle mounting React), so that Document Review's future content can host `<ArtifactCanvas>` without a later rewrite. It is the first `WebviewViewProvider` in the extension.

The work decomposes into four dependency-ordered phases that mirror the spec's umbrella boundary — skeleton + resolver + switching + minimal navigation stubs, *no* real mode content:

1. **Mode resolver + contract types** — the pure, VSCode-free decision core (load-bearing; fully unit-testable in isolation).
2. **Panel surface + placeholder retirement** — the webview tab exists and renders a static shell; the vestigial `codev.placeholder` and its dead context-key flip are retired; manifest-invariant tests updated.
3. **Context adapter + contextual mode switching** — the tab-based `SurfaceContext` derivation, the trigger set (including the terminal-exit proxy), and resolver→webview wiring so the panel follows the active surface.
4. **Transient navigation + minimum summary stubs** — clickable pills and summary-list drill-in as transient (never-persisted) navigation, cleared on any active-surface change.

**Two cross-cutting implementation rules** (architect-directed) apply across phases 2–4:
- **Local primitives with extraction seams for [#1549].** Build the panel's UI primitives (pill/segmented-header, list, row, empty-state) locally under `src/contextual-panel/webview/`, factored cleanly so #1549 can later extract them into a generalized artifact-canvas — but do **not** pre-build a shared layer here. #1549 extracts from proven code.
- **No mode content.** Every mode body is a placeholder; the only "real" data touched is the minimal builder-id list in Phase 4's summary stub (cheaply enumerable), sufficient to make drill-in demonstrable.

**Contract-surface note (process):** the sections marked **[CONTRACT SURFACE]** below — the resolver types (Phase 1), the `SurfaceContext` derivation + trigger set + terminal-exit proxy (Phase 3), and the host↔webview message contract (Phase 4) — are routed to the architect for review *before* the plan gate, per the standing instruction.

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

Deliver the pure, synchronous, VSCode-free decision core — the load-bearing surface of the whole feature — so it can be exhaustively unit-tested before any UI exists. This is the piece the spec calls out as most needing to be deterministic.

#### Files to Create / Modify

- Create `apps/vscode/src/contextual-panel/types.ts` — the contract types: `ModeKind` (`'document-review' | 'code-review' | 'builder-inspector' | 'attention'`), `ModeLevel` (`'summary' | 'detail'`), `SurfaceContext`, `ManualSelection`, `ModeDescriptor`, and a `ModeApplicability` map.
- Create `apps/vscode/src/contextual-panel/resolver.ts` — `resolveMode(surface: SurfaceContext, selection: ManualSelection | null): ModeDescriptor` plus an applicability helper.
- Create `apps/vscode/src/contextual-panel/__tests__/resolver.test.ts` — Vitest unit tests.

#### [CONTRACT SURFACE] Contract definition

- `SurfaceContext` (plain, host-derived): `{ surface: 'artifact' | 'builder-diff' | 'builder-terminal' | 'other' | 'none', resourcePath?: string, viewType?: string, builderId?: string }`.
- `ManualSelection` (transient, never persisted): `{ mode: ModeKind, builderId?: string }`.
- `ModeDescriptor`: `{ kind: ModeKind, level: ModeLevel, context: { builderId?: string; resourcePath?: string }, applicability: Record<ModeKind, boolean> }`.
- **Precedence (locked by the spec):** `builder-terminal → builder-diff → artifact-path → attention`. A `ManualSelection` overrides contextual resolution when present.
- **Never emits `{ kind: 'document-review', level: 'summary' }`** — Document Review is detail-only.
- **Never throws** — unknown/malformed input degrades to `attention`.

#### Deliverables

- [ ] `types.ts` and `resolver.ts` implementing the contract above.
- [ ] Unit tests covering: each surface → mode+level; precedence overlap (builder `codev/specs/*.md` in a diff session → `code-review`); `ManualSelection` overrides context; summary vs detail selection (transient with/without `builderId`); attention fallback; applicability per context; Document-Review-never-summary; malformed input → attention (no throw).

#### Acceptance Criteria

- [ ] Resolver is pure/synchronous with no VSCode/`node:` imports and no I/O.
- [ ] Precedence order is encoded exactly once and asserted by the overlap test.
- [ ] `pnpm --filter codev-vscode test:unit` (Vitest) passes for the new suite; `check-types` clean.

#### Test Plan

Vitest unit tests only (no VSCode host). One `describe` per branch of the resolver plus the applicability matrix and the malformed-input degradation case.

---

### Phase 2: Panel surface + placeholder retirement

**Dependencies**: Phase 1 (for `ModeKind` / the pill set)

#### Objective

Make the contextual `Codev` tab exist in the bottom panel and render a static themed shell (header strip + four pills + empty body), retiring the vestigial placeholder and its dead context-key flip in the same change. Delivers a visible, always-present panel tab; `Codev Dev` untouched.

#### Files to Create / Modify

- Modify `apps/vscode/package.json` — replace the `codev.placeholder` entry in `contributes.views.codevPanel` with the contextual `Codev` webview view (`codev.contextualPanel`, or reuse the `codev.placeholder` id repurposed); drop the `when: codev.panelContainerEmpty` gating. Leave `codev.dev` as is.
- Create `apps/vscode/src/contextual-panel/panel-provider.ts` — the `WebviewViewProvider` (`resolveWebviewView`): builds the HTML with nonce/CSP/`localResourceRoots`, loads the bundled webview script, static shell only in this phase.
- Create `apps/vscode/src/contextual-panel/webview/main.ts` — React entry (esbuild IIFE) rendering the header + pills + empty body; local primitives (`Pill`, `HeaderStrip`) under `webview/components/`.
- Create `apps/vscode/src/contextual-panel/webview/components/` — local primitive components (extraction seams for [#1549]; not a shared package).
- Modify `apps/vscode/esbuild.js` — add a webview bundle entry `src/contextual-panel/webview/main.ts` → `dist/webview/contextual-panel.js` (+ css), mirroring the markdown-preview `webviewConfig`.
- Modify `apps/vscode/src/extension.ts` — register the provider via `registerWebviewViewProvider`; **retire the dead `setContext 'codev.panelContainerEmpty' false` flip (~line 555) and its now-stale `#813/#814/#815 "sibling tabs"` comment (~line 552).**
- Delete `apps/vscode/src/views/panel-placeholder.ts` (the signpost provider) **and** remove its registration; the stale body/tooltip text advertising `#813/#814/#815` (lines 18/20) goes with it.
- Modify manifest-invariant tests `apps/vscode/src/__tests__/contributes-panel.test.ts`, `panel-placeholder.test.ts`, `contributes-dev.test.ts` — update to the new always-present contextual view and the removal of the placeholder + `panelContainerEmpty` seed.

#### Deliverables

- [ ] Contextual `Codev` webview view registered in `codevPanel`, always present, rendering a static header + four pills + empty body.
- [ ] Placeholder provider, its registration, the `panelContainerEmpty` flip, and the `#813/#814/#815` text/comment all removed.
- [ ] esbuild produces `dist/webview/contextual-panel.js`.
- [ ] Manifest-invariant tests updated and green.
- [ ] Webview hardened: nonce-based CSP, constrained `localResourceRoots`.

#### Acceptance Criteria

- [ ] The panel shows one contextual `Codev` tab plus the untouched `Codev Dev` tab.
- [ ] No reference to `codev.panelContainerEmpty` or `codev.placeholder` remains (grep-clean across the extension).
- [ ] `pnpm --filter codev-vscode test:unit` and `check-types` pass; the extension + webview bundles build.

#### Test Plan

Updated manifest text-invariant tests (assert the contextual view is contributed, `codev.dev` remains, and the placeholder/gate are gone). Manual: launch the Extension Development Host, open the bottom panel, confirm the `Codev` tab renders the header shell and `Codev Dev` is unaffected.

---

### Phase 3: Context adapter + contextual mode switching

**Dependencies**: Phase 1, Phase 2

#### Objective

Wire the panel to follow the active surface: derive `SurfaceContext` from the active tab, re-resolve on the right events, and render the resolved mode's pill + a per-mode detail *placeholder* body. Delivers the headline behavior (open a spec → Document Review; builder diff → Code Review; builder terminal → Builder Inspector; else Attention).

#### Files to Create / Modify

- Create `apps/vscode/src/contextual-panel/surface-context.ts` — the host adapter deriving `SurfaceContext` from the active tab.
- Modify `apps/vscode/src/contextual-panel/panel-provider.ts` — subscribe to the trigger set, call `resolveMode`, `postMessage` the `ModeDescriptor`; escape header text derived from paths/builder ids.
- Modify `apps/vscode/src/contextual-panel/webview/main.ts` — render active/greyed pills from `applicability`; Document Review pill disabled (with hover hint) when inapplicable; render a per-mode detail placeholder body.
- Create `apps/vscode/src/contextual-panel/__tests__/surface-context.test.ts` and `panel-provider.test.ts` (mocked `vscode`).

#### [CONTRACT SURFACE] Surface derivation + trigger set

- **Derivation (O(1), no I/O):** read `window.tabGroups.activeTabGroup.activeTab.input` → viewType/scheme + resource URI. Artifact = path matches `/\/codev\/(plans|specs|reviews)\//` (covers the `codev.markdownPreview` custom editor, where `activeTextEditor` is `undefined`). Builder-diff = active tab is the diff / `codev.activeEditorIsBuilderFile` true; builder id from the diff-inject registry `DiffInjectSessionEntry.builderId`. Builder-terminal = `getActiveBuilderId()` non-null.
- **Trigger set:** `onDidChangeTabGroups` / `onDidChangeTabs`, `onDidChangeActiveTerminal`, `onDidChangeDiffInjectRegistry` (registry populates after diff activation).
- **Terminal-exit proxy (the flagged feasibility item):** returning focus from a builder terminal to an already-active editor fires none of the above while `window.activeTerminal` stays set (documented in `vscode.d.ts` as "has focus OR most recently had focus"). Add `onDidChangeTextEditorSelection` as the click-into-editor proxy that lets the adapter demote the terminal surface. **Accept that some focus returns fire no event at all** — document this residual limitation rather than engineer around it.
- On every trigger: clear any transient selection, re-resolve, post the descriptor.

#### Deliverables

- [ ] `surface-context.ts` adapter + trigger wiring in the provider.
- [ ] Webview renders the resolved mode (active pill, greyed/disabled inapplicable pills, per-mode detail placeholder).
- [ ] Tests: adapter maps each surface correctly (artifact incl. custom editor, builder-diff, builder-terminal, none); registry-not-yet-populated → re-resolve on registry change; terminal-exit proxy demotes the surface on editor selection; each trigger causes exactly one re-resolution.

#### Acceptance Criteria

- [ ] O(1) derivation, no filesystem/network on the switch path (asserted).
- [ ] Custom-editor (`codev.markdownPreview`) spec → Document Review; multi-file diff → Code Review; builder terminal → Builder Inspector; unmatched → Attention.
- [ ] The terminal-exit proxy path is exercised in tests; the residual "fires nothing" cases are documented in code comments.
- [ ] `test:unit` + `check-types` pass.

#### Test Plan

Vitest with mocked `vscode` (per the `review-queue-store.test.ts` pattern): stub tab groups, active terminal, and the diff-inject registry; assert `SurfaceContext` per case and that each event triggers a single re-resolution. Manual (dev-approval rehearsal): open a spec (plain + Codev preview), a builder diff, and a builder terminal, and confirm the mode follows; confirm the terminal→editor exit.

---

### Phase 4: Transient navigation + minimum summary stubs

**Dependencies**: Phase 3

#### Objective

Make the mode pills a transient navigation affordance and give the two builder-scoped modes a minimal summary ⇄ detail so navigation and drill-in are demonstrable — all without persistence and cleared on any active-surface change.

#### Files to Create / Modify

- Create `apps/vscode/src/contextual-panel/messages.ts` — the host↔webview message contract.
- Modify `apps/vscode/src/contextual-panel/panel-provider.ts` — hold the transient `ManualSelection` in memory; handle `mode-navigate` / `drill-in` messages; clear the selection on any active-surface change; enumerate builder ids for the summary stub from `ReviewQueueStore.buildersWithPending()` / `OverviewCache`.
- Modify `apps/vscode/src/contextual-panel/webview/main.ts` and `webview/components/` — clickable navigable pills; a minimal summary list (builder-id rows) for Code Review / Builder Inspector with drill-in; local `List`/`Row`/`EmptyState` primitives (extraction seams for [#1549]).
- Create/extend `apps/vscode/src/contextual-panel/__tests__/messages.test.ts` and provider tests for navigation + clear-on-change.

#### [CONTRACT SURFACE] Host↔webview message contract

- Host→webview: `{ type: 'render', descriptor: ModeDescriptor, summary?: { builderIds: string[] } }`.
- Webview→host: discriminated union `{ type: 'mode-navigate', mode: ModeKind } | { type: 'drill-in', mode: ModeKind, builderId: string }`.
- Unknown/malformed inbound messages are ignored (validated allowlist).
- Selection semantics: `mode-navigate` sets a transient `ManualSelection`; `drill-in` sets one with a `builderId`; **any** active-surface change (the Phase-3 triggers) clears it. Never written to `workspaceState`/`globalState`/configuration.

#### Deliverables

- [ ] Message contract module + validation.
- [ ] Clickable navigable pills (Code Review / Builder Inspector / Attention always navigable; Document Review disabled without an artifact).
- [ ] Minimal summary list (builder-id stub) for the two builder-scoped modes, with row drill-in → detail placeholder for that builder.
- [ ] Transient selection cleared on any active-surface change; no persistence key added anywhere.
- [ ] Tests: navigate sets selection; drill-in attaches builder; surface change clears selection; unknown message ignored; no-persistence invariant (no `codev.contextualPanel.*` key, provider reads/writes no store).

#### Acceptance Criteria

- [ ] Clicking a navigable pill switches the panel without changing the editor; the selection is discarded on the next active-surface change.
- [ ] Drilling into a summary row shows that builder's detail placeholder.
- [ ] Grep confirms no persistence surface introduced.
- [ ] `test:unit` + `check-types` pass; both bundles build.

#### Test Plan

Vitest (mocked `vscode`) for the message contract and the clear-on-change invariant. Dev-approval walkthrough (full spec scenario): open a spec → Document Review; builder diff → Code Review for that builder; builder terminal → Builder Inspector; click the Code Review pill with no diff open → Code Review summary list; drill into a row → that builder's detail; then switch editors → the panel follows context again (selection cleared).

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Terminal→editor exit path fires no VSCode event, leaving Builder Inspector stuck | High if unaddressed | High | Phase 3 adds the `onDidChangeTextEditorSelection` proxy; document residual "fires nothing" cases; test the exit path; contract-surface section routed to architect pre-gate. |
| First view-embedded webview surfaces lifecycle/CSP/bundle surprises | Medium | Medium | Model Phase 2 directly on the markdown-preview `webviewConfig` + provider; keep bodies as placeholders so scope is shell + switching. |
| Placeholder retirement breaks the three manifest-invariant tests | High (expected) | Low | Update the three tests in the same Phase-2 commit; grep for residual `panelContainerEmpty`/`codev.placeholder`. |
| Local primitives drift toward a premature shared layer | Medium | Medium | Build primitives locally with clean seams only; do not create a shared package here ([#1549] extracts later from proven code). |
| Summary stub pulls in real mode content, blurring the umbrella boundary | Medium | Medium | Phase 4 summary renders builder *ids* only (cheap enumeration); rich per-row content stays with participating issues (#1037, files-not-yet-reviewed). |
| Resolver drifts from O(1) (data fetched during resolve) | Low | Medium | Resolver is pure (Phase 1, no I/O); all data access lives in provider/render paths. |

## Documentation Updates

- `apps/vscode/CHANGELOG.md` — user-facing entry for the new contextual `Codev` panel tab (added when the feature lands; per the changelog-by-artifact convention this is extension code).
- `docs/releases/UNRELEASED.md` — accumulate the release-note line per the dual-changelog convention.
- No arch.md / lessons-learned.md change anticipated (no new system-shape invariant); revisit at the review phase.
- The `#813/#814/#815` rescope and [#1549] extraction are tracked in their own issues — no doc change here.
