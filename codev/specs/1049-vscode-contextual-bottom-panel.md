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

A single contextual `Codev` panel tab whose content morphs to pair with the active editor and workspace state, with a fallback **Attention** mode when nothing more specific matches. This mirrors patterns the user already knows: Source Control morphs with git state, Outline tracks the active editor, Run-and-Debug shows context-specific controls.

Four modes (v1):

| Active context | Mode | Panel shows (rendering owned by participating issues) |
|---|---|---|
| Editor is a file under `codev/{specs,plans,reviews}/` | **Document Review** | Review markers anchored to this file, with resolve / edit / delete actions (source: the marker bytes in the file). |
| Editor is the builder unified diff editor | **Code Review** | This builder's pending-comments queue (#1037) + files-not-yet-reviewed checklist + Submit Review action. |
| Active surface is a builder terminal | **Builder Inspector** | This builder's phase, gate state, recent activity, send-message input. |
| No specific match | **Attention** (fallback) | Cross-cutting roll-up: pending gates, blocked builders, queued review comments across builders, recently-closed audit. |

A header strip renders `<context label> · <four mode pills>`. The active mode is visually distinct; inactive-but-applicable modes are clickable to override the contextual default; modes that do not apply to the current context are greyed but still visible (so the user learns the panel can do more). A pin control locks the panel to a chosen mode so it stops following the editor, persisted per workspace.

