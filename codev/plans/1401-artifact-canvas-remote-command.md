# Plan: Artifact-Canvas Remote Command Channel (Tower relay + sdk route)

**Specification**: [codev/specs/1401-artifact-canvas-remote-command.md](../specs/1401-artifact-canvas-remote-command.md)

## Executive Summary

Implements the spec's recommended Approach 2: a Tower-side registry of live canvas views
plus a targeted command route, delivery as an addressed event over the existing SSE channel,
a `CommandAdapter` seam in the canvas package, and a `sendCanvasCommand` call on the sdk
controller subpath.

The work is sequenced contracts-first, then outward in dependency order: the wire vocabulary
lands once in `codev-types`, the canvas package becomes remotely drivable by any host, Tower
gains the registry and route, the sdk exposes the call, and the VS Code host wires the two
ends together into a working review loop. Phases 2, 3 and 4 each depend only on Phase 1, so
each is independently verifiable without the others; only Phase 5 requires the full stack.

Two decisions the spec deferred to this plan are settled here:

**Where the vocabulary lives.** `packages/artifact-canvas` has no dependency on
`@cluesmith/codev-types` today (its only deps are `dompurify` and `markdown-it`). The command
union is a genuine wire contract: it travels in the POST body and the SSE event, and both
Tower and the sdk need it while neither may depend on a React package. So `codev-types` owns
it, and the canvas package gains `@cluesmith/codev-types` as a type-only dependency, matching
the sdk's existing arrangement (a real `dependencies` entry so published `.d.ts` resolve,
with every import in the fully-erased `import type` form). This keeps one definition rather
than two unions kept in sync by hand. The canvas package's existing import-boundary guard
forbids `vscode`, `node:*`, bare `fs` and `fetch`, none of which this touches; Phase 2 extends
that guard to pin the import as type-only so no runtime value can leak in.

