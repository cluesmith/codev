# PIR Review: Wire the Attention fallback body from OverviewCache

Fixes #1553

## Summary

The #1049 contextual bottom panel shipped skeleton-only: every mode's body was a placeholder. This
participating feature wires one of them — the **Attention fallback** (shown when the active surface
is not a document, diff, or builder terminal) — to render a live roll-up from the `OverviewData` the
extension already holds in `OverviewCache`: builders **blocked at gates** (plus PRs awaiting review),
builders **waiting on input** (idle past the threshold), **held mail**, and **queued feedback**, with
an honest empty state. The projection is a pure, cross-client helper in `codev-sdk`; the panel
re-renders it on every SSE-driven cache refresh. Purely contextual — no navigation, selection, or
persisted state.

## Files Changed

- `packages/sdk/src/builder-helpers.ts` (+139 / -1) — new `deriveAttention` projection + its types,
  beside the existing `isIdleWaiting`
- `packages/sdk/src/__tests__/builder-helpers.test.ts` (+141 / -0) — new; unit tests for the
  projection and `isIdleWaiting`
- `apps/vscode/src/contextual-panel/webview/main.ts` (+189 / -18) — render the roll-up + empty state;
  drop the redundant Attention header
- `apps/vscode/src/contextual-panel/webview/styles.css` (+178 / -1) — section/row/badge styles, all
  theme tokens
- `apps/vscode/src/contextual-panel/panel-provider.ts` (+17 / -3) — inject `OverviewCache`; re-post in
  Attention mode on `onDidChange`; attach the projected payload
- `apps/vscode/src/contextual-panel/messages.ts` (+7) — optional `attention?` on `RenderMessage`
- `apps/vscode/src/__tests__/contextual-panel-provider.test.ts` (+115) — mock cache; payload +
  re-post coverage
- `apps/vscode/src/extension.ts` (+1 / -1) — pass `overviewCache` into the provider
- `apps/vscode/src/contextual-panel/attention.ts` (deleted) + its test (moved to `codev-sdk`)

## Design

Follows #1049's pure-core / host-adapter split. The resolver is untouched and stays pure
(`SurfaceContext → { kind, context }`, no knowledge of `OverviewData`). The provider, after resolving
Attention, attaches a projected `AttentionSummary` **alongside** the descriptor on the render message
(not inside `ModeDescriptor`), so the resolver's output contract stays pure. The webview renders the
sections via React children (auto-escaped, no `innerHTML`), using only `--vscode-*` theme tokens, so
it tracks the reviewer's theme in both light and dark with no separate palette.

## The `codev-sdk` move (plan deviation — logged, verified)

**The approved plan declared `AttentionSummary` and `deriveAttention` extension-local.** During dev
iteration the owner directed that they be **shared**: the projection was moved into
`packages/sdk/src/builder-helpers.ts`, beside the existing `isIdleWaiting`, and the extension-local
`contextual-panel/attention.ts` was deleted. The plan's "extension-local" claim is therefore
**superseded**; the owner was the deciding authority, and the main architect (owner of the
`packages/sdk` contract surface) was routed the change and confirmed the seat **satisfied post-hoc
with verification, no changes required**.

**Why this home (reuse, not speculation):** `builder-helpers.ts` already exists precisely for
cross-client UI-policy projections over `OverviewBuilder` — `isIdleWaiting` + `IDLE_WAITING_THRESHOLD_MS`,
whose own header states it lives there (not in `codev-types`) to stop the VSCode extension and the web
dashboard from drifting on "what needs a human." An attention roll-up is the same policy one level up;
`api.ts`'s `queuedFeedback` doc already names "#1049's future Attention rollup" and the Stream Deck
badge as consumers of the same fields. Co-locating avoids a second client re-deriving "attention" and
drifting.

**What main's ruling verified** (recorded here so it isn't re-argued):
- **Import boundary held** — `codev-types` imported type-only, pure functions, injectable `now`; the
  SDK's `import-boundary.test.ts` passes (no node/vscode/DOM/runtime-dep).
- **Single source** — extension-local `attention.ts` deleted; all consumers read the one SDK subpath;
  no duplicate definition.
- **Webview bundle clean** — the webview imports the types **type-only** (erased by esbuild); the sole
  value import (`deriveAttention`) is host-side, where SDK value imports are already established and
  the workspace dep already exists — **no dependency-class transition**.
