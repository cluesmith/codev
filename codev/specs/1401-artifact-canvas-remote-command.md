---
approved: 2026-08-11
validated: [gemini, codex, claude]
---

# Specification: Artifact-Canvas Remote Command Channel (Tower relay + sdk route)

<!--
SPEC vs PLAN BOUNDARY:
This spec defines WHAT and WHY. The plan defines HOW and WHEN.
-->

> **Revision note (2026-08-11, post-approval, authorized by the architect and the streamdeck
> stakeholder).** Two corrections, neither changing a requirement:
>
> 1. The multi-view example was corrected from "split editor" to an accurate one, since
>    `supportsMultipleEditorsPerDocument: false` means VS Code cannot open two canvas panels
>    for one document. The MRU requirement is unchanged; only the illustrative example and the
>    verification venue moved.
> 2. The sdk-visible error union gained a third member, `unreachable`, and the call is
>    explicitly non-throwing. The **wire** union Tower answers with is still exactly
>    `'no-canvas' | 'invalid-request'`; `unreachable` is client-synthesized. This resolves a
>    builder proposal (reject on transport failure) that the streamdeck stakeholder rejected,
>    because `TowerClient` holds a never-reject invariant that this call must not break.

## Problem Statement

The artifact canvas has a complete keyboard-first review vocabulary (#1237 / PR #1344,
#1380 / PR #1398): step between blocks, jump between commented blocks and headings, go to
document start/end, page columns in horizontal mode, open the comment composer on the focused
block, submit or cancel it, and toggle reading mode. All of it is reachable only from the
keyboard focused on the canvas itself.

Nothing outside the page can drive that vocabulary. A remote controller — the Stream Deck
(#1400), a test harness, an agent, or any future driver — has no way to tell an open canvas
"next commented block" or "open the composer here". Issue #1400 (deck review-navigation
actions) is blocked on exactly this bridge, and per the sequencing agreement it lands first,
deck-free, so any remote driver of the viewer gets it for free.

Affected parties: reviewers who want hardware-assisted review flow (#1400), the streamdeck
architect as consumer and controller-surface stakeholder, and any future automation that wants
to steer a review session.

## Current State

Ground truth (verified in-repo, 2026-08-11), including one correction to the issue's premise:

- **The keyboard vocabulary exists but has no names.** Canvas keyboard handling is two inline
  `e.key` handlers — `onBodyKeyDown` in
  `packages/artifact-canvas/src/components/ArtifactCanvas.tsx` (navigation, composer-open,
  help) and the composer's own `onKeyDown` in `src/overlays/CommentComposer.tsx`
  (submit/cancel). There is no action enum, no dispatch table, no action-name strings; the
  only place actions are named is the `?` help legend's display labels. "Focus next/previous
  block" is not even a handler — it is native Tab/Shift+Tab over blocks stamped
  `tabindex="0"` at render time. "Toggle reading mode" has no key at all; it is a toolbar
  button (`ReadingModeToggle.tsx`).
- **The canvas page holds no network channel.** The package's only production host is the
  VS Code webview (`apps/vscode/src/markdown-preview/`), fed by extension-side
  `postMessage({type:'update', …})`; `FileAdapter.watch` is a no-op there and refresh rides
  the `refreshKey` prop. The Tower-served `afx open` page is **not** the canvas today — it is
  the bespoke `templates/open.html` annotator (vendored `marked`, 1-second mtime polling).
  Migrating it onto the canvas is separately tracked as #1386. So "the live-update channel
  the page already holds" is, concretely: the webview's postMessage channel to the extension
  host, which in turn holds an SSE connection to Tower (`apps/vscode/src/sse-client.ts`).
- **Tower's push channel is broadcast-only SSE with no page identity.** `GET /api/events`
  fans every event to every client; the client registry is a flat array keyed by random id —
  no workspace, file, or page type per connection. Addressing is done client-side by
  filtering (e.g. the VS Code command relay drops events for other workspaces and requires
  window focus).
- **A generic remote-command relay already exists end-to-end.** `POST /api/command`
  (`CommandRequest {verb, args?, workspace?}` in `packages/types/src/command.ts`) →
  Tower broadcasts an SSE `command` event → `apps/vscode/src/command-relay.ts` filters by
  workspace + window focus and executes via a verb→VS Code-command allowlist
  (`view-diff`, `diff-next-hunk`, `scroll`, …). It is fire-and-forget: Tower answers
  `{ok:true}` whether or not any provider exists, and its own header comment flags provider
  addressing as a deliberate later addition.
- **The sdk side.** `TowerClient` (`packages/sdk/src/tower-client.ts`) has one method per
  Tower call, all through a common `request()` with injected fetch/auth. The curated
  controller surface is the `@cluesmith/codev-sdk/controller` subpath (`src/controller.ts`),
  owned in review terms by the streamdeck architect (#1189 arrangement); the deck calls
  `sendCommand(verb, args, workspace)` today. Hard constraints: sdk is environment-agnostic,
  zero runtime deps, imports only `codev-types` as fully-erased `import type` — CI boundary
  tests enforce all of this on both sides.
- **Tower already knows which files are open as tabs** (`fileTabs`, deduped one tab per
  path per workspace) but has no notion of which pages are *live* or focused.

The pain: driving the review vocabulary remotely is impossible; the one existing relay can
neither name a target view nor report that no target exists.

## Desired State

A generic, host-agnostic command bridge with three parts:

### 1. Canvas command entry point (the package seam)

The canvas package accepts remote commands through a new adapter interface alongside
File/Marker/Theme — host-implemented, interface-only in the package, following the
established D-series pattern:

```ts
/** Delivers remote review-navigation commands into the canvas. */
export interface CommandAdapter {
  /** Subscribe to inbound commands. Returns a Disposable synchronously. */
  subscribe(
    onCommand: (invocation: { command: CanvasCommand; count?: number }) => void
  ): Disposable;
}
```

(`count`, default 1, applies to traversal/paging commands only — defined with the Tower
route in §2.)

`CanvasCommand` is a closed union naming the existing keyboard vocabulary — **exactly** the
vocabulary, no parallel one. Canonical command set (14):

| Command | In-page equivalent | Semantics |
|---|---|---|
| `block-next` / `block-prev` | Tab / Shift+Tab (blocks only — see below) | Move the current block to the next/previous `[data-line]` block in flow order |
| `comment-next` / `comment-prev` | `n` / `p` | Move to next/previous commented block |
| `heading-next` / `heading-prev` | `]` / `[` | Move to next/previous heading |
| `doc-start` / `doc-end` | Home / End | Move to first/last block |
| `column-forward` / `column-back` | PageDown / PageUp | Page one column (horizontal mode) |
| `composer-open` | Enter / Space | Open composer on the current block |
| `composer-submit` | ⌘/Ctrl+Enter | Submit the view's open composer |
| `composer-cancel` | Escape | Cancel the view's open composer |
| `reading-mode-toggle` | Reading-mode toolbar button | Toggle vertical/horizontal reading mode |

**Semantics rule — effect parity with a defined remote origin.** A remote command produces
the same *effect on canvas state* as its in-page equivalent, through the same per-action
implementation (predicates, step logic, edge behavior — e.g. no wrap-around at edges, column
paging meaningful only in horizontal mode). Literal event parity is impossible — the in-page
handlers derive their origin from the DOM event (`e.target` → enclosing `[data-line]`
block), and a remote command has no event — so the spec defines the remote origin
explicitly:

- **Current block (the remote origin).** Relative navigation commands and `composer-open`
  operate on the canvas's *current block*: the most recently focused block (whether focused
  by keyboard, pointer, minimap, or a prior remote command). If no block has been focused
  yet, the fallback is the topmost visible block in the viewport; in an unscrolled document
  that is the first block. This makes every navigation command well-defined on a
  freshly-opened, never-touched view — the feature's primary scenario.
- **Remote navigation moves focus.** A navigation command focuses its target block within
  the canvas document via the same focus path the keyboard uses (visible focus ring, scroll
  into view), so a subsequent `composer-open` + keyboard typing continues the flow exactly
  as the in-page loop does. Whether the *hosting surface* (VS Code panel, browser tab)
  acquires input focus is the host's policy, outside the package; hosts must not let a
  delivered command steal focus across unrelated surfaces.
- **Composer commands are view-scoped, not focus-scoped.** `composer-submit` /
  `composer-cancel` act on the target view's open composer regardless of where DOM focus
  sits; with no composer open they are defined no-ops.
- **Two commands have no key to be parity with**, and are defined against their in-page
  equivalents directly: `block-next`/`block-prev` step `[data-line]` blocks in flow order —
  deliberately *not* full native-Tab parity, since Tab also visits affordance buttons,
  comment-card actions, toolbar controls, and links; and `reading-mode-toggle` mirrors the
  toolbar button.

Where the in-page equivalent would do nothing, the command does nothing — that is defined
per-command applicability, not targeting ambiguity (Requirement 4 governs *targeting*, which
is never silent; see §2). Text entry is out of scope: comment bodies are typed on the
keyboard.

Excluded from the set, deliberately: the `?` help legend (in-page discoverability chrome, not
review navigation, and outside the issue's enumerated vocabulary) and card edit/delete
(pointer-driven affordances, likewise outside it).

Internally the package converges both input paths on one implementation: the inline key
handlers and the adapter dispatch to the same per-action logic, so keyboard behavior cannot
drift from remote behavior. In-page keyboard *behavior* does not change (non-goal).

### 2. Tower surface: canvas view registry + command route

Tower gains an authoritative registry of **live canvas views**: each open canvas view is
registered by its host with `{viewId, workspace, file, lastActiveAt}`, kept fresh by the
host (activity updates on focus), and removed on close or liveness expiry (lease/TTL — a
dead host's views age out; exact transport is a plan decision).

A new command endpoint accepts one command for a given target selector:

```
POST → { workspace, file?, command, count? }   (selector: workspace required, file optional)
```

`count` (optional, default 1, positive integer) applies to the eight traversal/paging
commands only (`block-*`, `comment-*`, `heading-*`, `column-*`) and means "apply the step N
times" with the same edge semantics as N single steps (stops at the edge, no wrap). It is
rejected on the absolute and stateful commands (`doc-*`, `composer-*`,
`reading-mode-toggle`) as an invalid request. This is a streamdeck-architect design-review
addition: dials and repeated key presses batch naturally into one command.

Registry semantics, decided here because they are observable behavior:

- **`viewId` is Tower-minted** at registration: an opaque identifier, stable for the life of
  that registration, returned in command results for observability (it is what
  distinguishes two views of the same file). It is not a command selector today; admitting
  it as one is an additive follow-up if a need arises.
- **File paths are canonicalized by Tower** on both registration and command (resolved to
  absolute, same normalization the file-tab dedupe already uses), so path-spelling variance
  cannot split the registry or defeat MRU dedupe.
- **Activity time is Tower-stamped.** `lastActiveAt` is the Tower receipt time of the
  host's activity report (and of command delivery — a driven view stays MRU); host clocks
  are never trusted, so MRU stays deterministic across multiple host processes.

**Target rule (decided here, per Requirement 4 — never a silent ambiguous no-op):**

1. Filter the registry to live views matching the selector (workspace, and file when given).
2. **Zero matches → explicit error**: the route answers with a machine-readable
   `no-canvas` error (the caller can render "no canvas open"). Never `{ok:true}`.
3. **One match → deliver to it.**
4. **Multiple matches → deliver to exactly one: the most recently active view**
   (`lastActiveAt`; tie broken by most recent registration). Never broadcast to all
   matches — `composer-submit` delivered to two views of the same file would double-post a
   comment. MRU matches user intent ("the canvas I'm looking at") and gives the file-less
   deck selector ("drive whatever I'm reviewing in this workspace") a well-defined answer.

The success response names the resolved target (view id, file), so callers can verify what
was driven. Delivery to the resolved view rides the existing SSE events channel as an
addressed event (the target's host filters by its own view id — the established client-side
filter pattern, made unambiguous by carrying the resolved `viewId` in the event). Delivery
after resolution is best-effort (SSE has no ack); the explicit-answer guarantee covers
target resolution.

**Error contract.** Failure codes are a **closed, exported union type in `codev-types`**
(streamdeck design-review decision — not an open string). The **wire** union, i.e. the answers
Tower itself gives, has exactly two members: `'no-canvas' | 'invalid-request'`. `no-canvas`
answers HTTP 404 (selector resolved to zero live views); `invalid-request` answers HTTP 400
(unknown command, malformed selector, or `count` on a non-traversal command). Every failure
body is `{ok:false, code, error}` with `code` from the wire union; extending it is an additive
type change, not a string convention. The sdk-visible union is one member wider, for the
client-synthesized `unreachable` case described in §3.

**Security posture.** The route inherits Tower's existing trust boundary and adds no
authentication of its own.

> **Correction (2026-08-12, PR review).** An earlier draft described that boundary as a
> "host/origin gate". That description overstated the protection actually in place. Tower's
> existing request-trust boundary is weaker than this spec originally claimed; the specifics and
> the fix are tracked privately as a security advisory. The property is pre-existing and
> Tower-wide, not introduced by this channel, and it is handled there rather than patched onto a
> single route. No safeguard is asserted here that does not exist. What this channel adds is one
> more capability behind the existing boundary: a `composer-submit` writes a review comment
> through the host's existing marker path. `workspace` and `file` are registry
lookup keys only: this route never dereferences them as filesystem paths. The command
payload is validated against the closed `CanvasCommand` union before relay. Note the
inherited-boundary consequence explicitly: `composer-submit` is the first relay-triggerable
action that can cause a file write (through the target host's existing marker write path,
with the host's own validation) — the write path itself is unchanged and host-side, but the
trigger is remote. View registration and activity reports carry the same Tower auth as any
other route; `viewId` being Tower-minted means a registrant cannot claim another view's
identity.

Hosts (VS Code extension now; the #1386 Tower-served page when it lands) are responsible for
registering their canvas views, reporting activity, and forwarding delivered commands into
the page's `CommandAdapter`. The bridge is host-agnostic by construction: any surface that
can register a view and receive SSE gets remote drive for free.

### 3. sdk route (streamdeck-architect review section)

> This section is the design-time review surface for the streamdeck architect
> (controller-subpath owner, #1189 arrangement). **Reviewed and APPROVED**
> (issue #1401 comment, 2026-08-11) with the deltas already folded in below: the `count`
> parameter, the closed failure-code union, generic-relay exposure closed as NO, and the
> presence-query non-goal.

A new `TowerClient` method, re-exported through `@cluesmith/codev-sdk/controller`:

```ts
sendCanvasCommand(
  command: CanvasCommand,
  target: { workspace: string; file?: string },
  options?: { count?: number }   // traversal/paging commands only; default 1
): Promise<CanvasCommandClientResult>          // never rejects
// CanvasCommandClientResult: { ok: true, target: { viewId: string, file: string } }
//                          | { ok: false, code: CanvasCommandClientErrorCode, error: string }
// CanvasCommandErrorCode       = 'no-canvas' | 'invalid-request'       (wire; Tower's answers)
// CanvasCommandClientErrorCode = CanvasCommandErrorCode | 'unreachable' (sdk-visible)
```

- Wire types (`CanvasCommand`, `CanvasCommandErrorCode`, request/result shapes, route
  constant) live in `codev-types`; the sdk imports them type-only and re-declares the route
  string literal, matching the existing `COMMAND_ROUTE` pattern. Result types are
  re-exported as `export type` from the controller subpath.
- **The call never rejects**, matching the never-reject invariant the whole `TowerClient`
  holds (its shared `request()` catches every transport error and returns `ok:false` with
  `status: 0`). `sendCanvasCommand` is not an exception to that invariant.
- **`unreachable` is client-synthesized and never sent by Tower.** It is how a caller
  distinguishes "Tower answered: no canvas is open" from "Tower could not be reached", which
  is precisely the confusion a controller must not make. The wire union stays two members so
  Tower cannot even type such a response; the sdk-visible union carries the third.
- No structural `source` discriminator is added (builder's call, streamdeck indifferent). The
  type-level split already does that work: Tower cannot express `unreachable`, the union is
  closed so TS consumers get exhaustiveness checking when it grows, and the transport layer
  already signals the case with `status: 0`. A `source` field would be a third encoding of
  one fact.
- The machine-readable `code` must survive to the caller: the sdk call's observable
  contract is the typed result above, not a flattened error string (the deck renders
  "no canvas open" from `code`, never by parsing prose). How that composes with the shared
  `request()` normalization is plan detail; the contract is fixed here.
- Distinct from `sendCommand` deliberately: the generic verb relay is fire-and-forget
  broadcast; this call is targeted and reports resolution. **Decision (design review,
  closed): the canvas command set is exposed on the targeted route only** — it is *not*
  additionally exposed as `canvas-*` verbs on the generic relay. One path, one semantics.
- **Named non-goal: an sdk-visible presence query** (list/inspect open canvas views). Not
  in scope; if a controller later needs it (e.g. deck key-state display), it is an additive
  read-only route + sdk call over the same registry, with no change to the command
  contract.

## Success Criteria

- [ ] Every one of the 14 canonical commands, delivered remotely to an open canvas view,
      produces the effect defined in the command table — for the 12 with an in-page key,
      the same effect the key produces from the current block; for `block-next`/`block-prev`
      and `reading-mode-toggle`, their defined in-page equivalents (verified per command).
- [ ] The remote origin is well-defined with no prior interaction: on a freshly opened,
      never-focused view, relative navigation starts from the topmost visible block and
      every navigation command has an observable effect from a clean state.
- [ ] No parallel vocabulary exists: keyboard handlers and remote commands execute the same
      per-action implementation in the package.
- [ ] `count` multiplies the eight traversal/paging commands (N steps, edge-clamped, no
      wrap) and is rejected as `invalid-request` on the other six.
- [ ] Failure codes reach sdk callers as the closed `CanvasCommandErrorCode` union from
      `codev-types` — machine-readable, never only prose.
- [ ] With no matching canvas view open, the Tower route and the sdk call return an explicit
      machine-readable `no-canvas` error — observably not a success and not a silent no-op.
- [ ] With two views open on the same file (two hosts on one file, e.g. a VS Code panel and
      the Tower-served page once #1386 lands; verified at the Tower registry, which accepts
      two registrations for one file directly), a command is applied to exactly one — the
      most recently active — and the response names it.
- [ ] With views open on two different files in one workspace, a file-qualified command
      reaches the view for that file; a file-less command reaches the most recently active.
- [ ] `composer-open` → (human types) → `composer-submit` driven remotely posts exactly one
      comment through the existing marker write path.
- [ ] The sdk call is available from `@cluesmith/codev-sdk/controller`, and both existing
      boundary-test suites (sdk import rules, streamdeck subpath rules) pass unchanged in CI.
- [ ] In-page keyboard behavior is unchanged (existing canvas keyboard tests pass without
      modification).
- [ ] The VS Code host registers/unregisters views such that closing the last preview makes
      the next command return `no-canvas`.

## Constraints

Carried from issue #1401 and architect direction (fixed):

- The command set mirrors the existing keyboard vocabulary exactly; no parallel vocabulary.
  Composer open/submit/cancel in scope; text entry out.
- The no-canvas-open and multiple-canvases-open cases have the explicit spec-time answers
  above (error / MRU) — never a silent ambiguous no-op.
- The streamdeck architect reviews the sdk surface (§ Desired State 3) at design time,
  before implementation, routed via the main architect.
- sdk constraints are hard: environment-agnostic, zero runtime deps, imports only
  `codev-types` (type-only), CI boundary tests enforce.
- Ride existing plumbing (SSE events channel, adapter pattern, `codev-types` wire contracts);
  do not invent a new transport.
- Server/client isolation (#1189): core and sdk never import each other.
- Deck actions themselves are #1400; any change to in-page keyboard behavior is out of scope.

## Assumptions

- The VS Code extension host can observe per-panel focus/visibility (it can:
  `onDidChangeViewState`) and its existing SSE client can carry the new addressed event.
- #1386 (afx open → canvas migration) lands independently; this bridge must not depend on
  it, and its page becomes a second registrant with no protocol change.
- #1400 consumes the sdk route as specified; its UX (key feedback on `no-canvas`, workspace
  selection) is out of scope here.
- Registry liveness (lease TTL, refresh cadence) has workable values; exact numbers are a
  plan decision.

## Solution Approaches

### Approach 1: Extend the generic command relay with `canvas-*` verbs (rejected)

Add the 14 commands as verbs through the existing `POST /api/command` broadcast; the VS Code
relay forwards them to its preview panels (focused-window gate as today).

- **Pros**: zero new Tower surface; single controller act-path (deck posture doc: "ACTS by
  POSTing canonical verbs to the command relay"); smallest diff.
- **Cons**: structurally cannot satisfy Requirement 4 — the relay is fire-and-forget
  (`{ok:true}` with no providers listening), so no-canvas is a silent no-op; no per-file
  addressing; multi-view selection would be re-implemented ad hoc in every host; the relay's
  own comments defer provider addressing precisely because it doesn't fit this shape.
- **Risk/complexity**: low complexity, but fails a fixed requirement — rejected on that
  ground, not on taste.

### Approach 2: Canvas view registry + targeted command route over existing SSE (recommended)

As specified in Desired State: Tower-side live-view registry (host-registered, leased),
dedicated command route that resolves the target by the spec'd rule and answers explicitly,
delivery as a viewId-addressed event on the existing SSE channel, package-side
`CommandAdapter` seam, sdk `sendCanvasCommand` on the controller subpath.

- **Pros**: satisfies Requirement 4 by construction (Tower knows what's open and says so);
  MRU rule solves multi-view once, centrally; host-agnostic (any registrant works — #1386
  page inherits); no new transport (SSE + adapters + types, all existing plumbing); the
  registry closes a gap Tower's own code flags as deferred.
- **Cons**: new Tower state (registry) with liveness to manage; delivery after resolution is
  best-effort (no ack); hosts must implement registration glue.
- **Risk/complexity**: moderate — the registry is new but small, and staleness is bounded by
  leases.

### Approach 3: Dedicated per-view WebSocket channel (rejected)

Each canvas view opens a WS to Tower (like terminals); commands are routed down the socket,
acks come back up.

- **Pros**: precise addressing and delivery acks for free; connection lifetime *is*
  liveness.
- **Cons**: a new connection type per view; the VS Code webview would need its own
  authenticated socket to Tower (today the webview deliberately has no network identity —
  the extension host mediates); heavier than the problem warrants; duplicates what SSE +
  registry already provide minus acks nobody currently needs.
- **Risk/complexity**: highest; rejected as over-plumbing.

**Recommendation: Approach 2.**

## Open Questions

- **Important**: registration transport for hosts — dedicated register/unregister/heartbeat
  HTTP calls vs binding registrations to the host's SSE connection lifetime. Plan-phase
  decision; the spec fixes only the observable behavior (live views, activity, expiry).

Resolved during the streamdeck design review (2026-08-11), recorded here so they are not
reopened:

- Generic-relay exposure: **closed as NO** — targeted route only, never `canvas-*` verbs on
  `/api/command`.
- `reading-mode-toggle` stays a toggle (not `reading-mode-set`) — mirrors the vocabulary;
  endorsed as specced.
- `lastActiveAt` advances on command delivery (a driven view stays MRU) — endorsed, now
  part of the registry semantics.
- Traversal `count` parameter added; presence query named a non-goal with an additive
  follow-up path.

## Test Scenarios

Functional:

1. Each of the 14 commands delivered to a single open view produces its table-defined
   effect (focus moves with visible ring + scroll-into-view, composer
   opens/submits/cancels, column pages, mode toggles).
2. Command semantics parity edge cases: `comment-next` at the last commented block does not
   wrap (matches `n`); `column-forward` in vertical mode is a defined no-op;
   `composer-submit` / `composer-cancel` with no composer open are defined no-ops, and act
   on the view's composer regardless of where DOM focus sits.
3. Remote origin: on a freshly opened view with no interaction, `comment-next` starts its
   scan from the topmost visible block; after scrolling, from the new topmost visible
   block; after any focus (keyboard, pointer, minimap, or remote), from the current block.
   `composer-open` on a clean view opens on the topmost visible block.
4. `count`: `heading-next` with `count: 3` lands where three single steps land, clamping at
   the last heading without wrapping; `count` on `composer-open` (or any non-traversal
   command) returns `invalid-request`; `count: 0` and negative values are rejected.
5. No canvas open (workspace has none / file not shown / last view closed): route and sdk
   call return `no-canvas` (HTTP 404, closed-union code); nothing is delivered.
6. Two views, same file (exercised at the Tower registry, which accepts two registrations for
   one file regardless of host): command lands only on the most recently active; response
   names it via its Tower-minted `viewId`; activating the other view flips subsequent
   delivery. Two registrations of the same file under different path spellings match the same
   selector (Tower canonicalization) while remaining two distinct views with distinct
   `viewId`s.
7. Two views, different files: file-qualified selector routes correctly both ways; file-less
   selector follows MRU; a delivered command advances the target's `lastActiveAt`.
8. Stale registration (host killed without unregister): after lease expiry, commands return
   `no-canvas` rather than resolving to the dead view.
9. Full remote review loop on the VS Code host: navigate to a block, `composer-open`, type
   on the keyboard, `composer-submit` — exactly one marker written via the existing
   MarkerAdapter path; focus restoration behaves as the keyboard flow does.
10. sdk: `sendCanvasCommand` success and failure results are typed and reachable from
    `@cluesmith/codev-sdk/controller`, with `code` from the exported
    `CanvasCommandErrorCode` union.

Non-functional:

11. Boundary tests: sdk import rules and streamdeck subpath rules pass unchanged.
12. Existing canvas keyboard tests pass unmodified (no in-page behavior change).
13. SSE fan-out: non-target hosts receiving the addressed event ignore it cheaply (no
    canvas work triggered).

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Registry staleness: dead host leaves a view registered, commands resolve to a ghost | Medium | Medium — commands "succeed" but nothing happens | Leased registrations with expiry; liveness bound to host disconnect where the transport allows; test scenario 6 |
| Double-apply on duplicated views (composer-submit posts twice) | Low (ruled out by design) | High | MRU single-target rule is fixed at spec time; scenario 4 guards it |
| Vocabulary drift between keyboard and remote paths over time | Medium | Medium | Single per-action implementation both paths call; parity test per command (criterion 2) |
| Best-effort delivery after resolution (no ack): resolved view dies in the window | Low | Low — user retries | Accepted; documented; lease expiry keeps the window small |
| sdk boundary violation (importing runtime values from types) | Low | High — CI blocks | Follow the existing `COMMAND_ROUTE` re-declaration pattern; boundary tests already enforce |
| VS Code host complexity (panel registry glue, focus tracking) | Medium | Medium | Panels already expose lifecycle/view-state events; glue mirrors the existing command-relay filter pattern |

## References

- Issue #1401 (this bridge), #1400 (deck actions, dependent), #1386 (afx open → canvas
  migration; future second host), #1189 (server/client isolation + controller-subpath
  review arrangement).
- #1237 / PR #1344 (keyboard-first review), #1380 / PR #1398 (horizontal reading mode) —
  the vocabulary source of truth.
- Spec 945 (canvas package + D-series adapter contracts); spec 1313 (mailbox-first `afx
  send` — the precedent for explicit delivered/held answers instead of silent sends).
- Code ground truth: `packages/artifact-canvas/src/components/ArtifactCanvas.tsx`
  (`onBodyKeyDown`), `src/overlays/CommentComposer.tsx`, `src/adapters/*`;
  `packages/codev/src/agent-farm/servers/command-relay.ts`, `tower-server.ts` (SSE);
  `apps/vscode/src/command-relay.ts`, `src/markdown-preview/`;
  `packages/sdk/src/controller.ts`; `packages/types/src/command.ts`.
