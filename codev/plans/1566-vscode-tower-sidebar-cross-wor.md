# PIR Plan: Codev Tower sidebar — cross-workspace navigation hub

Issue: #1566 · Protocol: PIR · Branch: `builder/pir-1566`

## Understanding

VS Code windows (and the whole Codev view set) are bound to the single folder the window
opened, but Tower is user-global: one `afx tower` daemon on port 4100 registers every workspace
on the machine. Today the only cross-workspace client is the Stream Deck plugin, and the only
path *into* VS Code is the inbound `codev.focusWorkspaceWindow` command. A user running several
Codev workspaces has no in-IDE way to see which workspace needs a human, or to jump there.

This feature adds a **separate activity-bar container** (`codev-tower`, distinct from the existing
workspace-scoped `codev` container) with a TreeView that lists all Tower workspaces, annotated
with each workspace's attention state, urgency-sorted so "needs a human" floats to the top. Rows
switch to (or activate + open) a workspace. A keyboard-first `codev.switchWorkspace` QuickPick
presents the same list. The container's activity-bar icon carries the aggregate cross-workspace
attention count as its badge.

The container is machine-scope; the existing container is workspace-scope. That is the real
semantic boundary the owner ruled the split on (naming and placement are settled in the issue and
not relitigated here).

Key facts established by investigation (file:line references throughout the Files section):

- The extension's `TowerClient` is **machine-global**, not window-bound: `getOverview(path)` takes
  an explicit workspace path, and `/api/events` is a single global stream whose events carry a
  `workspace` field. So the current window's shared client can query *every* workspace's overview.
- `deriveAttention(OverviewData) → AttentionSummary` and `isIdleWaiting` already exist in
  `@cluesmith/codev-sdk/builder-helpers`; attention is **consumed**, never re-derived.
