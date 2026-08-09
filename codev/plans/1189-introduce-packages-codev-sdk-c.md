# PIR Plan: Introduce packages/codev-sdk (client SDK for Tower)

Issue: #1189. Branch: `builder/pir-1189`.

## Understanding

`@cluesmith/codev-core` is today consumed from both server contexts (Tower, CLI) and
client contexts (dashboard browser bundle, VS Code extension host). The server/client
boundary inside it is enforced only by convention. Two concrete failures of that
convention are cited in the issue: `constants.ts` imports `node:path`/`node:os`, so the
pure value `DEFAULT_TOWER_PORT` is unreachable from Metro (packages/core/src/constants.ts:1-5),
and nothing structurally stops a server-side need from adding a runtime dependency every
client inherits.

The fix is a package-level split:

- `codev-types`: wire contracts, unchanged. The only package imported by both sides.
- `codev-core`: server-side only (local-key issuance, homedir-derived paths, Tower internals over time).
- `codev-sdk` (new): the single client implementation of "how anything talks to Tower",
  consumed by apps/web, apps/vscode, the CLI's Tower-facing commands, and later the
  mobile app and streamdeck plugin.

**Hard invariant**: `codev-core` and `codev-sdk` never import each other; both import
`codev-types` only.

**Scope** (per architect guidance on the issue thread, 2026-08-05): this PIR delivers the
sdk package plus migration of the three in-repo consumers. The sdk absorbs the
`@cluesmith/codev-client` implementation (SSE client, command relay, local-key getToken
profile) and ships the `/controller` subpath the streamdeck lane will consume, but the
cross-repo work (apps/streamdeck move, codev-client npm deprecation, integrations repo
retirement) is follow-on owned by the streamdeck architect. Mobile consumption is a
future workstream; Metro/React-Native compatibility of the sdk is an acceptance
criterion here (enforced by the import-boundary test described below).

### Verified current state (recon, this worktree)

- `packages/core/src/` has 12 modules (1698 lines). Nine are already environment-pure
  (only `import type` from codev-types): workspace, escape-buffer, reconnect-policy,
  agent-names, architect-name, builder-helpers, area-grouping, phase-grouping,
  review-markers. Three are Node-entangled: constants (node:path/os), auth (node:fs/crypto),
  tower-client (imports both, plus `process.env.BRIDGE_TOWER_HOST` at
  tower-client.ts:190, `Buffer` in `pasteImage` at tower-client.ts:600-648, and bare
  global `fetch`).
- `tower-client.ts` already has an injectable `getAuthKey` option
  (tower-client.ts:171-176) but defaults to disk-backed `ensureLocalKey`.
- Every CLI command reaches TowerClient through the wrapper
  `packages/codev/src/agent-farm/lib/tower-client.ts` (today a pure re-export). This is
  the natural injection point: the wrapper can supply `ensureLocalKey` and the
  `BRIDGE_TOWER_HOST` fallback so zero command files change behavior.
- apps/vscode already injects auth: `connection-manager.ts:73` and `tower-starter.ts:121`
  construct with explicit options; `auth-wrapper.ts` wraps `readLocalKey`.
- `@cluesmith/codev-types` already exports `CommandRequest` and `COMMAND_ROUTE`
  (packages/types/src/command.ts:29,48), which resolves the duplication the absorption
  comment flags.
- Boundary-test exemplar: `packages/artifact-canvas/src/__tests__/import-boundary.test.ts`
  (forbids `vscode`, `node:*`, bare `fs`, and any `fetch(` call in shipped source).
- Sibling repo `~/repos/cluesmith/codev-integrations/packages/client/src/tower-client.ts`
  holds the absorption source: `subscribeEvents` (SSE with backoff), pure `parseSseText`,
  `sendCommand`, read-only local-key reader, all with injectable `fetchImpl`/`readKey`.
- Import census across `packages/codev/src`, `apps/web/src`, `apps/vscode/src` matches
  the issue's table. Per-subpath counts: reconnect-policy 9, tower-client 8, constants 7,
  agent-names 7, builder-helpers 6, review-markers 5, workspace 4, escape-buffer 4,
  area-grouping 4, phase-grouping 3, architect-name 3, auth 1 (vscode auth-wrapper).

## Proposed Change

### 1. New package: `packages/sdk` -> `@cluesmith/codev-sdk`