- **Policy home correct** — `AttentionSummary` is a derived *client projection*, not a wire contract,
  so it belongs out of `codev-types` and co-located with `isIdleWaiting`.
- **Semantics sound** — the gate-vs-idle de-dup (a builder already shown as a gate is not re-listed as
  waiting) and `heldTotal` (workspace-wide, all recipients) vs per-builder `heldMail` are correct.

The same iteration also folded `isIdleWaiting` into the roll-up as a **"Waiting on input"** section —
the issue asked for "needs-attention state," and idle-waiting is the SDK's canonical needs-me state
alongside `blocked`; the panel's stripe/badge use the sidebar's idle token (`notificationsInfoIcon`).

## Things to Look At During PR Review

- **Plan deviation** (above): the SDK relocation is intentional and stakeholder-verified, not scope
  creep. `packages/sdk` is the main architect's surface — that's why it was routed and confirmed.
- **Color/token cohesion** (dev-iteration): gate amber → `notificationsWarningIcon.foreground` (the
  sidebar's blocked-bell token, not `editorWarning`); idle → `notificationsInfoIcon.foreground`; count
  pill → the `badge-foreground`/`badge-background` pair (was grey-on-blue); row badges are text-only
  (a filled pale-warning chip washed out on the grey row-hover, and the queued badge was blue-on-blue).
- **Refresh model:** `deriveAttention` recomputes `isIdleWaiting` at post time (host `Date.now()`); a
  builder crossing the 5-min idle threshold surfaces on the next SSE cache tick, not by a timer. This
  matches how the sidebar recomputes idle on refresh; no polling is introduced.
- **Header dropped for Attention only:** the other three modes keep their one-line context header
  (it names their file/builder); Attention's would be a static word duplicating the "Codev" panel tab.

## Consultation Feedback

Populated after porch's single advisory 3-way pass (`max_iterations: 1`); verdicts surfaced to the
human at the `pr` gate.

## Architecture Updates

- Routed: **cold** — `codev/resources/arch.md` (VS Code Extension + the `codev-sdk` client helpers):
  the "what needs a human" attention roll-up is a **shared client projection** in
  `codev-sdk/builder-helpers.ts` (`deriveAttention`), the same cross-client UI-policy home as
  `isIdleWaiting`; the VSCode contextual panel is its first consumer and renders it into the Attention
  fallback target, re-posting on `OverviewCache` change. Subsystem-level detail → cold.
- No **hot** (`arch-critical.md`) change: no new always-must-know invariant, and the hot file is at cap.

## Lessons Learned Updates

- Routed: **cold** — `codev/resources/lessons-learned.md` (Architecture + UI/UX):
  1. Before declaring a UI projection over overview data extension-local, check
     `codev-sdk/builder-helpers.ts` — it is the established home for cross-client policy derived from
     `OverviewBuilder`/`OverviewData` (single source, anti-drift). `codev-types` stays wire-contracts
     only; a *derived client projection* belongs in the SDK, not the types package.
  2. For cross-surface visual cohesion, reuse the **exact** `ThemeColor` token a sibling surface
     already uses for the same concept (the sidebar's `notificationsWarningIcon` for a blocked gate,
     `notificationsInfoIcon` for idle), not a near-equivalent (`editorWarning`/`charts-*`).
  3. In a themed webview, pair fills from the token set designed to pair (`badge-foreground` on
     `badge-background`); a filled semantic-validation background (`inputValidation-*Background`) pairs
     poorly with its own amber/red text and with the row-hover — prefer colored text on the surface.
- No **hot** (`lessons-critical.md`) change: these are extension/SDK-specific, not cross-cutting
  must-knows; the hot file is at cap.

## Deviations from Plan

- **`AttentionSummary` / `deriveAttention` moved from extension-local to `codev-sdk`** — see "The
  `codev-sdk` move" above. Owner-directed during dev iteration; main architect verified the SDK
  surface post-hoc; recorded, not silently shipped.
- **"Waiting on input" section added** — `isIdleWaiting` folded into the roll-up (the plan's signal set
  was blocked/prReady/held/queued); it realizes the issue's "needs-attention state."
- **Color/token realignment + header removal** — dev-iteration polish against the running panel
  (see Things to Look At).
