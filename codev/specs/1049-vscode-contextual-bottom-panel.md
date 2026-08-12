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
- **Builder diff editor:** the unified multi-file diff opens under the custom scheme `codev-diff:`; the `codev.activeEditorIsBuilderFile` context key already tracks whether the active editor belongs to a builder diff session.
- **Builder terminal:** `TerminalManager` owns builder PTY terminals; `resolveBuilderTerminal` maps a terminal to its builder id.
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
- [ ] A `ModeResolver` exists as a **pure, synchronous function** taking `(activeContext, workspaceState, pinnedMode)` and returning a `ModeDescriptor` (`{ kind: 'document-review' | 'code-review' | 'builder-inspector' | 'attention', context }`). No filesystem walks, no async, no network. Its inputs are cheap-to-compute (URI-prefix / scheme / context-value checks).
- [ ] The panel header renders four mode pills (Document Review, Code Review, Builder Inspector, Attention). The active mode is visually distinct. Modes inapplicable to the current context are visibly greyed rather than hidden.
- [ ] Clicking an applicable mode pill overrides the contextual default for the session. A pin control toggles persistent pinning, stored per workspace under the key `codev.contextualPanel.pinnedMode`; when pinned, the panel stops switching with the editor.
- [ ] When no context matches and no pin is set, the panel falls back to Attention mode.
- [ ] The mode switches in response to the active-surface changing within a perceptible budget (~50 ms from the editor/terminal-change event to the header reflecting the new mode); resolution itself is O(1).
- [ ] The panel exposes a render target per mode but does **not** implement mode content — it ships placeholder bodies per mode plus the orchestration that switches between them.
- [ ] Unit tests cover the resolver's branches: each active-surface type → its mode, pin-overrides-context, attention fallback when nothing matches, and modes reported greyed/inapplicable for the current context.
- [ ] Dev-approval walkthrough passes: open a spec → Document Review active; switch to a builder diff editor → Code Review active; focus a builder terminal → Builder Inspector active; pin Attention, switch editors → panel stays on Attention.

## Constraints

Technical and integration constraints that bound the solution. The following reflect the architect's baked direction in issue #1049 and the current codebase:

- **Architecture split is fixed (baked):** the mode resolver is a separate concern from view rendering — `ContextualPanel = ModeResolver (context+state+pin → ModeDescriptor) + PanelRenderer (ModeDescriptor → view tree)`. The resolver is a pure function; heavier data fetches happen inside a mode's render path, after the mode is chosen.
- **Mode mapping v1 is fixed (baked):** the four modes and their trigger contexts are as tabled above. Individual mode *content* is out of scope and owned by participating issues.
- **`Codev Dev` stays a separate tab (baked):** it is a service surface ("is my dev server up?"), a different mental category from "what do I need to act on"; it is not folded into the contextual panel.
- **Panel-only change (baked):** no sidebar restructuring, no editor/terminal-surface modes, single mode at a time (no split-mode) for v1. Each VSCode window reflects its own active surface (already correct — active editor is per-window).
- **Performance budget (baked):** resolution runs on every active-surface change and must be O(1) — URI-prefix matching, scheme checks, `contextValue`/context-key checks, no filesystem walks. Data fetches are deferred into render.
- **Header with mode-pill buttons implies a webview surface.** The current panel tabs are tree views and no `WebviewViewProvider` exists yet; a mode-switcher header is not expressible as a tree. This is new infrastructure for the extension (see Solution Approaches).
- **Reuse existing state sources, do not duplicate them:** artifact-path matching, the `codev-diff:` scheme / `codev.activeEditorIsBuilderFile` key, `resolveBuilderTerminal`, `OverviewCache`, `ReviewQueueStore`, and the SDK review-marker codec are the authoritative inputs. The resolver reads already-computed signals; it does not re-derive them.
- **Terminal focus is a distinct VSCode event.** A builder terminal becoming active fires `onDidChangeActiveTerminal`, not `onDidChangeActiveTextEditor`. Builder Inspector mode therefore cannot be driven by the text-editor event alone; the resolver's trigger set must include the terminal event. (Correction to the issue's "runs on onDidChangeActiveTextEditor" phrasing.)
- **Persistence uses `workspaceState` (per-workspace Memento),** matching the existing `AreaGroupExpansionStore` precedent, under key `codev.contextualPanel.pinnedMode`. Note this is per-workspace-folder, shared across windows opening the same folder (see Open Questions on pin scope).
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

