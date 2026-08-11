/**
 * Wire contracts for Tower's artifact-canvas command channel (spec 1401).
 *
 * Lets any CONTROLLER (a control device, a companion app, a test harness) drive an open
 * artifact-canvas VIEW over Tower's existing SSE + REST transport:
 *  - host -> Tower:       REST `/api/canvas/views` (register / heartbeat / unregister).
 *  - controller -> Tower: REST POST `/api/canvas/command` (run one command on a target view).
 *  - Tower -> host:       SSE `canvas-command` (the command, addressed to one resolved view).
 *
 * This is a SEPARATE path from the generic verb relay in `command.ts`, deliberately: that one
 * is a fire-and-forget broadcast that answers `{ok:true}` whether or not any provider is
 * listening, which cannot express "no canvas is open" or address one view among several.
 * Here Tower keeps a registry of live views, resolves exactly one target, and says which.
 *
 * Pure wire shapes only.
 */

/**
 * The canvas command vocabulary — a closed union mirroring the canvas's existing in-page
 * keyboard actions exactly (#1237, #1380). There is no parallel vocabulary: each command
 * produces the same effect as the in-page action it names.
 *
 * Two members have no key binding and are defined against their in-page equivalents instead:
 * `block-next`/`block-prev` step `[data-line]` blocks in flow order (deliberately NOT native
 * Tab parity, which also visits affordances, card actions, toolbar controls and links), and
 * `reading-mode-toggle` mirrors the reading-mode toolbar button.
 *
 * Text entry is out of scope: comment bodies are typed on the keyboard.
 */
export type CanvasCommand =
  // Traversal — relative movement from the view's current block.
  | 'block-next'
  | 'block-prev'
  | 'comment-next'
  | 'comment-prev'
  | 'heading-next'
  | 'heading-prev'
  // Paging — horizontal reading mode only.
  | 'column-forward'
  | 'column-back'
  // Absolute movement.
  | 'doc-start'
  | 'doc-end'
  // Composer.
  | 'composer-open'
  | 'composer-submit'
  | 'composer-cancel'
  // View state.
  | 'reading-mode-toggle';

/**
 * The commands `count` applies to: relative traversal and column paging, where "do it N
 * times" is meaningful. Absolute moves (`doc-*`), composer actions and the reading-mode
 * toggle are excluded — repeating them is either a no-op or actively wrong.
 *
 * Deliberately TYPE-LEVEL, not a runtime array. Neither consumer could import a runtime value
 * from this package: `@cluesmith/codev-types` is a compile-time-only dependency of
 * `packages/codev`, which runs unbundled from `dist/` (see the same note in `command.ts`
 * explaining why `COMMAND_ROUTE` is re-declared there), and the artifact-canvas package's
 * import boundary pins its import of this package to `import type`. Each consumer therefore
 * declares its own `const` list bound to this type with `satisfies`, which turns any drift
 * between a consumer's list and this union into a compile error.
 */
export type TraversalCommand = Extract<
  CanvasCommand,
  | 'block-next'
  | 'block-prev'
  | 'comment-next'
  | 'comment-prev'
  | 'heading-next'
  | 'heading-prev'
  | 'column-forward'
  | 'column-back'
>;

/** Every command `count` does NOT apply to. The complement of `TraversalCommand`. */
export type NonTraversalCommand = Exclude<CanvasCommand, TraversalCommand>;

/**
 * Failure codes Tower itself answers with — the WIRE union, exactly two members.
 *
 * `no-canvas` (HTTP 404): the selector resolved to zero live views. This is the case the
 * channel exists to make explicit; it is never a silent success.
 * `invalid-request` (HTTP 400): unknown command, malformed selector, or a `count` that is not
 * a positive integer or was sent with a non-traversal command.
 */
export type CanvasCommandErrorCode = 'no-canvas' | 'invalid-request';

/**
 * Failure codes a CLIENT can observe: Tower's answers plus `unreachable`.
 *
 * `unreachable` is CLIENT-SYNTHESIZED and never sent by Tower — the sdk produces it when the
 * request never got an answer at all (connection refused, timeout, malformed response). It is
 * a separate type from `CanvasCommandErrorCode` precisely so Tower cannot type a response it
 * must never send, while callers still get one closed union to switch on. The distinction
 * matters: "Tower says no canvas is open" and "Tower could not be reached" must not render as
 * the same thing.
 */
