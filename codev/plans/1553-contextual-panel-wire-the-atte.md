# PIR Plan: Wire the Attention fallback body from OverviewCache

## Understanding

Issue #1553 is a skeleton fast-follow of the #1049 contextual bottom panel (merged skeleton-only
in PR #1551). The panel resolves one mode from the active surface and posts a `ModeDescriptor` to
its webview, which renders a one-line context label plus a per-mode **body**. For every mode the
body is currently a static placeholder string (`BODY_PLACEHOLDER` in
`apps/vscode/src/contextual-panel/webview/main.ts:31-36`). #1049's success criteria explicitly
forbade rendering real mode content; the participating features wire each body afterwards.

This issue wires exactly one body: **Attention**, the fallback view shown when no artifact / diff /
builder-terminal surface resolves (`resolver.ts` precedence
`builder-terminal → builder-diff → artifact → attention`). Post-reshape, Attention is a **fallback
render, not a selectable destination** — there are no pills, no navigation, no selection, no
persistence. So this is pure content rendering into the existing Attention render target, fed by
the `OverviewData` the extension already holds in `OverviewCache`.

The roll-up the body should show (per the issue and the #1049 review follow-up note "#1553 —
blocked builders / pending gates / queued comments"):

- **Pending gates / blocked builders** — builders parked at a human gate. `OverviewBuilder.blocked`
  (display label, e.g. "plan review"), `blockedGate`, `blockedSince`
  (`packages/types/src/api.ts:175-183`), plus `prReady` (`api.ts:210-224`), the uniform
  "PR waiting on a human reviewer" signal (the `pr` gate).
- **Held mail** — `OverviewData.heldCount` (workspace total) + `mailboxEscalated`
  (`api.ts:306-317`), broken down per builder via `OverviewBuilder.heldCount` (`api.ts:225-230`).
- **Queued feedback / comments** — `OverviewData.queuedFeedback`, a per-builder map of pending
  review-comment counts (`api.ts:318-327`); its doc comment already names "#1049's future Attention
  rollup" as a consumer.

All of these fields are **already on the overview wire** — this is a pure read/consume relationship
with `OverviewCache`; no Tower or `codev-types` surface is added (an architect fence).

## Proposed Change

Follow #1049's established split: a **pure, vscode-free projection** + a **host adapter that posts a
descriptor** + a **webview that renders it**. The resolver stays untouched and pure (it still maps
`SurfaceContext → { kind, context }` with no knowledge of `OverviewData`).

1. **Pure projection** — new `apps/vscode/src/contextual-panel/attention.ts`:
   - `deriveAttention(data: OverviewData | null): AttentionSummary` — a pure function (type-only
     import of `OverviewData` from `@cluesmith/codev-types`, no `vscode`), unit-testable with no host.
   - `AttentionSummary` (extension-local, like the other panel types — not a wire contract):
     ```ts
     interface AttentionBuilderRef { builderId: string; issueId: string | null; issueTitle: string | null; }
     interface GateItem  extends AttentionBuilderRef { gate: string; since: string | null; }
     interface CountItem extends AttentionBuilderRef { count: number; }
     interface AttentionSummary {
       pendingGates: GateItem[];    // blocked builders (blocked/blockedGate/blockedSince) + prReady (gate: "PR review")
       heldTotal: number;           // OverviewData.heldCount (all recipients, incl. architects)
       heldEscalated: boolean;      // OverviewData.mailboxEscalated
       heldMail: CountItem[];       // builders with heldCount > 0
       queuedFeedback: CountItem[]; // builders with queuedFeedback[id] > 0
       isEmpty: boolean;            // true when every list is empty AND heldTotal === 0
     }
     ```
   - `data === null` (cache not yet populated) → an all-empty summary with `isEmpty: true`. Ordering
     is deterministic (input order preserved; the host does no sorting).

2. **Host adapter** — `panel-provider.ts` + `messages.ts`:
   - Inject `OverviewCache` as a third constructor arg (DI-when-needed, per #1049). Subscribe to
     `overviewCache.onDidChange` and, when the current mode is Attention, re-post so the body
     refreshes on every SSE-driven cache update.
   - Extend `RenderMessage` to carry an optional `attention?: AttentionSummary` payload **alongside**
     the descriptor (keeps `ModeDescriptor` — the resolver's output — unchanged and pure). The
     provider fills it (via `deriveAttention(overviewCache.getData())`) only when
     `descriptor.kind === 'attention'`.
   - The existing surface-change dedup (`postId`) is unchanged; the cache subscription re-posts
     directly (bypassing the surface dedup, since a cache change is not a surface change) and only
     while `lastDescriptor.kind === 'attention'`, so non-Attention modes post nothing extra.

3. **Webview render** — `webview/main.ts` + `webview/styles.css`:
   - Replace the Attention branch's static `BODY_PLACEHOLDER` with a rendered roll-up: sections for
     Pending gates, Held mail, and Queued feedback, each a small list of rows (builder id + issue +
     gate label / count). All text via React children (auto-escaped) — no `innerHTML` (honors the
     no-innerHTML source-scan guard).
   - **Honest empty state**: when `attention.isEmpty`, render a single "Nothing needs attention right
     now" line. When the payload is absent (older post / non-Attention), keep the existing behavior.
   - Other modes keep their placeholder bodies (owned by their own participating issues).
   - Styles: reuse the theme-aware `--vscode-*` token approach; add minimal list/row/section classes.
     #1549's shared primitives are **not yet landed** (issue still OPEN at pickup), so per the
     umbrella constraint I render locally now and do not block on it.

## Files to Change

- `apps/vscode/src/contextual-panel/attention.ts` — **new**. Pure `deriveAttention` + `AttentionSummary`
  types. No `vscode` import; type-only `OverviewData` import.
- `apps/vscode/src/contextual-panel/messages.ts:12-15` — add optional `attention?: AttentionSummary`
  to `RenderMessage`.
- `apps/vscode/src/contextual-panel/panel-provider.ts` — inject `OverviewCache`; subscribe to
  `onDidChange` (re-post only in Attention mode); populate `attention` in `post()` when kind is
  `attention`.
- `apps/vscode/src/contextual-panel/webview/main.ts:31-67` — render the Attention roll-up + empty
  state; leave other modes' placeholders.
- `apps/vscode/src/contextual-panel/webview/styles.css` — add section/list/row classes (theme tokens).
- `apps/vscode/src/extension.ts:570` — pass `overviewCache` into `new ContextualPanelProvider(...)`.
- `apps/vscode/src/__tests__/contextual-panel-attention.test.ts` — **new**. Unit tests for
  `deriveAttention` (each signal, mixed, null → empty, isEmpty logic, ordering).
- `apps/vscode/src/__tests__/contextual-panel-provider.test.ts:125-129` — pass a mock `OverviewCache`;
  add cases: Attention post carries the projected `attention` payload; `onDidChange` re-posts in
  Attention mode and does **not** post in a non-Attention mode.

No changes to `resolver.ts`, `surface-context.ts`, `surface-reader.ts`, `types.ts` (the descriptor
contract), or any Tower / `codev-types` file. Sibling lane pir-1552 (`review-queue/feedback.ts`,
`comments/builder-review.ts`) is disjoint — untouched.

## Risks & Alternatives Considered

- **Risk: double-post / render churn** when both a surface change and a cache change fire. Mitigation:
  the render is idempotent; the cache subscription only acts while in Attention mode. Cost is one
  extra `postMessage` at worst — negligible.
- **Risk: stale body when the cache updates while the panel is hidden.** Mitigation: the provider
  already re-posts `lastDescriptor` on `onDidChangeVisibility`; `post()` recomputes the attention
  payload from the live cache each time, so reopening shows fresh data.
- **Risk: `heldTotal` (all recipients) can exceed the sum of per-builder `heldCount`** (architects
  also hold mail). This is intentional and shown honestly: total as a headline, per-builder as a
  breakdown. Not a bug.
- **Alternative — attach the summary to `descriptor.context`.** Rejected: it pollutes the resolver's
  pure output contract with data the resolver never produces. Carrying it as a sibling field on the
  render message keeps the resolver pure (a #1049 invariant).
- **Alternative — subscribe the webview directly to the cache.** Impossible/undesirable: the webview
  is sandboxed and only speaks `postMessage`; the host must be the single data path.
- **Alternative — wait for #1549 primitives.** Rejected per the umbrella constraint ("do not block on
  it"); #1549 is still OPEN.

## Test Plan

- **Unit — `deriveAttention` (`contextual-panel-attention.test.ts`):**
  - blocked builder → one `pendingGates` row with gate label + since; `prReady` builder → a `PR review`
    gate row; both → both rows.
  - `heldCount`/`mailboxEscalated` → `heldTotal`/`heldEscalated` set; per-builder `heldCount > 0` → rows.
  - `queuedFeedback` map entries > 0 → rows; zero/absent entries excluded.
  - `null` data → all-empty, `isEmpty: true`; a data set with no attention signals → `isEmpty: true`;
    any signal present → `isEmpty: false`.
- **Unit — provider (`contextual-panel-provider.test.ts`):**
  - Attention post includes an `attention` payload projected from the mock cache; non-Attention post
    omits it.
  - `overviewCache.onDidChange` re-posts while in Attention mode; fires **no** post while in a
    non-Attention mode.
- **Build/type:** `pnpm --filter @cluesmith/codev-vscode check-types` (webview + extension tsconfigs)
  and the full vitest run green from the worktree.
- **CMAP:** 3-way consultation after implementation code and after tests, per protocol.
- **Manual (dev-approval, in Extension Development Host):** open a surface that resolves to Attention
  (a plain non-artifact file, or no editor) and confirm the body renders the live roll-up; drive an
  SSE refresh (a builder reaching a gate / held mail / queued feedback) and confirm the body updates
  in place; drain all attention state and confirm the honest empty state.
  - **What I cannot fully drive from the builder shell:** producing genuine blocked-builder / held-mail
    / queued-feedback state requires a live Tower workspace with real builders at gates. I will verify
    the projection + wiring exhaustively via unit tests and confirm render/empty-state in the Extension
    Development Host against whatever live cache data is present; reproducing every attention signal on
    demand is a dev-approval walkthrough the owner drives. I will name this explicitly at the gate.
