---
approved: 2026-08-11
validated: [gemini, codex, claude]
---

# Plan: Artifact-Canvas Remote Command Channel (Tower relay + sdk route)

**Specification**: [codev/specs/1401-artifact-canvas-remote-command.md](../specs/1401-artifact-canvas-remote-command.md)

## Executive Summary

Implements the spec's recommended Approach 2: a Tower-side registry of live canvas views
plus a targeted command route, delivery as an addressed event over the existing SSE channel,
a `CommandAdapter` seam in the canvas package, and a `sendCanvasCommand` call on the sdk
controller subpath.

The work is sequenced contracts-first, then outward in dependency order. Phases 3, 4 and 5
depend only on Phase 1, so each is independently verifiable without the others; only Phase 6
requires the full stack. The canvas work is split in two because it contains two genuinely
different kinds of change: Phase 2 is a pure extraction whose regression oracle is the
untouched existing test suite, and Phase 3 newly authors the four commands that have no
handler to extract. Keeping them in separate commits is what makes the extraction's "no
behavior change" claim checkable.

Three decisions the spec deferred to this plan are settled here.

**Where the vocabulary lives.** `packages/artifact-canvas` has no dependency on
`@cluesmith/codev-types` today (its only deps are `dompurify` and `markdown-it`). The command
union is a genuine wire contract: it travels in the POST body and the SSE event, and both
Tower and the sdk need it while neither may depend on a React package. So `codev-types` owns
it, and the canvas package gains `@cluesmith/codev-types` as a type-only dependency, matching
the sdk's existing arrangement (a real `dependencies` entry so published `.d.ts` resolve,
with every import in the fully-erased `import type` form). The canvas package's existing
import-boundary guard forbids `vscode`, `node:*`, bare `fs` and `fetch`, none of which this
touches; Phase 2 extends that guard to pin the import as type-only.

**The classification is type-level, not runtime.** An earlier draft made the traversal
command list a runtime array in `codev-types` shared by both validators. Neither consumer can
import it: `packages/codev` treats `codev-types` as a compile-time-only dependency and runs
unbundled from `dist/`, so a runtime value import does not resolve (`command-relay.ts`
documents this and re-declares its route constants for exactly that reason), and the canvas
import is type-only by the rule above. The classification is therefore a type, and each
consumer declares its own `const` list bound to it with `satisfies`, which turns drift into a
compile error instead of a shared-import that cannot exist.

**Registration transport.** Hosts register views over dedicated HTTP calls with a heartbeat
lease, not by binding registrations to the host's SSE connection lifetime. The deciding case
is VS Code: one extension host holds a single SSE connection for the whole window, but that
window can host several canvas panels, so a connection-scoped registration cannot distinguish
panels and closing one panel would not drop one registration. Per-view HTTP registration
gives each panel its own identity and its own unregister, with the lease bounding staleness
when a host dies without cleaning up.

### A ground-truth note on the spec's split-editor example

