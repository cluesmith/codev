# pir-1347 thread — Stream Deck plugin migration (apps/streamdeck)

## 2026-08-06 — plan phase

Spawned on issue #1347 (PIR, strict). Investigated:

- Old repo `codev-integrations`: only **2 commits total** (initial import + one docs commit), which makes
  history preservation nearly moot — documented import-commit boundary wins over git subtree, matching
  the architect's lean.
- Plugin surface consumed from `@cluesmith/codev-client`: `TowerClient` (value, plugin.ts only),
  `WorkspaceSummary` + 4 Overview* types (type-only, store.ts/actions.ts), `sendCommand`/`subscribeEvents`/
  `listWorkspaces`/`getOverview` methods. All map 1:1 onto `codev-sdk/tower-client` (lifted verbatim per
  #1189 absorption); `WorkspaceSummary` → `TowerWorkspace` (compatible superset).
- Sequencing dependency: #1357 (controller re-exporting Overview* types) is being fixed on main by
  air-1357 — architect instructed to plan against it landing first. Until it lands, `pnpm check-types`
  in apps/streamdeck will fail on the Overview* imports; noted in plan.
- Architect instructions received mid-turn (2026-08-05T22:32Z): sequence after #1357; scope = issue
  steps 1–3 + canary landed manual-only; step 5 OUT; import-boundary via documented commit; auth via
  `TowerClient({ getAuthKey: readLocalKey })`.

Plan decisions: import-commit boundary w/ README provenance pointer; type-only sdk imports outside
plugin.ts (drops the old vitest alias hack); import-boundary vitest guard mirroring sdk's; CI steps in
test.yml unit job; canary as separate workflow_dispatch-only workflow using
`pnpm --filter ... add @cluesmith/codev-sdk@latest` (registry-resolves since link-workspace-packages
defaults false).

Plan written to `codev/plans/1347-migrate-the-stream-deck-plugin.md`; sitting at plan-approval gate.
