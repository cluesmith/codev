/**
 * Canvas command relay + live view registry for Tower (spec 1401).
 *
 * Lets any CONTROLLER (a control device, a companion app, a test harness) drive an open
 * artifact-canvas view over Tower's existing channels:
 *   - host -> Tower:       REST on `/api/canvas/views` (register / heartbeat / unregister).
 *   - controller -> Tower: REST POST `/api/canvas/command`.
 *   - Tower -> host:       SSE `canvas-command` at /api/events, addressed to one resolved view.
 *
 * Why this is not just another verb on `command-relay.ts`: that relay is a fire-and-forget
 * broadcast which answers `{ok:true}` whether or not anything is listening. It structurally
 * cannot say "no canvas is open", and it cannot pick one view among several. Both are hard
 * requirements here, so Tower keeps a registry of live views, resolves exactly ONE target, and
 * reports which one it drove.
 *
 * The registry is deliberately in-memory and lease-based: a view is a live UI surface, not
 * durable state, and a host that dies without unregistering must age out rather than linger as
 * a ghost that silently swallows commands.
 */

import type * as http from 'node:http';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import type {
  CanvasCommand,
  CanvasCommandEvent,
  CanvasCommandResult,
  CanvasView,
  CanvasViewRegistrationResult,
  TraversalCommand,
} from '@cluesmith/codev-types';
import { parseJsonBody } from '../utils/server-utils.js';

// Wire names — the canonical contract lives in @cluesmith/codev-types
// (CANVAS_COMMAND_ROUTE / CANVAS_VIEWS_ROUTE / CANVAS_COMMAND_EVENT) and must match these. They
// are re-declared locally because codev runs UNBUNDLED from dist/ and codev-types is a
// compile-time-only (type) dependency with no runtime dist on the codev side, so a runtime value
// import from it would not resolve. Same reason command-relay.ts re-declares COMMAND_ROUTE.
export const CANVAS_COMMAND_ROUTE = '/api/canvas/command';
export const CANVAS_VIEWS_ROUTE = '/api/canvas/views';
const CANVAS_COMMAND_EVENT = 'canvas-command';

/** Everything under this prefix belongs to this module. */
export const CANVAS_ROUTE_PREFIX = '/api/canvas/';

/** How often a host should heartbeat to keep its lease alive. */
export const CANVAS_VIEW_HEARTBEAT_MS = 30_000;
/**
 * How long a view survives without a heartbeat. Three missed beats: long enough to ride out a
 * busy event loop or a paused debugger, short enough that a killed host's ghost view stops
 * absorbing commands quickly.
 */
export const CANVAS_VIEW_LEASE_MS = 90_000;

/**
 * A type that fails to instantiate when its argument is not `true`. A bare conditional type
 * alias would constrain nothing and silently resolve to `false`, which is exactly how the same
 * guard in the canvas package went inert before review caught it.
 */
type Assert<T extends true> = T;

/**
 * The closed command vocabulary as runtime data, so an unknown command can be rejected. The
 * assertion below fails to compile if `CanvasCommand` gains a member that is missing here, which
 * is what keeps Tower's validation from silently falling behind the contract.
 */
const CANVAS_COMMANDS = [
  'block-next',
  'block-prev',
  'comment-next',
  'comment-prev',
  'heading-next',
  'heading-prev',
  'column-forward',
  'column-back',
  'doc-start',
  'doc-end',
  'composer-open',
  'composer-submit',
  'composer-cancel',
  'reading-mode-toggle',
] as const satisfies readonly CanvasCommand[];

type _EveryCommandIsListed = Assert<
  Exclude<CanvasCommand, (typeof CANVAS_COMMANDS)[number]> extends never ? true : false
>;

/** The commands `count` is valid on. Same drift protection as above. */
const TRAVERSAL_COMMANDS = [
  'block-next',
  'block-prev',
  'comment-next',
  'comment-prev',
  'heading-next',
  'heading-prev',
  'column-forward',
  'column-back',
] as const satisfies readonly TraversalCommand[];

