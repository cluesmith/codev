# Builder thread: pir-1189 (Introduce packages/codev-sdk)

## 2026-08-05 - Spawn + plan phase

Spawned in strict PIR mode for issue #1189. Read the issue body plus both load-bearing
2026-08-05 comments (codev-client absorption census, ownership clarification) and the
architect's mid-turn scope guidance:

- In scope: SDK package + migration of in-repo consumers (apps/web, apps/vscode, CLI
  Tower-facing commands). Design the `/controller` subpath for the streamdeck lane.
- Out of scope: apps/streamdeck move, codev-client npm deprecation, integrations repo
  retirement, mobile-app consumption. Metro compatibility is an acceptance criterion.
- Hard invariant: codev-core and codev-sdk never import each other; both import
  codev-types only.

Recon findings that shaped the plan:

- core's tower-client already has a `getAuthKey` seam but defaults to disk-backed
  `ensureLocalKey`; also uses `process.env.BRIDGE_TOWER_HOST`, `Buffer` (pasteImage),
  and bare global fetch. All four need seam work for the sdk.
- 9 of core's 12 leaves are already pure (only `import type` from codev-types).
- codev-types already owns `CommandRequest` + `COMMAND_ROUTE`, so the codev-client
  absorption can use type-only imports plus one mirrored route const.
- All CLI commands construct TowerClient via `packages/codev/src/agent-farm/lib/tower-client.ts`
  (a re-export wrapper today), which becomes the natural place to inject
  `ensureLocalKey` + env-host so no command file changes behavior.
- Boundary-test exemplar confirmed at `packages/artifact-canvas/src/__tests__/import-boundary.test.ts`.

Writing plan to `codev/plans/1189-introduce-packages-codev-sdk-c.md`; will sit at
plan-approval. Expect consumer-stakeholder review from the mobile architect (Metro
constraints) on top of the normal gate.
