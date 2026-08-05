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

## 2026-08-05 - Plan approved; implement phase

Plan approved without revision. Implementation went to plan with four discoveries worth
recording:

1. **The boundary test caught a real Metro-breaker on day one**: `workspace.ts` used
   `Buffer` for base64url. Replaced with a dependency-free codec; added a
   Buffer-parity test (byte-exact against Node's own base64url, since Tower decodes
   these segments server-side).
2. **An escaped regex dodged the bulk repoint**: `extension-architect-commands.test.ts`
   asserts extension.ts's import line via `@cluesmith\/codev-core\/architect-name`
   (backslash-escaped, so a plain-string grep missed it). Found by the vscode unit
   suite, not the sweep grep. Lesson candidate: sweep greps must cover escaped forms.
3. **tower-starter probed /health with the old implicit disk auth**; under the sdk's
   no-default-auth contract it would have gone unauthenticated. Now injects the
   read-only key from `@cluesmith/codev-sdk/node`.
4. **The private reconnect copy landed in packages/codev**, not codev-core (refining
   the issue text): its only consumers (tunnel-client, tower-websocket) live there,
   which keeps core's surface at exactly auth + constants. Flagged in the plan and
   awaiting reviewer confirmation.

All suites green: sdk 65, core 1, codev 4106, web 323, vscode 643. Boundary test
negative-checked (planted node:os import fails the suite). Sitting at dev-approval.