type _EveryTraversalIsListed = Assert<
  Exclude<TraversalCommand, (typeof TRAVERSAL_COMMANDS)[number]> extends never ? true : false
>;

interface RegisteredView extends CanvasView {
  /** Last heartbeat of any kind; drives lease expiry. */
  lastSeenAt: number;
  /**
   * Registration order. Used to break an MRU tie deterministically — two views registered in the
   * same millisecond would otherwise resolve arbitrarily, and a target rule that depends on
   * timer resolution is not a rule.
   */
  sequence: number;
}

export interface CanvasRelayDeps {
  /** Fan an event out to all SSE clients (wraps broadcastNotification). */
  broadcast: (type: string, body: unknown) => void;
  /** Injectable clock, so lease expiry is tested by advancing time rather than waiting. */
  now: () => number;
}

/** The slice of Tower's RouteContext this module needs (avoids a type import cycle). */
interface CanvasRouteCtx {
  broadcastNotification: (n: { type: string; title: string; body: string }) => void;
}

const views = new Map<string, RegisteredView>();
let sequence = 0;
let deps: CanvasRelayDeps | null = null;
let inited = false;

/** Wire the module's dependencies. */
export function initCanvasRelay(d: CanvasRelayDeps): void {
  deps = d;
  inited = true;
}

/** Tear down state (used by tests and shutdown). */
export function shutdownCanvasRelay(): void {
  views.clear();
  sequence = 0;
  deps = null;
  inited = false;
}

/**
 * Resolve a path the same way the file-tab registry does, so the two agree on what "the same
 * file" means: follow symlinks, fall back to resolving the parent when the file itself does not
 * exist, and finally to a plain absolute path.
 */
function canonicalPath(raw: string): string {
  try {
    return fs.realpathSync(raw);
  } catch {
    try {
      return path.join(fs.realpathSync(path.dirname(raw)), path.basename(raw));
    } catch {
      return path.resolve(raw);
    }
  }
}

/** Drop views whose lease has lapsed. Called on every access, so no timer is needed. */
function sweep(nowMs: number): void {
  for (const [id, view] of views) {
    if (nowMs - view.lastSeenAt > CANVAS_VIEW_LEASE_MS) views.delete(id);
  }
}

/**
 * Pick the single view a command should go to.
 *
 * Zero matches is the caller's problem to hear about, not something to paper over. More than one
 * match resolves to the most recently active view and NEVER fans out: delivering
 * `composer-submit` to two views of one file would post the comment twice.
 */
function resolveTarget(workspace: string, file: string | undefined, nowMs: number): RegisteredView | null {
  sweep(nowMs);
  const ws = canonicalPath(workspace);
  let wanted: string | null = null;
  if (file !== undefined) wanted = canonicalPath(file);

  const matches: RegisteredView[] = [];
  for (const view of views.values()) {
    if (view.workspace !== ws) continue;
    if (wanted !== null && view.file !== wanted) continue;
    matches.push(view);
  }
  if (matches.length === 0) return null;

  matches.sort((a, b) => {
    if (b.lastActiveAt !== a.lastActiveAt) return b.lastActiveAt - a.lastActiveAt;
    return b.sequence - a.sequence;
  });
  return matches[0];
}

/**
 * Single entry point for `/api/canvas/*`, delegated from tower-routes. Lazily initializes from
 * the RouteContext on first hit, then dispatches.
 */
export async function handleCanvasRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  ctx: CanvasRouteCtx,
): Promise<void> {
  if (!inited) {
    initCanvasRelay({
      broadcast: (type, body) =>
        ctx.broadcastNotification({ type, title: type, body: JSON.stringify(body) }),
      now: () => Date.now(),
    });
  }

  if (req.method === 'POST' && url.pathname === CANVAS_COMMAND_ROUTE) {
    return handleCanvasCommand(req, res);
  }
  if (req.method === 'POST' && url.pathname === CANVAS_VIEWS_ROUTE) {
    return handleRegisterView(req, res);
  }

  const viewMatch = url.pathname.match(/^\/api\/canvas\/views\/([^/]+)(\/heartbeat)?$/);
  if (viewMatch) {
    const viewId = decodeURIComponent(viewMatch[1]);
    if (req.method === 'POST' && viewMatch[2]) return handleHeartbeat(req, res, viewId);
    if (req.method === 'DELETE' && !viewMatch[2]) return handleUnregisterView(res, viewId);
  }

  sendJson(res, 404, { ok: false, error: 'Unknown canvas route' });
}

