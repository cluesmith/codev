/**
 * Editor + command relay for Tower.
 *
 * Lets a CONTROLLER (an external control device or companion app) drive and observe the
 * active editor PROVIDER (the VSCode extension today, the web dashboard later)
 * over Tower's EXISTING channels rather than a dedicated socket:
 *   - Tower -> client push: SSE at /api/events. Controllers receive
 *     `editor-position` / `editor-context`; providers receive `command` /
 *     `editor-scroll` / `editor-wants-position`. Clients filter by type.
 *   - client -> Tower: REST POST at `/api/editor/*` and `/api/command`.
 *
 * The `command` channel carries CANONICAL VERBS (`view-diff`, `forward-hunk`),
 * not provider-specific command ids, so one controller drives any provider; each
 * provider maps the verb to its own implementation. This module is pure relay +
 * presence: it reads NO project files (navigator state comes from /api/overview).
 *
 * NOTE: a single active provider is assumed today (the focused VSCode window
 * self-gates). Provider addressing/selection (VSCode vs dashboard) is a
 * deliberate later addition when a second provider type exists.
 */

import type * as http from 'node:http';
import type {
  CommandRequest,
  ScrollEditorRequest,
  EditorPositionReport,
  EditorContextReport,
} from '@cluesmith/codev-types';
import { EDITOR_ROUTES, EDITOR_EVENTS } from '@cluesmith/codev-types';
import { parseJsonBody } from '../utils/server-utils.js';

export interface EditorRelayDeps {
  /** Fan an event out to all SSE clients (wraps broadcastNotification). */
  broadcast: (type: string, body: unknown) => void;
}

/** The slice of Tower's RouteContext this module needs (avoids a type import cycle). */
interface EditorRouteCtx {
  broadcastNotification: (n: { type: string; title: string; body: string }) => void;
}

let deps: EditorRelayDeps | null = null;
let inited = false;

// Controller presence. A controller heartbeats and every request refreshes
// presence; a lightweight timer (NO filesystem work) releases the editor-position
// demand when presence goes stale (controller closed), so an absent controller
// leaves no provider emitting and Tower does no ongoing work.
let expiryTimer: ReturnType<typeof setInterval> | null = null;
let lastPresenceAt = 0;
const PRESENCE_CHECK_INTERVAL_MS = 5_000;
const PRESENCE_TTL_MS = 45_000;

// The provider emits editor positions only while at least one controller wants
// them (subscriber gating), so an idle editor pays nothing. The provider
// throttles a single focused window, so Tower fans position/context out as-is.
// Scroll and commands are passed straight through; the controller awaits no result.
let positionWantedCount = 0;

/** Wire the module's dependencies. */
export function initEditorRelay(d: EditorRelayDeps): void {
  deps = d;
  lastPresenceAt = 0;
  positionWantedCount = 0;
}

/** Tear down timers/state (used by tests and shutdown). */
export function shutdownEditorRelay(): void {
  stopExpiryTimer();
  positionWantedCount = 0;
  deps = null;
  lastPresenceAt = 0;
  inited = false;
}

/** Record that a controller is present and ensure the presence-expiry timer runs. */
export function markPresence(): void {
  lastPresenceAt = Date.now();
  if (!expiryTimer) {
    expiryTimer = setInterval(presenceExpiryTick, PRESENCE_CHECK_INTERVAL_MS);
    expiryTimer.unref();
  }
}

function stopExpiryTimer(): void {
  if (expiryTimer) {
    clearInterval(expiryTimer);
    expiryTimer = null;
  }
}

/**
 * When no controller has been seen within the TTL, stop the timer and release any
 * editor-position demand (telling the provider to stop emitting) so an absent
 * controller leaves zero ongoing work. Does NO filesystem work.
 */
function presenceExpiryTick(): void {
  if (Date.now() - lastPresenceAt <= PRESENCE_TTL_MS) {
    return;
  }
  stopExpiryTimer();
  if (positionWantedCount > 0) {
    positionWantedCount = 0;
    deps?.broadcast(EDITOR_EVENTS.wantsPosition, { wanted: false });
  }
}

/**
 * Single entry point for `/api/editor/*` and `/api/command`, delegated from
 * tower-routes. Lazily initializes from the RouteContext on first hit (so a Tower
 * with no controller never starts the timer), then dispatches by method + path.
 */
