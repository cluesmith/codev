# PIR #841 — Architects tree: Add Architect UI, Cmd+K A picker, label casing

Builder: pir-841 | Branch: builder/pir-841 | Protocol: PIR (strict)

## Plan phase (started)
Investigated the multi-architect surface:
- `packages/vscode/src/views/workspace.ts` — Workspace tree; `getArchitectChildren()` renders one row per architect (line 271 `new vscode.TreeItem(name)`). Architects parent row has `contextValue: 'workspace-architects-root'`. Already has `refresh()` (line 62) for imperative re-render.
- `packages/vscode/src/extension.ts:685` — `codev.openArchitectTerminal(architectName?)`; no-arg defaults to `main` (line 695). `codev.removeArchitect` (718) reads name from `arg.label` for TreeItem invocations.
- `packages/core/src/tower-client.ts:249` — `addArchitect(workspacePath, name?)` already exists; POST validates server-side.
- `packages/codev/src/agent-farm/utils/architect-name.ts` — `validateArchitectName` (pure). Lives in codev CLI pkg, NOT core. vscode depends on core only (6 import sites in codev).
- `package.json` — keybinding `cmd+k a`→openArchitectTerminal (no `when`); menus `view/item/context` + `view/title`.

Key decision for plan: where to source client-side name validation for the Add Architect InputBox (relocate pure validator to core w/ re-export shim, vs duplicate regex, vs server-side only). Recommending core relocation.

Casing safety check: `removeArchitect` reads `arg.label`; Option A keeps siblings as-typed so label==name stays correct (only `main`→`Main`, and main is unremovable). Verified safe.

## Plan revision 1 — casing decision
User chose **UPPERCASE all** for architect display labels (`MAIN`, `WEB`, `OB-REFINE`). Internal id stays lowercase. Consequence: sibling label now != raw name, so the `removeArchitect` fix (read raw name from `item.id`, not `arg.label`) is now MANDATORY, not defensive — otherwise Remove would DELETE the uppercased name Tower doesn't know. Plan Gap 3 + Files + Tests + Risks updated. Still awaiting plan-approval gate.

## Implement phase (done, awaiting dev-approval)
Plan approved. Implemented all three gaps:
- **Decision A1**: relocated pure `validateArchitectName`/`autoNumberArchitectName`/constants to `packages/core/src/architect-name.ts` (+ `./architect-name` export); codev shim re-exports them (zero churn at 6 call sites; `currentArchitectName` stays in codev). Confirmed codev-side tests (spec-755-phase2, spec-1057, af-architect) pass through the shim.
- **Gap 1**: `codev.addArchitect` command + inline `$(add)` button on the Architects root row; InputBox validates via the shared core validator; refresh on success. Palette-visible.
- **Gap 2**: `openArchitectTerminal` no-arg + N>1 shows QuickPick (`sortArchitectsForPicker`, main-first); N<=1 opens main directly.
- **Gap 3**: UPPERCASE labels via `displayArchitectName`; pure helpers extracted to vscode-free `views/architect-display.ts` so they're directly unit-testable. `removeArchitect` now resolves raw name from `item.id` (mandatory with uppercased labels).

Tests: 34 architect tests pass (new architect-display.test.ts behavior tests + extended sentinels). check-types ✓, lint ✓, esbuild bundles ✓ (after building workspace deps).

**Pre-existing unrelated failures** (confirmed on base via stash): `terminal-adapter.test.ts` + `reconnect-link-provider.test.ts` fail to collect under plain vitest (dynamic `import('ws')` / `terminal-link-provider.js`). NOT touched by this diff — out of scope, will note in review.
