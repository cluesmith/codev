# PIR #991 — dashboard terminal self-heals onto successor session after Tower restart

## Plan phase (current)

**Issue**: After a Tower restart, persistent terminal sessions reconnect under a new id; a dashboard tab holding the old `/ws/terminal/<oldId>` gets a permanent `4404` close and correctly gives up — but nothing triggers the `/api/state` re-fetch that would resolve the successor id and remount. Recovery is incidental (poll/focus/manual refresh).

**Key findings from investigation:**
- Recovery machinery already exists: `useBuilderStatus` polls `/api/state` every 1s + refreshes on SSE; `getTerminalWsPath` produces a new `wsPath` from the successor id; the `Terminal` effect is keyed on `[wsPath]` so it remounts on a new id.
- Tab identity is **stable** across the id swap (`useTabs` keys on `builder.id` / `architect` / `util.id`); only the `terminalId` field changes. So a refresh → new wsPath → remount = self-heal.
- Missing seam: the permanent-close branch (`Terminal.tsx:533-537`) doesn't nudge a re-fetch. The 1s poll is throttled to ~1/min when the tab is hidden, and SSE disconnects while hidden — hence "incidental."

**Chosen approach**: add `onPermanentClose?: () => void` to `Terminal`, wired to `refresh` in `App.tsx` at all 3 render sites. On permanent close: trigger refresh, show `reconnecting`, defer the give-up message behind a bounded `PERMANENT_RECOVERY_MS` (~4s) timer (avoids flashing "session gone" during a successful heal). Dashboard-only; no Tower/core changes.