Directory follows the existing short-name convention (core, types, config). Package
manifest mirrors `packages/core`: `"type": "module"`, tsc build to `dist/`, vitest,
per-module subpath exports, `"files": ["dist"]`, version lockstep with the workspace
(3.2.4 at time of writing).

**Dependency contract**: `dependencies: {}` (literally absent/empty). `@cluesmith/codev-types`
stays in `devDependencies` and is imported **type-only** (`import type`), exactly as
codev-core does today. Where the absorbed command relay needs the `COMMAND_ROUTE` value,
the sdk declares its own route constant rather than making codev-types a runtime
dependency; codev-types keeps the provider-side mirror (this mirror already exists today
between codev-client and codev-types, and is one string literal).

Module map (src/):

| Module | Origin | Notes |
|---|---|---|
| `constants.ts` | split from core/constants.ts | `DEFAULT_TOWER_PORT`, `UNCATEGORIZED_AREA`. Pure values only. |
| `tower-client.ts` | moved from core, seams reworked (below) | The Tower API client. |
| `sse.ts` | lifted from codev-client | Pure `parseSseText` + `SseEnvelope`; `subscribeEvents` becomes a `TowerClient` method (below). |
| `workspace.ts` | moved verbatim | URL grammar (encode/decodeWorkspacePath). |
| `escape-buffer.ts` | moved verbatim | |
| `reconnect-policy.ts` | moved verbatim | sdk owns it; core keeps a private backoff copy (below). |
| `agent-names.ts` | moved verbatim | |
| `architect-name.ts` | moved verbatim | |
| `builder-helpers.ts` | moved verbatim | |
| `area-grouping.ts` | moved verbatim | |
| `phase-grouping.ts` | moved verbatim | |
| `review-markers.ts` | moved verbatim | |
| `controller.ts` | new (curated re-export) | The outside-in integration surface: overview read, workspace list, `sendCommand`, SSE subscribe, `parseSseText`. Subpath `@cluesmith/codev-sdk/controller`, designed for the streamdeck lane. |
| `node/local-key.ts` | lifted from codev-client (read-only reader) | Node-only adapter subpath `@cluesmith/codev-sdk/node`. See "the /node adapter" below. |

Tests move with their modules: core's `reconnect-policy.test.ts` and
`review-markers.test.ts`, plus the `parseSseText`/client tests adapted from
codev-integrations' `tower-client.test.ts`.

### 2. The sdk TowerClient: seam rework

Moved from `packages/core/src/tower-client.ts` with these changes (everything else,
including all endpoint methods and doc comments, moves as-is):

- **Auth**: `getAuthKey` remains in options but the default becomes `() => null`
  (unauthenticated unless injected). The disk-backed default moves to the callers that
  are entitled to it (CLI wrapper, below). No `import ... auth.js` remains.
- **Transport**: new option `fetchFn?: typeof fetch`, defaulting to
  `globalThis.fetch.bind(globalThis)` resolved lazily. All call sites use `this.fetchFn`;
  no bare `fetch(` appears in shipped source (the boundary test enforces this, matching
  the artifact-canvas rule). Works unmodified in browser, Node >= 18, and React Native.
- **Host**: the `process.env.BRIDGE_TOWER_HOST` fallback (tower-client.ts:190) moves to
  the CLI wrapper. The sdk reads no environment; `host` arrives via options only
  (default `'localhost'`).
- **pasteImage**: parameter type changes `Buffer` -> `Uint8Array` (Buffer is a
  Uint8Array subclass, so the vscode caller compiles unchanged; the ArrayBuffer slice
  logic already present stays).
- **subscribeEvents**: lifted from codev-client onto the sdk `TowerClient` (auth header
  and fetchFn come from the client instance; `parseSseText` imported from `sse.ts`).
  This is additive; no in-repo consumer is required to adopt it in this PR.
- **sendCommand**: lifted from codev-client onto the sdk `TowerClient`
  (`import type { CommandRequest }` from codev-types; route constant local to the sdk).
- **getTowerClient singleton**: moves OUT of the sdk into the CLI wrapper. A
  process-wide singleton with implicit disk auth is CLI ergonomics, not client-SDK
  surface. The sdk exports the class only.

### 3. The `/node` adapter subpath (decision point for reviewers)

The absorption comment mandates lifting the read-only local-key reader
(`~/.agent-farm/local-key` -> `codev-web-key` header) into the sdk as the default
getToken profile for local Node controllers. That code requires `node:fs`/`node:os`,
which the sdk's core rules forbid. Resolution: an explicitly Node-only adapter at
subpath `@cluesmith/codev-sdk/node` (src/node/local-key.ts, ~15 lines: `readLocalKey()`
returning `string | null`, never generating).

