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

- `packages/sdk/src/builder-helpers.ts` (+143 / -1) — new `deriveAttention` projection + its types,
  beside the existing `isIdleWaiting`
- `packages/sdk/src/__tests__/builder-helpers.test.ts` (+149 / -0) — new; unit tests for the
  projection and `isIdleWaiting`
- `apps/vscode/src/contextual-panel/webview/main.ts` (+191 / -18) — render the roll-up + empty state;
  drop the redundant Attention header
- `apps/vscode/src/contextual-panel/webview/styles.css` (+178 / -1) — section/row/badge styles, all
  theme tokens
- `apps/vscode/src/contextual-panel/panel-provider.ts` (+17 / -3) — inject `OverviewCache`; re-post in
  Attention mode on `onDidChange`; attach the projected payload
- `apps/vscode/src/contextual-panel/messages.ts` (+7) — optional `attention?` on `RenderMessage`
- `apps/vscode/src/__tests__/contextual-panel-provider.test.ts` (+115) — mock cache; payload +
  re-post coverage
- `apps/vscode/src/extension.ts` (+1 / -1) — pass `overviewCache` into the provider
- `apps/vscode/src/contextual-panel/attention.ts` (deleted) + its test (relocated to `codev-sdk`)
- `codev/resources/arch.md`, `codev/resources/lessons-learned.md` — cold-tier governance updates

## Commits