/** POST /api/canvas/views — a host registers one live canvas view. */
async function handleRegisterView(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const d = requireDeps();
  let parsed: unknown;
  try {
    parsed = await parseJsonBody(req);
  } catch {
    return sendJson(res, 400, { ok: false, error: 'Invalid JSON' });
  }
  const body = asObject(parsed);
  if (!body) return sendJson(res, 400, { ok: false, error: 'Invalid JSON' });
  if (!isNonEmptyString(body.workspace)) {
    return sendJson(res, 400, { ok: false, error: 'Missing workspace' });
  }
  if (!isNonEmptyString(body.file)) {
    return sendJson(res, 400, { ok: false, error: 'Missing file' });
  }

  const nowMs = d.now();
  sweep(nowMs);
  sequence += 1;
  const viewId = `canvas-${randomUUID()}`;
  const file = canonicalPath(body.file);
  // One registration per VIEW, never per file: two panels showing the same document are two
  // views with distinct ids, which is precisely the case the MRU rule exists to disambiguate.
  views.set(viewId, {
    viewId,
    workspace: canonicalPath(body.workspace),
    file,
    lastActiveAt: nowMs,
    lastSeenAt: nowMs,
    sequence,
  });
  const result: CanvasViewRegistrationResult = { ok: true, viewId, file };
  return sendJson(res, 200, result);
}

/**
 * POST /api/canvas/views/:viewId/heartbeat — keep the lease alive.
 *
 * `focused: true` additionally makes this the most recently active view. Tower stamps both times
 * itself; host clocks are never trusted, so MRU stays deterministic across hosts whose clocks
 * disagree.
 */
async function handleHeartbeat(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  viewId: string,
): Promise<void> {
  const d = requireDeps();
  let parsed: unknown;
  try {
    parsed = await parseJsonBody(req);
  } catch {
    // A bodyless heartbeat is valid and already parses as `{}` ("still here, not necessarily
    // focused"), so reaching here means the body was genuinely malformed. Renewing the lease on
    // a payload we could not read would be extending liveness on the strength of a broken
    // request.
    return sendJson(res, 400, { ok: false, error: 'Invalid JSON' });
  }
  const body = asObject(parsed);
  if (!body) return sendJson(res, 400, { ok: false, error: 'Invalid JSON' });
  // `focused` is optional but typed: a non-boolean violates `CanvasViewHeartbeat`. Reject before
  // touching the lease, matching how the command route treats a bad `count` — a payload that does
  // not meet the contract should not buy liveness just because the rest of it parsed.
  if (body.focused !== undefined && typeof body.focused !== 'boolean') {
    return sendJson(res, 400, { ok: false, error: 'focused must be a boolean' });
  }

  const nowMs = d.now();
  sweep(nowMs);
  const view = views.get(viewId);
  // 404 rather than a silent re-create: a host holding an id Tower has forgotten (a restart, an
  // expired lease) must learn that and re-register, or it would heartbeat into the void forever.
  if (!view) return sendJson(res, 404, { ok: false, error: 'Unknown view' });

  view.lastSeenAt = nowMs;
  if (body.focused === true) view.lastActiveAt = nowMs;
  return sendJson(res, 200, { ok: true });
}

/** DELETE /api/canvas/views/:viewId — the host's view is gone. */
function handleUnregisterView(res: http.ServerResponse, viewId: string): void {
  const existed = views.delete(viewId);
  if (!existed) return sendJson(res, 404, { ok: false, error: 'Unknown view' });
  return sendJson(res, 200, { ok: true });
}

