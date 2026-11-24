# Phase 4 (`cockpit_hierarchy`), iteration 1: responses to the reviews

Codex: REQUEST_CHANGES (3 points). Claude: APPROVE (5 non-blocking notes). I checked every claim
against the code before acting on it.

## Codex

### 1. Non-Codev (dormant) windows cannot show the fleet: kept, by architect ruling (option A)

The claim holds. In a dormant window (guest mode, a folder without Codev; `ide-mode.ts` tier
`dormant`), `activationPolicy('dormant').initializeConnection` is false, so `ConnectionManager` never
initialises. The Cockpit then shows *Not connected to Tower* instead of navigate-only workspace
rows.

That inertness is deliberate and older than this spec. #1144 says a dormant window "must remain
exactly as inert as if activation had never fired: no Tower process, no UI mutation, no state
writes". Listing the fleet would mean that window connects to Tower.

I put the conflict to the architect with three options:
- **A:** keep #1144;
- **B:** connect read-only when the Cockpit is first shown;
- **C:** connect after a click.

The architect ruled **A**. B and C weaken #1144, so they are the owner's call, and neither is built.
The ruling, as built:
- **Dormant row.** It keeps *Not connected to Tower*, now with the reason and *Open Folder*: click
  runs `workbench.action.files.openFolder`. The tooltip carries the Agents view's welcome text for
  such a window (`codev init`). It never initialises the connection.
- **Where the criterion holds.** The spec's no-workspace criterion holds in the window the owner
  uses without a workspace: the Codev IDE's `ide-empty` tier, which connects and shows the fleet.
  For the dormant tier it is a recorded deviation. The architect noted it on issue #1963 and will
  raise it at the PR gate. The approved spec is not edited; the PR description and the review state
  the deviation.
- **New test, `cockpit-dormant-1144.test.ts`.** It assembles a dormant window from the real
  `ConnectionManager` (never initialised), `OverviewCache`, `TowerFleetCache`, `CockpitProvider` and
  `OverviewRefreshGate`. Every route to Tower is a recording mock: the SDK `TowerClient`, the SSE
  client, the Tower auto-starter and global `fetch`. The test shows the Cockpit, renders it, runs
  its Refresh and advances every poll timer five minutes. It asserts no client was constructed, no
  client call, no SSE, no auto-start and no fetch. A control case shows the same mocks do record a
  window that connects.

### 2. The badge is not cleared when Tower disconnects: fixed

The claim holds. `updateActivityBadge` ran only at startup and on `OverviewCache.onDidChange`.
`OverviewCache` keeps last-known-good data and emits nothing on a disconnect, so both buttons kept a
stale count through an outage. This was already true of the Codev button on `main`.

- **Fix.** `extension.ts` now subscribes `connectionManager.onStateChange(() => updateActivityBadge())`.
  The pure `workspaceActivityBadge` already returned `undefined` when not connected.
- **Tests (`cockpit-wiring.test.ts`).** A connected-with-badge → reconnecting → connected sequence
  on both views, plus a source check of the subscription.
- **Effect on the existing Codev button.** This changes it: during an outage its badge now clears
  rather than keeping the last count. The PR description says so, because "existing views behave as
  before" is an acceptance criterion. The architect accepted the fix in place.

### 3. `codev.autoConnect: false` leaves *Connecting to Tower…* forever: fixed

The claim holds. With auto-connect off, `initialize()` never attempts a connection, the state stays
at its initial `disconnected`, and no event follows.

- **Fix.** The Cockpit's `connects: boolean` became a `connection: 'auto' | 'manual' | 'none'` mode.
  `cockpitConnectionMode(policy.initializeConnection, codev.autoConnect)` derives it at activation,
  reading the same setting `initialize()` reads at that moment.
- **What each mode shows:**
  - Only `auto` shows *Connecting…* before any attempt has started.
  - `manual` shows *Not connected to Tower*, with *Reconnect* and a tooltip naming
    `codev.autoConnect`, until an attempt runs. `reconnect()` moves the state from `disconnected` to
    `connecting`, which shows *Connecting…*.
  - A failed attempt gives the ordinary not-connected row.
- **Tests (`cockpit-provider.test.ts`).** The `manual` sequence, the mode derivation, and a source
  check of the `extension.ts` wiring.
- **Mutation check.** Six mutations across the mode, the row logic and the wiring are all caught.

## Claude (APPROVE): notes

1. **An active workspace whose overview has no architects and no builders shows a chevron that
   expands to nothing.** Agreed, and left as is. Phase 7 adds the Decisions entry under every active
   workspace, so the node is never empty after that. Recorded in the thread so it is not fixed twice.
2. **The dormant-tier deviation should be recorded.** Done; see Codex 1. The architect ruled, and it
   goes in the PR description and the review.
3. **`navigateTarget`'s `this.trees.get(scope)!`.** Changed, but not to the suggested fallback. The
   project rule is to fail fast, not fall back. `treeFor` stores the entry before building any row,
   so a miss is a routing bug, and it now throws a named error instead of a bare `TypeError`.
4. **`entryOfRow` throws for unscoped rows; return `[]` instead?** Kept as a throw. This was a
   Phase 3 review decision: mis-routed rows throw (`d1714a740`). The unscoped rows are the
   placeholder rows (*No changes yet*, *Diff unavailable*, *No worktree on record*). They are leaves
   with no id, so VS Code calls neither `getChildren` nor `getParent` (reveal) on them. Returning
   `[]` would hide a real routing bug as an empty subtree.
5. **A workspace node is a snapshot of its fleet entry.** Agreed, the impact is negligible. Each
   `getChildren` call reads the live caches, and `isCurrent` and `active` rarely change. Recorded as
   an observation for the Phase 5 rendered run.

The "working tree changed during the review" warning on Claude's output refers to my own fixes for
Codex 2 and 3, made while that review was running.