- The import-boundary test excludes `src/node/**` from the node-builtin ban but adds two
  assertions: nothing outside `src/node/` imports it, and `src/node/**` itself imports
  only node builtins (no vscode, no fetch, no codev-core).
- Metro safety holds because Metro only resolves modules that are imported; the core sdk
  graph never touches `src/node/`, and mobile/browser consumers never import the subpath.
- Key **issuance** (`ensureLocalKey`, mkdir + keygen) stays in codev-core per the
  issue's auth disposition. The read-only reader is duplicated between core/auth.ts
  (used internally by issuance) and sdk/node (client profile): ~10 lines, deliberate,
  same rationale as the reconnect exception.
- apps/vscode's `auth-wrapper.ts:2` switches from `codev-core/auth` to
  `codev-sdk/node`, which removes the last vscode dependency on codev-core.

Alternative rejected: keeping the reader only in codev-core would force vscode to retain
a codev-core dependency for one function and would leave the streamdeck/controller lane
with no default getToken profile, contradicting the absorption plan.

### 4. codev-core after the split

- Keeps `auth.ts` (issuance + reader, unchanged) and `constants.ts` (shrinks to
  `AGENT_FARM_DIR`; the two pure values move to the sdk).
- New private module `reconnect-backoff.ts`: a copy of `backoffDelayMs` (+ its options
  interface, ~45 lines) and the `WS_CLOSE_SESSION_UNKNOWN` constant, with a header
  comment recording the deliberate duplication per issue #1189 (the alternatives, core
  importing the sdk or algorithm code in codev-types, each break a rule worth more than
  the duplicated lines). Consumers: `tunnel-client.ts:20` (backoffDelayMs) and
  `tower-websocket.ts:12` (the close-code constant). Not exported from the package
  (no subpath entry): it exists for Tower internals only.
- `package.json` exports shrink to `./auth` and `./constants`; moved subpaths are
  deleted with **no facades** (single source of truth; all consumers are in-repo and
  migrate in this same PR). Description updated to say server-side.
- A small guard test in core's `__tests__`: no module under packages/core/src imports
  `@cluesmith/codev-sdk` (the other half of the invariant).

### 5. Consumer migration (mechanical import repoints unless noted)

**packages/codev** (gains `"@cluesmith/codev-sdk": "workspace:*"` in dependencies;
keeps codev-core):

