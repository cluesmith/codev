# Spec 823 — iter-3 CMAP Rebuttal

**Date**: 2026-05-22
**Reviewers**: Gemini (APPROVE), Codex (REQUEST_CHANGES, narrower than iter-2), Claude (APPROVE)

---

## Summary

Iter-3 narrowed further. Codex surfaced two new substantive findings (skeleton-template propagation for Item 2; thread-file commit/retention for Item 3) plus one minor wording hedge for Item 4. Gemini and Claude both APPROVE with non-blocking architectural affirmations and plan-phase observations. All five iter-3 findings addressed; no findings rejected.

---

## Gemini (APPROVE) — non-blocking affirmations (no spec changes required, but folded in where useful)

### G-3.1. SSE broadcast seam pattern confirmed

Gemini confirmed that `broadcastNotification` lives in `tower-server.ts` and is passed to `worktree-config-watcher.ts` via `setWorktreeConfigNotifier()`. The plan phase will likely either add a similar setter (`setArchitectsUpdatedNotifier()`) or thread `broadcastNotification` into `InstanceDeps` so `addArchitect` / `removeArchitect` can trigger the emit. No spec change — plan phase pins the exact seam.

### G-3.2. VSCode reconnect resilience already handled

Gemini noted that `WorkspaceProvider` already subscribes to `connectionManager.onStateChange()` (which fires `changeEmitter` on reconnect). The tree self-heals after SSE disconnection without new defensive logic. This makes the iter-1 risk row about reconnect-driven misses largely obsolete.

**Action taken**: updated the relevant Risks-and-Mitigation row to acknowledge this — the mitigation is now "already handled" rather than "add defensive `refresh()` on reconnect," with the plan phase responsible only for confirming the existing behaviour remains intact.

### G-3.3. SQL fix approach confirmed

Gemini explicitly endorsed dropping `WHERE issue_number IS NOT NULL` + conditional assignment. No action needed; the spec already says this since iter-1.

---

## Codex (REQUEST_CHANGES) — all three findings addressed

### C-3.1. Item 2 incomplete for external adopters (skeleton templates)

**Finding**: The iter-2 spec required updating only the repo-root `CLAUDE.md` / `AGENTS.md` and `codev/resources/commands/agent-farm.md`. But external adopters get their initial `CLAUDE.md` / `AGENTS.md` from `codev-skeleton/templates/` via `codev init`. Without updating those templates, the messaging primitives never reach external adopters' projects.

**Verification**: Confirmed by `ls codev-skeleton/templates/` — both `CLAUDE.md` and `AGENTS.md` are present as adopter-facing templates. The problem statement explicitly centers external discoverability, so this gap directly undercuts the spec's own goal.

**Resolution**: Promoted from non-explicit to MUST. The Functional MUST / Item 2 now requires equivalent messaging content in both `codev-skeleton/templates/CLAUDE.md` and `codev-skeleton/templates/AGENTS.md`. The skeleton template content does not have to be byte-identical to the repo-root files (some sections may differ for adopter context), but the messaging-section MUST appear in both with the same primitives documented (four addressing forms, spoofing-check note, sibling-architect example, thread-file mention). Also added both files to the Dependencies / Item 2 list.

**Where in spec**: Functional MUST / Item 2 (new MUST), Dependencies / Item 2 (two new entries).

### C-3.2. Item 3 post-merge story underspecified (commit/retention)

**Finding**: The iter-2 spec said thread files "land in `codev/state/` on `main`" post-merge, but with "no porch hooks" this only materializes if builders actually commit the thread file in their PR. The role-file instruction focused on writing/discovery, not commit/retention.

**Verification**: Conceded. Without an explicit commit rule, builders might leave the thread uncommitted (especially if it never gets edited in the builder's normal git-add flow), and after `afx cleanup` the thread evaporates. The "historical review record" outcome the spec describes would never actually materialize.

**Resolution**: Added an explicit commit/retention rule as a new sub-bullet in the Functional MUST / Item 3 instruction list. The default disposition is "commit the thread as part of the PR." The alternative ("strip the thread before PR") is an explicit builder decision — typically because the thread turned out to be noise — which the builder handles via gitignore or by not staging the file. This makes the post-merge story robust against accidental loss while still respecting builder autonomy.

**Where in spec**: Functional MUST / Item 3 (new "Commit/retention rule" sub-bullet).

### C-3.3 (minor). Item 4 wording hedge for `removeArchitect`

**Finding**: The iter-2 spec referenced `removeArchitect` as if it exists on the builder's branch. It does not — #786 PR #822 is what adds it. The wording should be hedged.

**Verification**: Confirmed. `removeArchitect` is in main (post-#786 merge) but not on the builder's branch yet. The spec already framed Item 4 as dependent on #786; the wording just needed to match that framing more carefully.

**Resolution**: Hedged the MUST wording from "every successful `addArchitect` and `removeArchitect` call" to "every successful architect add and remove path (specifically: `addArchitect` and the corresponding successful remove seam introduced by #786)." The function-name claim is now conditional on the #786 seam landing.

**Where in spec**: Functional MUST / Item 4 (SSE event emission MUST, wording hedged).

---

## Claude (APPROVE) — non-blocking plan-phase observations (no spec changes required)

### Cl-3.1. `WorkView` doesn't currently have direct access to `state.architects`

Claude noted that `WorkView` receives `DashboardState` as a prop, but `architects` comes from a separate field on `DashboardState`, while overview data comes via `useOverview()`. The builder needs to confirm which source `architectCount` reads from at plan time.

**Action**: No spec change. OQ-A already defers this to plan phase (it asks how `BuilderCard` learns the architect count). The plan phase will pin whether the prop is `state.architects.length` (from `DashboardState`) or a derived `architectCount` computed in `WorkView` from a different source. The OQ-A recommendation (`WorkView` computes once, passes as prop) stands regardless of the source.

### Cl-3.2. Reconnect defensive refresh may be redundant

Claude noted that `WorkspaceProvider` already subscribes to `connectionManager.onStateChange()`. **This was independently confirmed by Gemini (G-3.2)**, so the Risks-and-Mitigation row is updated to reflect the existing handling.

### Cl-3.3. `BuilderCard` is a `<tr>` element

Claude noted that the attribution tag goes inside the existing `<td>` for the builder ID as a cell-internal `<span>`, not as a new column. This aligns with baked decision 2b (no column-shift) and OQ-B's recommendation (a). No spec change needed; the constraint is already baked in.

---

## Net spec change summary (iter-3)

- **2 new MUSTs** (skeleton templates for item 2; commit/retention rule for item 3).
- **1 wording hedge** (item 4 `removeArchitect` → "remove seam introduced by #786").
- **1 risk row updated** (SSE reconnect — now "already handled" per `connectionManager.onStateChange()`).
- **2 new Dependencies / Item 2 entries** (`codev-skeleton/templates/CLAUDE.md` + `AGENTS.md`).
- **No findings rejected.** No disagreements with reviewers.

## Iter-4 readiness

Spec is ready for iter-4 CMAP. Codex's three iter-3 findings are addressed (two substantive, one minor wording). Gemini and Claude were already APPROVE; their architectural affirmations are folded in where they affected the spec (reconnect risk row). Iter-4 should converge to APPROVE across all three reviewers; if any new findings surface, those will be addressed in iter-4 corrections.