export type CanvasCommandClientErrorCode = CanvasCommandErrorCode | 'unreachable';

/**
 * Controller -> Tower (`/api/canvas/command`): run one command against a target view.
 *
 * `workspace` is the absolute path of the workspace to search, and is required — it is the
 * outer scope of every lookup. `file` narrows to one document; omitted, the command goes to
 * the workspace's most recently active view ("drive whatever I'm reviewing"). Both are
 * REGISTRY LOOKUP KEYS: Tower canonicalizes them for matching and never dereferences them as
 * filesystem paths.
 *
 * `count` defaults to 1 and is valid only on a `TraversalCommand`.
 */
export interface CanvasCommandRequest {
  workspace: string;
  file?: string;
  command: CanvasCommand;
  count?: number;
}

/** The view a command was actually delivered to. */
export interface CanvasCommandTarget {
  /** Tower-minted view identifier, stable for the life of that registration. */
  viewId: string;
  /** The canonicalized path of the document that view is showing. */
  file: string;
}

/**
 * Tower -> controller (the `/api/canvas/command` response).
 *
 * Success names the resolved target, so a caller can see WHICH view it drove when several
 * were open.
 */
export type CanvasCommandResult =
  | { ok: true; target: CanvasCommandTarget }
  | { ok: false; code: CanvasCommandErrorCode; error: string };

/**
 * The same result as an sdk caller sees it, widened to include the client-synthesized
 * `unreachable`. The sdk call never rejects; a failed request resolves to this shape.
 */
export type CanvasCommandClientResult =
  | { ok: true; target: CanvasCommandTarget }
  | { ok: false; code: CanvasCommandClientErrorCode; error: string };

/**
 * Host -> Tower (`POST /api/canvas/views`): register one live canvas view.
 *
 * One registration per view, not per host: a host showing the same document in two views
 * registers twice and receives two distinct `viewId`s.
 */
export interface CanvasViewRegistration {
  /** Absolute path of the workspace the view belongs to. */
  workspace: string;
  /** Absolute path of the document the view is showing. */
  file: string;
}

/** Tower -> host: the minted identity a host uses for heartbeat, unregister, and filtering. */
export interface CanvasViewRegistrationResult {
  viewId: string;
  /** The canonicalized `file`, so the host sees the identity Tower matched it under. */
  file: string;
}

/**
 * Host -> Tower (`POST /api/canvas/views/:viewId/heartbeat`): keep the lease alive.
 *
 * `focused: true` additionally marks the view as the most recently active one, which is how
 * the multi-view target rule picks a winner. Tower stamps the time itself; host clocks are
 * never trusted.
 */
export interface CanvasViewHeartbeat {
  focused?: boolean;
}

/** A live view as Tower tracks it. `lastActiveAt` is a Tower-stamped epoch milliseconds value. */
export interface CanvasView {
  viewId: string;
  workspace: string;
  file: string;
  lastActiveAt: number;
}

/**
 * Tower -> hosts (SSE `canvas-command`): one command, addressed to one resolved view.
 *
 * Tower's SSE channel is a broadcast with no per-connection identity, so every subscriber
 * receives this and all but one discard it on a `viewId` comparison. Carrying the resolved
 * `viewId` is what makes the delivery unambiguous.
 */
export interface CanvasCommandEvent {
  viewId: string;
  command: CanvasCommand;
  /** Present only for traversal commands; absent means 1. */
  count?: number;
}

// ----- Wire protocol names (single source for the routes + event type) -----
// The route paths and SSE event-type name ARE the contract: controllers, hosts, Tower and the
// sdk must agree on them. They are declared once here as the canonical definition. Both Tower
// and the sdk re-declare these literals locally — Tower because it cannot resolve a runtime
// import from this package, the sdk because its import boundary is type-only — and both point
// back here. This mirrors how `command.ts` handles COMMAND_ROUTE / COMMAND_EVENT.

/** REST route a controller POSTs a canvas command to. */
export const CANVAS_COMMAND_ROUTE = '/api/canvas/command';

/** REST route family a host registers, heartbeats, and unregisters its views on. */
export const CANVAS_VIEWS_ROUTE = '/api/canvas/views';

/** SSE event-type name Tower fans an addressed canvas command out to hosts as. */
export const CANVAS_COMMAND_EVENT = 'canvas-command';