export async function handleEditorRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  ctx: EditorRouteCtx,
): Promise<void> {
  if (!inited) {
    inited = true;
    initEditorRelay({
      broadcast: (type, body) =>
        ctx.broadcastNotification({ type, title: type, body: JSON.stringify(body) }),
    });
  }
  // Any request keeps the controller "present" and (re)starts the expiry timer.
  markPresence();
  const path = url.pathname;
  if (req.method === 'POST' && path === EDITOR_ROUTES.command) return handleCommand(req, res);
  if (req.method === 'POST' && path === EDITOR_ROUTES.scroll) return handleScroll(req, res);
  if (req.method === 'POST' && path === EDITOR_ROUTES.wantsPosition) return handleWantsPosition(req, res);
  if (req.method === 'POST' && path === EDITOR_ROUTES.position) return handleEditorPosition(req, res);
  if (req.method === 'POST' && path === EDITOR_ROUTES.context) return handleEditorContext(req, res);
  if (req.method === 'POST' && path === EDITOR_ROUTES.heartbeat) return sendJson(res, 200, { ok: true });
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Unknown editor/command route' }));
}

// ---------------------------------------------------------------------------
// REST handlers
// ---------------------------------------------------------------------------

/**
 * POST /api/command — a controller asks the active provider to run a canonical
 * verb (`view-diff`, `forward-hunk`, ...). Tower fans it out as a `command` SSE
 * event; the provider maps the verb to its own implementation. Fire-and-forget:
 * the verb allowlist + execution live provider-side.
 */
export async function handleCommand(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const d = requireDeps();
  let body: CommandRequest;
  try {
    body = (await parseJsonBody(req)) as unknown as CommandRequest;
  } catch {
    return sendJson(res, 400, { ok: false, error: 'Invalid JSON' });
  }
  if (!body.verb || typeof body.verb !== 'string') {
    return sendJson(res, 400, { ok: false, error: 'Missing verb' });
  }
  d.broadcast(EDITOR_EVENTS.command, { verb: body.verb, args: body.args ?? [] });
  return sendJson(res, 200, { ok: true });
}

/** Access the wired deps, throwing a clear error if init was skipped. */
function requireDeps(): EditorRelayDeps {
  if (!deps) throw new Error('Editor relay not initialized');
  return deps;
}

/** Write a JSON response with the given status code. */
function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * POST /api/editor/wants-position — a controller signals demand for editor
 * position/context updates. A reference count tracks demand across controllers;
 * the provider is told to start emitting on the 0->1 transition, stop on 1->0.
 */
export async function handleWantsPosition(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const d = requireDeps();
  let body: { wanted?: boolean };
  try {
    body = (await parseJsonBody(req)) as { wanted?: boolean };
  } catch {
    return sendJson(res, 400, { ok: false, error: 'Invalid JSON' });
  }
  if (body.wanted === true) {
    positionWantedCount += 1;
    if (positionWantedCount === 1) d.broadcast(EDITOR_EVENTS.wantsPosition, { wanted: true });
  } else {
    if (positionWantedCount > 0) positionWantedCount -= 1;
    if (positionWantedCount === 0) d.broadcast(EDITOR_EVENTS.wantsPosition, { wanted: false });
  }
  return sendJson(res, 200, { ok: true });
}

/**
 * POST /api/editor/position — the provider reports the active editor's visible
 * range (or null). The provider throttles a single focused window, so Tower fans
 * the report out to controllers as-is.
 */
export async function handleEditorPosition(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const d = requireDeps();
  let body: EditorPositionReport;
  try {
    body = (await parseJsonBody(req)) as unknown as EditorPositionReport;
  } catch {
    return sendJson(res, 400, { ok: false, error: 'Invalid JSON' });
  }
  d.broadcast(EDITOR_EVENTS.position, body.value ?? null);
  return sendJson(res, 200, { ok: true });
}

/**
 * POST /api/editor/context — the provider reports the focused editor's context
 * (a builder diff? an artifact? a selection?), fanned out to controllers so they
 * can gate the context verbs.
 */
export async function handleEditorContext(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const d = requireDeps();
  let body: EditorContextReport;
  try {
    body = (await parseJsonBody(req)) as unknown as EditorContextReport;
  } catch {
    return sendJson(res, 400, { ok: false, error: 'Invalid JSON' });
  }
  d.broadcast(EDITOR_EVENTS.context, body.value ?? null);
  return sendJson(res, 200, { ok: true });
}

/**
 * POST /api/editor/scroll — a controller asks to scroll (or recenter) the active
 * editor. Tower passes the request straight through to providers as an
 * `editor-scroll` SSE event and acks immediately. Fire-and-forget: no focused
 * editor simply means nothing scrolls.
 */
export async function handleScroll(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const d = requireDeps();
  let body: ScrollEditorRequest;
  try {
    body = (await parseJsonBody(req)) as unknown as ScrollEditorRequest;
  } catch {
    return sendJson(res, 400, { ok: false, error: 'Invalid JSON' });
  }
  d.broadcast(EDITOR_EVENTS.scroll, body);
  return sendJson(res, 200, { ok: true });
}