Back the contextual tab with a `WebviewViewProvider` registered against the `codevPanel` container. The webview renders the header (context label + four mode pills + pin control) and a mode body region. The host runs the resolver on active-surface-change events and posts the resulting `ModeDescriptor` to the webview; the webview renders the header state and a per-mode placeholder body. Message passing follows the existing `BacklogSearchPanel` (themed `--vscode-*` HTML) or `MarkdownPreviewProvider` (React) precedents.

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

- None. The baked architecture, mode mapping, and out-of-scope boundary remove the blocking ambiguities; the substrate choice above has a clear recommendation.

**Important (shapes design — resolve at plan gate):**

- **Pin scope: per-window vs per-workspace.** Plan-gate lean #1 favors per-window (each window has its own panel state), but `workspaceState` persists per workspace-folder and is *shared* across windows opening the same folder. True per-window requires in-memory/session state (not persisted) or window-keyed storage. Which wins: per-window feel (session-scoped, not persisted) or persisted-per-workspace as the issue's key name implies? (Recommend: persist the pin per workspace under `codev.contextualPanel.pinnedMode`; accept that same-folder multi-window shares it, which is rare.)
- **Terminal trigger event.** Confirm Builder Inspector mode is driven by `onDidChangeActiveTerminal` (plus text-editor changes for the other modes), since the text-editor event does not fire on terminal focus. Does focusing a builder terminal switch the mode while a text editor remains the "active editor"? (Recommend: yes — treat the active terminal as part of the resolver's `activeContext`.)
- **Sticky input during mode switch.** Plan-gate lean #5: if the user is mid-typing in one mode and focuses an editor that would switch modes, does the panel switch immediately (losing input) or hold until the input settles? (Recommend: hold until commit — typed input is sticky.) The skeleton's placeholder bodies have no input, so this is a contract to define now and honor when participating modes add inputs.

**Nice-to-know (optimization):**

- **Greyed-pill hover explanation** (plan-gate lean #3): should hovering an inapplicable pill explain how to activate it (e.g. "open a spec/plan/review to activate Document Review")? (Recommend: yes; cheap.)
- **Pin visual treatment** (plan-gate lean #2): pin icon adjacent to the active pill vs a separate toggle. (Recommend: icon next to the active pill.)
- **Empty-state per mode** (plan-gate lean #4): the umbrella ships placeholders, but should the placeholder for e.g. Code-Review-with-zero-comments already read as a calm empty state with an "override to Attention" affordance, or is that deferred to the participating issue? (Recommend: minimal placeholder now; rich empty state owned by the participating mode.)

## Test Scenarios

**Resolver (pure-function unit tests — happy paths and branches):**

- Active editor is a `codev/specs/…md` file → `document-review`; same for `plans/` and `reviews/`.
- Active editor is a `codev-diff:` builder diff / `codev.activeEditorIsBuilderFile` is true → `code-review`, context carries the builder id.
- Active surface is a builder terminal → `builder-inspector`, context carries the builder id.
- No matching context (arbitrary non-artifact file, no builder terminal) → `attention` (fallback).
- A pin is set → resolver returns the pinned mode regardless of context (pin overrides).
- For a given context, the resolver reports which of the four modes are applicable vs inapplicable (drives greyed pills).

**Edge cases:**

- Non-builder markdown file *outside* `codev/{specs,plans,reviews}/` → not Document Review (must be Attention or whatever else matches), guarding against over-broad path matching.
- Active editor is `undefined` (all editors closed) with a builder terminal focused → `builder-inspector`; with nothing focused → `attention`.
- Pinned mode value that is stale/invalid (persisted mode no longer valid) → resolver degrades gracefully to contextual/attention rather than throwing.
- Multi-window: each window's resolver reflects its own active surface independently.

**Non-functional / integration:**

- Switching the active editor updates the header within ~50 ms (no perceptible lag); resolution is O(1) with no filesystem/network calls on the switch path.
- Manifest invariant: the panel container contributes the contextual `Codev` view and still contributes `codev.dev`; the placeholder is repurposed/hidden appropriately.
- Persistence round-trip: pinning a mode writes `codev.contextualPanel.pinnedMode`; reopening the workspace restores the pin; unpinning clears it and resumes contextual switching.

**Error conditions:**

- Resolver never throws on malformed/absent context inputs — it falls back to Attention.
- With `OverviewCache` / `ReviewQueueStore` empty or not-yet-loaded, the panel still renders the header and a mode's placeholder body (data-fetch failures degrade inside render, not in the resolver).

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| First view-embedded webview adds unforeseen lifecycle/CSP/bundle work | Medium | Medium | Model directly on existing `BacklogSearchPanel` / `MarkdownPreviewProvider` webviews; keep the skeleton's bodies as placeholders so webview scope is header + switching only. |
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
