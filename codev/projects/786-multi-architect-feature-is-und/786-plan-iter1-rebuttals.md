# Plan 786 — Iter-1 CMAP Rebuttal

**Date**: 2026-05-22
**Reviewers (iter-1)**: Gemini (APPROVE), Codex (REQUEST_CHANGES), Claude (COMMENT)
**Outcome**: All Codex findings accepted and incorporated. All Claude findings accepted and incorporated. Gemini's endorsements recorded.

---

## Summary

Plan iter-1 hit one verified APPROVE (Gemini), one verdict-blocking REQUEST_CHANGES (Codex) with four substantive findings, and one COMMENT (Claude) with three minor implementation gaps. After verification against the codebase, every reviewer finding checked out and was incorporated. No disagreements.

---

## Gemini — APPROVE

Three positive endorsements; no spec changes requested.

### Endorsement 1: VSCode right-click context menu (Phase 6 OQ-D plan-time)
> "Your recommendation to use a right-click context menu for 'Remove Architect' in the TreeView is exactly the right call. It's standard VSCode UI practice (using `view/item/context` in `package.json`), scales well, and avoids cluttering the UI with inline action buttons. You have my full support on this pattern for the plan-approval gate."

**Effect**: confidence boost for the architect's expected plan-approval call on this UX. Recorded in the iter-2 plan's Phase 6 deliverables (the `viewItem == workspace-architect-sibling` menu contribution).

### Endorsement 2: Tower `/status` API contract extension (Phase 5)
> "Extending the existing terminal entries with optional `pid`, `port`, and `architectName` fields is far superior to adding a new `/architects` endpoint. It avoids N+1 queries, keeps the client simple, and is entirely backward-compatible for older clients that just ignore the new fields."

**Effect**: confirms the iter-1 plan's recommendation. Iter-2 pins this explicitly: extend terminal entries, do NOT add a new endpoint. Documented in Phase 5 and the consultation log.

### Endorsement 3: `clearState` split (Phase 1/3)
> "Splitting `clearState()` into a variant that skips the `architect` table is the safest way to change `commands/stop.ts` without breaking the global `afx` uninstall/nuke flows."

**Effect**: confirms Phase 1 Option B (new `clearRuntime()` function) over Option A (options bag on existing `clearState()`). Iter-2 plan leans further toward Option B based on this endorsement plus Claude's matching reasoning.

---

## Codex — REQUEST_CHANGES (4 findings, all accepted)

### Co1. Phase 3 restore flow inconsistency
> "Phase 3's proposed restore flow is inconsistent with the actual code: `launchInstance` cannot 're-spawn each via the existing addArchitect code path' before `main` exists, because `addArchitect()` currently rejects when `entry.architects.size === 0`. The plan needs to pin a valid seam."

**Status**: Accepted.

**Verification**:
- `tower-instances.ts:666` — `if (!entry || entry.architects.size === 0) { return { success: false, error: "Workspace ... is not running. Start it with 'afx workspace start' first." }; }`. Confirmed.

**Changes made (iter-2)**: Phase 3's Implementation Details now pin explicit ordering:
1. Create `main` if `!entry.architects.has('main')` — same logic as today.
2. Query `state.db.architect` for all rows whose `id !== 'main'` via `getArchitects()`.
3. For each persisted sibling not already in `entry.architects`, call `addArchitect(workspacePath, name)` — which now passes the size>0 guard because `main` was created in step 1.

This ordering also pins Claude's iter-1 finding about `main`-first ordering for Spec 761's `architectTabId` convention (see Cl3 below).

### Co2. JSON-RPC vs REST transport
> "The plan describes `removeArchitect` as a new 'JSON-RPC envelope' method, but the real Tower client/server uses REST-style HTTP endpoints (`POST /api/workspaces/:encoded/architects`, `POST /deactivate`, etc.), not JSON-RPC."

**Status**: Accepted.

**Verification**:
- `tower-client.ts:212` — `addArchitect` issues `POST /api/workspaces/${encoded}/architects`. REST.
- `tower-client.ts:237` — `deactivateWorkspace` issues `POST /api/workspaces/${encoded}/deactivate`. REST.
- No JSON-RPC envelopes anywhere in the client.

**Changes made (iter-2)**: Phase 4 transport corrected throughout. New endpoint is `DELETE /api/workspaces/:encoded/architects/:name` (REST-idiomatic — DELETE on a path-identified resource, no request body needed). Plan now names the route shape and the implementation site in `tower-routes.ts`.

### Co3. Missing file changes
> "Several required file changes are missing from the plan even though they are necessary in the current codebase: `packages/codev/src/agent-farm/cli.ts` must register `workspace remove-architect`; `packages/codev/src/agent-farm/types.ts` must grow an `architects` collection if `loadState()` becomes collection-aware; `packages/core/src/tower-client.ts` and likely `packages/types/src/api.ts` need status-response type updates if `/status` gains architect `pid/port/terminalId`; and VSCode `package.json` needs a contributed `codev.removeArchitect` command in addition to the context-menu entry."

**Status**: Accepted.

**Verification**:
- `cli.ts:108-114` — existing `add-architect` registration pattern. `remove-architect` would mirror it. Confirmed missing from iter-1 plan.
- `types.ts` not yet inspected by hand, but Codex's claim is structurally sound: making `loadState()` return an `architects` collection requires the type to expose it.
- VSCode `package.json` — must contribute the new command (`contributes.commands`) AND the menu binding (`menus['view/item/context']`).

