---
approved: 2026-08-24
validated: [gemini, codex, claude]
---

# Specification: VSCode Contextual Bottom Panel (mode resolver + Attention fallback)

<!--
SPEC vs PLAN BOUNDARY:
This spec defines WHAT and WHY. The plan defines HOW and WHEN.
Keep implementation phases, file paths, code, and "first we will… then we will…"
out of the spec — those belong in codev/plans/1049-*.md.
-->

## Problem Statement

Codev has been moving activity surfaces into the VSCode bottom panel: the `Codev` scaffold placeholder tab and the `Codev Dev` tab already live there, and several planned features (pending review comments #1037, Reader View #807, future Recently-Closed / Team / Status detail) all want a panel home.

If every feature earns its own sibling tab, the bottom panel grows tabs faster than the user wants to navigate them. Side-by-side tabs make the user do the pairing work: a reviewer reading a diff still has to click away from a spec-markers tab; someone reading a spec still has to ignore the code-review queue. The panel does not follow what the user is doing.

**Who is affected:** every Codev user who works inside the VSCode extension — architects triaging attention items, reviewers working a diff, contributors reading spec/plan/review artifacts. **The pain:** the panel is a static list of surfaces the user must navigate, instead of a single surface that shows what pairs with the thing in front of them.

## Current State

The extension (`apps/vscode`, package `codev-vscode`) contributes a bottom-panel view container `codevPanel` ("Codev") holding exactly two views:

- **`codev.placeholder`** — a `TreeDataProvider` (`PanelPlaceholderProvider`) rendering a single signpost row, gated by the `codev.panelContainerEmpty` context key so it hides once a real panel view exists. This is the "scaffold" tab.
- **`codev.dev`** — a `TreeDataProvider` (`DevTreeProvider`, #921) showing the status of the single `afx dev` PTY (target / uptime / port), with its own title-bar controls.

Both panel tabs are tree views; **no `WebviewViewProvider` is registered anywhere in the extension today**. The two existing webviews are a custom text editor (`codev.markdownPreview`, React via `@cluesmith/codev-artifact-canvas`) and a floating `WebviewPanel` (`codev.backlogSearch`, plain theme-variable HTML) — neither is embedded in the bottom panel.

The extension already computes, elsewhere, every piece of state the contextual modes want:

- **Artifact-file context:** spec/plan/review files are matched by the path shape `/\/codev\/(plans|specs|reviews)\//` (used both by the `codev.markdownPreview` custom-editor selector and by menu `when` clauses).
- **Builder diff editor:** the unified multi-file diff renders each file as a two-side diff whose *base/left* side is backed by the read-only custom scheme `codev-diff:`, while the *right* side is the live `file:` worktree document (which is the side the context key keys off). The `codev.activeEditorIsBuilderFile` context key tracks whether the active editor's file is registered in a builder diff-inject session — note this is true for *any* registered builder file, including one opened as a normal editor tab, not only inside the diff surface. The diff-inject registry is populated *after* the diff editor activates and exposes a change event (`onDidChangeDiffInjectRegistry`).
- **Builder terminal:** `TerminalManager` owns builder PTY terminals; `getActiveBuilderId()` maps the currently active managed terminal to its builder id (the inverse helper `resolveBuilderTerminal` maps a builder id to its terminal).
- **Attention data:** the Agents view (`codev.agents`, `BuildersProvider`) already sorts builders into blocked / idle-waiting / active buckets. Its data comes from `OverviewCache` (`GET /api/overview` from Tower, refreshed on SSE), typed as `OverviewBuilder` / `OverviewData` (fields: `blocked`, `blockedGate`, `blockedSince`, `gates`, `phase`, `prReady`, `idleMs`, `heldCount`, `mailboxEscalated`). There is no view literally named "Needs Attention" — the Agents view is the closest existing surface.
- **Per-builder pending comments (#1037):** `ReviewQueueStore` watches `.builders/*/.codev/pending-comments.json`, exposing `buildersWithPending()`, `getComments(id)`, `count(id)`, and `onDidChangeQueue(builderId)`.
- **Review markers (#859/#945):** the SDK codec (`@cluesmith/codev-sdk` review-markers) parses/serializes markers whose actual on-disk form is `<!-- REVIEW(@<author>): <text> -->` (positional), consumed by the markdown preview and plan-review flows.

None of these are wired into a single context-following panel; each surfaces its slice independently.

## Desired State

A single contextual `Codev` panel tab whose content morphs to pair with the active editor/surface, showing the **detail** for the current builder or artifact when a relevant surface is active and falling back to a cross-cutting **summary** (Attention) when nothing specific is. The panel is purely contextual — it always reflects what the user is looking at. This mirrors patterns the user already knows: Source Control morphs with git state, Outline tracks the active editor, Run-and-Debug shows context-specific controls.

**There is no pinning, freezing, or locking.** The panel is never held against the active surface; it always follows context. The header's mode pills are a **transient navigation** affordance (see below), not a persistent override — nothing about the panel's mode is written to disk.

Four modes (v1). The two builder-scoped modes have a **summary ⇄ detail** shape — a cross-builder list, and the single-builder view reached by drilling into a list row or by the active surface supplying that builder:

| Active context | Mode | Detail (one builder / one file) | Summary (no specific context) |
|---|---|---|---|
| Editor/preview is a file under `codev/{specs,plans,reviews}/` | **Document Review** | Review markers anchored to this file, with resolve / edit / delete actions (source: the marker bytes in the file). | N/A — inherently file-scoped; when no artifact is open the contextual result is Attention, not a Document-Review summary. |
| Builder unified diff editor is active | **Code Review** | This builder's pending-comments queue (#1037) + files-not-yet-reviewed checklist + Submit Review action. | List of all builders with pending comments; a row drills into that builder's detail. |
| Builder terminal is the active surface | **Builder Inspector** | This builder's phase, gate state, recent activity, send-message input. | List of all builders and their states; a row drills into that builder's detail. |
| No specific match | **Attention** | — | Cross-cutting roll-up: pending gates, blocked builders, queued review comments across builders, recently-closed audit. This is the contextual fallback. |

**Builder attachment is derived, never chosen.** For the builder-scoped modes, *which* builder the detail shows comes from the active surface: a builder terminal supplies its id via `getActiveBuilderId()`; a builder diff supplies its id via the diff-inject registry entry (`DiffInjectSessionEntry.builderId`). There is no global "current builder" and no way to lock onto one — attachment swaps with the active surface, and each VSCode window resolves its own.

**Header and transient navigation.** A header strip renders `<context label> · <four mode pills>`. The pill matching the current mode is visually distinct; modes inapplicable to the current context are greyed but still visible (so the user learns the panel can do more). Navigable pills are **clickable to navigate**: a user can jump to Code Review, Builder Inspector, or Attention — each of which has a cross-builder summary or global view even with no matching surface — and browse *without touching their editor*. Document Review is the exception: being inherently file-scoped, its pill is disabled when no artifact is active (greyed, with a hover hint). This manual selection is **transient** — the next active-surface change (switching editor tabs, focusing a builder terminal, opening a file) discards it and the panel returns to following context. Drilling into a summary-list row is navigation *within* a mode and works the same way. Nothing is persisted; there is no lock.

**Umbrella scope is the skeleton only:** this project ships the panel surface, the mode resolver, the header/switcher, the transient-navigation orchestration, and a placeholder body per mode (including the summary vs detail render targets). The *actual content rendering* for each mode is owned by the participating-feature issues (#1037, files-not-yet-reviewed, #807, …) and lands in their own PRs against the render targets this umbrella exposes.

Users will see: the panel automatically pairs with what they are looking at; they can click the pills to browse other modes/builders transiently; the moment they change what they are looking at, the panel follows.

## Success Criteria

- [ ] One contextual `Codev` tab exists in the bottom panel; the existing scaffold placeholder is repurposed into it. The `Codev Dev` tab is untouched.
- [ ] The panel is **purely contextual — no pinning, freezing, locking, or persisted panel state.** Nothing about the panel's mode or attached builder is written to disk; the panel always follows the active surface.
- [ ] A `ModeResolver` exists as a **pure, synchronous, VSCode-free function** taking a plain `SurfaceContext` value plus a transient `ManualSelection | null`, and returning a `ModeDescriptor` (`{ kind: 'document-review' | 'code-review' | 'builder-inspector' | 'attention', level: 'summary' | 'detail', context }`) together with the applicability of all four modes. No VSCode host types in the signature (no `Memento`/editor objects), no filesystem walks, no async, no network. A host-side adapter derives `SurfaceContext` from cheap signals (active tab input viewType/scheme/resource path, `codev.activeEditorIsBuilderFile`, diff-inject registry `builderId`, `getActiveBuilderId()`).
- [ ] **Predicate precedence is explicit, total, and fixed here:** `builder-terminal → builder-diff → artifact-path → attention`. When predicates overlap (e.g. a builder's `codev/specs/*.md` open inside a diff session satisfies both artifact-path and builder-diff), the diff surface wins (Code Review), because the diff surface signals code-review intent; a spec opened as a plain/preview tab is not a builder-diff surface and lands in Document Review. Encoded once, tested for the overlap case, never ambiguous.
- [ ] **Context is derived from the active tab, not `activeTextEditor` alone**, so the resolver works for the extension's non-text surfaces: the `codev.markdownPreview` custom editor (where `activeTextEditor` is `undefined`) still resolves to Document Review, and the multi-file diff tab still resolves to Code Review. The trigger set includes tab-group changes, terminal-focus changes, and diff-inject registry changes — not only `onDidChangeActiveTextEditor`.
- [ ] **Builder attachment is derived from the active surface, never chosen or locked.** In a builder-scoped mode, the attached builder comes from the active surface (`getActiveBuilderId()` for a terminal; the diff-inject registry `builderId` for a diff); it swaps with the surface and is never persisted.
- [ ] The panel header renders four mode pills (Document Review, Code Review, Builder Inspector, Attention). The pill for the current mode is visually distinct. Modes inapplicable to the current context are visibly greyed rather than hidden.
- [ ] **Navigability is defined per mode.** Code Review, Builder Inspector, and Attention are *always* navigable — they have content without the active surface (a cross-builder summary, or the global roll-up), so their pills are clickable even when greyed. Document Review is inherently file-scoped: with no artifact active it has no summary, so its pill is disabled (greyed, non-clickable) with a hover hint ("open a spec/plan/review to activate Document Review").
- [ ] **Mode pills are transient navigation, not override.** Clicking a navigable pill (or drilling into a builder row in a summary list) navigates the panel without touching the editor. This manual selection is discarded on the next active-surface change, at which point contextual resolution resumes. It is never persisted.
- [ ] When no context matches and no transient selection is active, the panel shows Attention (the summary fallback).
- [ ] **Resolution is O(1) with no filesystem/network I/O** on the switch path (automated assertion). The perceived switch latency (~50 ms from trigger to header update, across the host→webview `postMessage` boundary) is a dev-approval feel check, not an automated test.
- [ ] The panel exposes render targets for the modes and their levels — **seven in total**: Document Review (detail only; the resolver never emits `{document-review, summary}`), Code Review (summary + detail), Builder Inspector (summary + detail), Attention (summary only). It ships placeholder bodies for these plus the orchestration that switches between them; it does **not** implement mode content.
- [ ] **Minimum navigation UI the umbrella ships** (so transient navigation and drill-in are demonstrable without the participating features): the summary placeholders for Code Review and Builder Inspector render a minimal clickable list of builder ids (cheaply enumerable from `ReviewQueueStore.buildersWithPending()` / `OverviewCache`), and clicking a row drills into that builder's detail placeholder. The *rich* per-row content (comment counts, gate states, queues) is owned by the participating issues; the umbrella ships only the id-level stub + drill-in plumbing.
- [ ] The webview surface is hardened: nonce-based CSP, constrained `localResourceRoots`, an allowlisted/validated host↔webview message contract, and escaping of any header text derived from file paths or builder ids.
- [ ] Unit tests cover the resolver's branches: each active-surface type → its mode and level, builder-attachment derivation, predicate-overlap precedence, transient-selection-overrides-context, attention fallback when nothing matches, modes reported greyed/inapplicable for the current context, and graceful degradation on malformed/absent inputs. Additional automated tests cover provider event wiring, the webview message contract, and that any active-surface change clears the transient selection.
- [ ] Dev-approval walkthrough passes: open a spec (including via the Codev markdown preview) → Document Review; switch to a builder diff editor → Code Review for that builder; focus a builder terminal → Builder Inspector for that builder; click the Code Review pill while no diff is open → Code Review summary list; then switch editors → the panel follows context again (transient selection cleared).

## Constraints

Technical and integration constraints that bound the solution. The following reflect the architect's baked direction in issue #1049 and the current codebase:

- **Architecture split is fixed (baked):** the mode resolver is a separate concern from view rendering — `ContextualPanel = ModeResolver (context + transient selection → ModeDescriptor) + PanelRenderer (ModeDescriptor → view tree)`. The resolver is a pure function; heavier data fetches happen inside a mode's render path, after the mode is chosen.
- **No pinning / no persisted panel state (architect decision).** The panel is purely contextual: it follows the active surface and never locks. The mode pills are a transient navigation affordance whose selection is discarded on any active-surface change and is never written to disk. (Issue #1049 has been amended to this no-pin model.)
- **The panel always follows context on a surface change — no deferral, no sticky-input in the umbrella.** When the active surface changes, the transient selection clears and the panel re-resolves immediately (subject to the O(1) budget). In-progress input preservation (not yanking a half-typed comment) is a *participating-mode* concern — a mode that owns interactive content persists and restores its own draft; the umbrella does not hold re-resolution. This keeps "purely contextual" honest and avoids the contradiction of deferring a switch the model says is immediate.
- **Mode mapping v1 is fixed (baked):** the four modes and their trigger contexts are as tabled above. Individual mode *content* is out of scope and owned by participating issues.
- **`Codev Dev` stays a separate tab (baked):** it is a service surface ("is my dev server up?"), a different mental category from "what do I need to act on"; it is not folded into the contextual panel.
- **Panel-only change (baked):** no sidebar restructuring, no editor/terminal-surface modes, single mode at a time (no split-mode) for v1. Each VSCode window reflects its own active surface (already correct — active editor is per-window).
- **Performance budget (baked):** resolution runs on every active-surface change and must be O(1) — URI-prefix matching, scheme checks, `contextValue`/context-key checks, no filesystem walks. Data fetches are deferred into render.
- **Header with mode-pill buttons implies a webview surface.** The current panel tabs are tree views and no `WebviewViewProvider` exists yet; a mode-switcher header is not expressible as a tree. This is new infrastructure for the extension (see Solution Approaches).
- **Reuse existing state sources, do not duplicate them:** artifact-path matching, the `codev-diff:` scheme / `codev.activeEditorIsBuilderFile` key / `onDidChangeDiffInjectRegistry`, `getActiveBuilderId()`, `OverviewCache`, `ReviewQueueStore`, and the SDK review-marker codec are the authoritative inputs. The resolver reads already-computed signals; it does not re-derive them.
- **The resolver contract is VSCode-free and total.** Its input is a plain `SurfaceContext` value (illustratively: `{ surface: 'artifact' | 'builder-diff' | 'builder-terminal' | 'other' | 'none', resourcePath?, viewType?, builderId? }`) produced by a thin host-side adapter, plus an optional transient `ManualSelection` (`{ mode, builderId? }`, never persisted). It returns the chosen `ModeDescriptor` (mode + summary/detail level + attached-builder context) and the applicability of each mode. It must never throw on malformed input — unknown/empty context degrades to Attention. This keeps it unit-testable under Vitest with no VSCode host and no `Memento` in the signature.
- **The transient selection is host-side UI state, cleared on any active-surface change.** The host holds an optional `ManualSelection` set by a pill click or a summary-row drill-in and passes it to the resolver; on any active-surface change (tab-group, terminal-focus, diff-registry) the host clears it before re-resolving, so context always wins after the user moves. It is never written to `workspaceState`, `globalState`, or configuration.
- **Builder attachment is a derived property of the active surface.** For builder-scoped modes the attached builder id comes from `getActiveBuilderId()` (terminal) or the diff-inject registry `DiffInjectSessionEntry.builderId` (diff); a transient drill-in may carry a builder id for a summary-selected builder. It is never persisted and there is no global "current builder."
- **Context is tab-based, and the trigger set is explicit.** The adapter reads the active tab input (`window.tabGroups.activeTabGroup.activeTab.input` → viewType/scheme + resource URI) rather than `activeTextEditor` alone, so custom editors (`codev.markdownPreview`) and the multi-file diff tab resolve correctly. Re-resolution is triggered by tab-group changes, terminal-focus changes (`onDidChangeActiveTerminal`), and diff-inject registry changes (`onDidChangeDiffInjectRegistry`, since the registry populates after the diff activates). (Correction to the issue's "runs on onDidChangeActiveTextEditor" phrasing.) This trigger set is likely *insufficient for the terminal-exit path* (returning focus to an already-active editor); the plan must add an editor-focus proxy (e.g. `onDidChangeTextEditorSelection`) and accept that some focus returns fire no event — see Open Questions.
- **Active-surface semantics must resolve editor-vs-terminal focus.** A terminal gaining focus does not clear `activeTextEditor`; the adapter must decide the currently-active surface (most-recently-focused editor tab vs terminal) and define how returning focus to an editor exits Builder Inspector. This is captured as an Important open question, not left implicit.
- **No persistence surface is introduced.** Because the panel is purely contextual with only transient in-memory navigation state, this feature adds no `workspaceState` / `globalState` / configuration key (in particular, no `codev.contextualPanel.pinnedMode`).
- **The placeholder is retired, not preserved.** The contextual `Codev` view is always present (like `codev.dev`), so the `codev.placeholder` signpost and its `codev.panelContainerEmpty` gate become vestigial: the placeholder existed only to fill an otherwise-empty panel. The contextual view takes the `Codev` name in `codevPanel`; the placeholder view is removed (or reduced to the contextual view itself). Existing manifest-invariant tests assert the current placeholder/gate shape (`contributes-panel.test.ts`, `panel-placeholder.test.ts`, `contributes-dev.test.ts`) and will be updated as part of this work.
- **Webview hardening is required (baked by the substrate choice).** The panel webview must use a nonce-based CSP, constrained `localResourceRoots`, an allowlisted and validated host↔webview message contract (discriminated union, ignore unknown types), and HTML-escaping of any header text derived from file paths or builder ids.
- **Testing harness:** pure-logic units use Vitest (`src/__tests__/**/*.test.ts`, node env); manifest structure is asserted with text-reading invariant tests; provider tests mock `vscode` via `vi.mock`. The pure resolver must be Vitest-testable with no VSCode host.
- **Review-marker on-disk format** is `<!-- REVIEW(@<author>): <text> -->` (per the SDK codec), not the `<!-- REVIEW: author "body" -->` form in the issue text. Document Review's future content must read the real codec.

## Assumptions

- The participating-feature issues (#1037, files-not-yet-reviewed, #807) will supply the actual per-mode rendering against the render targets this umbrella exposes; this umbrella only guarantees the switching contract and placeholder bodies.
- `OverviewCache`, `ReviewQueueStore`, and the artifact/diff/terminal context signals remain the stable inputs for the resolver and modes; no new backend/Tower API is required for the skeleton.
- A `WebviewViewProvider` embedded in the `codevPanel` container is an acceptable substrate (the extension currently has webviews, just not view-embedded ones) — see approaches if this proves undesirable.
- Repurposing the `codev.placeholder` slot (or replacing it with the contextual view) is acceptable; the placeholder's only job today is to signpost an empty panel.
- Dev-approval is required because the contextual "feel" (does the panel switch when and how it should) is not evaluable from a PR diff alone.

## Solution Approaches

The architecture (resolver + renderer, pure resolver, four modes) is baked. The genuinely open axis is **the rendering substrate for the panel surface** — what kind of VSCode view backs the contextual tab and its mode-switcher header. Two viable approaches:

### Approach 1: Webview-view panel (recommended)

Back the contextual tab with a `WebviewViewProvider` registered against the `codevPanel` container. The webview renders the header (context label + four navigable mode pills) and a mode body region (summary or detail). The host derives a tab-based `SurfaceContext`, runs the pure resolver on active-surface-change events (tab-group, terminal-focus, diff-inject registry) — clearing any transient selection first — and posts the resulting `ModeDescriptor` to the webview; the webview renders the header state and a per-mode placeholder body. Pill clicks and summary-row drill-ins post back a transient selection. Message passing follows the existing `BacklogSearchPanel` (themed `--vscode-*` HTML) or `MarkdownPreviewProvider` (React) precedents, and inherits their nonce/CSP/`localResourceRoots` hardening.

- **Pros:** the mode-pill header, greyed/active pill styling, hover explanations, and a flexible summary/detail body are all naturally expressible; gives participating issues a real render surface (React or HTML) to build their mode content into; matches where the extension's richer surfaces already live.
- **Cons:** first view-embedded webview in the extension — a small amount of new infrastructure (webview lifecycle in a panel view, CSP, bundle wiring); more surface area than a tree.
- **Risk/complexity:** low-to-moderate. Webview mechanics are already proven in the repo; the new part is hosting one inside a panel view rather than a floating panel/editor.

### Approach 2: Tree-view panel with header rows

Keep a `TreeDataProvider` (evolving the placeholder) and express the "header" as special top rows — the context label and four mode entries as clickable tree items for navigation; the summary/detail body as child rows.

- **Pros:** reuses the dominant panel pattern (all current tabs are trees); no webview/CSP/bundle work; trivially Vitest-friendly.
- **Cons:** a horizontal pill switcher and greyed-but-visible affordances are awkward as tree rows; mode content (comment editors, message input, checklists) is what participating issues need, and trees are a poor host for rich, interactive content — likely forcing a later rewrite to a webview. Fights the issue's explicit "header strip with mode pill buttons" UI.
- **Risk/complexity:** low to build, high risk of throwaway work when participating modes need interactive rendering.

**Recommendation: Approach 1 (webview-view).** The header-with-pills UI and the interactive per-mode content the participating issues require both point to a webview substrate; a tree would satisfy the switching contract but hand every downstream mode a hostile rendering surface. The resolver stays a pure, host-side function either way (unchanged by this choice), so the substrate decision is isolated to the renderer half of the split.

## Open Questions

**Critical (blocks progress):**

- None. The baked architecture, mode mapping, and out-of-scope boundary remove the blocking ambiguities; the substrate choice has a clear recommendation, and the precedence gap surfaced by review is now a required (though as-yet-unordered) criterion rather than a hidden ambiguity.

Pinning and its dependent questions (pin scope, override lifetime, pin visual treatment) are **removed** by the architect's no-pin decision and no longer appear here.

**Important (shapes design — resolve at plan gate):**

- **Predicate precedence order — LOCKED in Success Criteria (`builder-terminal → builder-diff → artifact-path → attention`); recorded here for rationale only, not open.** The diff surface signals code-review intent even when the file is an artifact, so a builder's `codev/specs/*.md` opened *inside a diff session* resolves to Code Review; the same spec opened as a plain/preview tab is not a builder-diff surface and lands in Document Review. The plan encodes this order as given — it is not to be re-litigated.
- **Active-surface (editor vs terminal) semantics — needs an API feasibility check, not just a policy choice.** Focusing a builder terminal fires `onDidChangeActiveTerminal` but does not clear `activeTextEditor`, and `getActiveBuilderId()` reads `window.activeTerminal`, which stays set after focus leaves the terminal. The hard direction is *exit*: returning focus from a builder terminal to an **already-active** editor tab fires none of the enumerated triggers (no tab change, no `activeTextEditor` change, no `activeTerminal` change), so Builder Inspector has no event to exit on. The plan gate must pick a concrete signal that fires on click-into-editor — the usual proxy is `onDidChangeTextEditorSelection`, plus a webview/terminal focus signal — and must accept that some focus returns fire nothing at all (a known limitation to document rather than engineer around). "Most-recently-focused surface wins" is the desired *behavior*, but it is contingent on that signal existing; treat it as a feasibility question, not a settled lean.
- **Reset granularity of the transient selection.** Does *any* active-surface change reset a pill-navigation selection (switching between already-open editor tabs included), or only opening a genuinely new file? (Recommend: any active-surface change resets — that is what makes the panel feel contextual; tab-switching between open editors follows context too.) Bounded by the same signal-availability limit as the exit-path question above.

**Nice-to-know (optimization):**

- **Greyed-pill hover explanation** (plan-gate lean #3): should hovering an inapplicable pill explain how to activate it (e.g. "open a spec/plan/review to activate Document Review")? (Recommend: yes; cheap.)
- **Header attachment label** — should the header show the attached builder alongside the mode (e.g. `Code Review · builder A`) so the two axes (mode, attached builder) are both visible? (Recommend: yes when a builder is attached.)
- **Summary placeholder richness** (was plan-gate lean #4): the umbrella ships placeholder bodies, but should the Code-Review / Builder-Inspector *summary* placeholders already read as a calm "pick a builder" list stub, or is that deferred to the participating issue? (Recommend: minimal placeholder now; rich summary owned by the participating mode.)

## Test Scenarios

**Resolver (pure-function unit tests — happy paths and branches):**

- Artifact surface: `SurfaceContext` for a `codev/specs/…md` file → `document-review`, `detail`; same for `plans/` and `reviews/`.
- Artifact via custom editor: surface `viewType = codev.markdownPreview` on a spec resource → `document-review` (proves the tab-based, not `activeTextEditor`, model).
- Builder-diff surface (diff tab / `activeEditorIsBuilderFile`) → `code-review`, `detail`, context carries the builder id derived from the registry.
- Builder-terminal surface → `builder-inspector`, `detail`, context carries the builder id from `getActiveBuilderId()`.
- **Predicate overlap:** a builder `codev/specs/*.md` inside a diff session → the single mode chosen by the documented precedence order (and a test asserting the order is applied, not either-or).
- No matching context → `attention` (the summary fallback).
- Transient selection set to Code Review with no builder-diff context → `code-review`, `summary` (the cross-builder list level), not a throw or blank.
- Transient selection with a drilled-in builder id → `code-review`/`builder-inspector`, `detail` for that builder.
- For a given context, the resolver reports which of the four modes are applicable vs inapplicable (drives greyed pills).

**Edge cases:**

- Non-builder markdown file *outside* `codev/{specs,plans,reviews}/` → not Document Review (guards against over-broad path matching).
- Multi-file diff tab active where the registry has not yet populated on first open → re-resolution on `onDidChangeDiffInjectRegistry` yields `code-review` (no stale-key miss).
- Surface is `none`/unknown (all tabs closed) with a builder terminal focused → `builder-inspector`; with nothing focused → `attention`.
- Malformed/unknown transient-selection value → resolver degrades to contextual/attention rather than throwing.
- Multi-window: each window's resolver reflects its own active surface independently.

**Provider / integration (mocked-`vscode` and manifest tests):**

- Provider event wiring: tab-group / terminal-focus / diff-inject-registry changes each trigger exactly one re-resolution and a header update.
- Webview message contract: unknown/malformed inbound messages are ignored; known messages (mode-navigate, drill-in) drive the expected host action.
- **Transient selection is cleared on any active-surface change:** click the Code Review pill (→ summary), then fire a tab-group/terminal change → the host clears the selection and the panel resolves contextually; the selection is never written to any store.
- No-persistence invariant: the feature reads/writes no `workspaceState` / `globalState` / configuration key (asserted against the provider, and no `codev.contextualPanel.*` key in the manifest).
- Manifest invariant: the panel container contributes the contextual `Codev` view and still contributes `codev.dev`; the placeholder is repurposed/hidden appropriately.

**Non-functional / security:**

- Resolution is O(1) with no filesystem/network calls on the switch path (automated). Perceived header-update latency (~50 ms, spanning the `postMessage` boundary) is a dev-approval feel check, not an automated assertion.
- Webview CSP: only nonce-tagged scripts execute; resources outside `localResourceRoots` are blocked; a header context label containing HTML metacharacters (crafted path/builder id) renders escaped, not as markup.

**Error conditions:**

- Resolver never throws on malformed/absent context inputs — it falls back to Attention.
- With `OverviewCache` / `ReviewQueueStore` empty or not-yet-loaded, the panel still renders the header and a mode's placeholder body (data-fetch failures degrade inside render, not in the resolver).

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| First view-embedded webview adds unforeseen lifecycle/CSP/bundle work | Medium | Medium | Model directly on existing `BacklogSearchPanel` / `MarkdownPreviewProvider` webviews; keep the skeleton's bodies as placeholders so webview scope is header + switching only. |
| Overlapping predicates make the "deterministic resolver" non-deterministic (the load-bearing risk for a resolver spec) | High if unaddressed | High | Lock an explicit precedence order at the plan gate; encode it once; unit-test the overlap case directly. |
| Editor-centric context model silently fails on the extension's own custom-editor / multi-diff surfaces (opening a spec via Codev preview falls to Attention) | High if unaddressed | High | Derive context from the active tab input, not `activeTextEditor`; include the diff-inject-registry and tab-group events in the trigger set; test custom-editor and multi-diff surfaces. |
| Webview XSS / resource escape via path- or builder-id-derived header text | Low | High | Nonce+CSP, `localResourceRoots`, validated message allowlist, HTML-escape all header text; assert escaping in tests. |
| Terminal-vs-editor event mismatch causes Builder Inspector to never *trigger* | Medium | High | Make the resolver's trigger set explicit (editor + terminal events); cover terminal-active → builder-inspector in unit tests; verify in dev-approval walkthrough. |
| Builder Inspector never *exits* — focus returns from terminal to an already-active editor and no enumerated event fires while `activeTerminal` stays set, so the panel is stuck on the builder (the harder direction, source-confirmed) | High if unaddressed | High | Plan-gate API feasibility check for an editor-focus proxy (`onDidChangeTextEditorSelection` + webview/terminal focus); document the residual "fires nothing" cases; test the exit path explicitly. |
| Transient selection not cleared on a surface-change path, leaving the panel "stuck" off-context (a soft regression to the pinning behavior we removed) | Medium | Medium | Clear the selection in one place on every trigger event before re-resolving; assert the clear-on-change invariant in provider tests. |
| Umbrella/participating boundary blurs — skeleton starts implementing mode content | Medium | Medium | Ship only placeholder bodies + render targets; success criteria explicitly forbid mode-content rendering here; participating issues reference this umbrella. |
| Resolver drifts from O(1) as modes grow (tempted to fetch data during resolve) | Low | Medium | Enforce pure/sync/no-IO resolver in tests; keep all data access in render paths after the mode is chosen. |
| Greyed-but-visible pills add clutter or confusion | Low | Low | Follow VSCode peer patterns (Run/Debug, Source Control); optional hover explanations; dev-approval feel check. |

## References

- Issue #1049 — this umbrella (panel skeleton + mode resolver + Attention fallback).
- #1037 — Pending Review Comments queue → powers Code Review mode and the Attention cross-builder roll-up (`ReviewQueueStore`, `.builders/<id>/.codev/pending-comments.json`).
- #807 — Codev Reader View → candidate Builder Inspector mode / variant, evaluated when picked up.
- Files-not-yet-reviewed — sibling issue, contributes to Code Review mode; needs its own persistence.
- #859 / #945 — artifact-canvas + markdown preview; Document Review reads the SDK review-marker codec (`<!-- REVIEW(@<author>): <text> -->`).
- #789 / PR #1023 — codelens injection precedent that #1037 builds on.
- #921 — the `Codev Dev` panel tab (`DevTreeProvider`), which stays separate.
- Existing peers for the pattern: VSCode Source Control (morphs with git state), Outline (tracks active editor), Run and Debug (context-specific controls).