**Umbrella scope is the skeleton only:** this project ships the panel surface, the mode resolver, the header/switcher, mode-switch orchestration, and a placeholder body per mode. The *actual content rendering* for each mode is owned by the participating-feature issues (#1037, files-not-yet-reviewed, #807, …) and lands in their own PRs against the render targets this umbrella exposes.

Users will see: the panel automatically pairs with what they are looking at; power users can pin a mode and lock it; the switcher advertises the panel's full capability even when a mode is inactive.

## Success Criteria

- [ ] One contextual `Codev` tab exists in the bottom panel; the existing scaffold placeholder is repurposed into it. The `Codev Dev` tab is untouched.
- [ ] A `ModeResolver` exists as a **pure, synchronous, VSCode-free function** taking a plain `SurfaceContext` value plus a `ModeOverride | null`, and returning a `ModeDescriptor` (`{ kind: 'document-review' | 'code-review' | 'builder-inspector' | 'attention', context }`) together with the applicability of all four modes. No VSCode host types in the signature (no `Memento`/editor objects), no filesystem walks, no async, no network. A host-side adapter derives `SurfaceContext` from cheap signals (active tab input viewType/scheme/resource path, `codev.activeEditorIsBuilderFile`, `getActiveBuilderId()`) and reads the persisted override before calling the resolver.
- [ ] **Predicate precedence is explicit and total.** When more than one context predicate matches (e.g. a builder's `codev/specs/*.md` open inside a diff session satisfies both the artifact-path and builder-diff predicates), the resolver applies a single documented priority order to pick exactly one mode. The order is a plan-gate decision; whatever it is, it is encoded once, tested, and never ambiguous.
- [ ] **Context is derived from the active tab, not `activeTextEditor` alone**, so the resolver works for the extension's non-text surfaces: the `codev.markdownPreview` custom editor (where `activeTextEditor` is `undefined`) still resolves to Document Review, and the multi-file diff tab still resolves to Code Review. The trigger set includes tab-group changes, terminal-focus changes, and diff-inject registry changes — not only `onDidChangeActiveTextEditor`.
- [ ] The panel header renders four mode pills (Document Review, Code Review, Builder Inspector, Attention). The active mode is visually distinct. Modes inapplicable to the current context are visibly greyed rather than hidden (any mode remains user-selectable/pinnable).
- [ ] **Override model is unified and its lifetime is defined.** Selecting a mode pill sets a session override; a pin control persists that override per workspace under the key `codev.contextualPanel.pinnedMode`. An override (session or pinned) holds across active-surface changes until the user changes it or clears it; a documented "return to contextual" affordance clears it. A pinned override survives reload; a session-only override does not.
- [ ] When no context matches and no override is set, the panel falls back to Attention mode.
- [ ] The mode switches in response to the active-surface changing within a perceptible budget (~50 ms from the trigger event to the header reflecting the new mode); resolution itself is O(1).
- [ ] The panel exposes a render target per mode but does **not** implement mode content — it ships placeholder bodies per mode plus the orchestration that switches between them.
- [ ] The webview surface is hardened: nonce-based CSP, constrained `localResourceRoots`, an allowlisted/validated host↔webview message contract, and escaping of any header text derived from file paths or builder ids.
- [ ] Unit tests cover the resolver's branches: each active-surface type → its mode, predicate-overlap precedence, override-overrides-context, attention fallback when nothing matches, modes reported greyed/inapplicable for the current context, and graceful degradation on malformed/absent inputs. Additional automated tests cover provider event wiring, the webview message contract, override reset, and pin persistence round-trip.
- [ ] Dev-approval walkthrough passes: open a spec (including via the Codev markdown preview) → Document Review active; switch to a builder diff editor → Code Review active; focus a builder terminal → Builder Inspector active; pin Attention, switch editors → panel stays on Attention.

## Constraints

Technical and integration constraints that bound the solution. The following reflect the architect's baked direction in issue #1049 and the current codebase:

- **Architecture split is fixed (baked):** the mode resolver is a separate concern from view rendering — `ContextualPanel = ModeResolver (context+state+pin → ModeDescriptor) + PanelRenderer (ModeDescriptor → view tree)`. The resolver is a pure function; heavier data fetches happen inside a mode's render path, after the mode is chosen.
- **Mode mapping v1 is fixed (baked):** the four modes and their trigger contexts are as tabled above. Individual mode *content* is out of scope and owned by participating issues.
- **`Codev Dev` stays a separate tab (baked):** it is a service surface ("is my dev server up?"), a different mental category from "what do I need to act on"; it is not folded into the contextual panel.
- **Panel-only change (baked):** no sidebar restructuring, no editor/terminal-surface modes, single mode at a time (no split-mode) for v1. Each VSCode window reflects its own active surface (already correct — active editor is per-window).
- **Performance budget (baked):** resolution runs on every active-surface change and must be O(1) — URI-prefix matching, scheme checks, `contextValue`/context-key checks, no filesystem walks. Data fetches are deferred into render.
- **Header with mode-pill buttons implies a webview surface.** The current panel tabs are tree views and no `WebviewViewProvider` exists yet; a mode-switcher header is not expressible as a tree. This is new infrastructure for the extension (see Solution Approaches).
- **Reuse existing state sources, do not duplicate them:** artifact-path matching, the `codev-diff:` scheme / `codev.activeEditorIsBuilderFile` key / `onDidChangeDiffInjectRegistry`, `getActiveBuilderId()`, `OverviewCache`, `ReviewQueueStore`, and the SDK review-marker codec are the authoritative inputs. The resolver reads already-computed signals; it does not re-derive them.
- **The resolver contract is VSCode-free and total.** Its input is a plain `SurfaceContext` value (illustratively: `{ surface: 'artifact' | 'builder-diff' | 'builder-terminal' | 'other' | 'none', resourcePath?, viewType?, builderId? }`) produced by a thin host-side adapter, plus an optional `ModeOverride` (`{ mode, persistent }`). It returns the chosen `ModeDescriptor` and the applicability of each mode. It must never throw on malformed input — unknown/empty context degrades to Attention. This keeps it unit-testable under Vitest with no VSCode host and no `Memento` in the signature.
- **Context is tab-based, and the trigger set is explicit.** The adapter reads the active tab input (`window.tabGroups.activeTabGroup.activeTab.input` → viewType/scheme + resource URI) rather than `activeTextEditor` alone, so custom editors (`codev.markdownPreview`) and the multi-file diff tab resolve correctly. Re-resolution is triggered by tab-group changes, terminal-focus changes (`onDidChangeActiveTerminal`), and diff-inject registry changes (`onDidChangeDiffInjectRegistry`, since the registry populates after the diff activates). (Correction to the issue's "runs on onDidChangeActiveTextEditor" phrasing.)
- **Active-surface semantics must resolve editor-vs-terminal focus.** A terminal gaining focus does not clear `activeTextEditor`; the adapter must decide the currently-active surface (most-recently-focused editor tab vs terminal) and define how returning focus to an editor exits Builder Inspector. This is captured as an Important open question, not left implicit.
- **Persistence uses `workspaceState` (per-workspace Memento),** matching the existing `AreaGroupExpansionStore` precedent, under key `codev.contextualPanel.pinnedMode`. This is per-workspace-folder: windows on distinct folders naturally keep distinct pins; only the rare case of two windows on the *identical* folder shares it (see Open Questions on pin scope, reconciled with issue #1049's per-window out-of-scope bullet).
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

Back the contextual tab with a `WebviewViewProvider` registered against the `codevPanel` container. The webview renders the header (context label + four mode pills + pin control) and a mode body region. The host derives a tab-based `SurfaceContext`, runs the pure resolver on active-surface-change events (tab-group, terminal-focus, diff-inject registry), and posts the resulting `ModeDescriptor` to the webview; the webview renders the header state and a per-mode placeholder body. Message passing follows the existing `BacklogSearchPanel` (themed `--vscode-*` HTML) or `MarkdownPreviewProvider` (React) precedents, and inherits their nonce/CSP/`localResourceRoots` hardening.

- **Pros:** the mode-pill header, greyed/active pill styling, hover explanations, and a flexible mode body are all naturally expressible; gives participating issues a real render surface (React or HTML) to build their mode content into; matches where the extension's richer surfaces already live.
- **Cons:** first view-embedded webview in the extension — a small amount of new infrastructure (webview lifecycle in a panel view, CSP, bundle wiring); more surface area than a tree.
- **Risk/complexity:** low-to-moderate. Webview mechanics are already proven in the repo; the new part is hosting one inside a panel view rather than a floating panel/editor.

### Approach 2: Tree-view panel with header rows

Keep a `TreeDataProvider` (evolving the placeholder) and express the "header" as special top rows — the context label and four mode entries as clickable tree items with a pin action in the row's inline actions; the mode body as child rows.

- **Pros:** reuses the dominant panel pattern (all current tabs are trees); no webview/CSP/bundle work; trivially Vitest-friendly.
- **Cons:** a horizontal pill switcher and greyed-but-visible affordances are awkward as tree rows; mode content (comment editors, message input, checklists) is what participating issues need, and trees are a poor host for rich, interactive content — likely forcing a later rewrite to a webview. Fights the issue's explicit "header strip with mode pill buttons" UI.
- **Risk/complexity:** low to build, high risk of throwaway work when participating modes need interactive rendering.

**Recommendation: Approach 1 (webview-view).** The header-with-pills UI and the interactive per-mode content the participating issues require both point to a webview substrate; a tree would satisfy the switching contract but hand every downstream mode a hostile rendering surface. The resolver stays a pure, host-side function either way (unchanged by this choice), so the substrate decision is isolated to the renderer half of the split.

## Open Questions

**Critical (blocks progress):**

- None. The baked architecture, mode mapping, and out-of-scope boundary remove the blocking ambiguities; the substrate choice has a clear recommendation, and the precedence gap surfaced by review is now a required (though as-yet-unordered) criterion rather than a hidden ambiguity.

**Important (shapes design — resolve at plan gate):**

- **Predicate precedence order.** The resolver must pick exactly one mode when predicates overlap (a builder's `codev/specs/*.md` in a diff session satisfies both artifact-path and builder-diff). What is the order? (Recommend: builder-terminal → builder-diff → artifact-path → attention. Rationale: the diff surface signals code-review intent even when the file is an artifact; a spec opened as a plain/preview tab is not a builder-diff surface, so it still lands in Document Review.) The order is a decision to lock, not to leave to implementation.
- **Active-surface (editor vs terminal) semantics.** Focusing a builder terminal fires `onDidChangeActiveTerminal` but does not clear `activeTextEditor`. How is the "active surface" chosen, and how does returning focus to an editor exit Builder Inspector? (Recommend: track the most-recently-focused surface; an editor-tab focus supersedes the terminal, a terminal focus supersedes the tab; Builder Inspector holds only while the terminal is the most-recent surface.)
- **Override lifetime and clearing.** A session override (pill click) and a pin (persisted override) both hold across surface changes. What clears a session override — an explicit "return to contextual" control, re-clicking the active pill, or closing the panel? Can builder-dependent modes (Code Review / Builder Inspector) be pinned when no builder is in context (they render an empty "no builder" state)? (Recommend: explicit clear control + re-click clears; any mode is pinnable, builder-dependent modes show an empty state when context is absent.)
- **Pin scope, reconciled with the issue's out-of-scope.** Issue #1049 states both "persisted as `codev.contextualPanel.pinnedMode` per workspace" and, in Out of Scope, "each VSCode window keeps its own pin state." These are reconcilable: `workspaceState` is per-workspace-folder, so windows on distinct folders already keep distinct pins; the only shared case is two windows on the identical folder. Decision to confirm at the gate: accept per-workspace-folder persistence (shared in the rare identical-folder case) or use in-memory per-window state (true per-window, but the pin does not survive reload). (Recommend: per-workspace-folder persistence — honors both statements for the common case.)
- **Sticky input during mode switch.** Plan-gate lean #5: if the user is mid-typing in one mode and focuses an editor that would switch modes, does the panel switch immediately (losing input) or hold until the input settles? (Recommend: hold until commit — typed input is sticky. A standard host↔webview signal such as `postMessage({ type: 'userEditingStateChanged', isEditing })` lets the orchestrator defer re-resolution; skeleton placeholders never set `isEditing`, but defining the contract now makes downstream mode integration seamless.)

**Nice-to-know (optimization):**

- **Greyed-pill hover explanation** (plan-gate lean #3): should hovering an inapplicable pill explain how to activate it (e.g. "open a spec/plan/review to activate Document Review")? (Recommend: yes; cheap.)
- **Pin visual treatment** (plan-gate lean #2): pin icon adjacent to the active pill vs a separate toggle. (Recommend: icon next to the active pill.)
- **Empty-state per mode** (plan-gate lean #4): the umbrella ships placeholders, but should the placeholder for e.g. Code-Review-with-zero-comments already read as a calm empty state with an "override to Attention" affordance, or is that deferred to the participating issue? (Recommend: minimal placeholder now; rich empty state owned by the participating mode.)

## Test Scenarios

**Resolver (pure-function unit tests — happy paths and branches):**

- Artifact surface: `SurfaceContext` for a `codev/specs/…md` file → `document-review`; same for `plans/` and `reviews/`.
- Artifact via custom editor: surface `viewType = codev.markdownPreview` on a spec resource → `document-review` (proves the tab-based, not `activeTextEditor`, model).
- Builder-diff surface (diff tab / `activeEditorIsBuilderFile`) → `code-review`, context carries the builder id.
- Builder-terminal surface → `builder-inspector`, context carries the builder id.
- **Predicate overlap:** a builder `codev/specs/*.md` inside a diff session → the single mode chosen by the documented precedence order (and a test asserting the order is applied, not either-or).
- No matching context → `attention` (fallback).
- An override is set (session or pinned) → resolver returns the overridden mode regardless of context; a builder-dependent overridden mode with no builder in context reports an empty-context descriptor rather than throwing.
- For a given context, the resolver reports which of the four modes are applicable vs inapplicable (drives greyed pills).

**Edge cases:**

- Non-builder markdown file *outside* `codev/{specs,plans,reviews}/` → not Document Review (guards against over-broad path matching).
- Multi-file diff tab active where the registry has not yet populated on first open → re-resolution on `onDidChangeDiffInjectRegistry` yields `code-review` (no stale-key miss).
- Surface is `none`/unknown (all tabs closed) with a builder terminal focused → `builder-inspector`; with nothing focused → `attention`.
- Malformed/stale override value (persisted mode no longer valid) → resolver degrades to contextual/attention rather than throwing.
- Multi-window: each window's resolver reflects its own active surface independently.

**Provider / integration (mocked-`vscode` and manifest tests):**

- Provider event wiring: tab-group / terminal-focus / diff-inject-registry changes each trigger exactly one re-resolution and a header update.
- Webview message contract: unknown/malformed inbound messages are ignored; known messages (mode-select, pin-toggle, clear-override) drive the expected host action.
- Override reset: selecting a pill sets the session override; the clear control returns to contextual resolution.
- Persistence round-trip: pinning writes `codev.contextualPanel.pinnedMode`; reopening the workspace restores the pin; unpinning clears it and resumes contextual switching.
- Manifest invariant: the panel container contributes the contextual `Codev` view and still contributes `codev.dev`; the placeholder is repurposed/hidden appropriately.

**Non-functional / security:**

- Switching the active surface updates the header within ~50 ms (no perceptible lag); resolution is O(1) with no filesystem/network calls on the switch path.
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
| Terminal-vs-editor event mismatch causes Builder Inspector to never trigger | Medium | High | Make the resolver's trigger set explicit (editor + terminal events); cover terminal-active → builder-inspector in unit tests; verify in dev-approval walkthrough. |
| Pin-scope decision (per-window vs per-workspace) chosen wrong, surprising multi-window users | Low | Low | Resolve at plan gate; default to persisted-per-workspace (rare multi-window-same-folder case); document behavior. |
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
