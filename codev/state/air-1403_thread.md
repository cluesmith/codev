# air-1403 — Stream Deck: filter Zoom Navigator dial to active workspaces

## Issue
#1403 — Rotating the Zoom Navigator at the workspace altitude walks every
registered workspace, dormant ones included. Dormant entries are dead stops on
the dial (no overview, every command needs the workspace active in Tower).
Requirement (owner-ratified 2026-08-11, strict filter): the plugin store keeps
only `active === true` workspaces.

## Approach (AIR, ~83 LOC)
All the change is in `apps/streamdeck/src/store.ts`. The zoom cursor and
`selectedWorkspacePath()` index into the stored `workspaces` array, so I filter
at fetch time (not per-render) to keep indices coherent:

- New private `fetchActiveWorkspaces()` wraps `client.listWorkspaces()` and
  returns only `active` entries. Both fetch sites (`refresh()` and
  `syncToWorkspace()`'s stale-list re-fetch) go through it.
- `refresh()` now clamps `cursor.workspace` back to 0 when it points past the
  end of the (shorter) filtered list — handles a workspace deactivating while
  it is the current selection.
- `syncToWorkspace()`: a dormant registration is filtered out, so its path stays
  unfound and falls through to the existing no-op (same as an unknown path /
  builder-worktree window). Updated the docstring + inline comment.

No change to `cursor.ts`, actions, or the SDK — the fix lives entirely in how
the store populates its list.

## Tests
Added `describe('CodevStore active-workspace filtering')` in
`apps/streamdeck/src/__tests__/actions.test.ts`:
- refresh() stores only active entries; the dial cycles active ones (clamped,
  dormant skipped).
- cursor clamps to a valid index when the selected workspace deactivates.
- syncToWorkspace treats a dormant path like an unknown path (no-op).

Note: existing tests that set `store.workspaces` directly with dormant fixtures
are unaffected — the filter runs only at fetch time, not on hand-set arrays.

## Verification
check-types clean, esbuild build OK, `vitest run` 66/66 pass.
(check-types needs `@cluesmith/codev-types` + `@cluesmith/codev-sdk` built first
in a fresh worktree — those emit `dist/` the streamdeck tsconfig resolves.)

## Status
Implementation + tests done and green. Next: commit, open PR with review in body.