- `src/agent-farm/lib/tower-client.ts`: from pure re-export to the CLI adapter. Exports
  a `getTowerClient()` singleton and a construction path that injects
  `getAuthKey: ensureLocalKey` (from codev-core/auth) and the `BRIDGE_TOWER_HOST` env
  fallback into the sdk `TowerClient`, then re-exports the sdk types plus
  `DEFAULT_TOWER_PORT`/`AGENT_FARM_DIR` as today. All ~28 CLI construction sites
  (`new TowerClient()` / `getTowerClient()` in src/agent-farm/commands/*, cli.ts,
  utils/notifications.ts, commands/porch/index.ts:1246) already import from this
  wrapper or will be repointed to it, so their auth/host behavior is unchanged.
- Direct `codev-core/tower-client` type imports in server files (tower-types.ts,
  tower-instances.ts, tower-terminals.ts, builder-lookup.ts, overview.ts) repoint to
  `@cluesmith/codev-sdk/tower-client`.
- `src/lib/github.ts:12` and `src/agent-farm/servers/overview.ts:12`
  (`UNCATEGORIZED_AREA`) -> `codev-sdk/constants`. `src/commands/doctor.ts:33`
  (`AGENT_FARM_DIR`) stays on codev-core.
- `src/agent-farm/utils/agent-names.ts`, `utils/architect-name.ts` re-export wrappers ->
  repoint to sdk.
- `tunnel-client.ts:20` and `tower-websocket.ts:12` -> `../lib/`-relative import of
  core's new private `reconnect-backoff` (via the core package's internals? No:
  packages/codev cannot reach core's unexported module). Correction: the private copy
  lives in **packages/codev** itself, e.g. `src/agent-farm/lib/reconnect-backoff.ts`,
  since its only consumers are Tower internals in this package. codev-core needs no
  copy. Same duplication rationale and header comment as above.
- `src/agent-farm/__tests__/tower-websocket.test.ts` repoints with its subject.

**apps/web** (dependency swap codev-core -> codev-sdk in package.json:17):
`src/lib/escapeBuffer.ts`, `src/components/Terminal.tsx:15`,
`src/components/BuilderCard.tsx` repoint.

**apps/vscode** (dependency swap at package.json:1067): ~25 files repoint
`@cluesmith/codev-core/<leaf>` -> `@cluesmith/codev-sdk/<leaf>` (views/*, terminal-*,
connection-manager, preflight, markdown-preview, extension.ts, commands/run-worktree-dev,
builder-pick-rows, auth-wrapper, plus 7 test files). `auth-wrapper.ts` additionally
switches to `codev-sdk/node` as described. No behavioral edits: this tree already
injects auth and host explicitly.

### 6. Boundary enforcement (CI)

`packages/sdk/src/__tests__/import-boundary.test.ts`, adapted from artifact-canvas:

- Everywhere in shipped src except `src/node/**`: forbid `vscode`, `node:*`, bare `fs`,
  any `fetch(` call, `window.`/`document.` globals, and any import of
  `@cluesmith/codev-core`.
- Forbid non-type imports of `@cluesmith/codev-types` (keeps the zero-runtime-deps
  contract honest at the source level).
- `src/node/**`: allow node builtins; still forbid vscode/fetch/codev-core; assert no
  module outside `src/node/` imports it.
- Assert `package.json` has no `dependencies` entries.

This test is the Metro acceptance criterion's executable form.

### 7. Build / release / operational wiring

- Root `package.json` build script: add `pnpm --filter @cluesmith/codev-sdk build`
  (after types; sdk, core, artifact-canvas order among themselves is free since none
  import each other).
- `.github/workflows/test.yml`: add packages/sdk build/test/check-types steps alongside
  the existing packages/core steps (4 job sections touch packages/core today: lines
  ~29-179). Check e2e.yml / dashboard-e2e.yml / post-release-e2e.yml for package-list
  assumptions at implement time.
- `scripts/bump-all.sh:90`: add `packages/sdk` to the version-aligned loop.
- `scripts/local-install.sh`: add sdk to the stale-tarball rm, the pack set, the
  uninstall/rm-rf list, and the single `npm install -g` invocation (the issue calls this
  out: global installs break on an unresolvable workspace dep otherwise).
- `codev/protocols/release/protocol.md`: sdk joins the lockstep-bump list (line 56) and
  the `pnpm publish` step (publish order: types, then core and sdk, then codev).
- CLAUDE.md + AGENTS.md (byte-identical): the Local Build Testing section names the
  packed packages; add codev-sdk.
- `codev/resources/arch.md`: Monorepo Structure + Core Components sections gain the
  package and the invariant. A HOT-tier fact candidate ("core and sdk never import each
  other; both import types only") is proposed at review phase per Spec 987 displacement
  rules, not unilaterally added.
- Grep both `codev/` and `codev-skeleton/` for stale codev-core references when done
  (skeleton currently has none; lessons-critical rule).

### Implementation order

1. Scaffold packages/sdk (manifest, tsconfig, vitest, boundary test red).
2. Move the nine pure modules + their tests; split constants; boundary test green.
3. Port tower-client with the seam rework; lift sse/sendCommand from codev-client;
   add controller and node subpaths.
4. Shrink codev-core; add packages/codev's private reconnect-backoff copy.
5. Migrate consumers: packages/codev wrapper + server imports, apps/web, apps/vscode.
6. Wiring: root build, CI, bump-all, local-install, release protocol, CLAUDE/AGENTS,
   arch.md.
7. Full `pnpm build` + all package test suites + manual verification (test plan below).

## Files to Change

New:

- `packages/sdk/package.json`, `packages/sdk/tsconfig.json` (mirroring packages/core)
- `packages/sdk/src/{constants,tower-client,sse,workspace,escape-buffer,reconnect-policy,agent-names,architect-name,builder-helpers,area-grouping,phase-grouping,review-markers,controller}.ts`
- `packages/sdk/src/node/local-key.ts`
- `packages/sdk/src/__tests__/import-boundary.test.ts` (+ moved/adapted unit tests)
- `packages/codev/src/agent-farm/lib/reconnect-backoff.ts` (private copy, documented)
- `packages/core/src/__tests__/no-sdk-import.test.ts` (invariant guard)

Modified (representative; full list is the census above):

- `packages/core/src/constants.ts` (shrink), `packages/core/package.json` (exports/description); delete the ten moved src modules + two moved test files
- `packages/codev/package.json`, `packages/codev/src/agent-farm/lib/tower-client.ts`, `src/lib/github.ts:12`, `src/agent-farm/servers/{overview,tower-types,tower-terminals,tower-instances,tower-websocket}.ts`, `src/agent-farm/lib/{tunnel-client,builder-lookup}.ts`, `src/agent-farm/utils/{agent-names,architect-name}.ts`, `src/agent-farm/__tests__/tower-websocket.test.ts`
- `apps/web/package.json:17` + 3 src files; `apps/vscode/package.json:1067` + ~25 src/test files (incl. `auth-wrapper.ts`)
- Root `package.json`, `.github/workflows/test.yml`, `scripts/bump-all.sh`, `scripts/local-install.sh`, `codev/protocols/release/protocol.md`, `CLAUDE.md`, `AGENTS.md`, `codev/resources/arch.md`

## Risks & Alternatives Considered

- **Risk: silent auth loss.** The sdk client defaults to no auth; a consumer newing the
  sdk class directly instead of the CLI wrapper would send unauthenticated requests.
  Mitigation: every CLI site goes through the wrapper (verified list above); final grep
  for `new TowerClient` outside wrappers; vscode already injects.
- **Risk: global-install breakage** if the pack set or publish set misses sdk.
  Mitigation: local-install.sh in the same commit as the dependency edit; post-release
  E2E workflow already catches E404 on missing workspace deps.
- **Risk: hidden behavioral drift in the move** (e.g. `BRIDGE_TOWER_HOST` fallback lost
  for a caller that bypasses the wrapper). Mitigation: the wrapper preserves defaults;
  repo-wide grep for `BRIDGE_TOWER_HOST` at implement time.
- **Alternative: facades/re-export shims left in codev-core.** Rejected: all consumers
  are in-repo and migrate in this PR; shims would preserve the exact ambient-boundary
  problem the issue exists to kill (and "deprecate, don't facade" is the stated
  direction for codev-client).
- **Alternative: codev-types as a runtime dep of the sdk** (to share `COMMAND_ROUTE`
  and the WS close code as values). Rejected: `dependencies: {}` is the reviewable
  contract the issue names; the cost is two mirrored literals, both recorded.
- **Alternative: reconnect backoff private copy in codev-core** (as the issue sketches)
  rather than packages/codev. Chosen location is packages/codev because its only
  consumers (tunnel-client, tower-websocket) live there and core has no other need for
  it; this keeps core's public surface at exactly auth + constants. Flagged for
  reviewer confirmation since it refines the issue text.
- **Alternative: full adoption of the sdk SSE client by apps/web and apps/vscode in
  this PR.** Deferred: both have working bespoke SSE consumers; consolidating them is
  real churn with no isolation payoff. The sdk ships `subscribeEvents` for the
  controller/streamdeck/mobile lanes; in-repo consolidation can be a follow-up.

## Test Plan

Automated (all must pass before dev-approval):

- `pnpm build` from repo root (types, sdk, core, artifact-canvas, codev).
- Package suites from their own dirs: `pnpm --filter @cluesmith/codev-sdk test`
  (boundary + moved unit tests), `--filter @cluesmith/codev-core test`,
  `--filter @cluesmith/codev test`, apps/web and apps/vscode builds + tests.
- Boundary-test negative check: temporarily add a `node:fs` import to an sdk module and
  confirm the suite fails, then revert (demonstrates the guard actually guards).

Manual (for the reviewer at the dev-approval gate, from this worktree):

1. `pnpm build && pnpm -w run local-install` (verifies the three-tarball pack set and
   global install; Tower restarts on the new code).
2. `afx status` and `afx send architect "ping from pir-1189 worktree"` (CLI ->
   Tower auth through the new wrapper; the message arriving proves the authenticated
   path).
3. Open the Tower dashboard in a browser; open a terminal pane (exercises apps/web on
   sdk escape-buffer + reconnect-policy).
4. In VS Code, reload the window with the extension built from this worktree; check the
   Builders sidebar renders and a builder terminal opens (exercises vscode on sdk
   tower-client/auth via `codev-sdk/node`).
5. Metro proxy: confirm `packages/sdk/src` greps clean for `node:` outside `src/node/`
   (the CI test automates this; the grep is the human-visible spot check).

Cross-platform: not applicable (no mobile artifact in this PR; Metro compatibility is
covered by the boundary test).
