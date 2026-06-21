/**
 * Wire contracts for Tower's editor + command channels.
 *
 * These let a CONTROLLER (an external control device or companion app) drive and
 * observe the active editor PROVIDER (the VSCode extension today, the web
 * dashboard later) over Tower's existing SSE + REST transport:
 *  - controller -> Tower: REST POST `/api/editor/*` (scroll, position demand,
 *    presence) and `/api/command` (run a canonical verb on the active provider).
 *  - provider  -> Tower: REST POST `/api/editor/position` / `/api/editor/context`.
 *  - Tower -> clients: SSE `editor-scroll` / `editor-wants-position` / `command`
 *    to the provider; `editor-position` / `editor-context` to controllers.
 *
 * The command channel carries CANONICAL VERBS (`view-diff`, `forward-hunk`, ...),
 * not provider-specific command ids, so one controller drives any provider; each
 * provider maps the verb to its own implementation. Pure wire shapes only.
 */

/** Scroll direction for an editor-scroll request. */
export type ScrollDirection = 'up' | 'down';

/** Scroll magnitude unit (mirrors VSCode's `editorScroll` `by`). */
export type ScrollBy = 'line' | 'page' | 'halfPage' | 'wrappedLine';

/** Which editor viewport operation a scroll request asks for. */
export type ScrollAction = 'scrollEditor' | 'recenterEditorOnCaret';

/** Visible range of the active editor. The push value is `null` when no editor is focused. */
export interface EditorPosition {
  visibleStart: number;
  visibleEnd: number;
  totalLines: number;
  file: string;
}

/**
 * Focused-editor context that gates a controller's context verbs (forward,
 * comment). `diffFocused`: the active editor is a builder diff; `hasSelection`:
 * that diff has a non-empty selection; `artifactFocused`: the active editor is a
 * codev artifact (spec/plan/review).
 */
export interface EditorContext {
  diffFocused: boolean;
  hasSelection: boolean;
  artifactFocused: boolean;
}

// ----- SSE payloads (Tower -> client, carried as the event `body`) -----

/** Tower signals whether any controller currently wants editor-position reports. */
export interface WantsEditorPosition {
  wanted: boolean;
}

// ----- REST request/response bodies -----

/**
 * Controller -> Tower (`/api/command`): run a canonical verb on the active
 * editor provider. The verb (e.g. `view-diff`, `forward-hunk`) is
 * provider-agnostic; the provider maps it to its own implementation. `args`
 * carries verb operands (typically the target builder id).
 */
export interface CommandRequest {
  verb: string;
  args?: unknown[];
}

/** Controller -> Tower (`/api/editor/scroll`): scroll (or recenter) the active editor. */
export interface ScrollEditorRequest {
  action: ScrollAction;
  to?: ScrollDirection;
  by?: ScrollBy;
  value?: number;
}

/** Provider -> Tower (`/api/editor/position`): the active editor's visible range, or null. */
export interface EditorPositionReport {
  value: EditorPosition | null;
}

/** Provider -> Tower (`/api/editor/context`): the focused editor's context, or null. */
export interface EditorContextReport {
  value: EditorContext | null;
}

/** Result of a relayed command (the `/api/command` response). */
export interface CommandResult {
  ok: boolean;
  error?: string;
}

// ----- Wire protocol names (single source for routes + event types) -----
// The route paths and SSE event-type names ARE the contract: the controller,
// Tower, and the provider must agree on them. Defining them once here (rather
// than repeating string literals in each package) keeps the protocol in lockstep
// and gives compile-time references instead of stringly-typed coupling.

/** REST routes for the editor + command channels (client <-> Tower). */
export const EDITOR_ROUTES = {
  command: '/api/command',
  scroll: '/api/editor/scroll',
  position: '/api/editor/position',
  context: '/api/editor/context',
  wantsPosition: '/api/editor/wants-position',
  heartbeat: '/api/editor/heartbeat',
} as const;

/** Prefix the Tower router uses to delegate the editor routes. */
export const EDITOR_ROUTE_PREFIX = '/api/editor/';

/** SSE event-type names (carried as the envelope `type`). */
export const EDITOR_EVENTS = {
  /** Tower -> provider: run a canonical command verb. */
  command: 'command',
  /** Tower -> provider: scroll/recenter the active editor. */
  scroll: 'editor-scroll',
  /** Tower -> provider: start/stop emitting editor position + context. */
  wantsPosition: 'editor-wants-position',
  /** Tower -> controllers: the active editor's visible range (or null). */
  position: 'editor-position',
  /** Tower -> controllers: the focused editor's context (or null). */
  context: 'editor-context',
} as const;