**Registration transport.** Hosts register views over dedicated HTTP calls with a heartbeat
lease, not by binding registrations to the host's SSE connection lifetime. The deciding case
is VS Code: one extension host holds a single SSE connection for the whole window, but that
window can host several canvas panels, so a connection-scoped registration cannot distinguish
panels and closing one panel would not drop one registration. Per-view HTTP registration
gives each panel its own identity and its own unregister, with the lease bounding staleness
when a host dies without cleaning up.

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "phase_1", "title": "Command vocabulary wire contracts"},
    {"id": "phase_2", "title": "Canvas action registry and CommandAdapter seam"},
    {"id": "phase_3", "title": "Tower canvas view registry and command route"},
    {"id": "phase_4", "title": "sdk canvas command and view registration calls"},
    {"id": "phase_5", "title": "VS Code host wiring and end-to-end review loop"}
  ]
}
```

## Phase Breakdown

### Phase 1: Command vocabulary wire contracts

**Dependencies**: None

#### Objective

Define the command vocabulary, error codes, request/result shapes and protocol names once,
in the package every other participant may depend on. This is the contract that keeps four
packages in lockstep, and the single place the traversal-versus-non-traversal classification
(which governs `count` applicability) is expressed.

#### Files to Create / Modify

- `packages/types/src/canvas-command.ts` (new)
- `packages/types/src/index.ts` (export the new module)
- `packages/types/src/__type-tests__/canvas-command.type-test.ts` (new, compile-time only)

#### Deliverables

- [ ] `CanvasCommand`: closed union of the 14 canonical commands from the spec's table.
- [ ] `TRAVERSAL_COMMANDS` (the eight traversal/paging commands) and an
      `isTraversalCommand(c)` predicate, as the single source both Tower validation and
      canvas dispatch consume.
- [ ] `CanvasCommandErrorCode`: closed union `'no-canvas' | 'invalid-request'`.
- [ ] `CanvasCommandRequest { workspace, file?, command, count? }` and
      `CanvasCommandResult` (success carries `target: { viewId, file }`; failure carries
      `code` and `error`).
- [ ] View-registry wire shapes: registration request/result (`viewId` minted by Tower),
      heartbeat body (`{ focused?: boolean }`), and the registered-view shape.
- [ ] Protocol name constants: `CANVAS_COMMAND_ROUTE`, `CANVAS_VIEWS_ROUTE`,
      `CANVAS_COMMAND_EVENT`, following the existing `COMMAND_ROUTE`/`COMMAND_EVENT`
      precedent in `command.ts`.
- [ ] Compile-time exhaustiveness guard: a type-test file that fails to compile if a command
      is added to the union without being classified as traversal or non-traversal.

#### Acceptance Criteria

- [ ] `pnpm --filter @cluesmith/codev-types check-types` passes, and the guard file fails to
      compile when a command is deliberately left unclassified (verified once by hand during
      development).
- [ ] Repo-wide `check-types` still passes: nothing else has changed behavior.
- [ ] No implementation or policy lands here, only wire shapes and the classification data
      they carry.

#### Test Plan

`@cluesmith/codev-types` ships no test runner (its scripts are `build` and `check-types`
only), so verification here is compile-time: the exhaustiveness guard plus `check-types`
across the package and its dependents. Runtime behavior of the classification is covered
where it is consumed, by Phase 2 (canvas dispatch) and Phase 3 (Tower validation).

### Phase 2: Canvas action registry and CommandAdapter seam

**Dependencies**: Phase 1

#### Objective

Make the canvas remotely drivable by any host, with keyboard and remote paths sharing one
implementation per action so the two cannot drift. Delivers standalone value: the package
gains the seam regardless of whether Tower ever calls it.

#### Files to Create / Modify

- `packages/artifact-canvas/src/adapters/CommandAdapter.ts` (new)
- `packages/artifact-canvas/src/components/ArtifactCanvas.tsx` (action registry, current-block
  cursor, adapter subscription)
- `packages/artifact-canvas/src/types.ts` (`commandAdapter?` on `ArtifactCanvasProps`)
- `packages/artifact-canvas/src/index.ts` (export the adapter type)
- `packages/artifact-canvas/package.json` (add `@cluesmith/codev-types` dependency)
- `packages/artifact-canvas/src/__tests__/import-boundary.test.ts` (pin the new import as
  type-only)
- `packages/artifact-canvas/src/__tests__/remote-commands.test.tsx` (new)

#### Deliverables

- [ ] Per-action functions extracted from `onBodyKeyDown` into one action registry keyed by
      `CanvasCommand`; the existing key handlers call into that registry rather than
      duplicating the logic. Pure extraction, no behavior change.
- [ ] Current-block cursor: the most recently focused block (by keyboard, pointer, minimap or
      remote command), falling back to the topmost visible block when nothing has been focused
      yet. This is the remote origin the spec defines, and it is what makes navigation
      well-defined on a freshly opened view.
- [ ] `CommandAdapter` interface (host-implemented, interface-only, matching the existing
      D-series adapter convention) and an optional `commandAdapter` prop; omitting it leaves
      behavior identical to today.
- [ ] Adapter dispatch honouring `count` for traversal commands (N steps, edge-clamped, no
      wrap) using the Phase 1 classification.
- [ ] Composer commands scoped to the view's open composer rather than to DOM focus.
- [ ] Navigation focuses its target through the same focus path the keyboard uses (visible
      ring, scroll into view); the package never reaches outside the canvas document.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] All 14 commands, driven through a test `CommandAdapter`, produce the effect defined in
      the spec's command table.
- [ ] On a freshly mounted, never-focused canvas, every navigation command has an observable
      effect, starting from the topmost visible block.
- [ ] `count` multiplies the eight traversal commands and is ignored or rejected consistently
      on the other six (rejection surfaces to the host through the existing `onError` sink,
      never as a throw out of a handler).
- [ ] Existing canvas keyboard tests pass **unmodified**: the in-page behavior non-goal holds.
- [ ] Import-boundary test passes, including the new type-only rule.
- [ ] `pnpm --filter @cluesmith/codev-artifact-canvas test` and `check-types` pass.

#### Test Plan

Unit and component tests in vitest: one case per command driven through the adapter; the
clean-state origin cases; the `count` cases including clamping at edges; composer submit and
cancel with focus deliberately parked outside the composer; the no-adapter case asserting
unchanged behavior. Real-DOM assertions that jsdom cannot make honestly (scroll-into-view,
column paging geometry) go to the package's existing Playwright harness via
`pnpm --filter @cluesmith/codev-artifact-canvas test:browser`. The regression guard is that
the pre-existing keyboard suite is not edited in this phase.

### Phase 3: Tower canvas view registry and command route

**Dependencies**: Phase 1

#### Objective

Give Tower an authoritative picture of which canvas views are live, and a command route that
resolves a target by the spec's rule and answers explicitly. This is the phase that satisfies
Requirement 4, and it is verifiable end to end without any canvas existing.

#### Files to Create / Modify

- `packages/codev/src/agent-farm/servers/canvas-relay.ts` (new; self-routing module modeled
  on `command-relay.ts`)
- `packages/codev/src/agent-farm/servers/tower-routes.ts` (dispatch the new route family)
- `packages/codev/src/agent-farm/__tests__/canvas-relay.test.ts` (new)
- `packages/codev/src/agent-farm/__tests__/canvas-relay.e2e.test.ts` (new, using the existing
  `helpers/tower-test-utils.ts` harness)

#### Deliverables

- [ ] View registry: register (Tower mints an opaque `viewId`), heartbeat with optional
      `focused` flag, unregister, and lease expiry. Heartbeat cadence and lease TTL are named
      constants; the lease is sized to tolerate a small number of missed heartbeats.
- [ ] Tower-side path canonicalization on both registration and command, reusing the same
      resolution the existing file-tab dedupe applies, so path spelling cannot split the
      registry.
- [ ] Tower-stamped `lastActiveAt`: set on registration, advanced on a `focused` heartbeat and
      on command delivery. Host clocks are never trusted.
- [ ] Target resolution: filter by workspace and, when given, file; zero matches answer
      `no-canvas` with HTTP 404; one match delivers; multiple matches deliver to the single
      most recently active view, tie-broken by most recent registration. Never a broadcast to
      several matches.
- [ ] Validation against the closed `CanvasCommand` union and the traversal classification,
      answering `invalid-request` with HTTP 400 for an unknown command, a malformed selector,
      `count` on a non-traversal command, or a non-positive `count`.
- [ ] Success response naming the resolved target (`viewId`, canonical `file`).
- [ ] Delivery as a `CANVAS_COMMAND_EVENT` SSE event carrying the resolved `viewId`, so
      exactly one view acts on it and every other subscriber discards it cheaply.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] Resolution rule holds for zero, one and many matching views, including the two-views-one-
      file case and the two-files-one-workspace case, with and without a `file` selector.
- [ ] Registering the same file under different path spellings yields one registry identity.
- [ ] After lease expiry with no heartbeat, commands return `no-canvas` rather than resolving
      to the dead view.
- [ ] Every failure body carries a `code` from the closed union with the specified HTTP status.
- [ ] The route never dereferences `workspace` or `file` as filesystem paths beyond
      canonicalization; they are registry lookup keys.
- [ ] Existing Tower route tests pass; `pnpm --filter @cluesmith/codev test` passes.

#### Test Plan

Unit tests over the registry and resolver: lease expiry driven by injected/faked time rather
than real waiting, MRU ordering including the tie-break, path-spelling canonicalization,
and each validation rejection with its status and code. An e2e test boots a real Tower via
the existing harness, registers two views over HTTP, opens a live `/api/events` stream, POSTs
commands, and asserts both the HTTP answer and that exactly one addressed event is emitted
carrying the expected `viewId`. The no-canvas case asserts a 404 with no event emitted.

### Phase 4: sdk canvas command and view registration calls

**Dependencies**: Phase 1

#### Objective

Expose the route to clients: the controller-facing command call on the approved subpath, and
the host-facing registration calls that Phase 5 needs, without widening the controller surface
beyond what the streamdeck architect reviewed.

#### Files to Create / Modify

- `packages/sdk/src/tower-client.ts` (new methods)
- `packages/sdk/src/controller.ts` (re-export `sendCanvasCommand` and its result types only)
- `packages/sdk/src/__tests__/tower-client-canvas.test.ts` (new)

#### Deliverables

- [ ] `sendCanvasCommand(command, target, options?)` returning the typed
      `CanvasCommandResult`, with the machine-readable `code` preserved on failure. The shared
      `request()` helper normalizes non-2xx responses and discards body-level codes today, so
      this call must read the parsed error body rather than inheriting that flattening; the
      observable contract is the typed result, and the implementation bends to it.
- [ ] Host-facing `registerCanvasView`, `heartbeatCanvasView`, `unregisterCanvasView` on
      `TowerClient`, deliberately **not** re-exported through `controller.ts`: controllers
      drive views, hosts register them, and the controller surface stays exactly what was
      approved.
- [ ] Route path string literals re-declared in the sdk rather than imported as runtime values
      from `codev-types`, matching the existing `COMMAND_ROUTE` precedent.
- [ ] Result and error-code types re-exported as `export type` from the controller subpath so
      integrations need no direct `codev-types` dependency.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] Success, `no-canvas` and `invalid-request` responses each produce the correct typed
      result, with `code` reaching the caller rather than only a prose string.
- [ ] Transport failures (timeout, connection refused) surface distinguishably from a
      resolved `no-canvas`, so a controller does not report "no canvas open" when Tower is
      simply unreachable.
- [ ] `packages/sdk/src/__tests__/import-boundary.test.ts` passes unchanged: no `node:*`, no
      direct `fetch`, no runtime import from `codev-types`, zero new runtime dependencies.
- [ ] `apps/streamdeck/src/__tests__/import-boundary.test.ts` passes unchanged.
- [ ] `pnpm --filter @cluesmith/codev-sdk test` and `check-types` pass.

#### Test Plan

Unit tests with an injected `fetchFn` (the established pattern in `tower-client.test.ts`):
one case per response shape including a malformed body, one asserting the request payload
carries `count` only when supplied, and transport-failure cases. Registration calls get the
same treatment. The two boundary suites act as the architectural regression tests.

### Phase 5: VS Code host wiring and end-to-end review loop

**Dependencies**: Phase 2, Phase 3, Phase 4

#### Objective

Connect the two ends so a human can actually drive a review remotely: the extension registers
its canvas panels, reports activity, receives addressed commands, and forwards them into the
webview's `CommandAdapter`.

#### Files to Create / Modify

- `apps/vscode/src/markdown-preview/canvas-view-registry.ts` (new; register, heartbeat,
  unregister, and command forwarding per panel)
- `apps/vscode/src/markdown-preview/preview-provider.ts` (register on
  `resolveCustomTextEditor`, unregister on dispose, report activity on view-state change)
- `apps/vscode/src/markdown-preview/messages.ts` (host-to-webview `command` message)
- `apps/vscode/src/markdown-preview/webview/main.ts` (implement `CommandAdapter`, pass it to
  `ArtifactCanvas`)
- `apps/vscode/src/__tests__/canvas-view-registry.test.ts` (new)

#### Deliverables

- [ ] One registration per canvas panel, carrying the panel's real document path, unregistered
      on panel dispose and on extension deactivate.
- [ ] Activity reported on `onDidChangeViewState` so the panel the reviewer is looking at wins
      MRU, plus the heartbeat that keeps the lease alive.
- [ ] Subscription to the addressed SSE event on the extension's existing SSE client, filtered
      by the panel's own `viewId`, forwarded to that panel's webview via `postMessage`.
- [ ] Webview-side `CommandAdapter` implementation feeding the canvas, following the existing
      `update` message-handling pattern.
- [ ] The host never pulls window focus in response to a delivered command, matching the
      existing command relay's stated posture.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] Opening a canvas panel registers exactly one view; closing it unregisters, and once the
      last panel closes the next command returns `no-canvas`.
- [ ] Two panels on the same document register two views, and the most recently activated one
      receives the command.
- [ ] Real-path verification (this is the phase where "tests pass" is not "it works"): with a
      spec open in the canvas, commands issued through the sdk move focus, page columns, and
      drive the composer; a remote `composer-open`, keyboard-typed body, and remote
      `composer-submit` write exactly one marker through the existing `MarkerAdapter` path.
      The transcript of this manual pass goes in the review document.
- [ ] Existing VS Code extension tests pass; `pnpm --filter <vscode package> test` and
      `check-types` pass.

#### Test Plan

Unit tests over the registry glue with a faked Tower client: registration and unregistration
lifecycle, viewId filtering (a command for another panel is ignored), and the no-focus-stealing
rule. The end-to-end verification is manual against a running Tower and a real VS Code window,
because the value being verified is a human review loop across three processes; its steps and
outcome are recorded in `codev/reviews/1401-artifact-canvas-remote-command.md`.

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| The Phase 2 extraction silently changes keyboard behavior | Medium | High: breaks a shipped review flow | Pure extraction with the pre-existing keyboard suite left unedited as the regression oracle; behavior changes and extraction never share a commit |
| Adding `@cluesmith/codev-types` to the canvas package leaks a runtime import and breaks the package's host-agnostic posture | Low | Medium | Type-only import enforced by an extended import-boundary test, mirroring the sdk's rule; fallback if the architect prefers no new dependency is a canvas-local union plus a drift test, at the cost of two definitions |
| Registry staleness leaves a ghost view after a hard host kill | Medium | Medium: commands resolve and silently do nothing | Lease expiry bounds the window; unregister on both panel dispose and extension deactivate covers every graceful path; Phase 3 tests the expiry path explicitly |
| The sdk `request()` normalization swallows the error code | Medium | Medium: the deck cannot distinguish no-canvas from a generic failure | Called out as a Phase 4 deliverable with its own test cases, including transport failure versus resolved `no-canvas` |
| SSE fan-out means every subscriber sees every canvas command | High (by design) | Low | Events carry the resolved `viewId`; non-target subscribers discard on a cheap comparison, the same filtering posture the existing command relay uses |
| Two act-paths on the deck (`sendCommand` to open, `sendCanvasCommand` to drive) confuse future contributors | Medium | Low | The distinction is documented at both call sites and in the arch integration-points note; the generic-relay question is recorded as closed in the spec |

## Documentation Updates

- `codev/resources/arch.md`: the Tower canvas view registry belongs under **Agent Farm
  Internals** (a new Tower-side registry with lease semantics) and the controller-to-canvas
  path under **Integration Points**, alongside the existing command relay so the two act-paths
  are described together rather than discovered separately.
- Hot-tier routing: no `arch-critical.md` entry is proposed. The hot file is at its cap, and
  this feature does not change a system-shape invariant a contributor must consult before
  deciding. If the architect judges otherwise at review time, it would displace a weaker fact
  rather than grow the file.
- No README changes: neither `packages/artifact-canvas` nor `packages/types` ships one.
- VS Code changelog and release notes are accumulated on the architect's changelog branch per
  repo convention, not in this PR.