/**
 * POST /api/canvas/command — run one command against the resolved target view.
 *
 * Answers explicitly in every case: `no-canvas` (404) when the selector matches nothing,
 * `invalid-request` (400) when the payload is malformed, and the resolved target on success.
 * Delivery itself rides SSE and is best-effort; what is guaranteed is the ANSWER about targeting.
 */
async function handleCanvasCommand(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const d = requireDeps();
  let parsed: unknown;
  try {
    parsed = await parseJsonBody(req);
  } catch {
    return sendJson(res, 400, invalidRequest('Invalid JSON'));
  }
  const raw = asObject(parsed);
  if (!raw) return sendJson(res, 400, invalidRequest('Invalid JSON'));

  const invalid = validateCommandRequest(raw);
  if (invalid) return sendJson(res, 400, invalidRequest(invalid));

  const workspace = raw.workspace as string;
  const file = raw.file as string | undefined;
  const command = raw.command as CanvasCommand;
  const count = raw.count as number | undefined;

  const nowMs = d.now();
  const target = resolveTarget(workspace, file, nowMs);
  if (!target) {
    const noCanvas: CanvasCommandResult = {
      ok: false,
      code: 'no-canvas',
      error: 'No canvas view is open for that workspace/file',
    };
    return sendJson(res, 404, noCanvas);
  }

  const event: CanvasCommandEvent = { viewId: target.viewId, command };
  if (count !== undefined) event.count = count;
  d.broadcast(CANVAS_COMMAND_EVENT, event);

  // Driving a view is activity: it keeps that view the MRU target for the follow-up commands a
  // controller is about to send, even though it never took focus in its host.
  //
  // It is deliberately NOT liveness. Delivery is fire-and-forget over SSE and proves nothing
  // about the host still being alive, so refreshing the lease here would mean a ghost view kept
  // renewing itself for as long as a controller kept driving it — exactly when the reviewer most
  // needs to be told there is no canvas. Only a heartbeat, which only a live host can send,
  // extends the lease.
  target.lastActiveAt = nowMs;

  const ok: CanvasCommandResult = {
    ok: true,
    target: { viewId: target.viewId, file: target.file },
  };
  return sendJson(res, 200, ok);
}

/** Returns an error message when the payload is not a valid command request, else null. */
function validateCommandRequest(raw: Record<string, unknown>): string | null {
  if (!isNonEmptyString(raw.workspace)) return 'Missing workspace';
  if (raw.file !== undefined && !isNonEmptyString(raw.file)) return 'Invalid file';
  if (typeof raw.command !== 'string') return 'Missing command';
  if (!(CANVAS_COMMANDS as readonly string[]).includes(raw.command)) {
    return `Unknown command: ${raw.command}`;
  }
  if (raw.count !== undefined) {
    const count = raw.count;
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1) {
      return 'count must be a positive integer';
    }
    if (!(TRAVERSAL_COMMANDS as readonly string[]).includes(raw.command)) {
      return `count is not valid for ${raw.command}`;
    }
  }
  return null;
}

/** Every command-route failure carries a wire `code`; this keeps that impossible to forget. */
function invalidRequest(error: string): CanvasCommandResult {
  return { ok: false, code: 'invalid-request', error };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * `parseJsonBody` is typed as returning an object but will happily resolve a literal `null`, a
 * bare array, or a number, since those are all valid JSON. Reading a field off `null` throws,
 * which would escape as a 500 with no wire `code` — the one thing the error contract forbids.
 */
function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Access the wired deps, throwing a clear error if init was skipped. */
function requireDeps(): CanvasRelayDeps {
  if (!deps) throw new Error('Canvas relay not initialized');
  return deps;
}

/** Write a JSON response with the given status code. */
function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Live views, for tests and diagnostics. Never part of the wire surface. */
export function listCanvasViewsForTest(): CanvasView[] {
  return [...views.values()].map((v) => ({
    viewId: v.viewId,
    workspace: v.workspace,
    file: v.file,
    lastActiveAt: v.lastActiveAt,
  }));
}