**Changes made (iter-2)**: All four files added to Phase deliverables:
- Phase 4: `packages/codev/src/agent-farm/cli.ts` registration; `tower-routes.ts` new route handler; `tower-client.ts` new client method.
- Phase 5: `packages/codev/src/agent-farm/types.ts` `architects` field; `packages/types/src/api.ts` + `tower-client.ts` type extensions for the new optional `architectName/pid/port` fields on terminal entries.
- Phase 6: `packages/vscode/package.json` command contribution + menu entry.

### Co4. Test plan gaps
> "Spec coverage is not quite complete in the test plan: the spec explicitly requires automated architect-to-architect routing verification and distinguishes `workspace stop/start`, `tower stop/start`, and crash-recovery paths. The plan covers some of this manually, but it does not clearly assign automated integration coverage for architect↔architect messaging, Tower stop/start, crash recovery regression, or the non-functional timing assertions."

**Status**: Accepted.

**Verification**: re-reading the spec's Functional Tests section — items 2 (graceful-restart), 3 (Tower stop+start), 4 (crash recovery), 5 (shellper auto-restart), 8 (architect-to-architect), and the Non-Functional Tests (persistence performance, restart timing) — all are present. The iter-1 plan listed some as manual-only.

**Changes made (iter-2)**: 
- Phase 3 Test Plan adds explicit automated integration tests for: workspace stop+start, tower stop+start (distinct path), crash recovery regression, `handleWorkspaceStopAll` full-wipe regression, permanent-exit auto-delete.
- Phase 3 Test Plan adds **non-functional timing assertions**: 8-architect rebind <2s; per-architect persistence write/delete <100ms.
- Phase 5 Test Plan adds **automated architect-to-architect routing test**: main → `architect:ob-refine` and reverse, asserted via PTY input/output rather than manual eyeball.

---

## Claude — COMMENT (3 minor gaps, all accepted)

### Cl1. `ArchitectTabStrip.tsx` has no close-button rendering
> "The plan's Phase 4 sets `closable: name !== 'main'` in `useTabs.ts` and describes 'Dashboard click handler for the close-X.' But `ArchitectTabStrip.tsx` (33 lines, verified) renders only `<span className="tab-label">{tab.label}</span>` — it has **no close button rendering at all**. Compare with `TabBar.tsx:48-64` which conditionally renders `&times;` when `tab.closable === true`."

**Status**: Accepted.

**Verification**: confirmed during earlier Explore — `ArchitectTabStrip.tsx` renders only the label span; no conditional X.

**Changes made (iter-2)**: Phase 4 deliverables now include an explicit "add close-button rendering to `ArchitectTabStrip.tsx`" item that matches `TabBar.tsx`'s `{tab.closable && (<span className="tab-close" onClick={...}>×</span>)}` pattern. The plan now also pins the click-handler routing: it invokes the confirmation modal (not the RPC directly).

### Cl2. Intentional-stop flag cross-module access
> "The plan proposes the `Set<string>` in tower-instances.ts module-level state, but one of the five exit handlers (at `tower-terminals.ts:665-677`) lives in a different module. The plan should note that this handler needs access to the flag, either via a shared export, a `_deps` injection, or passing it through the kill cascade."

**Status**: Accepted.

**Verification**: confirmed five exit handlers across two modules (`tower-instances.ts` × 4, `tower-terminals.ts:665-677` × 1).

**Changes made (iter-2)**: Phase 3 Implementation Details now pin the cross-module accessor pattern: the Set lives in `tower-instances.ts` and is exposed via an exported getter `isIntentionallyStopping(workspacePath: string): boolean`. `tower-terminals.ts` imports the getter. This keeps the Set encapsulated to `tower-instances.ts` while letting the cross-module exit handler read its state.

### Cl3. Phase 5 `main`-first ordering should be pinned
> "The plan notes that after Phase 3, siblings may be restored before `main` in `launchInstance`, which could affect the 'first architect gets bare `'architect'` id' convention. The plan should pin the decision (recommend: always create main first in `launchInstance` reconciliation, then loop siblings) rather than leaving it open."

**Status**: Accepted.

**Verification**: Spec 761's `architectTabId` convention (`useTabs.ts:33` — `index === 0 ? 'architect' : 'architect:<name>'`) is order-dependent. Bare `'architect'` id is load-bearing for deep-linking (`?tab=architect`).

**Changes made (iter-2)**: Phase 3 Implementation Details now pin the ordering explicitly — create `main` first, then iterate siblings. Phase 5's emission code uses `name === 'main'` directly rather than relying on positional ordering, which is more robust. Phase 5 description includes a `main`-first sort in `loadState()` so the state-shape is also predictable for fallback consumers.

---

## What did NOT change

- The 7-phase structure is preserved.
- The Approach 1 endorsement from the spec carries through.
- OQ-A/B/D/G architect decisions are unchanged.
- The PR strategy (single bundled PR, mid-checkpoint after Phase 3 if architect requests) is unchanged.
- The Risk Analysis table is unchanged; mitigations already covered most of the new findings.

---

## Net effect

Iter-1 → iter-2: 55 line insertions, 27 deletions. Phase 3 and Phase 4 received the bulk of changes (launchInstance ordering, REST transport, new file deliverables, automated test scenarios). Phase 5 gained type-file additions and architect-to-architect automation. Phase 6 gained the VSCode `package.json` contribution.

Ready for plan iter-2 CMAP.