- The existing `OverviewCache` is single-workspace, so a new cross-workspace aggregate cache is
  required. It reuses the **one** shared SSE stream via `connectionManager.onSSEEvent` (no second
  EventSource — the #1211 lesson).
- **No cross-workspace urgency comparator exists anywhere.** The only urgency ordering today is
  `orderForDisplay` (within a workspace, over `OverviewBuilder[]`) in `apps/vscode/src/views/builders.ts`,
  which is in the pir-1563 fence and is the wrong granularity. A workspace-level comparator over
  `AttentionSummary` is genuinely new shared surface (see Risks — pending architect ruling).
- Workspace activation runs `codev adopt` **server-side and unconditionally** for a directory with
  no `codev/` folder, returning `{ ok, adopted }` *after* the fact. "Confirm before adopting" is
  therefore a client-side pre-check.
- Activation/deactivation emit **no SSE event**, so the workspace *list* must be re-polled (the
  Stream Deck store does exactly this on every envelope).

## Proposed Change

A new container + tree view + one QuickPick command, plus a cross-workspace aggregate cache, a
shared urgency comparator, and a basename-disambiguation helper. All Tower data flows strictly
through `@cluesmith/codev-sdk` (`TowerClient`) and `@cluesmith/codev-types`; no raw endpoint
coupling. Loopback-only; auth reuses the existing `AuthWrapper` / `readLocalKey` path.

### Fence compliance (sibling lane pir-1563)

pir-1563 (terminal cycling) touches `views/builders.ts`, `terminal-manager.ts`, `command-relay.ts`,
`apps/streamdeck`. **This plan touches none of them.** In particular:

- The switch action **invokes** `codev.focusWorkspaceWindow` via `vscode.commands.executeCommand`
  (its registration lives in `extension.ts:1394`, not `command-relay.ts`), so no relay edit.
- The urgency comparator is new (SDK), not a reuse of `orderForDisplay` from the fenced `builders.ts`.
- `extension.ts` and `package.json` are shared with 1563; my additions land as **self-contained,
  grouped blocks** (new container/views/command together, not interleaved) for a clean textual merge.

### 1. Shared urgency comparator (req#2) — RULED: Option A (sdk builder-helpers)

Add `compareAttention(a: AttentionSummary, b: AttentionSummary): number` to
`packages/sdk/src/builder-helpers.ts`, beside `deriveAttention`.

> **Owner ruling (main, sdk-surface owner), 2026-08-31 — Option A.** `AttentionSummary` is a client
> projection, not a wire contract, so this is **not** a codev-types addition (classification now
> twice-ratified). Grounds, for the record: the #1553 precedent is directly on point — attention
> *policy* co-locates in `builder-helpers` preemptively (`deriveAttention` itself moved there with a
> single consumer, owner-directed) to prevent drift on "what needs a human"; **ranking is the same
> policy one level up ("what needs a human MOST")**. The extract-on-second-consumer lesson (#818)
> yields to the more specific, more recent, owner-ratified rule for this exact file and policy
> family. And req#2 declares the comparator the de facto cross-client order — cross-client policy
> hidden in one client is the anti-pattern.

**Four binding conditions (acceptance criteria for the addition):**

1. **Pure** function over two `AttentionSummary` values; **zero new imports**; the sdk import
   boundary is untouched (the `import-boundary` test stays green).
2. **Deterministic total order.** Bucket precedence: **pending-gates > waiting > held-mail >
   queued-feedback > quiet**. Within a bucket, **oldest `since` first** (longest-waiting;
   `null → +Infinity`, i.e. last) where a `since` applies; held-mail orders `heldEscalated` before
   plain then higher `heldTotal` first; queued-feedback orders higher total first. A **final stable
   tie-break returns `0` for equal summaries** so equal inputs compare equal and **callers use a
   stable sort** for any further (e.g. label) ordering. The doc comment documents the full semantics
   as the **canonical definition of attention ordering**.
3. Unit tests include order-**property** checks — **antisymmetry** (`sgn(cmp(a,b)) === -sgn(cmp(b,a))`),
   **transitivity** spot-checks, and **tie** cases (equal summaries → `0`) — not just examples.
4. **No version/packaging action in-lane**; it ships with the next release like any sdk change.

Because the comparator sees only `AttentionSummary` (no workspace path/label), the **label
tiebreak is the caller's job**: the Tower provider pre-orders workspaces by disambiguated label and
applies `compareAttention` with a **stable** sort, so equal-attention workspaces stay in label order
deterministically.

### 2. Basename-collision disambiguation (req#3)

New local helper `apps/vscode/src/views/workspace-label.ts`:
`disambiguateLabels(workspaces: TowerWorkspace[]): Map<path, label>`. `TowerWorkspace.name` is a
raw `path.basename` (no disambiguation server-side). When two active workspaces share a basename
(the live `cluesmith/codev` vs `amrmelsayed/codev` case, #1565), render the **minimal distinguishing
path tail** (parent dir + basename) for the colliding rows only; unique basenames render plain. The
Tower tree and the QuickPick both consume this. Kept local for v1 (streamdeck has the same collision
but is fenced; a shared SDK extraction is a noted follow-up, not v1 scope).

### 3. Cross-workspace attention cache (req#8, #9)

New `apps/vscode/src/views/tower-cache.ts`: `TowerFleetCache`.

- On refresh: `client.listWorkspaces()` → for each, `client.getOverview(w.path)` fan-out →
  `deriveAttention(overview)` per workspace → store `{ workspace, attention }[]`.
- **One shared SSE**: subscribes to `connectionManager.onSSEEvent` (the single stream owned by
  ConnectionManager) and refreshes on each envelope. Does **not** create an `SSEClient`.
- **List freshness**: because activation emits no SSE, each envelope also re-polls `listWorkspaces()`
  (matching the Stream Deck workaround), and the cache exposes a manual `refresh()` the activate/
  deactivate actions call directly.
- **Low-frequency poll fallback** (req#8): when `connectionManager` is not `connected` (SSE down),
  a low-frequency timer (~15s) drives refresh; the timer is cleared while connected to avoid double
  refresh. Subscribes to `onStateChange` to arm/disarm.
- **Last-write-wins** via a monotonic sequence counter (the `OverviewCache` #916 pattern), so SSE
  bursts and out-of-order fan-out landings never clobber last-known-good with a transient/null read.
- Exposes `onDidChange` for the provider, plus `getFleet()` and `getAttentionCount()`.

### 4. Tower container, view, provider (req#1, placement, differentiation)

- **`apps/vscode/package.json`**: new `viewsContainers.activitybar` entry
  `{ id: "codev-tower", title: "Codev Tower", icon: "icons/tower.svg" }` and a matching
  `views: { "codev-tower": [ { id: "codev.tower", name: "Tower" } ] }`. New command
  `codev.switchWorkspace` under `contributes.commands`; a row context-menu entry for deactivate
  (should-have) under `contributes.menus` `view/item/context` gated on a `contextValue`.
- **Icon asset** `apps/vscode/icons/tower.svg` (+ light/dark pair if the container needs them):
  a monochrome `currentColor` "stacked layers / many-workspaces" glyph in the codev family —
  legibly distinct from the single dense codev glyph at 16px. **Subject to owner visual sign-off
  and rendered/verified at actual 16px (the #1104 lesson).**
- **`apps/vscode/src/views/tower.ts`**: `TowerProvider implements vscode.TreeDataProvider` (modeled
  on `views/status.ts`). Top level = workspaces pre-ordered by disambiguated label, then a **stable**
  sort by `compareAttention` over their `AttentionSummary` (so equal-attention rows keep label
  order). Each workspace row: disambiguated label, an attention `ThemeIcon`, a tooltip,
  and a `contextValue` (active vs inactive) that gates inline menu items. Rows **expand** to the
  attention items (`pendingGates`, `waiting`, `heldMail`, `queuedFeedback` from `AttentionSummary`).
  Known-but-inactive workspaces render in a **secondary group** (req#5).
  - **Current-workspace marking**: the row whose path equals `connectionManager.getWorkspacePath()`
    is marked "current" (distinct icon + description). **Recommendation: do NOT pin it first** — keep
    urgency order so an urgent *other* workspace still floats up (the whole point of the hub); mark
    it distinctly in place. (Owner left this to the spec; flagged as a decision at the gate.)
- **`apps/vscode/src/extension.ts`**: register the provider via `createTreeView('codev.tower', …)`
  (needs a title count + badge) inside a **self-contained grouped block**; wire the container
  **badge** to `getAttentionCount()` via a `composeActivityBadge`-style helper (set `.badge` on the
  Tower TreeView — the same mechanism `updateActivityBadge` uses for `buildersView.badge`). Refresh
  the badge/title on `TowerFleetCache.onDidChange`.

### 5. Actions (req#4, #5, #6)

- **Switch** (row activation on an **active** workspace): invoke
  `vscode.commands.executeCommand('codev.focusWorkspaceWindow', w.path)` — reuses its re-validation
  + `vscode.openFolder { forceNewWindow: true }` (focuses an already-open window, else opens one).
  The hub stops at the workspace boundary; within-workspace agent-terminal cycling is #1563's lane.
- **Activate on demand** (row activation on an **inactive** workspace):
  1. **Adopt pre-check** (req#5, "never adopt silently"): since the extension host is loopback-local,
     `fs.existsSync(join(w.path, 'codev'))`. If absent, show a **modal confirm** naming that activation
     will run `codev adopt` and write files into the directory; proceed only on confirm. (In practice
     the inactive group is already-adopted known workspaces, so this is defensive — but correct.)
  2. `client.activateWorkspace(w.path)` → spawns the `main` architect PTY (headless bring-up) and
     surfaces confirmation **before** a window opens (the ConnectionManager idempotent-activate note:
     the opened window would converge on its own, but explicit activation is kept for confirmations
     and headless bring-up).
  3. On `{ ok: true }` → refresh the cache, then invoke `codev.focusWorkspaceWindow`. Surface
     `adopted: true` in the confirmation toast.
  4. **Rate limit** (10/min, HTTP 429): `activateWorkspace` returns `{ ok: false, error }`; show a
     non-fatal "Too many activations, try again shortly" message. No new lifecycle code; if Tower is
     down, the existing `codev.autoStartTower` path covers it.
- **Deactivate** (should-have, row context menu): `client.deactivateWorkspace(w.path)` behind a
  confirm (it stops the architect/terminals); refresh on `{ ok: true }`.
- **QuickPick** `codev.switchWorkspace` (req#6): keyboard-first command (modeled on
  `codev.openArchitectTerminal`) presenting the same attention-annotated, urgency-ordered,
  disambiguated list; pick dispatches to the switch/activate path above.

### 6. Status-bar badge (req#7, should-have)

**Recommendation: defer.** The container-icon badge (must-have) already surfaces the aggregate
count, and the existing status bar shows *current-workspace* counts — a second, cross-workspace
count there risks an ambiguous duplicate affordance. Ship the container badge; leave the status-bar
badge out of v1 unless the gate wants it. (Flagged as a gate decision.)

## Files to Change

New (unfenced, mostly self-contained):

- `packages/sdk/src/builder-helpers.ts` — **add** `compareAttention` (Option A, ruled; pure, zero new imports, canonical doc comment).
- `packages/sdk/src/__tests__/builder-helpers.test.ts` — comparator cases (bucket order, oldest-first, tiebreak).
- `apps/vscode/src/views/workspace-label.ts` (new) — basename-collision disambiguation.
- `apps/vscode/src/views/tower-cache.ts` (new) — `TowerFleetCache` cross-workspace fan-out + shared SSE.
- `apps/vscode/src/views/tower.ts` (new) — `TowerProvider` TreeDataProvider.
- `apps/vscode/src/commands/switch-workspace.ts` (new) — `codev.switchWorkspace` QuickPick + shared switch/activate helper.
- `apps/vscode/icons/tower.svg` (new; + `tower-dark.svg`/`tower-light.svg` if needed) — container icon, 16px-verified, owner sign-off.
- `apps/vscode/src/__tests__/tower-provider.test.ts`, `tower-cache.test.ts`, `workspace-label.test.ts`,
  `switch-workspace.test.ts` (new) — vitest, `vi.mock('vscode')` per the `overview-cache.test.ts` pattern.

Shared with pir-1563 (grouped-block additions only):

- `apps/vscode/package.json` — `viewsContainers.activitybar` + `views` (`codev-tower`/`codev.tower`),
  `contributes.commands` (`codev.switchWorkspace`), `contributes.menus` (deactivate context item).
- `apps/vscode/src/extension.ts:~537-585` region — register `TowerProvider` via `createTreeView`,
  create/own the `TowerFleetCache`, wire the badge; register `codev.switchWorkspace` in the command
  push block. All grouped.

Parity tests to update (they assert declaration/registration parity):

- `apps/vscode/src/__tests__/contributes-commands.test.ts` — new command.
- `apps/vscode/src/__tests__/contributes-view-gating.test.ts` — new container/view.
- `apps/vscode/src/__tests__/extension-architect-commands.test.ts` — greps exact
  `registerTreeDataProvider`/`createTreeView` strings.
- `apps/vscode/src/__tests__/menu-when-clauses.test.ts` — new context-menu when-clause.

Docs / changelog (vscode extension code, user-facing):

- `apps/vscode/CHANGELOG.md` and `docs/releases/UNRELEASED.md` — one entry each (dual-accumulate).

Explicitly **not** touched: `views/builders.ts`, `terminal-manager.ts`, `command-relay.ts`,
`apps/streamdeck` (fence), and `@cluesmith/codev-types` / any Tower server route (consumption only).

## Risks & Alternatives Considered

- **Shared-surface risk (comparator home)**: RESOLVED — flagged pre-gate, owner ruled Option A (SDK
  `builder-helpers`) with four binding conditions folded in above. It is the one move beyond pure
  consumption, now ratified; the four conditions keep the sdk boundary and purity intact.
- **Fan-out cost at high workspace counts** (req#9): N `getOverview` calls per refresh. v1 accepts
  client-side fan-out (the Stream Deck store already fans out); a Tower-side aggregate endpoint is
  explicitly out of scope and, if ever needed, routes to codev:main as a types/Tower addition — not
  something this builder adds. Mitigation: last-write-wins + throttle; refresh coalesced per envelope.
- **Auto-adopt writing files** (req#5): the server adopts unconditionally for an un-adopted dir. The
  client-side `fs.existsSync` pre-check + modal confirm prevents a silent adopt. Alternative rejected:
  a new "will-adopt?" endpoint (out of scope; no new Tower route). Residual: TOCTOU between check and
  activate is benign (worst case the confirm is shown for an already-adopted dir, or adopt is skipped
  server-side by its own guard).
- **No SSE on activation**: relying on SSE alone would miss list changes. Mitigation: re-poll the
  list per envelope + manual refresh after activate/deactivate + low-frequency fallback.
- **Second SSE stream** (#1211): explicitly avoided — reuse `connectionManager.onSSEEvent`.
- **Icon legibility at 16px** (#1104): the dense codev glyph tiled is illegible small; a "stacked
  layers" glyph is used instead, verified at 16px and subject to owner sign-off.
- **Merge with pir-1563**: shared files get grouped self-contained blocks; no fenced file touched.

## Test Plan

**Unit (vitest, `apps/vscode` + `packages/sdk`):**

- `compareAttention`: pending-gate > waiting > held(escalated>plain) > queued > quiet; oldest-`since`
  first within a bucket; `null` since sorts last; equal summaries → `0`. **Order-property checks**:
  antisymmetry (`sgn(cmp(a,b)) === -sgn(cmp(b,a))`), transitivity spot-checks, tie cases — not just
  examples (binding condition 3).
- `disambiguateLabels`: colliding basenames → minimal path tails; unique basenames → plain; the
  `cluesmith/codev` vs `amrmelsayed/codev` case.
- `TowerFleetCache`: fan-out over a fake client, `deriveAttention` per workspace, last-write-wins on
  out-of-order/null landings, refresh on a faked `onSSEEvent`, poll-fallback armed only when
  disconnected, no `SSEClient` constructed.
- `TowerProvider`: workspace ordering via `compareAttention`, current-workspace marking, active vs
  inactive grouping, expansion to attention items, badge count.
- `switch-workspace`: active row → `focusWorkspaceWindow`; inactive un-adopted → confirm-then-activate,
  confirm-declined → no activate; 429 → non-fatal message; deactivate → confirm-then-deactivate.
- Parity tests (contributes/registration) pass with the new container/view/command.

**Manual (dev-approval evidence bar — needs a Tower serving ≥2 workspaces):**

- Container renders in the activity bar with the distinct icon; opens the Tower view listing ≥2
  workspaces, urgency-sorted, current workspace marked, colliding basenames disambiguated.
- Activity-bar icon badge shows the aggregate cross-workspace attention count; changes as a builder
  hits/clears a gate.
- Clicking an active row focuses/opens that workspace's window; `codev.switchWorkspace` QuickPick does
  the same from the keyboard.
- Activating an inactive known workspace brings it up and opens its window; an un-adopted directory
  shows the adopt confirm before any files are written.
- Live update: a gate change in another workspace re-sorts/re-badges without a manual refresh (one SSE
  stream); with SSE forced down, the poll fallback still refreshes.

**Evidence-bar gap I cannot drive from the builder shell**: a *second live workspace* with a real
architect/builder producing attention states, and **visual 16px icon verification**, need the owner's
environment. I will run everything drivable here and name precisely what remains for the owner to
eyeball at dev-approval.