The spec's multi-view criterion cites "two views open on the same file (e.g. split editor)".
Verified against the code: `extension.ts` registers the canvas custom editor with
`supportsMultipleEditorsPerDocument: false`, so VS Code cannot open two canvas panels for one
document. The MRU rule itself is unaffected and still load-bearing, for two views on
different files in one workspace (the file-less selector case), for two views of one file
across different hosts once #1386 lands, and as registry-level defensive behavior. What
changes is only where that case is verified: at the Tower registry in Phase 4, which
registers views over HTTP directly and can trivially create two views of one file, rather
than by a manual split-editor pass in VS Code. Flipping the VS Code flag is deliberately not
proposed: it would change user-visible editor behavior well outside this issue's scope.

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "phase_1", "title": "Command vocabulary wire contracts"},
    {"id": "phase_2", "title": "Canvas action registry extraction"},
    {"id": "phase_3", "title": "Canvas remote command seam"},
    {"id": "phase_4", "title": "Tower canvas view registry and command route"},
    {"id": "phase_5", "title": "sdk canvas command and view registration calls"},
    {"id": "phase_6", "title": "VS Code host wiring and end-to-end review loop"}
  ]
}
```

## Phase Breakdown

### Phase 1: Command vocabulary wire contracts

**Dependencies**: None

#### Objective

Define the command vocabulary, error codes, request/result shapes and protocol names once, in
the package every other participant may depend on. This is the contract that keeps four
packages in lockstep.

#### Files to Create / Modify

- `packages/types/src/canvas-command.ts` (new)
- `packages/types/src/index.ts` (export the new module)
- `packages/types/type-tests/canvas-command.type-test.ts` (new, outside `src/`)
- `packages/types/tsconfig.type-tests.json` (new) and a `check-types:tests` script in
  `packages/types/package.json`

#### Deliverables

- [ ] `CanvasCommand`: closed union of the 14 canonical commands from the spec's table.
- [ ] `TraversalCommand`: a **type-level** classification
      (`Extract<CanvasCommand, 'block-next' | ...>`) covering the eight traversal/paging
      commands, plus its complement. Types-only for the reason given in the summary; each
      consumer declares its own `satisfies`-bound `const` list.
- [ ] `CanvasCommandErrorCode`: the closed **wire** union `'no-canvas' | 'invalid-request'`,
      i.e. exactly the answers Tower gives.
- [ ] `CanvasCommandClientErrorCode`: `CanvasCommandErrorCode | 'unreachable'`, the sdk-visible
      union, with `unreachable` documented at its declaration as client-synthesized and never
      sent by Tower. Two separate types rather than one, so Tower cannot type a response it
      must never send.
- [ ] `CanvasCommandRequest { workspace, file?, command, count? }`, `CanvasCommandResult`
      (the wire result: success carries `target: { viewId, file }`, failure carries a wire
      `code` and `error`), and `CanvasCommandClientResult` (the sdk-visible result, identical
      but widened to the client error union).
- [ ] View-registry wire shapes: registration request/result (`viewId` minted by Tower),
      heartbeat body (`{ focused?: boolean }`), and the registered-view shape.
- [ ] `CanvasCommandEvent`: the addressed SSE event payload as an explicit wire shape
      (resolved `viewId`, `command`, `count`), so the host validates a typed contract at
      runtime rather than trusting an ad-hoc object.
- [ ] Protocol names `CANVAS_COMMAND_ROUTE`, `CANVAS_VIEWS_ROUTE`, `CANVAS_COMMAND_EVENT`
      declared here as the canonical contract, following the `COMMAND_ROUTE`/`COMMAND_EVENT`
      precedent in `command.ts`. Both Tower and the sdk re-declare these literals locally
      (Tower because it cannot resolve a runtime import, the sdk because of its type-only
      boundary rule); `codev-types` remains the single place the contract is documented.
- [ ] Compile-time exhaustiveness guard, living **outside** `src/`: `packages/types` compiles
      `src/**/*` into `dist/` and publishes both `src` and `dist`, so a guard under `src/`
      would ship to consumers. It gets its own tsconfig and check script rather than an
      `exclude`, which would silently drop it from the check it exists to perform.

#### Acceptance Criteria

- [ ] `pnpm --filter @cluesmith/codev-types check-types` and the new `check-types:tests` both
      pass, and the guard fails to compile when a command is deliberately left unclassified
      (verified once by hand during development).
- [ ] The guard file is absent from `dist/` after a build.
- [ ] Repo-wide `check-types` still passes: nothing else has changed behavior.
- [ ] No implementation or policy lands here, only wire shapes and type-level classification.

#### Test Plan

`@cluesmith/codev-types` ships no test runner (its scripts are `build` and `check-types`
only), so verification is compile-time: the exhaustiveness guard under its own tsconfig,
`check-types` across the package and its dependents, and an inspection of `dist/` after a
build. Runtime behavior of each consumer's `satisfies`-bound list is covered where it is
consumed, in Phases 3 and 4.

### Phase 2: Canvas action registry extraction

**Dependencies**: Phase 1

#### Objective

Converge the canvas's existing keyboard actions onto one named implementation each, so a
later remote path cannot drift from the keyboard path. Pure refactor: no new capability, no
behavior change, and the untouched existing test suite is the oracle that proves it.

#### Files to Create / Modify

- `packages/artifact-canvas/src/components/ArtifactCanvas.tsx` (extract the action registry)

#### Deliverables

- [ ] The six actions already implemented inside `onBodyKeyDown` (`comment-next/prev`,
      `heading-next/prev`, `doc-start/end`, `composer-open`) move into named per-action
      functions in one registry keyed by command name, with the key handlers calling into it.
- [ ] Column paging (`column-forward/back`) likewise, noting it is container-level and
      geometry-dependent: it consults `measureColumnGeometry`, yields to
      `innerScrollerCanConsume`, and cancels an in-flight wheel glide, which is why it sits
      before the `[data-line]` guard. Extracting it is real work rather than a move.
- [ ] No change to key bindings, guards, edge behavior, or the composer.

#### Acceptance Criteria

- [ ] The pre-existing canvas keyboard tests pass **completely unmodified**. Any need to edit
      them means the extraction changed behavior and must be reworked.
- [ ] `pnpm --filter @cluesmith/codev-artifact-canvas test` and `check-types` pass.
- [ ] Diff review confirms the phase adds no new capability: every moved branch is
      traceable to its original.

#### Test Plan

The existing vitest suite for jump keys, composer-open, focus restoration and horizontal
paging, run unedited. The package's Playwright harness
(`pnpm --filter @cluesmith/codev-artifact-canvas test:browser`) covers the column-paging
geometry that jsdom cannot assert honestly.

### Phase 3: Canvas remote command seam

**Dependencies**: Phase 2

#### Objective

Make the canvas remotely drivable by any host, completing the vocabulary with the four
commands that have no handler to extract. Delivers standalone value: the package gains the
seam whether or not Tower ever calls it.

#### Files to Create / Modify

- `packages/artifact-canvas/src/adapters/CommandAdapter.ts` (new)
- `packages/artifact-canvas/src/components/ArtifactCanvas.tsx` (cursor, new actions, adapter
  subscription)
- `packages/artifact-canvas/src/overlays/CommentComposer.tsx` (submit/cancel seam)
- `packages/artifact-canvas/src/overlays/ReadingModeToggle.tsx` (shared toggle action)
- `packages/artifact-canvas/src/types.ts` (`commandAdapter?` on `ArtifactCanvasProps`)
- `packages/artifact-canvas/src/index.ts` (export the adapter type)
- `packages/artifact-canvas/package.json` (add `@cluesmith/codev-types` dependency)
- `packages/artifact-canvas/src/__tests__/import-boundary.test.ts` (pin the import as
  type-only)
- `packages/artifact-canvas/src/__tests__/remote-commands.test.tsx` (new)

#### Deliverables

- [ ] `block-next` / `block-prev`: newly authored, since block traversal today is native Tab
      over blocks stamped `tabindex="0"` and no handler exists. Implemented as flow-order
      stepping over `[data-line]` blocks per the spec, explicitly not Tab parity, and without
      intercepting Tab (which would break the in-page non-goal).
- [ ] `reading-mode-toggle`: the toggle becomes a shared function that both the toolbar
      button and the registry call.
- [ ] `composer-submit` / `composer-cancel`: submission state and the `⌘/Ctrl+Enter` and
      `Escape` handlers live inside `CommentComposer.tsx`, not the parent, so the composer
      gains an imperative seam (a ref handle or equivalent) letting the registry invoke submit
      and cancel directly, view-scoped rather than focus-scoped, with no simulated DOM click.
- [ ] Current-block cursor: the most recently focused block, falling back to the topmost
      visible block when nothing has been focused yet. This is **deliberately separate** state
      from the existing `activeLine`/`activeLineRef`, which is hover-driven and cleared on
      mouseleave because it positions the "+" affordance. The cursor is focus-derived and
      persistent; both are documented at their declarations as the affordance target versus
      the navigation origin, so the second "where am I" is named rather than accidental.
- [ ] `CommandAdapter` interface (host-implemented, interface-only, matching the D-series
      adapter convention) and an optional `commandAdapter` prop; omitting it leaves behavior
      identical to today.
- [ ] Adapter dispatch honouring `count` for traversal commands (N steps, edge-clamped, no
      wrap), using a canvas-local `const` list bound to `TraversalCommand` via `satisfies`.
- [ ] Navigation focuses its target through the same focus path the keyboard uses (visible
      ring, scroll into view); the package never reaches outside the canvas document.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] All 14 commands, driven through a test `CommandAdapter`, produce the effect defined in
      the spec's command table.
- [ ] On a freshly mounted, never-focused canvas, every navigation command has an observable
      effect, starting from the topmost visible block.
- [ ] `count` multiplies the eight traversal commands. On the other six the canvas **ignores**
      it rather than rejecting: Tower is the validator per the spec, and a command reaching
      the canvas has already passed validation. Rejection is Phase 4's job and is tested there.
- [ ] `composer-submit` works with DOM focus parked outside the composer.
- [ ] Existing canvas keyboard tests still pass unmodified.
- [ ] Import-boundary test passes, including the new type-only rule.
- [ ] `pnpm --filter @cluesmith/codev-artifact-canvas test` and `check-types` pass.

#### Test Plan

Vitest: one case per command driven through the adapter; the clean-state origin cases; `count`
including edge clamping; composer submit and cancel with focus deliberately elsewhere; the
no-adapter case asserting unchanged behavior; and a case asserting Tab still reaches non-block
focusables (the non-goal guard). Real-DOM assertions (scroll-into-view, column geometry) go to
the Playwright harness.

### Phase 4: Tower canvas view registry and command route

**Dependencies**: Phase 1

#### Objective

Give Tower an authoritative picture of which canvas views are live, and a command route that
resolves a target by the spec's rule and answers explicitly. This is the phase that satisfies
Requirement 4, and it is verifiable end to end without any canvas existing.

#### Files to Create / Modify

- `packages/codev/src/agent-farm/servers/canvas-relay.ts` (new; self-routing module modeled on
  `command-relay.ts`)
- `packages/codev/src/agent-farm/servers/tower-routes.ts` (dispatch the new route family)
- `packages/codev/src/agent-farm/__tests__/canvas-relay.test.ts` (new)
- `packages/codev/src/agent-farm/__tests__/canvas-relay.e2e.test.ts` (new, using
  `helpers/tower-test-utils.ts`)

#### Deliverables

- [ ] View registry: register (Tower mints an opaque `viewId`), heartbeat with optional
      `focused` flag, unregister, and lease expiry. Heartbeat cadence and lease TTL are named
      constants, the lease sized to tolerate a few missed heartbeats.
- [ ] Route and event name literals re-declared locally with a comment pointing at
      `codev-types` as the canonical contract, exactly as `command-relay.ts` does and for the
      same unbundled-runtime reason.
- [ ] Tower-side path canonicalization on both registration and command, reusing the
      resolution the existing file-tab dedupe applies. This canonicalizes the **file identity
      used for matching**; two panels showing the same canonical file remain two distinct
      registered views with distinct `viewId`s.
- [ ] Tower-stamped `lastActiveAt`: set on registration, advanced on a `focused` heartbeat and
      on command delivery. Host clocks are never trusted.
- [ ] Target resolution: filter by workspace and, when given, file; zero matches answer
      `no-canvas` with HTTP 404; one match delivers; multiple matches deliver to the single
      most recently active view, tie-broken by most recent registration. Never a broadcast to
      several matches.
- [ ] Validation against the closed `CanvasCommand` union and a locally declared,
      `satisfies`-bound traversal list, answering `invalid-request` with HTTP 400 for an
      unknown command, a malformed selector, `count` on a non-traversal command, or a
      non-positive or non-integer `count`.
- [ ] Success response naming the resolved target (`viewId`, canonical `file`).
- [ ] Delivery as a `CANVAS_COMMAND_EVENT` SSE event carrying the resolved `viewId`, so
      exactly one view acts and every other subscriber discards it on a cheap comparison.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] Resolution holds for zero, one and many matching views, including two views of one file
      (registered directly over HTTP, per the ground-truth note above) and two files in one
      workspace, with and without a `file` selector.
- [ ] Two registrations of the same file under different path spellings match the same
      selector, while remaining two distinct views with distinct `viewId`s.
- [ ] After lease expiry with no heartbeat, commands return `no-canvas` rather than resolving
      to the dead view.
- [ ] Every failure body carries a `code` from the closed union with the specified HTTP status.
- [ ] The route never dereferences `workspace` or `file` as filesystem paths beyond
      canonicalization; they are registry lookup keys.
- [ ] Existing Tower route tests pass; `pnpm --filter @cluesmith/codev test` passes.

#### Test Plan

Unit tests over the registry and resolver: lease expiry driven by injected or faked time
rather than real waiting, MRU ordering including the tie-break, path-spelling
canonicalization, distinct-viewId-per-view, and each validation rejection with its status and
code. An e2e test boots a real Tower via the existing harness, registers two views over HTTP,
opens a live `/api/events` stream, POSTs commands, and asserts both the HTTP answer and that
exactly one addressed event is emitted carrying the expected `viewId`. The no-canvas case
asserts a 404 with no event emitted.

### Phase 5: sdk canvas command and view registration calls

**Dependencies**: Phase 1

#### Objective

Expose the route to clients: the controller-facing command call on the approved subpath, and
the host-facing registration calls Phase 6 needs, without widening the controller surface
beyond what the streamdeck architect reviewed.

#### Files to Create / Modify

- `packages/sdk/src/tower-client.ts` (new methods)
- `packages/sdk/src/controller.ts` (re-export `sendCanvasCommand` and its result types only)
- `packages/sdk/src/__tests__/tower-client-canvas.test.ts` (new)

#### Deliverables

- [ ] `sendCanvasCommand(command, target, options?)` returning the typed
      `CanvasCommandClientResult`, with the machine-readable `code` preserved on failure. The
      shared `request()` helper returns only a flattened `error` string on non-2xx
      (`tower-client.ts:276-280` runs the body through `extractTowerError`), so this call
      parses the response body itself to recover the wire `code`.
- [ ] **The call never rejects** (streamdeck stakeholder verdict, 2026-08-11; an earlier
      builder proposal to reject on transport failure was rejected). `TowerClient.request()`
      catches every transport error and returns `{ok:false, status:0}`
      (`tower-client.ts:288-296`), a never-reject invariant the whole client holds, and this
      call is not its sole exception.
- [ ] Transport failures map to the client-synthesized `code: 'unreachable'`, keyed off the
      existing `status: 0` signal from `request()`. Tower never sends this code, and the wire
      union cannot express it.
- [ ] Host-facing `registerCanvasView`, `heartbeatCanvasView`, `unregisterCanvasView` on
      `TowerClient`, deliberately **not** re-exported through `controller.ts`: controllers
      drive views, hosts register them, so the controller surface stays exactly as approved.
- [ ] Route path literals re-declared in the sdk rather than imported as runtime values,
      matching the existing `COMMAND_ROUTE` precedent.
- [ ] Result and error-code types re-exported as `export type` from the controller subpath so
      integrations need no direct `codev-types` dependency.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] Success, `no-canvas` and `invalid-request` responses each produce the correct typed
      result, with `code` reaching the caller rather than only a prose string.
- [ ] Transport failure and malformed-response cases resolve (never reject) with
      `code: 'unreachable'`, so a caller distinguishes them from a Tower-answered `no-canvas`
      without parsing prose.
- [ ] No call path in the new methods can reject: asserted by a test that drives a throwing
      `fetchFn`.
- [ ] `packages/sdk/src/__tests__/import-boundary.test.ts` passes unchanged: no `node:*`, no
      direct `fetch`, no runtime import from `codev-types`, zero new runtime dependencies.
- [ ] `apps/streamdeck/src/__tests__/import-boundary.test.ts` passes unchanged.
- [ ] `pnpm --filter @cluesmith/codev-sdk test` and `check-types` pass.

#### Test Plan

Unit tests with an injected `fetchFn` (the established pattern in `tower-client.test.ts`): one
case per response shape including a malformed body, one asserting the request payload carries
`count` only when supplied, and transport-failure cases asserting a resolved `unreachable`
rather than a rejection. Registration calls get the same treatment. The two boundary suites are
the architectural regression tests.

### Phase 6: VS Code host wiring and end-to-end review loop

**Dependencies**: Phase 3, Phase 4, Phase 5

#### Objective

Connect the two ends so a human can actually drive a review remotely: the extension registers
its canvas panels, reports activity, receives addressed commands, and forwards them into the
webview's `CommandAdapter`.

#### Files to Create / Modify

- `apps/vscode/src/markdown-preview/canvas-view-registry.ts` (new; per-panel register,
  heartbeat, unregister, and command forwarding)
- `apps/vscode/src/markdown-preview/preview-provider.ts` (register on
  `resolveCustomTextEditor`, unregister on dispose, report activity on view-state change)
- `apps/vscode/src/extension.ts` (the provider is currently constructed as
  `new MarkdownPreviewProvider(extensionUri, overviewCache, globalState)` with no
  `ConnectionManager`, so registration and SSE forwarding need it threaded in)
- `apps/vscode/src/markdown-preview/messages.ts` (host-to-webview `command` message)
- `apps/vscode/src/markdown-preview/webview/main.ts` (implement `CommandAdapter`, pass it to
  `ArtifactCanvas`)
- `apps/vscode/src/__tests__/canvas-view-registry.test.ts` (new)

#### Deliverables

- [ ] One registration per canvas panel carrying the panel's real document path, unregistered
      on panel dispose and on extension deactivate.
- [ ] Activity reported on `onDidChangeViewState` so the panel the reviewer is looking at wins
      MRU, plus the heartbeat that keeps the lease alive.
- [ ] Reconnect handling: after a Tower restart or a dropped connection, open panels
      **re-register** and adopt the new `viewId` rather than heartbeating an id Tower no longer
      knows. A heartbeat rejected as unknown triggers the same re-registration path.
- [ ] Subscription to the addressed SSE event on the extension's existing SSE client,
      validated against the `CanvasCommandEvent` wire shape at runtime, filtered by the panel's
      own `viewId`, and forwarded to that panel's webview via `postMessage`.
- [ ] Webview-side `CommandAdapter` implementation feeding the canvas, following the existing
      `update` message-handling pattern.
- [ ] The host never pulls window focus in response to a delivered command, matching the
      existing command relay's stated posture.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] Opening a canvas panel registers exactly one view; closing it unregisters, and once the
      last panel closes the next command returns `no-canvas`.
- [ ] Two panels on different documents register two views, and the most recently activated
      one receives a file-less command. (Two panels on the *same* document is not reachable in
      VS Code, per the ground-truth note; that case is covered at the Tower layer in Phase 4.)
- [ ] Killing and restarting Tower leaves open panels drivable again once reconnected, without
      a manual reload.
- [ ] Real-path verification, and this is the phase where "tests pass" is not "it works": with
      a spec open in the canvas, commands issued through the sdk move focus, page columns, and
      drive the composer; a remote `composer-open`, keyboard-typed body, and remote
      `composer-submit` write exactly one marker. Note the write path precisely: the webview's
      `MarkerAdapter.add` is a documented no-op, so the write travels
      canvas `onAddComment` intent → `postMessage` → extension host → host-side write-back.
      A builder looking for the write inside the webview will not find it.
      The transcript of this pass goes in the review document.
- [ ] Existing VS Code extension tests pass; `check-types` passes.

#### Test Plan

Unit tests over the registry glue with a faked Tower client: registration and unregistration
lifecycle, viewId filtering (a command for another panel is ignored), re-registration after a
simulated reconnect and after an unknown-view heartbeat, and the no-focus-stealing rule.

Note a real coverage gap and treat it accordingly: `apps/vscode/tsconfig.json` excludes
`src/markdown-preview/webview`, so the webview-side `CommandAdapter` gets **no** `check-types`
coverage and no unit coverage. The manual end-to-end pass is therefore load-bearing evidence
for that file, not a confirmatory formality, and its transcript belongs in
`codev/reviews/1401-artifact-canvas-remote-command.md`.

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| The Phase 2 extraction silently changes keyboard behavior | Medium | High: breaks a shipped review flow | Extraction is its own phase and its own commit, with the pre-existing keyboard suite left unedited as the oracle; new actions land separately in Phase 3 |
| The composer seam (Phase 3) destabilizes submit/delete focus restoration, which #1237 found fiddly | Medium | Medium | Drive submit and cancel through the composer's existing internal paths rather than reimplementing them; the existing focus-restoration tests stay unmodified |
| Adding `@cluesmith/codev-types` to the canvas package leaks a runtime import | Low | Medium: breaks the package's host-agnostic posture | Type-only import enforced by an extended import-boundary test, mirroring the sdk rule; fallback is a canvas-local union plus a drift test, at the cost of two definitions |
| Registry staleness leaves a ghost view after a hard host kill | Medium | Medium: commands resolve and silently do nothing | Lease expiry bounds the window; unregister on panel dispose and on deactivate covers graceful paths; Phase 4 tests expiry explicitly |
| Tower restart strands open panels holding dead `viewId`s | Medium | Medium: canvas silently stops responding | Explicit re-registration on reconnect and on unknown-view heartbeat, with a Phase 6 test |
| The sdk `request()` normalization swallows the error code | Medium | Medium: the deck cannot distinguish no-canvas from a generic failure | Phase 5 parses the response body for the wire `code` and synthesizes `unreachable` from `status: 0`, with a test per case and a throwing-`fetchFn` test pinning the never-reject invariant |
| Webview code is outside the extension typecheck | High (pre-existing) | Medium: a broken adapter compiles | Called out in the Phase 6 test plan; the manual pass is treated as load-bearing evidence rather than a formality |
| Two act-paths on the deck (`sendCommand` to open a canvas, `sendCanvasCommand` to drive it) confuse future contributors | Medium | Low | Documented at both call sites and in the arch integration-points note; the generic-relay question is recorded as closed in the spec |

## Documentation Updates

- `codev/resources/arch.md`: the Tower canvas view registry belongs under **Agent Farm
  Internals** (a new Tower-side registry with lease semantics) and the controller-to-canvas
  path under **Integration Points**, described alongside the existing command relay so the two
  act-paths are found together rather than separately.
- Hot-tier routing: no `arch-critical.md` entry is proposed. The hot file is at its cap and
  this feature does not change a system-shape invariant a contributor must consult before
  deciding. If the architect judges otherwise at review time, it displaces a weaker fact
  rather than growing the file.
- No README changes: neither `packages/artifact-canvas` nor `packages/types` ships one.
- VS Code changelog and release notes are accumulated on the architect's changelog branch per
  repo convention, not in this PR.