**Scope decision (resolved)**: Architect chose **Option B** — fold VSCode in, relabel `area/cross-cutting`. There was NO existing GitHub issue for the VSCode successor remount (#936 added VSCode give-up/backoff but not auto-remount); #991's Notes were the only tracker. Both surfaces had the same hole.

## Plan revised — both surfaces + shared core helper

Architecture (matches #961/#971 cross-cutting pattern):
- **Core** (`@cluesmith/codev-core/session-successor`): new pure `resolveSuccessorTerminalId(state, ref)` over the shared `DashboardState` wire type. Resolves builder (via existing `resolveAgentName`) + architect (by name) → current terminalId. Only builder/architect are persistent/restart-reconciled (shells/dev are not), so the `SessionRef` union is scoped to those two.
- **VSCode glue**: adapter gets `onSessionGone?` seam → manager `recoverSuccessor(mapKey)` re-fetches `getWorkspaceState`, resolves successor via the helper, reopens via existing stale-replace (`openBuilder`/`openArchitect`). Also routes the manual `reconnectByTerminal` link through it (fixes the dead-URL retry bug).
- **Dashboard glue**: Terminal `onPermanentClose` → App `refresh()` → reactive `useTabs` rebuild → new wsPath → remount (unchanged from v1). Plus reconnecting-status + bounded deferred give-up message.

**Honest design note flagged to architect at the gate**: the dashboard does NOT directly consume the core helper — its `useTabs` already resolves the successor reactively by stable tab id, so forcing helper consumption would mean plumbing a SessionRef into Terminal + duplicating useTabs. Recommended: helper in core (consumed by VSCode), dashboard stays reactive. Architect can overrule.

Key findings backing this:
- VSCode `terminals` map keyed by stable identity (`builder-<id>`, `architect:<name>`); entries store current `terminalId`. `openBuilder`/`openArchitect` already do stale-replace (dispose+reopen on id change). `openBuilderByRoleOrId` already fetches state + resolves successor for builders.
- Give-up path (`reconnectByTerminal` → `pty.reconnect()` no URL) is the ONLY thing that bypasses all of it → blindly retries dead id. That's the gap.
- `getWorkspaceState` (core `tower-client.ts`) returns the SAME `DashboardState` the dashboard `/api/state` returns → helper is a clean fit for both.

dev-approval verification will exercise BOTH surfaces against a forced Tower restart (architect's explicit requirement).

Plan v2 committed. Awaiting `plan-approval`.

## plan-approval APPROVED → rebased → implemented

Rebased onto latest main (21 commits, all PIR #989 vscode-preflight; no overlap with my targets). Corrected one drifted line ref (terminal-manager openTerminal ctor 341→348).

**Implementation complete. All green:**
- **Core**: `session-successor.ts` (`resolveSuccessorTerminalId` + `SessionRef`), `./session-successor` export. Tests in `src/__tests__/` (NOT bare `__tests__/` — corrected the plan's path to match core's layout). 30 core tests pass.
- **Dashboard**: `Terminal.tsx` onPermanentClose + reconnecting-status + deferred give-up timer (`PERMANENT_RECOVERY_MS=4000`); `App.tsx` wired at 3 sites + dep. 322 pass / 1 pre-existing skip.
- **VSCode**: adapter `onSessionGone` seam; manager `recoverSuccessor(mapKey)` (in-place `pty.reconnect(newUrl)`, no tab churn) + `reconnectByTerminal` routed through it with same-url fallback. Extracted `sessionRefFromMapKey` into its own vscode-free `session-ref.ts` (so it unit-tests without the adapter import chain). 306 vscode tests pass; lint + compile clean.

**Implementation deviations from plan (minor):**
1. Used in-place `pty.reconnect(newUrl)` rather than dispose+reopen via openBuilder/openArchitect — both were sanctioned in the plan; in-place is cleaner (keeps the tab, no label reconstruction).
2. `sessionRefFromMapKey` lives in `session-ref.ts` (new file), not inline in terminal-manager.ts — needed a vscode-free module to unit-test the pure mapping.
3. Core test path is `src/__tests__/` not `__tests__/`.

**Environmental gotcha (NOT my diff)**: `packages/types/dist` was missing in the worktree → vitest couldn't resolve `@cluesmith/codev-types`, failing terminal-adapter.test.ts even at HEAD (verified via stash). Fixed by `pnpm --filter @cluesmith/codev-types build`. Worth noting in review Lessons Learned: worktree needs types built before vscode vitest runs.

Pushing + porch done → dev-approval gate.

## Live debugging at dev-approval → recovery trigger was wrong

Reviewer tested via vsix and VSCode terminals still didn't reconnect on Tower restart (had to close+reopen / restart window; terminal pane dead, no input). Long trace:
- Confirmed vsix DID contain the fix (minified; recovery strings present). Not a stale build.
- Confirmed sessions survive a graceful `afx tower stop` (SIGTERM → gracefulShutdown keeps shellpers alive; reconcile re-registers under new id). Successor exists (close+reopen proves it).
- Confirmed adapter never fires onDidClose, so the pane isn't retired — reconnect-in-place is viable.
- **Root finding**: #991's original VSCode trigger relied on EACH adapter independently hitting a dead-id 404 to fire onSessionGone → recoverSuccessor. That per-adapter detection wasn't firing reliably. Meanwhile the extension ALREADY detects Tower coming back reliably via `connectionManager.onStateChange === 'connected'` ("Connected to Tower" in logs), and nothing was re-syncing terminals off that event.

**Fix (committed 395c4dc5)**: added `TerminalManager.resyncAllTerminals()` (loops `recoverSuccessor` over every open terminal) and wired it to `connectionManager.onStateChange` in extension.ts — on reconnect (gated by `hasConnectedToTower` so the initial activation connect is skipped), re-point all terminals onto their successors. This is the reliable trigger; the per-adapter onSessionGone path is kept as redundant belt-and-suspenders. vscode: 332 tests, check-types + lint green.

Also added (earlier in this debugging) decision-point logging in recoverSuccessor + a permanent-close marker in the adapter (commit 4fcd4a60) for diagnosability.

Spun-off #997 (Tower reconcile-before-serving) remains the deterministic root-cause for the lookup *race*, but is NOT what reconnects the pane — the resync trigger is. #997 lets the client drop the bounded poll later.

Pending reviewer re-test with a freshly-built vsix (reload window once, then restart Tower only): expect Codev output `Tower reconnected — re-syncing N terminal(s)` → `recoverSuccessor(...): poll 1/5 → successor=...` → `Recovered ... onto successor session ...`.

## Pivot: close-on-stop + reopen-on-reconnect (reviewer-directed)

Multiple rounds of in-place successor-reconnect (recoverSuccessor / onSessionGone / resyncAllTerminals) did NOT reliably revive the VSCode pane on a Tower restart in the reviewer's environment. Reviewer directed a simpler approach: when Tower stops, CLOSE the terminals; reopen them when Tower returns. Confirmed decisions via AskUserQuestion: keep the dashboard self-heal; do close + auto-reopen.

**Removed (no value after pivot):**
- Core `@cluesmith/codev-core/session-successor` (resolveSuccessorTerminalId + SessionRef) + its export + tests.
- VSCode `recoverSuccessor`, `resyncAllTerminals`, `onSessionGone` (adapter param + marker), bounded poll, recovery logging, `sessionRefFromMapKey`/`session-ref.ts`, `reconnectByTerminal` routing.
- Reverted terminal-adapter.ts / terminal-manager.ts / extension.ts to the clean #921 base (origin/main e6747d8f), then layered the new approach.

**Added (VSCode):**
- `TerminalManager.closeAllTerminals()` — on Tower stop, capture open builder/architect terminals into `pendingReopen`, dispose all tabs, clear map. (shell/dev not reopened — not restart-persistent.)
- `TerminalManager.reopenAfterReconnect()` — on Tower reconnect, fetch state, resolve each pending terminal's current id (builders via existing `resolveAgentName`, architects via `state.architects.find`), reopen via existing `openBuilder`/`openArchitect` (the proven dispose+reopen path = what manual reopen does). Bounded retry (REOPEN_MAX_ATTEMPTS=5 × REOPEN_RETRY_MS=1000) rides out the reconcile race.
- extension.ts wiring on `connectionManager.onStateChange`: close on connected→disconnected edge, reopen on reconnected edge (two flags so each fires once; initial activation connect skipped).

**Kept:** dashboard self-heal (Terminal.tsx onPermanentClose → App refresh → reactive remount) — independent of the removed core helper.

All green: core 19, dashboard 322 (+1 pre-existing skip), vscode 324; check-types + lint clean. #997 (deterministic reconcile) still the proper root-cause for the reopen race; the bounded retry covers it meanwhile.

## Merged main (at dev-approval gate)

Merged origin/main (35 commits, dominated by PIR #921 — VSCode dev-server surface). True file overlap: `terminal-manager.ts` + its test.
- `terminal-manager.ts` **auto-merged cleanly**: #921's `devStartedAt` uptime map + `getDevStartedAt` + the `wasTracked` generic-close refactor sit alongside my `mapKey` hoist + `onSessionGone` closure + `recoverSuccessor`. Single `mapKey` decl (my hoist) serves both my pty closure and #921's close handler.
- `terminal-manager.test.ts` **conflicted** (both appended a `describe` at EOF) — resolved by keeping BOTH blocks (#991 recovery wiring + #921 dev-close).
- **No behavior interaction**: `recoverSuccessor` is a no-op for `dev-`/`shell-` keys (sessionRefFromMapKey → null), so #921's dev-uptime path is untouched; `{...entry, id}` in-place reconnect preserves the ManagedTerminal shape (#921 added no fields to it).

Post-merge all green: core 30, dashboard 322 (+1 pre-existing skip), vscode 327; check-types + lint clean. Still at dev-approval gate (did not re-run porch done — gate already pending).

## Reviewer trace (dev-approval) → found + fixed a reconcile race

Reviewer challenged whether VSCode terminals actually reattach on Tower restart ("they're dead, must close+reopen"). Traced the path:
- `getWorkspaceState` is a stateless HTTP GET → works as soon as Tower HTTP is up; `getClient`/`getWorkspacePath` survive a Tower restart. VSCode recovery chain is sound.
- Precondition: a successor exists ONLY if the shellper process (separate PID/socket in ~/.codev/run, created unconditionally at tower-server.ts:353) survives the restart. The fact that close+reopen restores the session proves a successor exists.
- **Real gap found**: `tower-server.ts` does `server.listen()` (:342) then `await reconcileTerminalSessions()` (:398) INSIDE the listen callback → Tower serves requests (404s the dead id, serves /api/state without successors) BEFORE reconcile registers successors. My one-shot `recoverSuccessor` raced that window → returned false → terminal stayed dead until manual reconnect. Dashboard was resilient (indefinite 1s poll); VSCode was not.

**Fix (committed 18031f8d)**: bounded re-poll in `recoverSuccessor` (RECOVER_POLL_ATTEMPTS=5 × RECOVER_POLL_INTERVAL_MS=1000 ≈ 4s) + a disposed-during-poll identity guard. Constants anchored to the dashboard's existing POLL_INTERVAL_MS (1s cadence) + PERMANENT_RECOVERY_MS (4s "declare gone" window) rather than invented numbers. vscode: 329 tests, check-types + lint green.

## Spun-off Tower issue (root-cause, out of scope for #991)

The deterministic fix is Tower-side: reconcile-before-serving OR a readiness signal (health doesn't gate on reconcile today), so a single getWorkspaceState is deterministic and both surfaces could drop the poll. That's an area/tower change with startup risk — out of #991's client-side scope. Drafted an issue and asked the architect to add it (not self-filing, per cross-cutting-spin-off discipline). #991 keeps the bounded poll as correct client behavior for today's Tower.
