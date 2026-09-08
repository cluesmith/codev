# air-1411 — sdk restricted controller client

**Issue #1411** — make `@cluesmith/codev-sdk/controller` a true capability surface (AIR).

## What the change does

`./controller` used to re-export the full `TowerClient` class, so every host/admin
method (`addArchitect`, `killTerminal`, `sweepHusks`, the canvas view-registration
trio, …) leaked through the "curated" surface. The stated posture and the actual
surface disagreed. This lane closes that gap.

- **New surface (`packages/sdk/src/controller.ts`)**: exposes `ControllerClient`
  (a `Pick<TowerClient, ...>` of exactly the 5 capability methods —
  `getOverview`, `listWorkspaces`, `subscribeEvents`, `sendCommand`,
  `sendCanvasCommand`) and a `createControllerClient(options?)` factory that builds
  a `TowerClient` internally but narrows the return type. Auth injection is
  preserved via `options.getAuthKey`.
- **Removed from `./controller`**: `TowerClient`, `COMMAND_ROUTE`,
  `CANVAS_COMMAND_ROUTE`. The full client stays available at
  `@cluesmith/codev-sdk/tower-client` for hosts.
- **Kept**: `parseSseText`/`SseEnvelope`, `TowerClientOptions`, `TowerWorkspace`,
  `DEFAULT_TOWER_PORT`, and the overview + canvas type re-exports.

## Export-list pin

`packages/sdk/src/__tests__/controller-surface.test.ts` pins the exact export set
(value + type, via a source scan) and the runtime value-export set, and asserts
the forbidden names never reappear. Same spirit as the #1189 boundary tests: the
surface can only grow with a deliberate edit to the pinned list.

## Consumer migration (same PR)

`apps/streamdeck` used only the controller capability set, so it was mechanical:
- `plugin.ts`: `new TowerClient(...)` → `createControllerClient(...)`.
- `store.ts`: `TowerClient` type → `ControllerClient`.
- `actions.test.ts`: mock cast `as unknown as TowerClient` → `ControllerClient`.
- `actions.ts`: unchanged (imports only types that stayed on the surface).

Behavior unchanged.

## Decisions / notes

- **Design**: `Pick<TowerClient, ...>` for the interface keeps method signatures in
  lockstep with the client (no hand-copied drift), while the factory keeps a single
  construction path with auth injection — matches the architect's baked requirements.
- **Breaking change**: sdk 3.3.0 shipped `./controller` exporting `TowerClient`
  (published 2026-08-09). Architect (Amr) accepted a clean removal (no deprecation)
  on blast radius: only known consumer is `apps/streamdeck` (migrated here), full
  client still at `./tower-client`. Migration line goes in the PR body; the architect
  transcribes it into the release notes on the changelog branch.
- **Merged `origin/main`** before implementing so the `actions.ts` refactor sits on
  the post-#1429 file (per architect caution).
- Did NOT touch `.builders/pir-1414` / `.builders/pir-1425` (live deck symlink).

## CMAP (impl review)

- **Gemini**: APPROVE, no issues.
- **Claude (Opus 5)**: APPROVE — verified all 4 requirements + ran both suites; checked
  the sibling integrations repo still uses the dissolved `codev-client`, so blast-radius
  holds. Two minor robustness notes taken.
- **Codex (GPT-5.6 Sol)**: REQUEST_CHANGES — the factory returned a live `TowerClient`, so
  host/admin methods survived at RUNTIME despite the narrowed type; wanted a real facade.

**Acted on the feedback** (the issue goal is literally "a *true* capability surface... not a
doc note"):
- `createControllerClient` now returns a facade of the 5 bound capability methods — host/admin
  methods are absent from the object at runtime, not merely type-hidden. Closes codex's block.
- Surface test strengthened: asserts the constructed object's own keys are EXACTLY the 5
  methods and that host methods (`killTerminal`, `addArchitect`, `sweepHusks`, view-reg trio,
  `writeTerminal`) are `undefined` on it.
- Added a guard forbidding `export */export type *` in controller.ts (Claude note (a):
  star re-export would widen the surface unnamed, invisible to the named-export scan).
- Fixed the stale `TowerClient`-from-`/controller` fixture string in streamdeck's
  import-boundary test (Claude note (b)).

## Status

- sdk: build + check-types clean; 8 files / **104** tests pass.
- streamdeck: check-types clean; 5 files / 86 tests pass.
- `porch check 1411`: build + tests PASS.