- `1bd926881` [PIR #1553] Wire Attention fallback body from OverviewCache
- `4cb89a5e8` [PIR #1553] Align gate amber to sidebar token, fix count-pill contrast, drop redundant Attention header
- `b2efca5c3` [PIR #1553] Make Attention row badges text-only for legible contrast in both themes
- `b20499182` [PIR #1553] Move Attention projection into codev-sdk/builder-helpers; add idle-waiting to the rollup
- (plus this review commit, and the CMAP-fix commit that added the mandated review sections + applied the routed arch/lessons updates)

## Test Results

- `pnpm --filter @cluesmith/codev-sdk build`: ✓ pass
- `pnpm --filter @cluesmith/codev-sdk test`: ✓ **120 pass** (16 for `deriveAttention`/`isIdleWaiting`, new)
- `pnpm --filter codev-vscode check-types`: ✓ pass (extension **and** webview tsconfigs)
- `pnpm --filter codev-vscode test:unit`: ✓ **935 pass** (provider payload + re-post cases, new)
- `node esbuild.js` (webview bundle): ✓ pass
- `pnpm --filter codev-vscode lint`: ✓ pass
- **Manual (owner, dev-approval):** verified the running panel across three review rounds against live
  cache data — drove the badge/contrast/token realignment (see Things to Look At). Reproducing every
  attention signal on demand needs a live Tower with builders at gates (see How to Test Locally).

## Architecture Updates

- Routed **COLD** — `codev/resources/arch.md` (VS Code Extension → the `#1049` contextual-panel
  paragraph): the Attention body roll-up is projected by `deriveAttention(OverviewData)`, a **pure
  cross-client helper co-located with `isIdleWaiting` in `@cluesmith/codev-sdk/builder-helpers`** (not
  extension-local), so a future dashboard / Stream Deck attention view shares one definition and can't
  drift; the payload rides beside the descriptor on `RenderMessage` (resolver stays pure) and re-posts
  on `overviewCache.onDidChange` only in Attention mode; colors reuse the sidebar's exact `ThemeColor`
  tokens. **Applied in this commit.**
- No **HOT** (`arch-critical.md`) change: no new always-must-know invariant, and the hot file is at cap.

## Lessons Learned Updates

- Routed **COLD** — `codev/resources/lessons-learned.md`, **applied in this commit**:
  1. *Architecture:* a UI projection over overview data belongs in `codev-sdk/builder-helpers` (the
     cross-client policy home, anti-drift), not extension-local; `codev-types` stays wire-contracts
     only; a `postMessage` envelope correctly stays local. Keep it pure with an injectable `now`;
     return a fresh empty object (no shared singleton) from public package surface.
  2. *UI/UX:* for cross-surface cohesion reuse the sibling surface's exact `ThemeColor` token
     (`notificationsWarningIcon` blocked, `notificationsInfoIcon` idle); pair fills from the
     designed pair (`badge-foreground`/`badge-background`); prefer colored text over a filled
     `inputValidation-*Background` chip (it washes out on the row-hover).
- No **HOT** (`lessons-critical.md`) change: extension/SDK-specific, not cross-cutting; hot file at cap.

## The `codev-sdk` move (plan deviation — logged, stakeholder-verified)

**The approved plan declared `AttentionSummary` and `deriveAttention` extension-local.** During dev
iteration the owner directed that they be **shared**: the projection moved into
`packages/sdk/src/builder-helpers.ts`, beside `isIdleWaiting`, and the extension-local
`contextual-panel/attention.ts` was deleted. The plan's "extension-local" claim is therefore
**superseded during dev iteration, with the owner as the deciding authority**. `packages/sdk` is the
main architect's contract surface, so the change was routed to them; the main seat is **satisfied
post-hoc, with verification, no changes required**. Owner approval did not substitute for stakeholder
routing (the pir-1494 precedent).

**Why this home (reuse, not speculation):** `builder-helpers.ts` already exists for cross-client
UI-policy projections over `OverviewBuilder` — `isIdleWaiting` + `IDLE_WAITING_THRESHOLD_MS`, whose
header states it lives there (not in `codev-types`) to stop the extension and the dashboard drifting
on "what needs a human." An attention roll-up is the same policy one level up; `api.ts`'s
`queuedFeedback` doc already names "#1049's future Attention rollup" and the Stream Deck badge as
consumers of the same fields.

**What main's ruling verified** (recorded so it isn't re-argued): import boundary held (type-only from
`codev-types`, pure functions, injectable `now`; `import-boundary.test.ts` passes); single source
(extension-local module deleted, all consumers on the one subpath, no duplicate); webview bundle clean
(type-only webview-side, the sole value import is host-side where SDK value imports are already
established and the workspace dep already exists — no dependency-class transition); policy home correct
(a derived client projection, not a wire contract); dedup + `heldTotal` semantics sound.

The same iteration folded `isIdleWaiting` into the roll-up as a **"Waiting on input"** section — the
issue asked for "needs-attention state," and idle-waiting is the SDK's canonical needs-me state
alongside `blocked`; the panel's stripe/badge use the sidebar's idle token (`notificationsInfoIcon`).

## Things to Look At During PR Review

- **Plan deviation** (above): the SDK relocation is intentional and stakeholder-verified, not scope
  creep — `packages/sdk` is the main architect's surface, which is why it was routed and confirmed.
- **CMAP dispositions (single-pass — the `pr` gate is the only remaining check):** Gemini APPROVE.
  Codex + Claude REQUEST_CHANGES, all on the *review artifact*, now fixed in this commit —
  (1) the mandated `## Commits` / `## Test Results` / `## How to Test Locally` sections were missing
  (added); (2) arch/lessons updates were *declared* but not *applied* to `codev/resources/*` (now
  applied in-commit). Two real code nits also fixed: the empty-state sub-line now names the "waiting"
  signal, and `deriveAttention`'s degenerate path returns a **fresh** object rather than a shared
  mutable singleton (regression test added). Rebutted/non-blocking: Codex's "renders empty-state
  instead of the prior placeholder" — the payload-absent branch now renders a neutral `Loading…`, not
  an emptiness claim (the provider always attaches the payload in Attention mode, so it is only a
  transient pre-first-post frame); Claude's "`since()` untested" — the webview render module can't be
  imported under vitest (top-level `acquireVsCodeApi()` + CSS import), so its four-branch age format is
  covered by manual/visual verification, not a unit test.
- **Color/token cohesion** (dev iteration): gate amber → `notificationsWarningIcon.foreground`; idle →
  `notificationsInfoIcon.foreground`; count pill → the `badge-foreground`/`badge-background` pair (was
  grey-on-blue); row badges text-only (a filled pale chip washed out on the grey row-hover, and the
  queued badge was blue-on-blue).
- **Refresh model:** `deriveAttention` recomputes `isIdleWaiting` at post time (host `Date.now()`); a
  builder crossing the 5-min idle threshold surfaces on the next SSE cache tick, not by a timer —
  matching the sidebar's idle recompute-on-refresh. No polling introduced.
- **Header dropped for Attention only:** the other three modes keep their one-line context header;
  Attention's would be a static word duplicating the "Codev" panel tab.

## How to Test Locally

For reviewers pulling the branch:

- **View diff**: VS Code sidebar → right-click builder `pir-1553` → **Review Diff** (auto-detects the
  default branch).
- **Run dev**: VS Code sidebar → **Run Dev**, or `afx dev pir-1553`. Reload the Extension Development
  Host (Cmd+R) after building — the webview is bundled at build time.
- **What to verify** (maps to the plan's Test Plan):
  - Open a surface that resolves to **Attention** (a plain non-artifact file, or no editor) → the Codev
    panel body shows the roll-up, not the old placeholder.
  - With live builders present, confirm the sections reflect real state: **Pending gates** for blocked
    builders + PRs awaiting review; **Waiting on input** for builders idle past ~5 min; **Held mail**
    (workspace total + per-builder, escalation flagged); **Queued feedback** per builder.
  - Drive an **SSE refresh** (a builder reaching a gate, held mail arriving, feedback queued) and
    confirm the body updates **in place**.
  - Drain all attention state → the **honest empty state** ("Nothing needs attention right now").
  - Toggle light/dark theme → colors track the theme and match the sidebar's amber/blue for the same
    states.
- **Cannot be driven from the builder shell:** manufacturing genuine blocked-builder / held-mail /
  queued-feedback state needs a live Tower with real builders at gates — that is the owner-driven part
  of the walkthrough. The projection + wiring are covered exhaustively by unit tests.

## Consultation Feedback

One advisory 3-way pass (`max_iterations: 1`). **Gemini: APPROVE** (no issues). **Codex &
Claude: REQUEST_CHANGES** — both scoped to the review artifact (missing mandated sections; arch/lessons
declared-not-applied), plus two minor code nits. All addressed in this commit (see Things to Look At
for the per-finding disposition). PIR does not re-review; the human at the `pr` gate is the remaining
check.

## Flaky Tests

None encountered. (First-run note: the `codev-sdk` / `codev-types` / `artifact-canvas` workspace
`dist/` must be built before the extension type-checks — normal monorepo build order, an env-setup
step, not a flaky test.)
